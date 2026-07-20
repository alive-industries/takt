import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

from google.cloud import bigquery
from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.db import transaction  # noqa: E402
from app.db_models import (  # noqa: E402
    AuditLogRow,
    OutboxEventRow,
    SessionRow,
)
from app.models import Member, OrgConfigUpdate, Project, SessionIn  # noqa: E402
from app.services import store  # noqa: E402


def _rows(client: bigquery.Client, table: str):
    settings = get_settings()
    return client.query(
        f"SELECT * FROM `{settings.gcp_project}.{settings.bq_dataset}.{table}`"
    ).result()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    settings = get_settings()
    client = bigquery.Client(project=settings.gcp_project, location=settings.bq_location)
    members = [dict(row) for row in _rows(client, "members")]
    projects = [dict(row) for row in _rows(client, "projects")]
    sessions = [dict(row) for row in _rows(client, "sessions")]
    configs = [dict(row) for row in _rows(client, "org_config")]
    audit_rows = [dict(row) for row in _rows(client, "audit_log")]
    print(
        {
            "members": len(members),
            "projects": len(projects),
            "sessions": len(sessions),
            "org_config": len(configs),
            "audit_log": len(audit_rows),
            "mode": "apply" if args.apply else "dry-run",
        }
    )
    if not args.apply:
        return

    for raw in members:
        store.upsert_member(Member(**raw))
    for raw in sessions:
        if store.get_member(raw["github_user"]) is None:
            store.upsert_member(
                Member(
                    github_login=raw["github_user"],
                    github_user_id=raw.get("github_user_id"),
                    role="member",
                    status="active",
                    source="manual",
                    added_by="migration",
                    added_at=raw.get("inserted_at") or datetime.now(UTC),
                )
            )
    store.upsert_projects([Project(**raw) for raw in projects])
    for raw in configs:
        project_fields = raw.get("project_fields") or {}
        if isinstance(project_fields, str):
            import json

            project_fields = json.loads(project_fields)
        excluded_projects = raw.get("excluded_projects") or []
        current = store.get_org_config()
        if (
            current.default_field_name != raw.get("default_field_name")
            or current.project_fields != project_fields
            or current.excluded_projects != excluded_projects
        ):
            store.update_org_config(
                OrgConfigUpdate(
                    default_field_name=raw.get("default_field_name"),
                    project_fields=project_fields,
                    excluded_projects=excluded_projects,
                ),
                updated_by=raw.get("updated_by") or "migration",
            )
    for raw in audit_rows:
        with transaction() as db:
            existing = db.scalar(
                select(AuditLogRow.id).where(
                    AuditLogRow.ts == raw["ts"],
                    AuditLogRow.actor == raw["actor"],
                    AuditLogRow.action == raw["action"],
                    AuditLogRow.target == raw.get("target"),
                )
            )
            if existing is None:
                db.add(
                    AuditLogRow(
                        ts=raw["ts"],
                        actor=raw["actor"],
                        action=raw["action"],
                        target=raw.get("target"),
                        subject=None,
                        before=None,
                        after={"legacy_payload": raw.get("payload")},
                    )
                )
    for raw in sessions:
        raw["context_type"] = "issue" if raw.get("issue_number", 0) > 0 else "repository"
        raw["member_login"] = None
        payload = SessionIn(**raw)
        store.create_session(
            payload,
            caller_login=raw["github_user"],
            is_admin=False,
        )
        with transaction() as db:
            row = db.get(SessionRow, raw["session_id"])
            if row:
                row.inserted_at = raw.get("inserted_at") or row.inserted_at
                row.updated_at = raw.get("inserted_at") or row.updated_at
                row.deleted_at = raw.get("deleted_at")
                event = db.scalar(
                    select(OutboxEventRow).where(
                        OutboxEventRow.aggregate_id == row.session_id,
                        OutboxEventRow.exported_at.is_(None),
                    )
                )
                if event:
                    payload_snapshot = dict(event.payload)
                    payload_snapshot["inserted_at"] = row.inserted_at.isoformat()
                    payload_snapshot["updated_at"] = row.updated_at.isoformat()
                    deleted_at = row.deleted_at
                    payload_snapshot["deleted_at"] = deleted_at.isoformat() if deleted_at else None
                    event.payload = payload_snapshot
    print(f"Migrated {len(sessions)} session(s) idempotently.")


if __name__ == "__main__":
    main()
