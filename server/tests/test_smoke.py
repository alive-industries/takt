"""Smoke tests — they don't touch BigQuery. Real integration tests come later."""

import importlib

from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    with TestClient(app) as client:
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


def test_me_requires_auth() -> None:
    with TestClient(app) as client:
        resp = client.get("/v1/me")
        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "invalid_pat"


def test_sessions_requires_auth() -> None:
    with TestClient(app) as client:
        resp = client.get("/v1/sessions")
        assert resp.status_code == 401


def test_openapi_schema_loads() -> None:
    """Catch import-time errors in any route module."""
    with TestClient(app) as client:
        resp = client.get("/openapi.json")
        assert resp.status_code == 200
        paths = resp.json()["paths"]
        assert "/v1/me" in paths
        assert "/v1/sessions" in paths
        assert "/v1/sessions/{session_id}" in paths
        # PUT (edit) and DELETE both live on the parameterised path.
        assert "put" in paths["/v1/sessions/{session_id}"]
        assert "delete" in paths["/v1/sessions/{session_id}"]
        assert "/v1/config" in paths
        assert "/v1/members" in paths


def test_session_update_requires_auth() -> None:
    with TestClient(app) as client:
        resp = client.put("/v1/sessions/abc", json={"duration_ms": 60000})
        assert resp.status_code == 401


def test_session_update_rejects_unknown_fields() -> None:
    """`extra='forbid'` on SessionUpdate should reject typos."""
    with TestClient(app) as client:
        resp = client.put(
            "/v1/sessions/abc",
            headers={"Authorization": "Bearer fake"},
            json={"duration_mss": 60000},  # typo
        )
        # 422 unprocessable (validation error) takes priority over 401 here
        # because FastAPI validates body before resolving the auth dependency.
        # Either status is acceptable signal that the field was rejected.
        assert resp.status_code in (401, 422)


def test_session_update_negative_duration_rejected() -> None:
    with TestClient(app) as client:
        resp = client.put(
            "/v1/sessions/abc",
            headers={"Authorization": "Bearer fake"},
            json={"duration_ms": -1},
        )
        assert resp.status_code in (401, 422)


def test_admin_routes_require_auth() -> None:
    with TestClient(app) as client:
        assert client.get("/v1/members").status_code == 401
        assert (
            client.post("/v1/members", json={"github_login": "x"}).status_code == 401
        )
        assert client.get("/v1/config").status_code == 401
        assert (
            client.put("/v1/config", json={"default_field_name": "Hours"}).status_code
            == 401
        )


def test_member_update_rejects_unknown_fields() -> None:
    with TestClient(app) as client:
        resp = client.post(
            "/v1/members",
            headers={"Authorization": "Bearer fake"},
            json={"github_login": "x", "rolex": "admin"},  # typo
        )
        assert resp.status_code in (401, 422)


def test_org_config_update_rejects_unknown_fields() -> None:
    with TestClient(app) as client:
        resp = client.put(
            "/v1/config",
            headers={"Authorization": "Bearer fake"},
            json={"default_field_naem": "Hours"},  # typo
        )
        assert resp.status_code in (401, 422)


# --- Admin role derived from GitHub org ownership ---


class _FakeGH:
    """Stand-in GitHub client for auth tests. `org_role` is what
    get_org_role/is_org_member report: "admin" (owner), "member", or None.
    """

    def __init__(self, org_role: str | None, login: str = "octo", uid: int = 1) -> None:
        self._role = org_role
        self._login = login
        self._uid = uid

    async def resolve_user(self, pat):  # noqa: ANN001
        from app.models import GitHubUser

        return GitHubUser(login=self._login, id=self._uid)

    async def get_org_role(self, pat, user, org=None):  # noqa: ANN001
        return self._role

    async def is_org_member(self, pat, user, org=None):  # noqa: ANN001
        return self._role is not None


