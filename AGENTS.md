# Takt — Agent notes

Project info and parked work for future agents/sessions.

## Verification

### Server (`server/`)

```bash
cd server
uv sync
uv run pytest            # smoke tests (no BQ needed)
uv run ruff check .
uv run uvicorn app.main:app --reload   # local dev (needs ADC: gcloud auth application-default login)
```

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

- BQ dataset: `cost-tracker-490815.takt` in `EU` (matches `billing_export`)
- Tables: `sessions`, `projects`, `members`, `org_config`, `audit_log`
- First admin seeded: `harveypitt`
- Cloud Run: `takt-api` in `europe-west1` (planned; not yet deployed)
- Runtime SA: `takt-api@cost-tracker-490815.iam.gserviceaccount.com` (needs `bigquery.dataEditor` on `takt` + `bigquery.jobUser` on project)
- Artifact Registry repo: `takt` in `europe-west1` (planned; not yet created)
- Bootstrap rerun: `ADMIN_LOGIN=<login> ./server/scripts/bootstrap.sh`

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

Why this exists: pre-v0.3.0, every My Time open did a synchronous BQ round-trip and felt slow. The cache makes the common path zero-latency while keeping BQ as the source of truth for cross-device / cross-user consistency.

## Conventions

- All BQ identifiers snake_case; extension internal state camelCase; conversion lives in `local-store.js#fromBackendSession` / `local-store.js#toBackendPayload`.
- `session_id` is a UUID generated at START time on the extension. The server `MERGE`s on `session_id` so retries from the sync queue are idempotent. Backfill of legacy local sessions uses a deterministic SHA-256-derived UUID-shaped id so re-runs are also idempotent.
- Times in BQ are TIMESTAMP (UTC), serialised as ISO 8601 over the wire.
- Hours rounded to 0.25 for display/Projects sync; raw `duration_ms` is source of truth.

## BigQuery write path: MERGE not streaming

We deliberately **do not** use `client.insert_rows_json` / `tabledata.insertAll`.

Streaming inserts hold rows in a buffer where DML (`UPDATE`/`DELETE`/`MERGE`) is rejected for ~30 min with:

> `400 ... UPDATE or DELETE statement over table ... would affect rows in the streaming buffer, which is not supported`

That blew up immediately when a user tried to edit a session they'd just stopped. So `insert_session` runs a `MERGE ... WHEN NOT MATCHED THEN INSERT` via `jobs.query`, which writes straight to permanent storage and is editable on the next request.

Trade-offs we're accepting:
- ~1-2s vs ~50ms write latency — fine, the extension's STOP path is async and saves locally first
- DML rate limits (~1500 jobs/table/day) — fine, we're nowhere near for any realistic team size

If/when we outgrow DML rate limits, the next step is the **Storage Write API** (`google-cloud-bigquery-storage`, `_default` stream). It has neither the streaming buffer nor the DML rate cap, but it's proto-based and noticeably more code.

`_run_dml()` in `services/bq.py` translates any `BadRequest` whose message contains "streaming buffer" into a `StreamingBufferConflict` (HTTP 409 with code `streaming_buffer`). This will only ever fire on rows inserted by the legacy streaming path — i.e. anything written before this commit.

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
