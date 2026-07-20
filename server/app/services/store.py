from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal, cast

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import get_settings
from app.db import transaction
from app.db_models import (
    AuditLogRow,
    ClientProjectRow,
    ClientRow,
    IssueRow,
    MemberRow,
    OrgConfigRow,
    OutboxEventRow,
    ProjectRepositoryRow,
    ProjectRow,
    RepositoryRow,
    SessionProjectRow,
    SessionRow,
)
from app.errors import AdminRequired, NotAuthorised
from app.models import (
    Client,
    ClientProject,
    Member,
    OrgConfig,
    OrgConfigUpdate,
    Project,
    SessionIn,
    SessionOut,
    SessionUpdate,
)


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


def _session_snapshot(row: SessionRow, project_ids: list[str], project_titles: list[str]) -> dict:
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
    return [r.project_id for r in rows], [r.title for r in rows]


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


def get_member(login: str, github_user_id: int | None = None) -> Member | None:
    with transaction() as db:
        row = None
        if github_user_id is not None:
            row = db.scalar(select(MemberRow).where(MemberRow.github_user_id == github_user_id))
        if row is None:
            row = db.scalar(
                select(MemberRow).where(func.lower(MemberRow.github_login) == login.lower())
            )
        if row and github_user_id is not None:
            row.github_login = login
            row.github_user_id = github_user_id
            row.updated_at = _now()
        return _member_model(row) if row else None


def list_members() -> list[Member]:
    with transaction() as db:
        rows = db.scalars(select(MemberRow).order_by(MemberRow.added_at.desc())).all()
        return [_member_model(row) for row in rows]


def upsert_member(member: Member, *, actor: str | None = None) -> Member:
    now = _now()
    with transaction() as db:
        row = db.scalar(
            select(MemberRow).where(
                func.lower(MemberRow.github_login) == member.github_login.lower()
            )
        )
        before = _member_model(row).model_dump(mode="json") if row else None
        if row is None:
            row = MemberRow(
                github_login=member.github_login,
                github_user_id=member.github_user_id,
                role=member.role,
                status=member.status,
                source=member.source,
                added_by=member.added_by,
                added_at=member.added_at or now,
                updated_at=now,
            )
            db.add(row)
        else:
            row.github_user_id = member.github_user_id or row.github_user_id
            row.github_login = member.github_login
            row.role = member.role
            row.status = member.status
            row.source = member.source
            row.updated_at = now
        db.flush()
        result = _member_model(row)
        if actor:
            _audit(
                db,
                actor=actor,
                action="member.upsert",
                target=row.github_login,
                subject=row.github_login,
                before=before,
                after=result.model_dump(mode="json"),
            )
        return result


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


def list_clients() -> list[Client]:
    with transaction() as db:
        rows = db.scalars(
            select(ClientRow).where(ClientRow.active.is_(True)).order_by(ClientRow.name)
        ).all()
        return [_client_model(db, row) for row in rows]


def create_client(name: str, *, actor: str) -> Client:
    clean_name = name.strip()
    now = _now()
    with transaction() as db:
        row = db.scalar(select(ClientRow).where(func.lower(ClientRow.name) == clean_name.lower()))
        if row is None:
            row = ClientRow(name=clean_name, active=True, created_at=now, updated_at=now)
            db.add(row)
            db.flush()
            _audit(
                db,
                actor=actor,
                action="client.create",
                target=str(row.id),
                subject=None,
                after={"client_id": row.id, "name": row.name},
            )
        return _client_model(db, row)


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


def map_client_project(client_id: int, project: Project, *, actor: str) -> Client:
    now = _now()
    with transaction() as db:
        client = db.get(ClientRow, client_id)
        if client is None or not client.active:
            raise NotAuthorised("Client not found or inactive.")
        project_row = db.get(ProjectRow, project.project_id)
        if project_row is None:
            project_row = ProjectRow(
                project_id=project.project_id,
                title=project.title,
                org=project.org,
                updated_at=now,
            )
            db.add(project_row)
        else:
            project_row.title = project.title
            project_row.org = project.org or project_row.org
            project_row.updated_at = now
        mapping = db.get(ClientProjectRow, project.project_id)
        previous_client_id = mapping.client_id if mapping else None
        if mapping is None:
            db.add(
                ClientProjectRow(
                    project_id=project.project_id,
                    client_id=client.id,
                    created_at=now,
                )
            )
        elif mapping.client_id != client.id:
            raise NotAuthorised("Project is already assigned to another client.")
        _audit(
            db,
            actor=actor,
            action="client.project.map",
            target=project.project_id,
            subject=str(client.id),
            before={"client_id": previous_client_id},
            after={"client_id": client.id},
        )
        db.flush()
        return _client_model(db, client)


def map_project_repository(client_id: int, project_id: str, repo: str, *, actor: str) -> Client:
    now = _now()
    with transaction() as db:
        client = db.get(ClientRow, client_id)
        project_mapping = db.get(ClientProjectRow, project_id)
        if client is None or project_mapping is None or project_mapping.client_id != client.id:
            raise NotAuthorised("Project is not mapped to this client.")
        repository = _upsert_repository(db, repo, now)
        link = db.get(ProjectRepositoryRow, (project_id, repository.id))
        if link is None:
            db.add(
                ProjectRepositoryRow(
                    project_id=project_id,
                    repository_id=repository.id,
                    created_at=now,
                )
            )
        sessions = db.scalars(
            select(SessionRow).where(
                SessionRow.repository_id == repository.id,
                SessionRow.reporting_project_id == project_id,
            )
        ).all()
        for session in sessions:
            session.client_id = client.id
            session.client_name = client.name
            session.reporting_status, session.label = _reporting_values(
                entry_type=session.entry_type,
                client_name=client.name,
                project_name=session.project_name,
                repo=session.repo,
                description=session.description,
            )
            session.updated_at = now
            if session.reporting_status == "complete":
                project_ids, project_titles = _projects_for_session(db, session.session_id)
                _outbox(
                    db,
                    session.session_id,
                    "upsert",
                    _session_snapshot(session, project_ids, project_titles),
                )
        _audit(
            db,
            actor=actor,
            action="project.repository.map",
            target=repo,
            subject=project_id,
            after={"client_id": client.id, "project_id": project_id},
        )
        db.flush()
        return _client_model(db, client)


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
            raise NotAuthorised("The selected member is not active.")

        existing = db.get(SessionRow, payload.session_id)
        if existing:
            if existing.member_id != target.id:
                raise NotAuthorised("Session ID is already assigned to another member.")
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
            raise NotAuthorised("Project is mapped to a different client.")
        if payload.entry_type == "delivery":
            client = mapped_client
        if client is not None and not client.active:
            raise NotAuthorised("The selected client is inactive.")

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
                raise NotAuthorised("Session ID is already assigned to another member.")
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
                raise NotAuthorised("The selected client is inactive.")
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
                SessionRow.repo == repo,
                SessionRow.issue_number == issue_number,
                SessionRow.deleted_at.is_(None),
            )
        )
        return float(total or 0) / 3_600_000


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
        return [Project(project_id=r.project_id, title=r.title, org=r.org) for r in rows]


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
