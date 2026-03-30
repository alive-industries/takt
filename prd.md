# Takt — Product Requirements Document

> **Takt** (n.) — the beat that sets the pace. A GitHub-native time tracker for any project.

**Repo:** `alive-industries/takt`  
**Status:** Pre-build  
**Owner:** Alive Industries

---

## 1. Problem

GitHub Issues and Projects have no native time tracking. Existing solutions (Toggl, Clockify, Harvest) bolt a button onto GitHub but store data in their own platforms — meaning time data never lives where the work lives. Teams end up with context split across two tools, reports that require third-party exports, and no way to surface time against a GitHub Project view.

---

## 2. Goal

A zero-dependency, GitHub-native time tracker that:
- Injects a play/pause button directly into GitHub issue pages
- Writes time entries back into GitHub Projects as a custom field
- Optionally operates via CLI (`gh` extension) for terminal-first workflows
- Stores nothing outside GitHub — no third-party accounts, no external APIs

---

## 3. Non-Goals

- Team timesheet management, invoicing, or billing
- Passive/automated tracking (window watching, idle detection)
- Support for GitLab, Jira, or any non-GitHub platform
- A standalone web UI or dashboard

---

## 4. Users

Initially: Alive Industries internal team, across all active projects (Zeyro, envirovue, CSR, and others).  
Target: Any developer or small team using GitHub Projects for task management who wants time data without leaving the GitHub ecosystem.

---

## 5. Core User Stories

| ID | As a… | I want to… | So that… |
|----|--------|------------|----------|
| U1 | Developer | Click a ▶ button on a GitHub issue | I can start tracking time without leaving the page |
| U2 | Developer | Click ⏸ to pause and ▶ to resume | I can step away and return without losing the session |
| U3 | Developer | See elapsed time on the active issue | I know how long I've been working |
| U4 | Developer | Have time auto-written to the GitHub Project | Time data is queryable alongside status, priority, etc. |
| U5 | Developer | Run `gh zeyro start <issue>` from terminal | I can track time without opening a browser |
| U6 | Developer | Run `gh zeyro stop` and see a summary | I can log and close a session from CLI |
| U7 | Team lead | See total tracked time per issue in Projects view | I can estimate and report without leaving GitHub |

---

## 6. Architecture

### 6.1 Chrome Extension (primary interface)

**Manifest V3.** Single-purpose, no background service requests to external hosts.

```
takt/
├── extension/
│   ├── manifest.json          # MV3, matches github.com only
│   ├── content/
│   │   └── github.js          # Injects button into issue sidebar
│   ├── background/
│   │   └── service-worker.js  # Timer state, GitHub API calls
│   ├── popup/
│   │   ├── popup.html         # Quick-view: active timer + recent sessions
│   │   └── popup.js
│   ├── options/
│   │   ├── options.html       # PAT setup, tracked Projects config
│   │   └── options.js
│   └── assets/
│       └── icons/
├── cli/                       # gh extension
│   └── gh-takt                # Executable (Node or shell)
├── docs/
│   └── prd.md
└── package.json
```

**Reference:** Clockify's browser extension ([github.com/clockify/browser-extension](https://github.com/clockify/browser-extension)) is a well-structured prior art for the content script injection pattern — specifically the `integrations.json` + per-app content script approach and `createButton()` helper. Zeyro should borrow the injection pattern only; all data handling is replaced with GitHub-native storage.

### 6.2 Content Script — `github.js`

Matches: `https://github.com/*/*/issues/*`

Responsibilities:
- Detect the issue number and repo slug from `window.location`
- Inject the ▶/⏸ button into the issue sidebar (after the Assignees/Labels section)
- Display a live elapsed timer (`HH:MM:SS`) while a session is active
- Send start/pause/stop messages to the service worker via `chrome.runtime.sendMessage`
- Listen for state updates to re-render button state on tab focus

The button must survive GitHub's SPA navigation (Turbo/pjax). Use a `MutationObserver` on `document.body` to re-inject if the sidebar is replaced.

### 6.3 Service Worker — `service-worker.js`

Manages all state and API calls.

**State (persisted to `chrome.storage.local`):**
```json
{
  "activeSession": {
    "repo": "alive-industries/envirovue",
    "issueNumber": 42,
    "projectItemId": "PVTI_xxx",
    "startedAt": "2025-04-01T09:00:00Z",
    "pausedMs": 0,
    "pausedAt": null
  },
  "completedSessions": []
}
```

**On stop:** calculate total duration, call GitHub GraphQL to update the Project field, clear `activeSession`.

### 6.4 GitHub Integration

**Auth:** Personal Access Token (classic), stored in `chrome.storage.local` via the Options page. Required scopes: `repo`, `project`.

