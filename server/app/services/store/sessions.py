from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db import transaction
from app.db_models import (
    ClientProjectRow,
    ClientRow,
    IssueRow,
    MemberRow,
    ProjectRepositoryRow,
    ProjectRow,
    SessionProjectRow,
    SessionRow,
)
from app.errors import AdminRequired, Conflict, InvalidEntry, NotAuthorised
from app.models import SessionIn, SessionOut, SessionUpdate

from ._common import (
    _audit,
    _now,
    _outbox,
    _projects_for_session,
    _reporting_values,
    _session_out,
    _session_snapshot,
    _upsert_issue,
    _upsert_repository,
)


def create_session(payload: SessionIn, *, caller_login: str, is_admin: bool) -> SessionOut:
    now = _now()
    with transaction() as db:
        caller = db.scalar(
            select(MemberRow).where(func.lower(MemberRow.github_login) == caller_login.lower())
        )
        if caller is None:
            raise NotAuthorised()
        if payload.member_login and not is_admin:
            raise AdminRequired("Only admins can use member_login.")
        target_login = payload.member_login or caller_login
        target = db.scalar(
            select(MemberRow).where(func.lower(MemberRow.github_login) == target_login.lower())
        )
        if target is None or target.status != "active":
            raise InvalidEntry("The selected member is not active.")

        existing = db.get(SessionRow, payload.session_id)
        if existing:
            if existing.member_id != target.id:
                raise Conflict("Session ID is already assigned to another member.")
            return _session_out(db, existing)

        repository = _upsert_repository(db, payload.repo, now) if payload.repo else None
        issue = (
            _upsert_issue(db, repository, payload, now)
            if repository and payload.issue_number > 0
            else None
        )
        assert payload.source is not None and payload.entry_type is not None
        client = db.get(ClientRow, payload.client_id) if payload.client_id else None
        mapped_client = None
        if payload.reporting_project_id:
            project_mapping = db.get(ClientProjectRow, payload.reporting_project_id)
            if project_mapping:
                mapped_client = db.get(ClientRow, project_mapping.client_id)
            if repository:
                repo_mapping = db.get(
                    ProjectRepositoryRow,
                    (payload.reporting_project_id, repository.id),
                )
                if repo_mapping is None:
                    mapped_client = None
        if client and mapped_client and client.id != mapped_client.id:
            raise Conflict("Project is mapped to a different client.")
        if payload.entry_type == "delivery":
            client = mapped_client
        if client is not None and not client.active:
            raise InvalidEntry("The selected client is inactive.")

        exact = payload.duration_ms / 3_600_000
        rounded = round(exact * 4) / 4
        reporting_status, label = _reporting_values(
            entry_type=payload.entry_type,
            client_name=client.name if client else None,
            project_name=payload.project,
            repo=payload.repo,
            description=payload.description,
        )
        values = {
            "session_id": payload.session_id,
            "member_id": target.id,
            "created_by_member_id": caller.id,
            "github_user": target.github_login,
            "github_user_id": target.github_user_id,
            "created_by_user": caller.github_login,
            "source": payload.source,
            "entry_type": payload.entry_type,
            "reporting_status": reporting_status,
            "client_id": client.id if client else None,
            "client_name": client.name if client else None,
            "reporting_project_id": payload.reporting_project_id,
            "project_name": payload.project,
            "description": payload.description,
            "label": label,
            "github_metadata": payload.github_metadata,
            "duration_hours_exact": exact,
            "context_type": "issue"
            if payload.issue_number > 0
            else ("repository" if payload.repo else None),
            "repository_id": repository.id if repository else None,
            "issue_id": issue.id if issue else None,
            "repo": payload.repo,
            "issue_number": payload.issue_number,
            "issue_title": payload.issue_title,
            "issue_url": payload.issue_url,
            "category": None,
            "category_title": None,
            "started_at": payload.started_at,
            "completed_at": payload.completed_at,
            "duration_ms": payload.duration_ms,
            "duration_hours": rounded,
            "source_url": payload.source_url,
            "synced_to_project": bool(payload.project_ids),
            "takt_version": payload.takt_version,
            "client_ts": payload.client_ts,
            "inserted_at": now,
            "updated_at": now,
        }
        inserted = db.scalar(
            pg_insert(SessionRow)
            .values(**values)
            .on_conflict_do_nothing(index_elements=[SessionRow.session_id])
            .returning(SessionRow.session_id)
        )
        row = db.get(SessionRow, payload.session_id)
        assert row is not None
        if inserted is None:
            if row.member_id != target.id:
                raise Conflict("Session ID is already assigned to another member.")
            return _session_out(db, row)

        for index, project_id in enumerate(payload.project_ids):
            if not project_id:
                continue
            project = db.get(ProjectRow, project_id)
            supplied_title = (
                payload.project_titles[index] if index < len(payload.project_titles) else None
            )
            title = supplied_title or (project.title if project else project_id)
            if project is None:
                db.add(ProjectRow(project_id=project_id, title=title, updated_at=now))
            elif supplied_title:
                project.title = supplied_title
                project.updated_at = now
            db.add(
                SessionProjectRow(
                    session_id=row.session_id,
                    project_id=project_id,
                    project_title_snapshot=title,
                )
            )
        db.flush()
        result = _session_out(db, row)
        snapshot = result.model_dump(mode="json", exclude={"deleted"})
        _audit(
            db,
            actor=caller.github_login,
            action="session.create",
            target=row.session_id,
            subject=target.github_login,
            after=snapshot,
        )
        if row.reporting_status == "complete":
            _outbox(db, row.session_id, "upsert", snapshot)
        return result


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
    with transaction() as db:
        query = select(SessionRow)
        if not include_deleted:
            query = query.where(SessionRow.deleted_at.is_(None))
        if not is_admin:
            caller = db.scalar(
                select(MemberRow).where(func.lower(MemberRow.github_login) == caller_login.lower())
            )
            query = query.where(SessionRow.member_id == (caller.id if caller else -1))
        elif user_filter:
            target = db.scalar(
                select(MemberRow).where(func.lower(MemberRow.github_login) == user_filter.lower())
            )
            query = query.where(SessionRow.member_id == (target.id if target else -1))
        if repo:
            query = query.where(SessionRow.repo == repo)
        if from_ts:
            query = query.where(SessionRow.completed_at >= from_ts)
        if to_ts:
            query = query.where(SessionRow.completed_at < to_ts)
        rows = db.scalars(query.order_by(SessionRow.completed_at.desc()).limit(limit)).all()
        return [_session_out(db, row) for row in rows]


