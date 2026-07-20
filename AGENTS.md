# Takt — Agent notes

Project info and parked work for future agents/sessions.

## Verification

### Server (`server/`)

```bash
docker compose up -d postgres  # host port 55432; does not collide with intel-v1 on 5433
cd server
uv sync
uv run alembic upgrade head
uv run pytest            # uses isolated local `takt_test` database
uv run ruff check .
uv run uvicorn app.main:app --reload
```

PostgreSQL is the transactional source of truth. BigQuery is an hourly analytics
replica populated from `outbox_events` by `scripts/export_bigquery.py`.

### Extension (`extension/`)

No build step. Load `extension/` as unpacked in `chrome://extensions`.
Syntax-check JS without loading:

```bash
node --check extension/background/service-worker.js   # etc.
```

### Project-rename sync (`server/scripts/sync_projects.py`)

Sessions reference projects by stable node id (`project_ids`). The
`projects` lookup table holds the current title for each id. The extension
upserts project rows automatically on STOP. To manually refresh (e.g.
after a batch of renames):

```bash
cd server
uv run python scripts/sync_projects.py --pat <github-pat> --dry-run   # preview
uv run python scripts/sync_projects.py --pat <github-pat>             # apply
```

PAT needs `project` and `read:org` scope. Fetches all org projects from
GitHub and upserts into the lookup table. Idempotent — only inserts/updates
rows where the title changed.

## Deployment

- BQ dataset (prod): `cost-tracker-490815.takt` in `EU` (matches `billing_export`)
- BQ dataset (test): `cost-tracker-490815.takt_test` in `EU` — used by the `takt-api-test` Cloud Run service ONLY. Keep prod/test data separate.
- Analytics replica: `session_facts`; PM-facing view: `time_tracking`; former BQ transactional tables remain migration sources
- Cloud SQL PostgreSQL: one shared `takt-db` instance in `europe-west1`; prod/test use separate databases, users, and URL secrets
- First admin seeded: `harveypitt`
- Cloud Run: `takt-api` (prod) and `takt-api-test` (test) in `europe-west1`
- Cloud Run jobs: Alembic migration and hourly BigQuery outbox export
- Runtime SA: `takt-api@cost-tracker-490815.iam.gserviceaccount.com` (Cloud SQL client, Run invoker, BQ dataset writer/job user)
- Artifact Registry repo: `takt` in `europe-west1`
- PostgreSQL admin seed: `uv run python scripts/bootstrap_postgres.py --admin-login <login>`
- BigQuery analytics bootstrap remains `BQ_DATASET=<dataset> ./server/scripts/bootstrap.sh`

### Prod vs test deploys

`cloudbuild.yaml` defaults to production. A test deployment must override the API,
jobs, dataset, Cloud SQL instance, and database URL secret together:

```bash
# prod
gcloud builds submit --config=server/cloudbuild.yaml .
# test
gcloud builds submit --config=server/cloudbuild.yaml . \
  --substitutions=_SERVICE=takt-api-test,_BQ_DATASET=takt_test,_CLOUD_SQL_INSTANCE=cost-tracker-490815:europe-west1:takt-db,_DB_URL_SECRET=takt-test-database-url,_MIGRATION_JOB=takt-test-migrate,_EXPORT_JOB=takt-test-export-bigquery
```

`schema.sql` uses the `__TAKT_DS__` placeholder for `<project>.<dataset>`; it
must be substituted (bootstrap.sh does this) before applying, so it can target
either dataset.

## Storage architecture (local-first)

The extension is **local-first**: all UI reads come from a normalised in-memory cache (`chrome.storage.local.sessionCache`), and the backend is treated as eventual durable storage.

Layout:
```
sessionCache = {
  byId: { [sessionId]: SessionRecord },  // see local-store.js for shape
  lastSyncAt: number | null,
}
```