**Multi-project support:** The extension works across any GitHub Project the PAT has access to. On first visit to an issue, it resolves which Project(s) the issue belongs to and writes to the correct one. Multiple projects (e.g. Zeyro #5, envirovue #3, CSR #7) are all handled automatically — no per-project configuration required beyond the initial PAT setup.

**Data sink: GitHub Projects v2 custom field**

The extension writes to a `Number` type custom field named `Tracked Time (mins)` on the linked Project item. The mutation accumulates — each stop adds to the existing value rather than overwriting.

```graphql
mutation UpdateTrackedTime($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { number: $value }
  }) {
    projectV2Item { id }
  }
}
```

**Project + field IDs** are resolved dynamically per issue visit. The extension queries which Projects an issue belongs to, then checks each for a `Tracked Time (mins)` field. If the field doesn't exist on a project, the extension offers to create it on first stop.

**Issue → Project item resolution:** Use the REST endpoint `GET /repos/{owner}/{repo}/issues/{issue_number}` to check if the issue is linked to the target Project, then resolve the `projectV2Item` ID via GraphQL.

---

## 7. CLI — `gh zeyro`

A `gh` extension (Node script, installed via `gh extension install alive-industries/takt`).

### Commands

```bash
gh takt start <issue-number>   # Start timer for issue in current repo
gh takt pause                  # Pause active session
gh takt resume                 # Resume paused session
gh takt stop                   # Stop + write to GitHub Projects
gh takt status                 # Print active session elapsed time
gh takt log [--issue <n>]      # Print all logged sessions for an issue
```

**State file:** `~/.config/gh-takt/state.json` — same shape as extension storage. Sessions written to GitHub on `stop`.

**Auth:** Inherits `gh auth token` — no separate credential management.

The CLI and extension operate independently. If both are used, the last `stop` to call the GitHub API wins (no conflict resolution needed at this scope).

---

## 8. Options / Setup Flow

First-run Options page:

1. **PAT input** — validate token by calling `GET /user`, confirm required scopes
2. **Org input** — e.g. `alive-industries` (used to scope project field resolution)
3. **Field name** — defaults to `Tracked Time (mins)`, editable
4. **Confirm** — save to `chrome.storage.local`; project and item IDs are resolved dynamically at track-time, not stored

No per-project configuration is needed. The extension resolves which project an issue belongs to automatically.

---

## 9. UI Spec

### Button states

| State | Appearance |
|-------|-----------|
| Idle | `▶ Track time` — subtle, matches GitHub sidebar style |
| Running | `⏸ 00:23:41` — accent colour, live counter |
| Paused | `▶ Resume — 00:23:41` — muted, shows accumulated time |

Button is injected into the issue sidebar. Minimal styling — use GitHub's own CSS variables (`--color-btn-*`, `--color-accent-fg`) so it reads as native.

### Popup

- Active session: repo, issue title, elapsed time, Pause / Stop buttons
- Last 5 completed sessions: issue ref, duration, timestamp
- Link to Options

---

## 10. Technical Constraints

- **Manifest V3** — no persistent background pages; use `chrome.alarms` for the live counter tick
- **No external requests** — all network calls go to `api.github.com` only
- **No build complexity by default** — vanilla JS preferred for v1; bundler optional
- **MV3 content script re-injection** — GitHub's SPA navigation requires `MutationObserver` guard

---

## 11. Out of Scope (v1)

- Multi-user / shared Project field aggregation
- Firefox support (ship Chrome first, port later — MV3 is compatible)
- Breakdown by date within a single issue's total
- Estimates / remaining time fields
- Notifications or reminders

---

## 12. Milestones

| Milestone | Scope |
|-----------|-------|
| **M1 — Local timer** | Button injects, play/pause/stop works, elapsed time displays, sessions stored locally |
| **M2 — GitHub Projects sync** | Stop writes duration to Projects v2 custom field via GraphQL |
| **M3 — CLI** | `gh zeyro` start/pause/resume/stop/status working with same GitHub write |
| **M4 — Polish** | Options UX, first-run flow, MV3 alarm-based counter, GitHub CSS variable theming |

---

## 13. Reference

- Clockify browser extension (injection pattern reference): [github.com/clockify/browser-extension](https://github.com/clockify/browser-extension)
- GitHub Projects v2 GraphQL API: [docs.github.com/graphql](https://docs.github.com/en/graphql)
- `gh` extension authoring: [cli.github.com/manual/gh_extension](https://cli.github.com/manual/gh_extension)
- Chrome MV3 service worker alarms: [developer.chrome.com/docs/extensions/reference/alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
