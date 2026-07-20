from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.auth import Caller, get_caller
from app.db import transaction
from app.db_models import AuditLogRow, OutboxEventRow
from app.main import app
from app.models import GitHubUser, Member
from app.services import store


def _member(login: str, user_id: int, role: Literal["admin", "member"] = "member") -> Member:
    return store.upsert_member(
        Member(
            github_login=login,
            github_user_id=user_id,
            role=role,
            status="active",
            source="manual",
            added_by="test",
            added_at=datetime.now(UTC),
        )
    )


def _caller(login: str, user_id: int, role: Literal["admin", "member"] = "member") -> Caller:
    member = _member(login, user_id, role)
    return Caller(pat="test", user=GitHubUser(login=login, id=user_id), member=member)


def _payload(session_id: str, **overrides) -> dict:
    completed = datetime.now(UTC)
    payload = {
        "session_id": session_id,
        "context_type": "issue",
        "repo": "alive-industries/takt",
        "issue_number": 42,
        "issue_title": "Transactional persistence",
        "issue_url": "https://github.com/alive-industries/takt/issues/42",
        "started_at": (completed - timedelta(hours=1)).isoformat(),
        "completed_at": completed.isoformat(),
        "duration_ms": 3_600_000,
        "duration_hours": 1,
        "project_ids": ["P_test"],
        "project_titles": ["Test project"],
    }
    payload.update(overrides)
    return payload


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_manual_ops_is_idempotent_and_outboxed(client: TestClient) -> None:
    suffix = uuid4().hex
    caller = _caller(f"member-{suffix}", int(suffix[:10], 16))
    reporting_client = store.create_client(f"Client {suffix}", actor="test")
    app.dependency_overrides[get_caller] = lambda: caller
    session_id = str(uuid4())
    payload = _payload(
        session_id,
        source="manual",
        type="ops",
        client_id=reporting_client.client_id,
        repo=None,
        issue_number=0,
        issue_title=None,
        issue_url=None,
        description="Weekly planning",
        project_ids=[],
        project_titles=[],
    )

    first = client.post("/v1/sessions", json=payload)
    second = client.post("/v1/sessions", json=payload)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["source"] == "manual"
    assert first.json()["type"] == "ops"
    assert first.json()["repo"] is None
    assert first.json()["label"] == f"Client {suffix} — ops"
    assert first.json()["github_user"] == caller.user.login
    with transaction() as db:
        outbox_count = db.scalar(
            select(func.count())
            .select_from(OutboxEventRow)
            .where(
                OutboxEventRow.aggregate_id == session_id,
            )
        )
    assert outbox_count == 1


