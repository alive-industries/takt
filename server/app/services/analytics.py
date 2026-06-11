"""Read-only analytics queries over BigQuery for the PM/dashboard API.

These power the key-only `/v1/analytics/*` endpoints. Everything here is SELECT-
only and parameterised. `group_by` values are resolved through whitelist maps to
fixed SQL expressions — user input is NEVER interpolated into SQL. Cost queries
default to the current month so the day-partitioned billing export isn't full-
scanned.
"""

from __future__ import annotations

from datetime import date, datetime

from google.cloud import bigquery

from app.config import get_settings
from app.errors import BadRequest
from app.services.bq import _client

# group_by token -> safe SQL expression. Adding a key here is the ONLY way to
# expose a new grouping; the value is trusted, the key is what the client sends.
_TIME_GROUPS = {
    "project": "project",
    "repo": "repo",
    "user": "github_user",
    "day": "DATE(completed_at)",
    "week": "DATE_TRUNC(DATE(completed_at), WEEK)",
    "month": "DATE_TRUNC(DATE(completed_at), MONTH)",
}

_GCP_COST_GROUPS = {
    "project": "project.name",
    "service": "service.description",
    "sku": "sku.description",
    "day": "DATE(usage_start_time)",
    "month": "DATE_TRUNC(DATE(usage_start_time), MONTH)",
}


def _resolve(group_by: str, groups: dict[str, str]) -> str:
    expr = groups.get(group_by)
    if expr is None:
        raise BadRequest(
            f"Invalid group_by '{group_by}'. Allowed: {', '.join(groups)}."
        )
    return expr


def _rows(sql: str, params: list) -> list[dict]:
    job = _client().query(
        sql, job_config=bigquery.QueryJobConfig(query_parameters=params)
    )
    return [dict(r) for r in job.result()]


# --- Time (Takt sessions) ---


def time_query(
    *,
    from_ts: datetime | None,
    to_ts: datetime | None,
    project: str | None,
    repo: str | None,
    user: str | None,
    group_by: str | None,
    limit: int,
) -> list[dict]:
    """Tracked time. With `group_by`, returns aggregated {group, hours, entries};
    without it, raw session rows (filtered, capped)."""
    s = get_settings()
    where = ["deleted_at IS NULL"]
    params: list = []
    if project:
        where.append("project = @project")
        params.append(bigquery.ScalarQueryParameter("project", "STRING", project))
    if repo:
        where.append("repo = @repo")
        params.append(bigquery.ScalarQueryParameter("repo", "STRING", repo))
    if user:
        where.append("github_user = @user")
        params.append(bigquery.ScalarQueryParameter("user", "STRING", user))
    if from_ts:
        where.append("completed_at >= @from_ts")
        params.append(bigquery.ScalarQueryParameter("from_ts", "TIMESTAMP", from_ts))
    if to_ts:
        where.append("completed_at < @to_ts")
        params.append(bigquery.ScalarQueryParameter("to_ts", "TIMESTAMP", to_ts))
    params.append(bigquery.ScalarQueryParameter("limit", "INT64", limit))
    where_sql = " AND ".join(where)

    if group_by:
        expr = _resolve(group_by, _TIME_GROUPS)
        sql = f"""
            SELECT
                {expr} AS `group`,
                ROUND(IFNULL(SUM(duration_ms), 0) / 3600000.0, 4) AS hours,
                COUNT(*) AS entries
            FROM `{s.sessions_table}`
            WHERE {where_sql}
            GROUP BY `group`
            ORDER BY hours DESC
            LIMIT @limit
        """
    else:
        sql = f"""
            SELECT project, repo, issue_number, issue_title, github_user,
                   duration_ms, duration_hours, completed_at
            FROM `{s.sessions_table}`
            WHERE {where_sql}
            ORDER BY completed_at DESC
            LIMIT @limit
        """
    return _rows(sql, params)


# --- Cost (billing_export) ---


def cost_summary(*, project: str | None) -> list[dict]:
    """The curated per-project current-month cost-vs-budget view, 1:1."""
    s = get_settings()
    where = []
    params: list = []
    if project:
        where.append("project = @project")
        params.append(bigquery.ScalarQueryParameter("project", "STRING", project))
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    sql = f"SELECT * FROM `{s.cost_summary_view}` {where_sql} ORDER BY total_cost_usd DESC"
    return _rows(sql, params)


def gcp_costs(
    *,
    from_dt: date,
    to_dt: date,
    project: str | None,
    service: str | None,
    group_by: str,
    limit: int,
) -> list[dict]:
    """GCP spend aggregated by the chosen dimension over a date window
    (defaults applied by the caller). Filters on the partition column
    usage_start_time to keep the scan bounded."""
    s = get_settings()
    expr = _resolve(group_by, _GCP_COST_GROUPS)
    where = [
        "DATE(usage_start_time) >= @from_dt",
        "DATE(usage_start_time) < @to_dt",
    ]
    params: list = [
        bigquery.ScalarQueryParameter("from_dt", "DATE", from_dt),
        bigquery.ScalarQueryParameter("to_dt", "DATE", to_dt),
        bigquery.ScalarQueryParameter("limit", "INT64", limit),
    ]
    if project:
        where.append("project.name = @project")
        params.append(bigquery.ScalarQueryParameter("project", "STRING", project))
    if service:
        where.append("service.description = @service")
        params.append(bigquery.ScalarQueryParameter("service", "STRING", service))
    sql = f"""
        SELECT
            {expr} AS `group`,
            ROUND(SUM(cost), 2) AS cost,
            ANY_VALUE(currency) AS currency
        FROM `{s.gcp_billing_table}`
        WHERE {' AND '.join(where)}
        GROUP BY `group`
        ORDER BY cost DESC
        LIMIT @limit
    """
    return _rows(sql, params)


def external_costs(
    *, project: str | None, from_dt: date | None, to_dt: date | None
) -> list[dict]:
    """external_costs table, 1:1 (manual non-GCP costs per project/month)."""
    s = get_settings()
    where = []
    params: list = []
    if project:
        where.append("project = @project")
        params.append(bigquery.ScalarQueryParameter("project", "STRING", project))
    if from_dt:
        where.append("month >= @from_dt")
        params.append(bigquery.ScalarQueryParameter("from_dt", "DATE", from_dt))
    if to_dt:
        where.append("month < @to_dt")
        params.append(bigquery.ScalarQueryParameter("to_dt", "DATE", to_dt))
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    sql = f"SELECT * FROM `{s.external_costs_table}` {where_sql} ORDER BY month DESC"
    return _rows(sql, params)


def budgets(*, project: str | None, month: date | None) -> list[dict]:
    """project_budgets table, 1:1."""
    s = get_settings()
    where = []
    params: list = []
    if project:
        where.append("project = @project")
        params.append(bigquery.ScalarQueryParameter("project", "STRING", project))
    if month:
        where.append("month = @month")
        params.append(bigquery.ScalarQueryParameter("month", "DATE", month))
    where_sql = f"WHERE {' AND '.join(where)}" if where else ""
    sql = f"SELECT * FROM `{s.project_budgets_table}` {where_sql} ORDER BY month DESC"
    return _rows(sql, params)
