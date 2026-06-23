# Takt API

Tiny FastAPI service that fronts BigQuery for the Takt Chrome extension.
Verifies a GitHub PAT on every request, enforces an allowlist of approved
members, and writes time-tracking sessions to BigQuery.

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
    services/
      github.py         # PAT -> user, org-membership check (cached)
      bq.py             # Thin BigQuery layer
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

| Method | Path                | Who          | Purpose                                        |
|--------|---------------------|--------------|------------------------------------------------|
| GET    | `/health`           | public       | Liveness                                       |
| GET    | `/v1/me`            | any member   | Identity + role + status                       |
| POST   | `/v1/sessions`      | any member   | Insert one session (idempotent on session_id)  |
| GET    | `/v1/sessions`      | any member   | List own; admins can `?user=`                  |
| GET    | `/v1/sessions/totals` | any member | Sum of non-deleted hours for repo+issue        |
| PUT    | `/v1/sessions/:id`  | owner/admin  | Patch duration / issue_title                   |
| DELETE | `/v1/sessions/:id`  | owner/admin  | Soft-delete (sets `deleted_at`)                |
| GET    | `/v1/config`        | any member   | Read org config                                |
| PUT    | `/v1/config`        | admin        | Update org config                              |
| GET    | `/v1/members`       | admin        | List members                                   |
| POST   | `/v1/members`       | admin        | Add / promote / revoke                         |

All authenticated requests use `Authorization: Bearer <github-pat>`.

### `GET /v1/sessions`

Query params (all optional):

| Param           | Type      | Default | Notes                                              |
|-----------------|-----------|---------|----------------------------------------------------|
| `user`          | string    | —       | Admin-only filter by GitHub login.                 |
| `repo`          | string    | —       | Filter by `owner/name`.                            |
| `from`          | datetime  | —       | `completed_at >= from` (ISO 8601).                 |
| `to`            | datetime  | —       | `completed_at < to` (ISO 8601).                    |
| `limit`         | int       | 500     | Max 5000.                                          |
| `include_deleted` | bool    | false   | Include soft-deleted sessions in the response.     |

By default only active (`deleted_at IS NULL`) sessions are returned. Pass
`include_deleted=true` to also receive soft-deleted sessions. Each session
object includes two deletion fields:

- `deleted` (bool) — `true` when the session has been soft-deleted.
- `deleted_at` (datetime \| null) — ISO 8601 timestamp of the soft-delete, or `null` for active sessions. Format matches `started_at`, `completed_at`, `inserted_at`.

This lets the extension reconcile its local cache when a session is deleted by
a peer or admin: list with `include_deleted=true`, then drop or mark any cached
row whose `deleted` is `true`.

## Auth flow per request

1. Bearer PAT extracted from header
2. PAT → `{login, id}` via GitHub `/user` (cached 5 min)
3. Member row looked up in `takt.members`
4. If absent: GitHub `/orgs/alive-industries/members/:login` (needs `read:org` on PAT)
   - If member: auto-insert `role=member, status=active, source=org`
   - Else: 403 `not_authorised`
5. `status=revoked|pending` → 403
6. Admin endpoints additionally require `role=admin`
