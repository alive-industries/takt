# Takt API

Tiny FastAPI service that fronts BigQuery for the Takt Chrome extension.
Verifies a GitHub PAT on every request, enforces an allowlist of approved
members, and writes time-tracking sessions to BigQuery.

## Analytics API

A read-only, API-key-authenticated surface for PMs/dashboards to pull time and
cost data out of BigQuery (Takt sessions + `billing_export`). See
[ANALYTICS_API.md](ANALYTICS_API.md).

## Why a backend?

The extension itself stays buildless and client-side. The backend exists to:

- Hold the only credential that can write to BigQuery (its own service identity)
- Enforce who is allowed to write (admin-managed allowlist + GitHub org membership)
- Dedup writes (`session_id` as `insertId`)
- Centralise org-level config (default Projects field name, per-project overrides)

## Layout

```
server/
  app/
    main.py             # FastAPI factory
    config.py           # env-driven settings
    auth.py             # Caller dependency, admin gate
    models.py           # Pydantic models — wire format & BQ row shape
    errors.py           # Typed HTTP errors
    routes/
      me.py             # GET  /v1/me
      sessions.py       # POST/GET/DELETE /v1/sessions
      admin.py          # /v1/config, /v1/members
      analytics.py      # GET /v1/analytics/* (read-only, key-only — see ANALYTICS_API.md)
    services/
      github.py         # PAT -> user, org-membership check (cached)
      bq.py             # Thin BigQuery layer
      analytics.py      # Read-only analytics queries (time + billing/cost)
  scripts/
    bootstrap.sh        # Create dataset + tables + seed first admin
  tests/
    test_smoke.py       # No-BQ import/auth smoke tests
  Dockerfile
  cloudbuild.yaml
  pyproject.toml
```

Schema DDL lives in `infra/bigquery/schema.sql` (one level up).

## Local dev

Requires `uv` and `gcloud` (logged in as a user with BQ access).

```bash
cd server
cp .env.example .env
uv sync
uv run uvicorn app.main:app --reload
```

The service uses Application Default Credentials, so `gcloud auth application-default login` once.

```bash
# Smoke tests (no BQ required)
uv run pytest

# Lint / format
uv run ruff check .
uv run ruff format .
```

## First-time bootstrap

```bash
ADMIN_LOGIN=harvey-aliveindustries \
GCP_PROJECT=cost-tracker-490815 \
BQ_LOCATION=EU \
./scripts/bootstrap.sh
```

This creates the `takt` dataset, applies the schema, and inserts the first
admin row in `takt.members`.

## Deploying

```bash
gcloud builds submit --config=cloudbuild.yaml
```

Or wire `cloudbuild.yaml` to a Cloud Build trigger on `main` with path filter `server/**`.

The service runs as `takt-api@cost-tracker-490815.iam.gserviceaccount.com`,
which needs:
- `roles/bigquery.dataEditor` on the `takt` dataset
- `roles/bigquery.jobUser` on the project

## API surface

| Method | Path                | Who          | Purpose                          |
|--------|---------------------|--------------|----------------------------------|
| GET    | `/health`           | public       | Liveness                         |
| GET    | `/v1/me`            | any member   | Identity + role + status         |
| POST   | `/v1/sessions`      | any member   | Insert one session (idempotent)  |
| GET    | `/v1/sessions`      | any member   | List own; admins can `?user=`    |
| DELETE | `/v1/sessions/:id`  | owner/admin  | Soft-delete                      |
| GET    | `/v1/config`        | any member   | Read org config                  |
| PUT    | `/v1/config`        | admin        | Update org config                |
| GET    | `/v1/members`       | admin        | List members                     |
| POST   | `/v1/members`       | admin        | Add / promote / revoke           |

All authenticated requests use `Authorization: Bearer <github-pat>`.

## Auth flow per request

1. Bearer PAT extracted from header
2. PAT → `{login, id}` via GitHub `/user` (cached 5 min)
3. Member row looked up in `takt.members`
4. If absent: GitHub `/orgs/alive-industries/members/:login` (needs `read:org` on PAT)
   - If member: auto-insert `role=member, status=active, source=org`
   - Else: 403 `not_authorised`
5. `status=revoked|pending` → 403
6. Admin endpoints additionally require `role=admin`
