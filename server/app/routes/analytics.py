"""Read-only analytics endpoints for PM dashboards.

Key-only: these handlers deliberately omit `Depends(get_caller)`, so they're
gated solely by the `X-Takt-Api-Key` middleware (no GitHub PAT, no member
check). They map ~1:1 to the BigQuery resources; cross-table blending is left to
the dashboard. See server/ANALYTICS_API.md.
"""

from datetime import date, datetime

from fastapi import APIRouter, Query

from app.services import analytics

router = APIRouter(prefix="/v1/analytics", tags=["analytics"])


def _month_start(d: date) -> date:
    return d.replace(day=1)


@router.get("/time")
def get_time(
    from_ts: datetime | None = Query(default=None, alias="from"),
    to_ts: datetime | None = Query(default=None, alias="to"),
    project: str | None = None,
    repo: str | None = None,
    user: str | None = None,
    group_by: str | None = Query(
        default=None, description="project | repo | user | day | week | month"
    ),
    limit: int = Query(default=1000, ge=1, le=5000),
) -> dict:
    """Tracked time from Takt sessions. With group_by → aggregated hours;
    without → raw session rows."""
    rows = analytics.time_query(
        from_ts=from_ts,
        to_ts=to_ts,
        project=project,
        repo=repo,
        user=user,
        group_by=group_by,
        limit=limit,
    )
    return {"group_by": group_by, "count": len(rows), "rows": rows}


@router.get("/cost-summary")
def get_cost_summary(project: str | None = None) -> dict:
    """Per-project current-month cost vs budget (the v_cost_summary view)."""
    rows = analytics.cost_summary(project=project)
    return {"count": len(rows), "rows": rows}


@router.get("/gcp-costs")
def get_gcp_costs(
    from_dt: date | None = Query(default=None, alias="from"),
    to_dt: date | None = Query(default=None, alias="to"),
    project: str | None = None,
    service: str | None = None,
    group_by: str = Query(
        default="service", description="project | service | sku | day | month"
    ),
    limit: int = Query(default=1000, ge=1, le=5000),
) -> dict:
    """GCP spend from the raw billing export, aggregated by group_by. Defaults
    to the current month so the partitioned export isn't full-scanned."""
    # Default window: current month -> start of next month.
    today = date.today()
    start = from_dt or _month_start(today)
    if to_dt is None:
        end = _month_start(today.replace(year=today.year + 1, month=1) if today.month == 12
                           else today.replace(month=today.month + 1))
    else:
        end = to_dt
    rows = analytics.gcp_costs(
        from_dt=start,
        to_dt=end,
        project=project,
        service=service,
        group_by=group_by,
        limit=limit,
    )
    return {
        "group_by": group_by,
        "from": start.isoformat(),
        "to": end.isoformat(),
        "count": len(rows),
        "rows": rows,
    }


@router.get("/external-costs")
def get_external_costs(
    project: str | None = None,
    from_dt: date | None = Query(default=None, alias="from"),
    to_dt: date | None = Query(default=None, alias="to"),
) -> dict:
    """Manual non-GCP costs (external_costs table), 1:1."""
    rows = analytics.external_costs(project=project, from_dt=from_dt, to_dt=to_dt)
    return {"count": len(rows), "rows": rows}


@router.get("/budgets")
def get_budgets(
    project: str | None = None,
    month: date | None = Query(default=None, description="First-of-month date, e.g. 2026-06-01"),
) -> dict:
    """Per-project monthly budgets + acknowledgement/approval (project_budgets), 1:1."""
    rows = analytics.budgets(project=project, month=month)
    return {"count": len(rows), "rows": rows}
