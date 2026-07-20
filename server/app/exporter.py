from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from google.cloud import bigquery
from sqlalchemy import or_, select

from app.config import get_settings
from app.db import transaction
from app.db_models import OutboxEventRow

_COLUMNS = [
    "session_id",
    "github_user",
    "github_user_id",
    "created_by_user",
    "source",
    "entry_type",
    "reporting_status",
    "client_id",
    "client",
    "reporting_project_id",
    "project",
    "description",
    "label",
    "github_metadata",
    "context_type",
    "repo",
    "issue_number",
    "issue_title",
    "issue_url",
    "started_at",
    "completed_at",
    "duration_ms",
    "duration_hours_exact",
    "duration_hours",
    "source_url",
    "synced_to_project",
    "project_titles",
    "project_ids",
    "takt_version",
    "client_ts",
    "inserted_at",
    "updated_at",
    "deleted_at",
]


def _claim(batch_size: int) -> list[tuple[int, dict]]:
    cutoff = datetime.now(UTC) - timedelta(hours=2)
    with transaction() as db:
        events = db.scalars(
            select(OutboxEventRow)
            .where(
                OutboxEventRow.exported_at.is_(None),
                or_(OutboxEventRow.claimed_at.is_(None), OutboxEventRow.claimed_at < cutoff),
            )
            .order_by(OutboxEventRow.id)
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        ).all()
        claimed_at = datetime.now(UTC)
        for event in events:
            event.claimed_at = claimed_at
        return [(event.id, event.payload) for event in events]


def _complete(ids: list[int]) -> None:
    with transaction() as db:
        events = db.scalars(select(OutboxEventRow).where(OutboxEventRow.id.in_(ids))).all()
        exported_at = datetime.now(UTC)
        for event in events:
            event.exported_at = exported_at
            event.claimed_at = None
            event.last_error = None


def _fail(ids: list[int], error: Exception) -> None:
    with transaction() as db:
        events = db.scalars(select(OutboxEventRow).where(OutboxEventRow.id.in_(ids))).all()
        for event in events:
            event.attempts += 1
            event.last_error = str(error)[:4000]
            event.claimed_at = None


def export_pending(batch_size: int = 1000) -> int:
    claimed = _claim(batch_size)
    if not claimed:
        return 0
    ids = [event_id for event_id, _ in claimed]
    latest_by_session: dict[str, dict] = {}
    replicated_at = datetime.now(UTC).isoformat()
    for _, payload in claimed:
        row = dict(payload)
        if row.get("reporting_status") != "complete":
            continue
        source = row.get("source")
        entry_type = row.get("entry_type")
        if source not in ("github", "manual") or entry_type not in ("delivery", "ops"):
            error = ValueError(f"Invalid reporting route for {row.get('session_id')}")
            _fail(ids, error)
            raise error
        if source == "github" and entry_type != "delivery":
            error = ValueError(f"GitHub entry must be delivery: {row.get('session_id')}")
            _fail(ids, error)
            raise error
        row["replicated_at"] = replicated_at
        latest_by_session[row["session_id"]] = row
    if not latest_by_session:
        _complete(ids)
        return len(ids)
    rows = list(latest_by_session.values())
    settings = get_settings()
    client = bigquery.Client(project=settings.gcp_project, location=settings.bq_location)
    destination = f"{settings.gcp_project}.{settings.bq_dataset}.session_facts"
    staging = f"{settings.gcp_project}.{settings.bq_dataset}._session_export_{uuid4().hex}"
    try:
        schema = client.get_table(destination).schema
        job_config = bigquery.LoadJobConfig(
            schema=schema,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            ignore_unknown_values=True,
        )
        client.load_table_from_json(rows, staging, job_config=job_config).result()
        updates = ",\n".join(f"            {column} = S.{column}" for column in _COLUMNS[1:])
        columns = ", ".join(_COLUMNS)
        values = ", ".join(f"S.{column}" for column in _COLUMNS)
        client.query(
            f"""
            MERGE `{destination}` T
            USING `{staging}` S
            ON T.session_id = S.session_id
            WHEN MATCHED THEN UPDATE SET
{updates},
                replicated_at = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT ({columns}, replicated_at)
            VALUES ({values}, CURRENT_TIMESTAMP())
            """
        ).result()
        _complete(ids)
        return len(ids)
    except Exception as exc:
        _fail(ids, exc)
        raise
    finally:
        client.delete_table(staging, not_found_ok=True)