Patterns:
- **Reads** (My Time, popup): render from cache instantly → kick off `LIST_BACKEND_SESSIONS` in the background → SW reconciles cache against the server response → re-render silently if changed.
- **Writes** (STOP, UPDATE, DELETE): optimistic cache mutation → push to backend → on success update sync metadata; on failure revert local change. Push failures are also enqueued in `syncQueue` for retry on alarm tick.
- **Reconciliation** (`local-store.js#reconcileWindow`): server response is authoritative for the queried window. Cached entries in that window with no matching server row are dropped (handles peer/admin deletes), **except** entries with `syncStatus !== 'synced'` which are pending local changes.
- **Retention**: cache prunes entries older than 30 days on every write. Filter ranges fully within the cache window render instantly + revalidate; older ranges go straight to backend (no cache).
- **Migration**: `migrateFromCompletedSessions()` folds the legacy `completedSessions[]` array into the new keyed cache on first wake of v0.3.0+, generating stable SHA-256-derived sessionIds for entries pre-v0.2.0.

Why this exists: pre-v0.3.0, every My Time open did a synchronous backend round-trip and felt slow. The cache makes the common path zero-latency while PostgreSQL provides cross-device / cross-user consistency.

## Conventions

- PostgreSQL/BigQuery identifiers use snake_case; extension state uses camelCase; conversion lives in `local-store.js#fromBackendSession` / `local-store.js#toBackendPayload`.
- `session_id` is generated at START time. PostgreSQL inserts use conflict-safe idempotency on `session_id`; legacy local sessions use deterministic SHA-256-derived IDs.
- Times are PostgreSQL `TIMESTAMPTZ` and BigQuery `TIMESTAMP`, serialised as ISO 8601.
- Hours rounded to 0.25 for display/Projects sync; raw `duration_ms` is source of truth.

## PostgreSQL and BigQuery write paths

Interactive creates, edits, deletes, member changes, project metadata, and org config
use PostgreSQL transactions. Session mutations write `audit_log` and `outbox_events`
in the same commit. The extension receives success only after that commit.

All entries use one model: `source` (`github`/`manual`) plus `entry_type`
(`delivery`/`ops`). GitHub-only provenance is stored in `github_metadata` JSONB.
Clients own many projects, and each project belongs to one client. Projects and
repositories are many-to-many. Delivery entries resolve their client through the
selected project/repository mapping. Labels are stored as `client — project` or
`client — ops`.

The hourly Cloud Run export job claims pending outbox rows with `FOR UPDATE SKIP
LOCKED`, loads a temporary BigQuery staging table, and merges into `session_facts`
by `session_id`. Only complete normalized entries appear in the `time_tracking` view.
Failed events remain pending. `scripts/reconcile_postgres_bigquery.py` compares row
counts, active counts, and exact duration totals.

## Parked work (deferred)

### Forgotten-timer auto-pause
**Problem**: users start a timer and forget it, racking up hours overnight. Elsewhere in the extension this also looks like a stuck "timer already active" bug because there's a single global active timer.

**Sketch**:
- After 4 hours of continuous running, the timer enters a "confirmation pending" state and posts a notification ("Still working on `repo#N`? Click to extend; ignored after 20 min will auto-pause")
- 20 min later with no confirmation: auto-pause at the 4h mark (don't accumulate beyond it)
- Confirmation extends for another 4h
- Configurable thresholds per-user (or org-level: 2h / 4h / 8h)
- Implementation hooks: extend `chrome.alarms` to fire at `startedAt + 4h`; use `chrome.notifications` API (needs `notifications` permission)

### Show active timer everywhere
**Problem**: if user has a running timer on `repo-A#1` and navigates to `repo-B#2`, the button is disabled with a tooltip but it's easy to miss.

**Sketch**:
- Surface the active timer in the popup more prominently (already there but small)
- On disabled state in content script, make the button click-through to the active timer's issue URL
- Consider a Chrome action badge with elapsed minutes
- Possibly a "switch to this issue" affordance (stop current + start new in one click)

### Future API endpoints we'll likely need
- `GET /v1/sessions/summary` — aggregations (hours by user, by repo, by day) for admin reporting
- `POST /v1/sessions/:id/restore` — undo a soft-delete
- `GET /v1/audit` — read the audit log
