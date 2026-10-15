from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal, cast

from sqlalchemy import select

from app.db_models import (
    AuditLogRow,
    ClientProjectRow,
    ClientRow,
    IssueRow,
    MemberRow,
    OutboxEventRow,
    ProjectRepositoryRow,
    ProjectRow,
    RepositoryRow,
    SessionProjectRow,
    SessionRow,
)
from app.models import Client, ClientProject, Member, SessionIn, SessionOut


def _now() -> datetime:
    return datetime.now(UTC)


def _member_model(row: MemberRow) -> Member:
    return Member(
        github_login=row.github_login,
        github_user_id=row.github_user_id,
        role=cast(Literal["admin", "member"], row.role),
        status=cast(Literal["active", "revoked", "pending"], row.status),
        source=cast(Literal["org", "manual"], row.source),
        added_by=row.added_by,
        added_at=row.added_at,
        updated_at=row.updated_at,
    )


def _session_snapshot(
    row: SessionRow, project_ids: list[str], project_titles: list[str]
) -> dict:
    return {
        "session_id": row.session_id,
        "github_user": row.github_user,
        "github_user_id": row.github_user_id,
        "created_by_user": row.created_by_user,
        "source": row.source,
        "entry_type": row.entry_type,
        "reporting_status": row.reporting_status,
        "client_id": row.client_id,
        "client": row.client_name,
        "repo": row.repo,
        "reporting_project_id": row.reporting_project_id,
        "project": row.project_name,
        "issue_number": row.issue_number,
        "issue_title": row.issue_title,
        "issue_url": row.issue_url,
        "description": row.description,
        "label": row.label,
        "github_metadata": row.github_metadata or {},
        "context_type": row.context_type
        or ("issue" if row.issue_number > 0 else ("repository" if row.repo else "category")),
        "started_at": row.started_at.isoformat(),
        "completed_at": row.completed_at.isoformat(),
        "duration_ms": row.duration_ms,
        "duration_hours": row.duration_hours,
        "duration_hours_exact": row.duration_hours_exact,
        "source_url": row.source_url,
        "synced_to_project": row.synced_to_project,
        "project_ids": project_ids,
        "project_titles": project_titles,
        "takt_version": row.takt_version,
        "client_ts": row.client_ts.isoformat() if row.client_ts else None,
        "inserted_at": row.inserted_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
        "deleted_at": row.deleted_at.isoformat() if row.deleted_at else None,
    }


def _projects_for_session(db, session_id: str) -> tuple[list[str], list[str]]:
    rows = db.execute(
        select(SessionProjectRow.project_id, ProjectRow.title)
        .join(ProjectRow, ProjectRow.project_id == SessionProjectRow.project_id)
        .where(SessionProjectRow.session_id == session_id)
        .order_by(SessionProjectRow.project_id)
    ).all()
    return [row.project_id for row in rows], [row.title for row in rows]


def _session_out(db, row: SessionRow) -> SessionOut:
    project_ids, project_titles = _projects_for_session(db, row.session_id)
    return SessionOut(**_session_snapshot(row, project_ids, project_titles))


def _audit(
    db,
    *,
    actor: str,
    action: str,
    target: str | None,
    subject: str | None,
    before: dict | None = None,
    after: dict | None = None,
) -> None:
    db.add(
        AuditLogRow(
            ts=_now(),
            actor=actor,
            action=action,
            target=target,
            subject=subject,
            before=before,
            after=after,
        )
    )


def _outbox(db, aggregate_id: str, event_type: str, payload: dict) -> None:
    db.add(
        OutboxEventRow(
            aggregate_type="session",
            aggregate_id=aggregate_id,
            event_type=event_type,
            schema_version=1,
            payload=payload,
            attempts=0,
            created_at=_now(),
        )
    )


def _client_model(db, row: ClientRow) -> Client:
    project_rows = db.execute(
        select(ProjectRow.project_id, ProjectRow.title)
        .join(ClientProjectRow, ClientProjectRow.project_id == ProjectRow.project_id)
        .where(ClientProjectRow.client_id == row.id)
        .order_by(ProjectRow.title)
    ).all()
    projects = []
    all_repositories: set[str] = set()
    for project in project_rows:
        repositories = list(
            db.scalars(
                select(RepositoryRow.full_name)
                .join(
                    ProjectRepositoryRow,
                    ProjectRepositoryRow.repository_id == RepositoryRow.id,
                )
                .where(ProjectRepositoryRow.project_id == project.project_id)
                .order_by(RepositoryRow.full_name)
            ).all()
        )
        all_repositories.update(repositories)
        projects.append(
            ClientProject(
                project_id=project.project_id,
                title=project.title,
                repositories=repositories,
            )
        )
    return Client(
        client_id=row.id,
        name=row.name,
        active=row.active,
        projects=projects,
        repositories=sorted(all_repositories),
    )


def _reporting_values(
    *,
    entry_type: str,
    client_name: str | None,
    project_name: str | None,
    repo: str | None,
    description: str | None,
) -> tuple[str, str | None]:
    complete = bool(
        client_name
        and description
        and ((entry_type == "ops" and repo is None) or (entry_type == "delivery" and project_name))
    )
    label = (
        f"{client_name} — {project_name if entry_type == 'delivery' else 'ops'}"
        if complete
        else None
    )
    return ("complete" if complete else "pending_metadata", label)


def _upsert_repository(db, repo: str, now: datetime) -> RepositoryRow:
    row = db.scalar(select(RepositoryRow).where(RepositoryRow.full_name == repo))
    owner, name = repo.split("/", 1) if "/" in repo else (repo, repo)
    if row is None:
        row = RepositoryRow(
            full_name=repo,
            owner=owner,
            name=name,
            url=f"https://github.com/{repo}" if "/" in repo else None,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.flush()
    return row


def _upsert_issue(db, repository: RepositoryRow, payload: SessionIn, now: datetime) -> IssueRow:
    row = db.scalar(
        select(IssueRow).where(
            IssueRow.repository_id == repository.id,
            IssueRow.issue_number == payload.issue_number,
        )
    )
    if row is None:
        row = IssueRow(
            repository_id=repository.id,
            issue_number=payload.issue_number,
            title=payload.issue_title,
            url=payload.issue_url,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        db.flush()
    else:
        row.title = payload.issue_title or row.title
        row.url = payload.issue_url or row.url
        row.updated_at = now
    return row
