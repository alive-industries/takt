#!/usr/bin/env python3
"""Sync GitHub Projects v2 titles into the Takt `projects` lookup table.

Sessions reference projects by stable node id (`project_ids`). The
`projects` table holds the current title for each id. This script fetches
all org projects from GitHub and upserts them into the lookup table, so a
project rename is reflected everywhere — no need to touch individual
session rows.

Run this:
  - After a project rename (updates the title in the lookup table)
  - Periodically to keep the lookup table fresh
  - Once to backfill the lookup table from existing session data

Usage:
    cd server
    uv run python scripts/sync_projects.py --pat <github-pat> [--dry-run]

The PAT needs `project` and `read:org` scope.
The PostgreSQL URL comes from the same .env / TAKT_* env vars as the server.

Idempotent: safe to re-run. Only inserts/updates rows where the title changed.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from urllib.request import Request, urlopen

# Allow running as `uv run python scripts/sync_projects.py` from server/
# without setting PYTHONPATH.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.models import Project  # noqa: E402
from app.services import store  # noqa: E402

log = logging.getLogger("sync_projects")

GITHUB_GRAPHQL = "https://api.github.com/graphql"
GITHUB_REST = "https://api.github.com"


def _graphql(pat: str, query: str, variables: dict) -> dict:
    """Minimal GitHub GraphQL client."""
    body = json.dumps({"query": query, "variables": variables}).encode()
    req = Request(
        GITHUB_GRAPHQL,
        data=body,
        headers={
            "Authorization": f"Bearer {pat}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urlopen(req) as resp:
        payload = json.loads(resp.read())
    if payload.get("errors"):
        raise RuntimeError(
            "GitHub GraphQL error: " + "; ".join(e["message"] for e in payload["errors"])
        )
    return payload["data"]


def fetch_user_orgs(pat: str) -> list[str]:
    """Fetch org logins the PAT user belongs to."""
    req = Request(
        f"{GITHUB_REST}/user/orgs?per_page=100",
        headers={
            "Authorization": f"Bearer {pat}",
            "Accept": "application/vnd.github+json",
        },
    )
    with urlopen(req) as resp:
        orgs = json.loads(resp.read())
    return [o["login"] for o in orgs]


def fetch_org_projects(pat: str, org: str) -> list[dict]:
    """Fetch all Projects v2 for an org via GraphQL."""
    data = _graphql(
        pat,
        """
        query ($org: String!) {
          organization(login: $org) {
            projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes { id title }
            }
          }
        }
        """,
        {"org": org},
    )
    nodes = data.get("organization", {}).get("projectsV2", {}).get("nodes", [])
    return [{"project_id": n["id"], "title": n["title"], "org": org} for n in nodes]


def upsert_project(project: dict) -> bool:
    """Upsert one project row. Returns True if a row was inserted/updated."""
    store.upsert_projects([Project(**project)])
    return True


def list_existing() -> dict[str, str]:
    """Return {project_id: title} for all rows currently in the lookup table."""
    return {project.project_id: project.title for project in store.list_projects()}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sync GitHub Projects v2 titles into the Takt projects lookup table."
    )
    parser.add_argument(
        "--pat", required=True, help="GitHub PAT with `project` and `read:org` scope."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would change without writing to PostgreSQL.",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Show every project.")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    # --- Fetch all org projects from GitHub ---
    log.info("Fetching orgs for PAT user...")
    orgs = fetch_user_orgs(args.pat)
    log.info("Found %d org(s): %s", len(orgs), ", ".join(orgs))

    all_projects: list[dict] = []
    for org in orgs:
        try:
            projects = fetch_org_projects(args.pat, org)
            log.info("  %s: %d project(s)", org, len(projects))
            all_projects.extend(projects)
        except Exception as exc:
            log.warning("  %s: failed to fetch projects: %s", org, exc)

    if not all_projects:
        log.warning("No projects found. Nothing to sync.")
        return 0

    # --- Compare against existing lookup table ---
    existing = list_existing()
    log.info("Lookup table has %d existing row(s).", len(existing))

    new_count = 0
    updated_count = 0
    unchanged_count = 0

    for p in all_projects:
        pid = p["project_id"]
        title = p["title"]
        if pid not in existing:
            log.info("  NEW: %s -> %r", pid, title)
            new_count += 1
            if not args.dry_run:
                upsert_project(p)
        elif existing[pid] != title:
            log.info("  RENAME: %s\n    old: %r\n    new: %r", pid, existing[pid], title)
            updated_count += 1
            if not args.dry_run:
                upsert_project(p)
        else:
            unchanged_count += 1

    log.info(
        "Done. New: %d, renamed: %d, unchanged: %d, dry-run: %s",
        new_count,
        updated_count,
        unchanged_count,
        args.dry_run,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