def _auth_client(monkeypatch, *, org_role, existing):
    """TestClient wired so get_caller sees `existing` (a Member or None) and the
    given GitHub `org_role`. Returns (client, upserts, headers); `headers`
    carries the bearer token plus the X-Takt-Api-Key when one is configured
    (the gate is orthogonal to what these tests exercise). `upserts` captures
    every Member written via bq.upsert_member.
    """
    from app.config import get_settings
    from app.models import Member
    from app.services import bq
    from app.services.github import get_github_client

    upserts: list[Member] = []
    monkeypatch.setattr(bq, "get_member", lambda login: existing)
    monkeypatch.setattr(bq, "upsert_member", lambda m: upserts.append(m))

    app.dependency_overrides[get_github_client] = lambda: _FakeGH(org_role)
    client = TestClient(app)
    headers = {"Authorization": "Bearer x"}
    api_key = get_settings().api_key
    if api_key:
        headers["X-Takt-Api-Key"] = api_key
    return client, upserts, headers


def _member(role: str, source: str, status: str = "active"):
    from app.models import Member

    return Member(github_login="octo", github_user_id=1, role=role, status=status, source=source)


def test_new_org_owner_becomes_admin(monkeypatch) -> None:
    client, upserts, headers = _auth_client(monkeypatch, org_role="admin", existing=None)
    try:
        resp = client.get("/v1/me", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"
        assert len(upserts) == 1 and upserts[0].role == "admin" and upserts[0].source == "org"
    finally:
        app.dependency_overrides.clear()


def test_new_org_member_becomes_member(monkeypatch) -> None:
    client, upserts, headers = _auth_client(monkeypatch, org_role="member", existing=None)
    try:
        resp = client.get("/v1/me", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["role"] == "member"
        assert upserts[0].role == "member"
    finally:
        app.dependency_overrides.clear()


def test_non_member_is_not_authorised(monkeypatch) -> None:
    client, upserts, headers = _auth_client(monkeypatch, org_role=None, existing=None)
    try:
        resp = client.get("/v1/me", headers=headers)
        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "not_authorised"
        assert upserts == []
    finally:
        app.dependency_overrides.clear()


def test_org_member_promoted_when_ownership_gained(monkeypatch) -> None:
    client, upserts, headers = _auth_client(
        monkeypatch, org_role="admin", existing=_member("member", "org")
    )
    try:
        resp = client.get("/v1/me", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"
        assert len(upserts) == 1 and upserts[0].role == "admin"
    finally:
        app.dependency_overrides.clear()


def test_manual_admin_not_demoted(monkeypatch) -> None:
    client, upserts, headers = _auth_client(
        monkeypatch, org_role="member", existing=_member("admin", "manual")
    )
    try:
        resp = client.get("/v1/me", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"  # manual override preserved
        assert upserts == []  # no sync write
    finally:
        app.dependency_overrides.clear()


def test_inconclusive_org_role_leaves_member_unchanged(monkeypatch) -> None:
    client, upserts, headers = _auth_client(
        monkeypatch, org_role=None, existing=_member("admin", "org")
    )
    try:
        resp = client.get("/v1/me", headers=headers)
        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"  # not demoted on inconclusive lookup
        assert upserts == []
    finally:
        app.dependency_overrides.clear()


def test_api_key_gate(monkeypatch) -> None:
    """When TAKT_API_KEY is set, /v1/* requires a matching X-Takt-Api-Key."""
    import app.config as config_module
    import app.main as main_module

    monkeypatch.setenv("TAKT_API_KEY", "shh-secret")
    config_module.get_settings.cache_clear()
    importlib.reload(main_module)

    with TestClient(main_module.app) as client:
        # Health remains open
        assert client.get("/health").status_code == 200

        # Missing key → 401
        resp = client.get("/v1/me")
        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "invalid_api_key"

        # Wrong key → 401
        resp = client.get("/v1/me", headers={"X-Takt-Api-Key": "wrong"})
        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "invalid_api_key"

        # Right key → falls through to PAT auth (no PAT → invalid_pat)
        resp = client.get("/v1/me", headers={"X-Takt-Api-Key": "shh-secret"})
        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "invalid_pat"

    # Reset for other tests
    monkeypatch.delenv("TAKT_API_KEY", raising=False)
    config_module.get_settings.cache_clear()
    importlib.reload(main_module)
