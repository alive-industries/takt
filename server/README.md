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

## Project renames (lookup table)

Sessions reference projects by stable node id (`project_ids`). The
`projects` lookup table holds the current title for each id — a rename is
a single-row UPDATE there, and every session that references the id
instantly reflects the new name on the next read. The extension upserts
project rows automatically on STOP.

To manually refresh the lookup table (e.g. after a batch of renames):

```bash
cd server
# Dry-run first — shows what would change without writing:
uv run python scripts/sync_projects.py --pat <github-pat> --dry-run

# Apply:
uv run python scripts/sync_projects.py --pat <github-pat>
```

The PAT needs `project` and `read:org` scope. The script fetches all org
projects from GitHub and upserts them into the lookup table. Idempotent —
only inserts/updates rows where the title changed.

## Iteration hours analytics

The iteration snapshot reads every Projects v2 iteration field, including completed
iterations and closed projects, from `TAKT_GITHUB_ORG`. PostgreSQL org config controls
excluded project ids and the NUMBER field used for hours (per-project override,
then default field name). Missing hours remain NULL; all number values are retained
as JSON. Items without iteration assignments are not exported.

```bash
cd server
uv run python scripts/sync_iterations.py --dry-run
uv run python scripts/sync_iterations.py
```

Set `TAKT_GITHUB_PAT` or pass `--pat`. Scopes: `read:project` and `read:org`, plus
`repo` for private issue content. `-v` enables verbose logging. Dry-run fetches
GitHub and reads org config but prints counts and sample rows without touching BQ.

Apply `infra/bigquery/schema.sql` (substitute `__TAKT_DS__`) before the first sync.
The `iterations` and `iteration_items` snapshots are replaced together in a BQ
transaction only after the entire GitHub fetch and staging loads succeed. Empty
snapshots clear stale rows. Iteration end dates are inclusive (start + duration - 1).
The `iteration_hours` view reports GitHub item hours, lifetime Takt hours, and Takt
hours completed within the iteration dates (UTC). Issue identities are deduplicated
within each project/field/iteration before joining sessions; an issue deliberately
assigned to different iterations contributes to each, so totals across iterations
are not additive.

Cloud Build deploys `_ITERATIONS_JOB` (default `takt-sync-iterations`) with Cloud SQL
access and `TAKT_GITHUB_PAT` from `_GITHUB_PAT_SECRET` (default `takt-github-pat`).
Provision that secret and grant the runtime service account Secret Manager access.
Run `bash server/scripts/schedule_iterations.sh` to create/update the hourly
scheduler; use `ITERATIONS_JOB=takt-test-sync-iterations` for the test job. Scheduler
uses the same `GCP_PROJECT`, `REGION`, `SA_EMAIL`, and `SCHEDULER_JOB` overrides as
the export scheduler. The scheduler identity needs Cloud Run invoker access.

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
| GET    | `/v1/projects`      | any member   | List all known projects (current titles)       |
| POST   | `/v1/projects/sync` | any member   | Batch upsert projects (id + title)             |

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
