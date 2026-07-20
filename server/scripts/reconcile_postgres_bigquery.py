import sys
from pathlib import Path

from google.cloud import bigquery
from sqlalchemy import func, select

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.db import transaction  # noqa: E402
from app.db_models import SessionRow  # noqa: E402


def main() -> None:
    settings = get_settings()
    with transaction() as db:
        pg_count, pg_duration = db.execute(
            select(func.count(), func.coalesce(func.sum(SessionRow.duration_ms), 0)).where(
                SessionRow.reporting_status == "complete"
            )
        ).one()
        pg_active = db.scalar(
            select(func.count())
            .select_from(SessionRow)
            .where(
                SessionRow.deleted_at.is_(None),
                SessionRow.reporting_status == "complete",
            )
        )
    sql = f"""
        SELECT COUNT(*) AS row_count,
               COUNTIF(deleted_at IS NULL) AS active_count,
               COALESCE(SUM(duration_ms), 0) AS duration_ms
        FROM `{settings.gcp_project}.{settings.bq_dataset}.session_facts`
    """
    bq_row = next(
        iter(
            bigquery.Client(project=settings.gcp_project, location=settings.bq_location)
            .query(sql)
            .result()
        )
    )
    print(
        {
            "postgres": {
                "rows": pg_count,
                "active": pg_active,
                "duration_ms": pg_duration,
            },
            "bigquery": {
                "rows": bq_row.row_count,
                "active": bq_row.active_count,
                "duration_ms": bq_row.duration_ms,
            },
            "matches": (
                pg_count == bq_row.row_count
                and pg_active == bq_row.active_count
                and pg_duration == bq_row.duration_ms
            ),
        }
    )


if __name__ == "__main__":
    main()
