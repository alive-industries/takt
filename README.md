# Takt

> **Takt** (n.) — the beat that sets the pace.

A GitHub-native time tracker for Alive Industries. Track time directly on GitHub issues, sync to GitHub Projects, and export time logs — without leaving the browser.

## Features

- **One-click timer** on any GitHub issue page or project board side panel
- **Play / Pause / Stop** with live elapsed time display
- **Double-click to edit** — manually set the time if you forgot to start tracking
- **GitHub Projects sync** — writes tracked hours to a Number field on your project (e.g. "Actual Hours")
- **Issue comments** — posts a summary comment on the issue when you stop the timer
- **Per-project field mapping** — different projects can use different field names
- **Auto-discovers orgs and projects** from your PAT
- **My Time** — full log of all sessions with filters, delete, and CSV export
- **Works on both URL types:**
  - Standard issues: `github.com/owner/repo/issues/1`
  - Project board panels: `github.com/orgs/org/projects/5?pane=issue&issue=...`

## Install

### 1. Clone the repo

```bash
git clone git@github.com:alive-industries/takt.git
cd takt
```

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this repo

The Takt icon appears in your browser toolbar.

### 3. Create a GitHub PAT

Takt needs a **classic** Personal Access Token (fine-grained PATs don't support Projects v2 yet).

1. Go to [github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo,project&description=Takt%20time%20tracker)
2. Scopes: **repo** + **project**
3. Copy the token

### 4. Configure Takt

1. Click the Takt icon in your toolbar, then **Settings**
2. Paste your PAT and click **Connect & Fetch Projects**
3. Takt auto-discovers all your orgs and projects
4. Choose a **default time field** (e.g. "Actual Hours")
5. Optionally override per project or remove projects you don't need
6. Click **Save Field Settings**

## Usage

### Track time

1. Navigate to any GitHub issue
2. Click **Track time** in the issue header (next to the Edit button)
3. The timer starts — click to pause/resume
4. Click the stop button when done

### Manual time entry

Double-click the timer to manually set the elapsed time. Accepts:
- `01:30:00` (HH:MM:SS)
- `45:00` (MM:SS)
- `90` (minutes)

### What happens on stop

- Time is saved locally in **My Time**
- If the issue is linked to a GitHub Project, the configured Number field is updated (hours rounded to nearest 0.25)
- A comment is posted on the issue: "Tracked **1.25 hours** — @you via Takt"

### My Time

Click **My Time** in the popup to see all tracked sessions. From here you can:
- Filter by repo and date range
- See total hours
- Delete entries
- Export to CSV

## Project structure

```
extension/
  manifest.json              # Chrome MV3 config
  background/
    service-worker.js        # Timer state machine, message router
    github-api.js            # GraphQL/REST queries, sync, comments
  content/
    github.js                # Injects timer into GitHub pages
  popup/
    popup.html / popup.js    # Toolbar popup (active timer + recent)
  options/
    options.html / options.js # PAT setup, project field mapping
  mytime/
    mytime.html / mytime.js  # Full time log with export
  assets/icons/              # Extension icons
```

## Notes

- **No build step** — vanilla JS, load directly as an unpacked extension
- **No external services** — all data stays in GitHub + local browser storage
- **One active timer** at a time across all tabs
- Time syncs to GitHub Projects as **hours** rounded to the nearest **0.25** (15-minute increments)
- Classic PATs are required because GitHub's fine-grained tokens don't yet support Projects v2 field mutations

## License

See [LICENSE](LICENSE).