def _permitted_session(
    db, session_id: str, caller_login: str, is_admin: bool, include_deleted: bool = False
) -> SessionRow | None:
    query = select(SessionRow).where(SessionRow.session_id == session_id)
    if not include_deleted:
        query = query.where(SessionRow.deleted_at.is_(None))
    if not is_admin:
        caller = db.scalar(
            select(MemberRow).where(func.lower(MemberRow.github_login) == caller_login.lower())
        )
        query = query.where(SessionRow.member_id == (caller.id if caller else -1))
    return db.scalar(query)


def update_session(
    session_id: str, update: SessionUpdate, *, caller_login: str, is_admin: bool
) -> SessionOut | None:
    with transaction() as db:
        row = _permitted_session(db, session_id, caller_login, is_admin)
        if row is None:
            return None
        project_ids, project_titles = _projects_for_session(db, session_id)
        before = _session_snapshot(row, project_ids, project_titles)
        if update.duration_ms is not None:
            row.duration_ms = update.duration_ms
            row.duration_hours_exact = update.duration_ms / 3_600_000
            row.duration_hours = round(row.duration_hours_exact * 4) / 4
            row.started_at = row.completed_at - timedelta(milliseconds=update.duration_ms)
        if update.issue_title is not None:
            row.issue_title = update.issue_title
            if row.issue_id:
                issue = db.get(IssueRow, row.issue_id)
                if issue:
                    issue.title = update.issue_title
                    issue.updated_at = _now()
        if update.client_id is not None:
            client = db.get(ClientRow, update.client_id)
            if client is None or not client.active:
                raise InvalidEntry("The selected client is inactive.")
            row.client_id = client.id
            row.client_name = client.name
        if update.reporting_project_id is not None:
            row.reporting_project_id = update.reporting_project_id
        if update.project is not None:
            row.project_name = update.project
        if update.description is not None:
            row.description = update.description
        row.reporting_status, row.label = _reporting_values(
            entry_type=row.entry_type,
            client_name=row.client_name,
            project_name=row.project_name,
            repo=row.repo,
            description=row.description,
        )
        actor = db.scalar(
            select(MemberRow).where(func.lower(MemberRow.github_login) == caller_login.lower())
        )
        row.updated_by_member_id = actor.id if actor else None
        row.updated_at = _now()
        db.flush()
        result = _session_out(db, row)
        after = result.model_dump(mode="json", exclude={"deleted"})
        _audit(
            db,
            actor=caller_login,
            action="session.update",
            target=session_id,
            subject=row.github_user,
            before=before,
            after=after,
        )
        if row.reporting_status == "complete":
            _outbox(db, session_id, "upsert", after)
        return result


def soft_delete_session(session_id: str, *, caller_login: str, is_admin: bool) -> bool:
    with transaction() as db:
        row = _permitted_session(db, session_id, caller_login, is_admin)
        if row is None:
            return False
        project_ids, project_titles = _projects_for_session(db, session_id)
        before = _session_snapshot(row, project_ids, project_titles)
        actor = db.scalar(
            select(MemberRow).where(func.lower(MemberRow.github_login) == caller_login.lower())
        )
        deleted_at = _now()
        row.deleted_at = deleted_at
        row.deleted_by_member_id = actor.id if actor else None
        row.updated_at = deleted_at
        db.flush()
        after = _session_snapshot(row, project_ids, project_titles)
        _audit(
            db,
            actor=caller_login,
            action="session.delete",
            target=session_id,
            subject=row.github_user,
            before=before,
            after=after,
        )
        _outbox(db, session_id, "delete", after)
        return True


def total_hours_for_issue(repo: str, issue_number: int) -> float:
    if issue_number <= 0:
        return 0.0
    with transaction() as db:
        total = db.scalar(
            select(func.coalesce(func.sum(SessionRow.duration_ms), 0)).where(
                func.lower(SessionRow.repo) == repo.lower(),
                SessionRow.issue_number == issue_number,
                SessionRow.deleted_at.is_(None),
            )
        )
        return float(total or 0) / 3_600_000
