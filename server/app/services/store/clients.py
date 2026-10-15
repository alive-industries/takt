from __future__ import annotations

from sqlalchemy import func, select

from app.db import transaction
from app.db_models import (
    ClientProjectRow,
    ClientRow,
    ProjectRepositoryRow,
    ProjectRow,
    SessionRow,
)
from app.errors import Conflict, InvalidEntry
from app.models import Client, Project

from ._common import (
    _audit,
    _client_model,
    _now,
    _outbox,
    _projects_for_session,
    _reporting_values,
    _session_snapshot,
    _upsert_repository,
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


def map_client_project(client_id: int, project: Project, *, actor: str) -> Client:
    now = _now()
    with transaction() as db:
        client = db.get(ClientRow, client_id)
        if client is None or not client.active:
            raise InvalidEntry("Client not found or inactive.")
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
            raise Conflict("Project is already assigned to another client.")
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
            raise InvalidEntry("Project is not mapped to this client.")
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
