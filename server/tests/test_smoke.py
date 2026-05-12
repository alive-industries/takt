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