def test_manual_delivery_uses_client_mapping_and_reporting_project(
    client: TestClient,
) -> None:
    suffix = uuid4().hex
    admin = _caller(f"admin-{suffix}", int(suffix[:10], 16), "admin")
    app.dependency_overrides[get_caller] = lambda: admin
    reporting_client = client.post("/v1/clients", json={"name": f"Beagle {suffix}"}).json()
    repo = f"alive-industries/repo-{suffix}"
    project_id = f"P_delivery_{suffix}"
    mapped_project = client.post(
        f"/v1/clients/{reporting_client['client_id']}/projects",
        json={"project_id": project_id, "title": "Q3 stabilisation"},
    )
    assert mapped_project.status_code == 200
    mapped = client.post(
        f"/v1/clients/{reporting_client['client_id']}/projects/{project_id}/repositories",
        json={"repo": repo},
    )
    assert mapped.status_code == 200

    response = client.post(
        "/v1/sessions",
        json=_payload(
            str(uuid4()),
            source="manual",
            type="delivery",
            client_id=reporting_client["client_id"],
            repo=repo,
            reporting_project_id=project_id,
            project="Q3 stabilisation",
            description="Delivery work",
            project_ids=[project_id],
            project_titles=["Q3 stabilisation"],
        ),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["type"] == "delivery"
    assert body["reporting_status"] == "complete"
    assert body["label"] == f"Beagle {suffix} — Q3 stabilisation"
    assert body["duration_hours_exact"] == 1
    assert body["duration_hours"] == 1


def test_manual_delivery_can_be_project_only(client: TestClient) -> None:
    suffix = uuid4().hex
    admin = _caller(f"admin-{suffix}", int(suffix[:10], 16), "admin")
    app.dependency_overrides[get_caller] = lambda: admin
    reporting_client = client.post("/v1/clients", json={"name": f"Project-only {suffix}"}).json()
    project_id = f"P_non_code_{suffix}"
    assert (
        client.post(
            f"/v1/clients/{reporting_client['client_id']}/projects",
            json={"project_id": project_id, "title": "Research and planning"},
        ).status_code
        == 200
    )

    response = client.post(
        "/v1/sessions",
        json=_payload(
            str(uuid4()),
            source="manual",
            type="delivery",
            client_id=reporting_client["client_id"],
            repo=None,
            issue_number=0,
            issue_title=None,
            issue_url=None,
            reporting_project_id=project_id,
            project="Research and planning",
            description="Workshop preparation",
            project_ids=[project_id],
            project_titles=["Research and planning"],
        ),
    )

    assert response.status_code == 201
    body = response.json()
    assert body["reporting_status"] == "complete"
    assert body["repo"] is None
    assert body["label"] == f"Project-only {suffix} — Research and planning"


def test_repository_mapping_backfills_pending_github_entry(client: TestClient) -> None:
    suffix = uuid4().hex
    admin = _caller(f"admin-{suffix}", int(suffix[:10], 16), "admin")
    app.dependency_overrides[get_caller] = lambda: admin
    repo = f"alive-industries/unmapped-{suffix}"
    project_id = f"P_github_{suffix}"
    session_id = str(uuid4())
    created = client.post(
        "/v1/sessions",
        json=_payload(
            session_id,
            source="github",
            type="delivery",
            repo=repo,
            reporting_project_id=project_id,
            project="GitHub project",
            description="GitHub issue",
            source_url=f"https://github.com/{repo}/issues/42",
            github_metadata={"schema_version": 1, "issue_number": 42},
        ),
    )
    assert created.status_code == 201
    assert created.json()["reporting_status"] == "pending_metadata"

    reporting_client = client.post("/v1/clients", json={"name": f"Client {suffix}"}).json()
    mapped_project = client.post(
        f"/v1/clients/{reporting_client['client_id']}/projects",
        json={"project_id": project_id, "title": "GitHub project"},
    )
    assert mapped_project.status_code == 200
    mapped = client.post(
        f"/v1/clients/{reporting_client['client_id']}/projects/{project_id}/repositories",
        json={"repo": repo},
    )
    assert mapped.status_code == 200
    listed = client.get("/v1/sessions").json()
    session = next(row for row in listed if row["session_id"] == session_id)
    assert session["reporting_status"] == "complete"
    assert session["label"] == f"Client {suffix} — GitHub project"


def test_admin_can_create_for_active_member(client: TestClient) -> None:
    suffix = uuid4().hex
    admin = _caller(f"admin-{suffix}", int(suffix[:10], 16), "admin")
    target = _member(f"target-{suffix}", int(suffix[10:20], 16))
    app.dependency_overrides[get_caller] = lambda: admin
    session_id = str(uuid4())

    response = client.post(
        "/v1/sessions",
        json=_payload(session_id, member_login=target.github_login),
    )

    assert response.status_code == 201
    assert response.json()["github_user"] == target.github_login
    assert response.json()["created_by_user"] == admin.user.login
    with transaction() as db:
        audit = db.scalar(
            select(AuditLogRow).where(
                AuditLogRow.target == session_id,
                AuditLogRow.action == "session.create",
            )
        )
    assert audit is not None
    assert audit.actor == admin.user.login
    assert audit.subject == target.github_login


def test_member_cannot_create_for_another_member(client: TestClient) -> None:
    suffix = uuid4().hex
    caller = _caller(f"member-{suffix}", int(suffix[:10], 16))
    target = _member(f"target-{suffix}", int(suffix[10:20], 16))
    app.dependency_overrides[get_caller] = lambda: caller

    response = client.post(
        "/v1/sessions",
        json=_payload(str(uuid4()), member_login=target.github_login),
    )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "admin_required"


def test_session_id_cannot_be_reused_for_another_member(client: TestClient) -> None:
    suffix = uuid4().hex
    owner = _caller(f"owner-{suffix}", int(suffix[:10], 16))
    other = _caller(f"other-{suffix}", int(suffix[10:20], 16))
    session_id = str(uuid4())
    app.dependency_overrides[get_caller] = lambda: owner
    assert client.post("/v1/sessions", json=_payload(session_id)).status_code == 201

    app.dependency_overrides[get_caller] = lambda: other
    response = client.post("/v1/sessions", json=_payload(session_id))
    assert response.status_code == 403


def test_sessions_follow_stable_member_id_after_login_rename(client: TestClient) -> None:
    suffix = uuid4().hex
    user_id = int(suffix[:10], 16)
    old_login = f"old-{suffix}"
    new_login = f"new-{suffix}"
    caller = _caller(old_login, user_id)
    app.dependency_overrides[get_caller] = lambda: caller
    session_id = str(uuid4())
    assert client.post("/v1/sessions", json=_payload(session_id)).status_code == 201

    renamed = store.get_member(new_login, user_id)
    assert renamed is not None
    renamed_caller = Caller(
        pat="test", user=GitHubUser(login=new_login, id=user_id), member=renamed
    )
    app.dependency_overrides[get_caller] = lambda: renamed_caller
    response = client.get("/v1/sessions")
    assert response.status_code == 200
    assert session_id in {session["session_id"] for session in response.json()}


def test_owner_update_delete_and_issue_total(client: TestClient) -> None:
    suffix = uuid4().hex
    caller = _caller(f"member-{suffix}", int(suffix[:10], 16))
    app.dependency_overrides[get_caller] = lambda: caller
    session_id = str(uuid4())
    repo = f"alive-industries/repo-{suffix}"
    created = client.post("/v1/sessions", json=_payload(session_id, repo=repo))
    assert created.status_code == 201

    updated = client.put(f"/v1/sessions/{session_id}", json={"duration_ms": 1_800_000})
    assert updated.status_code == 200
    assert updated.json()["duration_ms"] == 1_800_000
    assert client.get(f"/v1/sessions/totals?repo={repo}&issue=42").json()["total_hours"] == 0.5

    deleted = client.delete(f"/v1/sessions/{session_id}")
    assert deleted.status_code == 204
    assert client.get(f"/v1/sessions/totals?repo={repo}&issue=42").json()["total_hours"] == 0
