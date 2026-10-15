from __future__ import annotations

from sqlalchemy import func, select

from app.config import get_settings
from app.db import transaction
from app.db_models import OrgConfigRow, OutboxEventRow, ProjectRow, SessionRow
from app.models import BigQuerySyncStatus, OrgConfig, OrgConfigUpdate, Project

from ._common import _audit, _now


def get_bigquery_sync_status() -> BigQuerySyncStatus:
    with transaction() as db:
        pending = (
            db.scalar(
                select(func.count())
                .select_from(OutboxEventRow)
                .where(OutboxEventRow.exported_at.is_(None))
            )
            or 0
        )
        incomplete = (
            db.scalar(
                select(func.count())
                .select_from(SessionRow)
                .where(
                    SessionRow.deleted_at.is_(None),
                    SessionRow.reporting_status == "pending_metadata",
                )
            )
            or 0
        )
        failed = (
            db.scalar(
                select(func.count())
                .select_from(OutboxEventRow)
                .where(
                    OutboxEventRow.exported_at.is_(None),
                    OutboxEventRow.attempts > 0,
                )
            )
            or 0
        )
        last_exported_at = db.scalar(select(func.max(OutboxEventRow.exported_at)))
        last_failed = db.scalar(
            select(OutboxEventRow)
            .where(
                OutboxEventRow.exported_at.is_(None),
                OutboxEventRow.last_error.is_not(None),
            )
            .order_by(OutboxEventRow.id.desc())
            .limit(1)
        )
        return BigQuerySyncStatus(
            all_synced=pending == 0 and incomplete == 0,
            pending=pending,
            incomplete=incomplete,
            failed=failed,
            last_exported_at=last_exported_at,
            last_error=last_failed.last_error if last_failed else None,
        )


def upsert_projects(projects: list[Project]) -> None:
    if not projects:
        return
    now = _now()
    with transaction() as db:
        for project in projects:
            row = db.get(ProjectRow, project.project_id)
            if row is None:
                db.add(
                    ProjectRow(
                        project_id=project.project_id,
                        title=project.title,
                        org=project.org,
                        updated_at=now,
                    )
                )
            else:
                row.title = project.title
                row.org = project.org or row.org
                row.updated_at = now


def list_projects() -> list[Project]:
    with transaction() as db:
        rows = db.scalars(select(ProjectRow).order_by(ProjectRow.title)).all()
        return [Project(project_id=row.project_id, title=row.title, org=row.org) for row in rows]


def get_org_config() -> OrgConfig:
    org = get_settings().github_org
    with transaction() as db:
        row = db.get(OrgConfigRow, org)
        if row is None:
            return OrgConfig(org_login=org)
        return OrgConfig(
            org_login=row.org_login,
            default_field_name=row.default_field_name,
            project_fields=row.project_fields or {},
            excluded_projects=row.excluded_projects or [],
            updated_by=row.updated_by,
            updated_at=row.updated_at,
        )


def update_org_config(update: OrgConfigUpdate, *, updated_by: str) -> OrgConfig:
    org = get_settings().github_org
    now = _now()
    with transaction() as db:
        row = db.get(OrgConfigRow, org)
        before = None
        if row is None:
            row = OrgConfigRow(
                org_login=org,
                project_fields={},
                excluded_projects=[],
                updated_by=updated_by,
                updated_at=now,
            )
            db.add(row)
        else:
            before = {
                "default_field_name": row.default_field_name,
                "project_fields": row.project_fields,
                "excluded_projects": row.excluded_projects,
            }
        if update.default_field_name is not None:
            row.default_field_name = update.default_field_name
        if update.project_fields is not None:
            row.project_fields = update.project_fields
        if update.excluded_projects is not None:
            row.excluded_projects = update.excluded_projects
        row.updated_by = updated_by
        row.updated_at = now
        db.flush()
        result = OrgConfig(
            org_login=org,
            default_field_name=row.default_field_name,
            project_fields=row.project_fields or {},
            excluded_projects=row.excluded_projects or [],
            updated_by=row.updated_by,
            updated_at=row.updated_at,
        )
        _audit(
            db,
            actor=updated_by,
            action="config.update",
            target=org,
            subject=None,
            before=before,
            after=result.model_dump(mode="json"),
        )
        return result
