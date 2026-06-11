# Takt Analytics API

Read-only HTTP endpoints for project managers and dashboards to pull **time-tracking**
data (from Takt) and **cost** data (GCP + external billing) out of BigQuery. They map
~1:1 to the underlying BigQuery resources with filtering and light aggregation — join
across them on `project` in your dashboard layer.

All endpoints are **GET** and **read-only**. There is no pagination beyond `limit`.

## Base URLs

| Environment | Base URL | Time data |
|---|---|---|
| Test/dev | `https://takt-api-test-cjye4xg2ta-ew.a.run.app` | `takt_test` dataset |
| Production | `https://takt-api-cjye4xg2ta-ew.a.run.app` | `takt` dataset |

Cost data (`billing_export`) is shared across both environments.

## Authentication

Send the shared API key in a header on **every** request:

```
X-Takt-Api-Key: <key>
```

No GitHub token is required for these endpoints. A missing/invalid key returns
`401 {"detail":{"code":"invalid_api_key", ...}}`.

```bash
curl -s "$BASE/v1/analytics/cost-summary" -H "X-Takt-Api-Key: $TAKT_API_KEY"
```

## Conventions

- Dates/timestamps are ISO-8601. `from` is inclusive, `to` is exclusive.
- Responses are JSON: `{ "count": <n>, "rows": [ ... ], ...echoed params }`.
- `limit` defaults to 1000, max 5000.
- An invalid `group_by` returns `400 {"detail":{"code":"bad_request", ...}}`.

---

## `GET /v1/analytics/time`

Tracked time from Takt sessions (excludes deleted).

| Param | Type | Notes |
|---|---|---|
| `from`, `to` | timestamp | filter on `completed_at` |
| `project` | string | exact match (project label = GitHub Project title, else `owner/repo`) |
| `repo` | string | `owner/name` |
| `user` | string | GitHub login |
| `group_by` | enum | `project` \| `repo` \| `user` \| `day` \| `week` \| `month` — omit for raw rows |
| `limit` | int | ≤ 5000 |

**Aggregated** (`group_by` set) rows: `{ "group": <value>, "hours": <float>, "entries": <int> }`.
**Raw** (no `group_by`) rows: `project, repo, issue_number, issue_title, github_user, duration_ms, duration_hours, completed_at`.

```bash
curl -s "$BASE/v1/analytics/time?group_by=project&from=2026-06-01" \
  -H "X-Takt-Api-Key: $TAKT_API_KEY"
```
```json
{
  "group_by": "project",
  "count": 2,
  "rows": [
    { "group": "Dawbell", "hours": 12.5, "entries": 9 },
    { "group": "alive-industries/zeyro", "hours": 3.25, "entries": 4 }
  ]
}
```

---

## `GET /v1/analytics/cost-summary`

Per-project current-month total cost vs budget, from the curated `v_cost_summary`
view (blends GCP + external costs and joins budgets/approvals).

| Param | Type | Notes |
|---|---|---|
| `project` | string | optional exact match |

Row columns: `project, total_cost_usd, budget_allocated_per_month, over_by_usd,
is_over_budget, acknowledged, acknowledged_by, acknowledged_at, last_alerted_at,
client_approved, client_approval_provided_by, client_approved_at`.

```bash
curl -s "$BASE/v1/analytics/cost-summary" -H "X-Takt-Api-Key: $TAKT_API_KEY"
```
```json
{
  "count": 1,
  "rows": [
    {
      "project": "Dawbell",
      "total_cost_usd": 412.83,
      "budget_allocated_per_month": 500.0,
      "over_by_usd": -87.17,
      "is_over_budget": false,
      "acknowledged": false,
      "client_approved": true
    }
  ]
}
```

---

## `GET /v1/analytics/gcp-costs`

GCP spend from the raw billing export, aggregated. **Defaults to the current month**
(filtered on `usage_start_time`, the partition column) so scans stay cheap — pass
`from`/`to` to widen.

| Param | Type | Notes |
|---|---|---|
| `from`, `to` | date | window on `usage_start_time`; default = current month |
| `project` | string | GCP `project.name` |
| `service` | string | GCP `service.description` |
| `group_by` | enum | `project` \| `service` \| `sku` \| `day` \| `month` — default `service` |
| `limit` | int | ≤ 5000 |

Row: `{ "group": <value>, "cost": <usd float>, "currency": "USD" }`.

```bash
curl -s "$BASE/v1/analytics/gcp-costs?group_by=service&from=2026-06-01&to=2026-07-01" \
  -H "X-Takt-Api-Key: $TAKT_API_KEY"
```
```json
{
  "group_by": "service",
  "from": "2026-06-01",
  "to": "2026-07-01",
  "count": 3,
  "rows": [
    { "group": "Compute Engine", "cost": 210.4, "currency": "USD" },
    { "group": "BigQuery", "cost": 41.2, "currency": "USD" }
  ]
}
```

---

## `GET /v1/analytics/external-costs`

Manual, non-GCP costs (`external_costs` table), 1:1.

| Param | Type | Notes |
|---|---|---|
| `project` | string | optional |
| `from`, `to` | date | window on `month` |

Row columns: `project, provider, cost_allocated_per_month, month, notes, date`.

---

## `GET /v1/analytics/budgets`

Per-project monthly budgets + acknowledgement/approval (`project_budgets`), 1:1.

| Param | Type | Notes |
|---|---|---|
| `project` | string | optional |
| `month` | date | first-of-month, e.g. `2026-06-01` |

Row columns: `project, budget_allocated_per_month, month, acknowledged, acknowledged_by,
acknowledged_at, last_alerted_at, client_approved, client_approval_provided_by,
client_approved_at`.

---

## Recipe: cost vs effort per project

Both time and cost are keyed on **project**, so a "spend vs hours" view is a client-side
join:

1. `GET /v1/analytics/time?group_by=project&from=<month-start>` → `{ project: hours }`
2. `GET /v1/analytics/cost-summary` → `{ project: total_cost_usd, budget, over_by_usd }`
3. Join on `project` in your dashboard; derive `cost_per_hour = total_cost_usd / hours`.

> Note: the time `project` is the GitHub Project title when the issue is on a board,
> otherwise the repo (`owner/name`). Align your cost `project` names accordingly.
