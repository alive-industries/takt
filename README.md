# Takt

Takt is a time tracker for GitHub work. The Chrome extension records time on
issues and repositories, while a FastAPI service stores sessions and supplies
the team-facing reporting data.

## Features

- **Dashboard:** review tracked time, active sessions, and sync status.
- **My Time:** filter, edit, and delete your sessions; review totals and export
  the log as CSV.
- **Clients:** map GitHub Projects and repositories to clients for consistent
  reporting.
- **Admin:** manage members and organization-level project and reporting
  settings.
- **Sync status:** see pending or failed synchronization and retry recoverable
  entries.
- **GitHub timer:** start, pause, resume, and stop a timer from an issue page or
  project issue panel; completed sessions can update GitHub Projects and add
  an issue comment.

## Architecture

The extension is local-first: it renders from a local session cache and puts
session changes in a durable sync queue before sending them to the backend.
The FastAPI service backed by PostgreSQL is the source of truth for sessions,
members, clients, and project mappings. An hourly exporter copies completed
reporting data from PostgreSQL's outbox to BigQuery as an analytics replica.

## Install

1. In Chrome, open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this repository's `extension/` folder.
3. Create a GitHub classic personal access token with the `repo`, `project`,
   and `read:org` scopes. The `project` scope is needed for GitHub Projects;
   `read:org` enables organization discovery.
4. Open Takt **Settings**, enter the GitHub token, backend URL, and API key
   provided for your environment, then save the settings.

The extension can be used with a locally running backend during development.
Do not put deployment-specific backend URLs or credentials in this repository.

## Repository layout

```text
extension/
  assets/
    fonts/                # Self-hosted Archivo variable font and OFL license
  background/
    handlers/             # Timer, session, GitHub, and admin actions
    local-store.js        # Local session cache
    service-worker.js     # Message dispatch, alarms, and wake handling
    sync-queue.js         # Durable extension outbox
    worker-shared.js      # Shared service-worker sync helpers
  content/                # GitHub page controls
  dashboard/
    dashboard.html        # Single-page dashboard shell and native views
    dashboard.js          # Navigation, Clients view, and status
    views/                 # Lazy-loaded Time, Settings, and Admin scripts
  lib/                    # Shared extension time and UI helpers
  popup/                  # Toolbar popup
server/
  app/                    # FastAPI application, routes, and models
    services/store/       # PostgreSQL store modules
  scripts/                # Bootstrap, sync, and BigQuery export tools
  tests/                  # API and exporter tests
tests/extension/          # Node tests for extension modules
docs/research/            # Research notes
AGENTS.md                 # Development and verification guide
```

## Development and tests

See [AGENTS.md](AGENTS.md) for the full environment setup and verification
instructions. The main local checks are:

```bash
docker compose up -d postgres
cd server
uv sync
uv run alembic upgrade head
uv run pytest
uv run ruff check .
cd ..
npm run test:ext
find extension -name '*.js' -print0 | xargs -0 -n1 node --check
```

The server tests use the separate local `takt_test` database configured in
`server/tests/conftest.py`.

## License

See [LICENSE](LICENSE).
