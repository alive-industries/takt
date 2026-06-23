"""BigQuery access layer.

All reads go through parameterised queries. Writes use streaming insertAll
with `insertId` for dedup. We deliberately keep this layer thin — no ORM —
so the schema and row shapes stay obvious.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from google.api_core import exceptions as gax
from google.cloud import bigquery

from app.config import get_settings
from app.errors import StreamingBufferConflict, UpstreamError
from app.models import (
    Member,
    OrgConfig,
    OrgConfigUpdate,
    SessionIn,
    SessionOut,
    SessionUpdate,
)

log = logging.getLogger(__name__)


def _client() -> bigquery.Client:
    s = get_settings()
    return bigquery.Client(project=s.gcp_project, location=s.bq_location)


def _run_dml(sql: str, params: list) -> bigquery.QueryJob:
    """Run a DML statement and translate the streaming-buffer error.

    BigQuery rejects UPDATE/DELETE/MERGE on rows still in the streaming
    buffer with a specific BadRequest. Anything else with that signature
    we keep as 5xx so we don't silently swallow real failures.
    """
    bq = _client()
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    try:
        job.result()
    except gax.BadRequest as exc:
        msg = str(exc)
        if "streaming buffer" in msg.lower():
            raise StreamingBufferConflict() from exc
        raise
    return job


# --- Sessions ---


def insert_session(row: SessionIn, *, github_user: str, github_user_id: int) -> None:
    """Insert a session via MERGE so it goes straight to permanent storage.

    Why MERGE not streaming insertAll:
      - Streaming inserts go via a buffer where DML (UPDATE/DELETE) is
        rejected for ~30 min. The user's first edit attempt hits this.
      - DML INSERT/MERGE writes directly to the table; rows are
        immediately editable. The trade-off is rate limits (~1500
        DML jobs/table/day) and slightly higher latency (~1-2s vs ~50ms),
        both of which are fine for a low-volume time tracker.

    Idempotency: MERGE on session_id, so retries from the extension's
    sync queue won't double-insert.
    """
    s = get_settings()
    sql = f"""
        MERGE `{s.sessions_table}` T
        USING (SELECT @session_id AS session_id) S
        ON T.session_id = S.session_id
        WHEN NOT MATCHED THEN INSERT (
            session_id, github_user, github_user_id, repo, issue_number,
            issue_title, issue_url, started_at, completed_at, duration_ms,
            duration_hours, source_url, synced_to_project, project_titles,
            project_ids, takt_version, client_ts, inserted_at
        ) VALUES (
            @session_id, @github_user, @github_user_id, @repo, @issue_number,
            @issue_title, @issue_url, @started_at, @completed_at, @duration_ms,
            @duration_hours, @source_url, @synced_to_project, @project_titles,
            @project_ids, @takt_version, @client_ts, CURRENT_TIMESTAMP()
        )
    """
    params = [
        bigquery.ScalarQueryParameter("session_id", "STRING", row.session_id),
        bigquery.ScalarQueryParameter("github_user", "STRING", github_user),
        bigquery.ScalarQueryParameter("github_user_id", "INT64", github_user_id),
        bigquery.ScalarQueryParameter("repo", "STRING", row.repo),
        bigquery.ScalarQueryParameter("issue_number", "INT64", row.issue_number),
        bigquery.ScalarQueryParameter("issue_title", "STRING", row.issue_title),
        bigquery.ScalarQueryParameter("issue_url", "STRING", row.issue_url),
        bigquery.ScalarQueryParameter(
            "started_at", "TIMESTAMP", row.started_at.astimezone(UTC)
        ),
        bigquery.ScalarQueryParameter(
            "completed_at", "TIMESTAMP", row.completed_at.astimezone(UTC)
        ),
        bigquery.ScalarQueryParameter("duration_ms", "INT64", row.duration_ms),
        bigquery.ScalarQueryParameter("duration_hours", "FLOAT64", row.duration_hours),
        bigquery.ScalarQueryParameter("source_url", "STRING", row.source_url),
        bigquery.ScalarQueryParameter(
            "synced_to_project", "BOOL", bool(row.synced_to_project)
        ),
        bigquery.ArrayQueryParameter(
            "project_titles", "STRING", row.project_titles or []
        ),
        bigquery.ArrayQueryParameter(
            "project_ids", "STRING", row.project_ids or []
        ),
        bigquery.ScalarQueryParameter("takt_version", "STRING", row.takt_version),
        bigquery.ScalarQueryParameter(
            "client_ts",
            "TIMESTAMP",
            (row.client_ts or datetime.now(UTC)).astimezone(UTC),
        ),
    ]
    try:
        _run_dml(sql, params)
    except StreamingBufferConflict:
        # Inserts can't conflict with the buffer themselves; let it bubble.
        raise
    except gax.GoogleAPIError as exc:
        log.error("BQ insert failed: %s", exc)
        raise UpstreamError("Failed to write session to BigQuery.") from exc


def list_sessions(
    *,
    caller_login: str,
    is_admin: bool,
    user_filter: str | None = None,
    repo: str | None = None,
    from_ts: datetime | None = None,
    to_ts: datetime | None = None,
    limit: int = 500,
    include_deleted: bool = False,
) -> list[SessionOut]:
    s = get_settings()
    bq = _client()

    where: list[str] = [] if include_deleted else ["deleted_at IS NULL"]
    params: list[bigquery.ScalarQueryParameter] = []

    if not is_admin:
        where.append("github_user = @caller")
        params.append(bigquery.ScalarQueryParameter("caller", "STRING", caller_login))
    elif user_filter:
        where.append("github_user = @user_filter")
        params.append(bigquery.ScalarQueryParameter("user_filter", "STRING", user_filter))

    if repo:
        where.append("repo = @repo")
        params.append(bigquery.ScalarQueryParameter("repo", "STRING", repo))
    if from_ts:
        where.append("completed_at >= @from_ts")
        params.append(bigquery.ScalarQueryParameter("from_ts", "TIMESTAMP", from_ts))
    if to_ts:
        where.append("completed_at < @to_ts")
        params.append(bigquery.ScalarQueryParameter("to_ts", "TIMESTAMP", to_ts))

    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    sql = f"""
        SELECT *
        FROM `{s.sessions_table}`
        {where_sql}
        ORDER BY completed_at DESC
        LIMIT @limit
    """
    params.append(bigquery.ScalarQueryParameter("limit", "INT64", limit))
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    return [SessionOut(**dict(r)) for r in job.result()]


def update_session(
    session_id: str,
    update: SessionUpdate,
    *,
    caller_login: str,
    is_admin: bool,
) -> SessionOut | None:
    """Patch mutable fields on a session row.

    Returns the updated row, or None if the session doesn't exist / caller
    has no permission. Atomicity: a single UPDATE statement, scoped by
    session_id + (admin OR ownership).
    """
    s = get_settings()

    set_clauses: list[str] = []
    params: list[bigquery.ScalarQueryParameter] = [
        bigquery.ScalarQueryParameter("id", "STRING", session_id),
    ]

    if update.duration_ms is not None:
        # Recompute started_at and duration_hours so the row stays coherent.
        # started_at = completed_at - INTERVAL duration_ms MILLISECOND.
        set_clauses.append("duration_ms = @duration_ms")
        set_clauses.append("duration_hours = @duration_hours")
        set_clauses.append(
            "started_at = TIMESTAMP_SUB(completed_at, INTERVAL @duration_ms MILLISECOND)"
        )
        hours = round((update.duration_ms / 3_600_000) * 4) / 4
        params.append(bigquery.ScalarQueryParameter("duration_ms", "INT64", update.duration_ms))
        params.append(bigquery.ScalarQueryParameter("duration_hours", "FLOAT64", hours))

    if update.issue_title is not None:
        set_clauses.append("issue_title = @issue_title")
        params.append(bigquery.ScalarQueryParameter("issue_title", "STRING", update.issue_title))

    if not set_clauses:
        # Nothing to update — return the row as-is.
        return _get_session(session_id, caller_login=caller_login, is_admin=is_admin)

    where = ["session_id = @id", "deleted_at IS NULL"]
    if not is_admin:
        where.append("github_user = @caller")
        params.append(bigquery.ScalarQueryParameter("caller", "STRING", caller_login))

    sql = f"""
        UPDATE `{s.sessions_table}`
        SET {', '.join(set_clauses)}
        WHERE {' AND '.join(where)}
    """
    job = _run_dml(sql, params)
    if (job.num_dml_affected_rows or 0) == 0:
        return None
    return _get_session(session_id, caller_login=caller_login, is_admin=is_admin)


def _get_session(
    session_id: str, *, caller_login: str, is_admin: bool
) -> SessionOut | None:
    s = get_settings()
    where = ["session_id = @id", "deleted_at IS NULL"]
    params: list[bigquery.ScalarQueryParameter] = [
        bigquery.ScalarQueryParameter("id", "STRING", session_id),
    ]
    if not is_admin:
        where.append("github_user = @caller")
        params.append(bigquery.ScalarQueryParameter("caller", "STRING", caller_login))
    sql = f"SELECT * FROM `{s.sessions_table}` WHERE {' AND '.join(where)} LIMIT 1"
    rows = list(
        _client()
        .query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
        .result()
    )
    return SessionOut(**dict(rows[0])) if rows else None


def total_hours_for_issue(repo: str, issue_number: int) -> float:
    """Sum of session time across all non-deleted sessions for repo+issue.

    Computed from `duration_ms` (the exact wall-clock measurement) and
    converted to hours at the end. We deliberately do NOT sum
    `duration_hours` — that column is quarter-hour rounded per row by the
    client, so short sessions (e.g. 3 minutes) get stored as 0 and would
    disappear from the total. Summing the underlying ms avoids that loss.

    The extension calls this after every create/update/delete and writes
    the result (not a delta) to the linked GitHub Projects v2 Number
    field, so the project field stays in sync with edits and deletes —
    not just the additive STOP path.

    Sum is across all users: the project field is org-wide, not per-user.
    issue_number=0 is the manual-entry sentinel (no linked issue) and
    never contributes, so we short-circuit.
    """
    if issue_number <= 0:
        return 0.0
    s = get_settings()
    sql = f"""
        SELECT IFNULL(SUM(duration_ms), 0) / 3600000.0 AS total
        FROM `{s.sessions_table}`
        WHERE repo = @repo
          AND issue_number = @issue_number
          AND deleted_at IS NULL
    """
    params = [
        bigquery.ScalarQueryParameter("repo", "STRING", repo),
        bigquery.ScalarQueryParameter("issue_number", "INT64", issue_number),
    ]
    job = _client().query(
        sql, job_config=bigquery.QueryJobConfig(query_parameters=params)
    )
    rows = list(job.result())
    if not rows or rows[0].total is None:
        return 0.0
    return float(rows[0].total)


def soft_delete_session(session_id: str, *, caller_login: str, is_admin: bool) -> bool:
    s = get_settings()
    where = ["session_id = @id", "deleted_at IS NULL"]
    params: list[bigquery.ScalarQueryParameter] = [
        bigquery.ScalarQueryParameter("id", "STRING", session_id)
    ]
    if not is_admin:
        where.append("github_user = @caller")
        params.append(bigquery.ScalarQueryParameter("caller", "STRING", caller_login))
    sql = f"""
        UPDATE `{s.sessions_table}`
        SET deleted_at = CURRENT_TIMESTAMP()
        WHERE {' AND '.join(where)}
    """
    job = _run_dml(sql, params)
    return (job.num_dml_affected_rows or 0) > 0


# --- Members ---


def get_member(login: str) -> Member | None:
    s = get_settings()
    bq = _client()
    sql = f"SELECT * FROM `{s.members_table}` WHERE github_login = @login LIMIT 1"
    params = [bigquery.ScalarQueryParameter("login", "STRING", login)]
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
    return Member(**dict(rows[0])) if rows else None


def list_members() -> list[Member]:
    s = get_settings()
    sql = f"SELECT * FROM `{s.members_table}` ORDER BY added_at DESC"
    return [Member(**dict(r)) for r in _client().query(sql).result()]


def upsert_member(member: Member) -> None:
    """Insert or update a member row. Uses MERGE for idempotency."""
    s = get_settings()
    bq = _client()
    sql = f"""
        MERGE `{s.members_table}` T
        USING (SELECT
            @login AS github_login,
            @user_id AS github_user_id,
            @role AS role,
            @status AS status,
            @source AS source,
            @added_by AS added_by
        ) S
        ON T.github_login = S.github_login
        WHEN MATCHED THEN UPDATE SET
            github_user_id = COALESCE(S.github_user_id, T.github_user_id),
            role = S.role,
            status = S.status,
            source = S.source,
            updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT
            (github_login, github_user_id, role, status, source, added_by, added_at, updated_at)
        VALUES
            (S.github_login, S.github_user_id, S.role, S.status, S.source, S.added_by,
             CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())
    """
    params = [
        bigquery.ScalarQueryParameter("login", "STRING", member.github_login),
        bigquery.ScalarQueryParameter("user_id", "INT64", member.github_user_id),
        bigquery.ScalarQueryParameter("role", "STRING", member.role),
        bigquery.ScalarQueryParameter("status", "STRING", member.status),
        bigquery.ScalarQueryParameter("source", "STRING", member.source),
        bigquery.ScalarQueryParameter("added_by", "STRING", member.added_by),
    ]
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()


# --- Org config ---


def get_org_config() -> OrgConfig:
    s = get_settings()
    bq = _client()
    sql = f"SELECT * FROM `{s.org_config_table}` WHERE org_login = @org LIMIT 1"
    params = [bigquery.ScalarQueryParameter("org", "STRING", s.github_org)]
    rows = list(bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
    if not rows:
        return OrgConfig(org_login=s.github_org)
    row = dict(rows[0])
    # project_fields stored as JSON
    pf = row.get("project_fields")
    if isinstance(pf, str):
        import json

        row["project_fields"] = json.loads(pf) if pf else {}
    return OrgConfig(**row)


def update_org_config(update: OrgConfigUpdate, *, updated_by: str) -> OrgConfig:
    """Patch the singleton org config row, creating it if missing."""
    import json

    s = get_settings()
    current = get_org_config()
    patch: dict[str, object] = {
        "updated_by": updated_by,
        "updated_at": datetime.now(UTC),
    }
    if update.default_field_name is not None:
        patch["default_field_name"] = update.default_field_name
    if update.project_fields is not None:
        patch["project_fields"] = update.project_fields
    if update.excluded_projects is not None:
        patch["excluded_projects"] = update.excluded_projects
    merged = current.model_copy(update=patch)

    bq = _client()
    sql = f"""
        MERGE `{s.org_config_table}` T
        USING (SELECT @org AS org_login) S
        ON T.org_login = S.org_login
        WHEN MATCHED THEN UPDATE SET
            default_field_name = @default_field_name,
            project_fields = @project_fields,
            excluded_projects = @excluded_projects,
            updated_by = @updated_by,
            updated_at = CURRENT_TIMESTAMP()
        WHEN NOT MATCHED THEN INSERT
            (org_login, default_field_name, project_fields, excluded_projects,
             updated_by, updated_at)
        VALUES
            (@org, @default_field_name, @project_fields, @excluded_projects,
             @updated_by, CURRENT_TIMESTAMP())
    """
    params = [
        bigquery.ScalarQueryParameter("org", "STRING", s.github_org),
        bigquery.ScalarQueryParameter("default_field_name", "STRING", merged.default_field_name),
        bigquery.ScalarQueryParameter(
            "project_fields", "STRING", json.dumps(merged.project_fields)
        ),
        bigquery.ArrayQueryParameter(
            "excluded_projects", "STRING", merged.excluded_projects
        ),
        bigquery.ScalarQueryParameter("updated_by", "STRING", updated_by),
    ]
    bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params)).result()
    return merged
