// Local-first cache of session records.
//
// This is the source of truth for "recent" reads in the UI. The backend
// (BigQuery) remains the durable store; we sync to it but the user-visible
// path goes through this cache so My Time / popup feel instant.
//
// Storage layout (chrome.storage.local.sessionCache):
//   {
//     byId: { [sessionId]: SessionRecord },
//     lastSyncAt: number | null,   // epoch ms of last successful pull
//   }
//
// SessionRecord (normalised — used identically in extension UI and when
// converting to/from the backend wire format):
//   {
//     sessionId: string,
//     repo: string,
//     issueNumber: number,
//     issueTitle: string | null,
//     issueUrl: string | null,
//     sourceUrl: string | null,
//     startedAt: number,           // ms epoch
//     completedAt: number,         // ms epoch
//     durationMs: number,
//     durationHours: number,
//     syncedToProject: boolean,
//     projectTitles: string[],
//     taktVersion: string | null,
//     syncStatus: 'pending' | 'synced' | 'dirty',
//     syncedAt: number | null,     // when last confirmed on backend
//   }

const KEY = 'sessionCache';
const RETENTION_DAYS = 30;

async function load() {
  const { [KEY]: c } = await chrome.storage.local.get(KEY);
  return c && c.byId ? c : { byId: {}, lastSyncAt: null };
}

async function save(cache) {
  await chrome.storage.local.set({ [KEY]: cache });
}

// --- Conversions ---

// Server snake_case -> normalised. Used when ingesting LIST/UPDATE responses.
export function fromBackendSession(s) {
  return {
    sessionId: s.session_id,
    repo: s.repo,
    issueNumber: s.issue_number,
    issueTitle: s.issue_title,
    issueUrl: s.issue_url,
    sourceUrl: s.source_url,
    startedAt: new Date(s.started_at).getTime(),
    completedAt: new Date(s.completed_at).getTime(),
    durationMs: s.duration_ms,
    durationHours: s.duration_hours,
    syncedToProject: !!s.synced_to_project,
    projectTitles: s.project_titles || [],
    taktVersion: s.takt_version,
    syncStatus: 'synced',
    syncedAt: Date.now(),
  };
}

// Normalised -> backend snake_case wire format (POST /v1/sessions).
export function toBackendPayload(r) {
  return {
    session_id: r.sessionId,
    repo: r.repo,
    issue_number: r.issueNumber,
    issue_title: r.issueTitle ?? null,
    issue_url: r.issueUrl ?? null,
    started_at: new Date(r.startedAt).toISOString(),
    completed_at: new Date(r.completedAt).toISOString(),
    duration_ms: r.durationMs,
    duration_hours: r.durationHours,
    source_url: r.sourceUrl ?? null,
    synced_to_project: !!r.syncedToProject,
    project_titles: r.projectTitles || [],
    takt_version: r.taktVersion ?? null,
    client_ts: new Date().toISOString(),
  };
}

// --- Pruning ---

function pruneInPlace(cache) {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  for (const [id, rec] of Object.entries(cache.byId)) {
    if (rec.completedAt < cutoff) delete cache.byId[id];
  }
}

// --- Public API ---

export async function upsertSessions(records) {
  if (!records || records.length === 0) return;
  const cache = await load();
  for (const r of records) {
    if (!r.sessionId) continue;
    cache.byId[r.sessionId] = { ...cache.byId[r.sessionId], ...r };
  }
  pruneInPlace(cache);
  await save(cache);
}

export async function upsertSession(record) {
  return upsertSessions([record]);
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  const cache = await load();
  return cache.byId[sessionId] || null;
}

export async function removeSession(sessionId) {
  if (!sessionId) return null;
  const cache = await load();
  const removed = cache.byId[sessionId] || null;
  delete cache.byId[sessionId];
  await save(cache);
  return removed;
}

// Synchronously available shape for filter/sort. Date filters are inclusive.
export async function listSessions({ from, to, repo, limit = 1000 } = {}) {
  const cache = await load();
  let arr = Object.values(cache.byId);

  if (from) {
    const fromMs = typeof from === 'number' ? from : new Date(from).getTime();
    arr = arr.filter((s) => s.completedAt >= fromMs);
  }
  if (to) {
    const toMs = typeof to === 'number' ? to : new Date(to).getTime() + 86_400_000;
    arr = arr.filter((s) => s.completedAt < toMs);
  }
  if (repo) arr = arr.filter((s) => s.repo === repo);

  arr.sort((a, b) => b.completedAt - a.completedAt);
  return arr.slice(0, limit);
}

/**
 * Reconcile the cache with a fresh server response for a given query window.
 *
 * - Upserts every record in `records` (server is authoritative for these).
 * - For any cached entry whose completedAt falls inside the window AND whose
 *   sessionId isn't in the server response, we delete it from the cache —
 *   this handles cases where another user/admin deleted the session, or the
 *   server pruned it.
 * - Locally-modified entries (`syncStatus !== 'synced'`) are NEVER deleted
 *   even if absent from the server response — they're awaiting a push.
 */
export async function reconcileWindow({ from, to, records }) {
  const cache = await load();
  const fromMs = from ? (typeof from === 'number' ? from : new Date(from).getTime()) : 0;
  const toMs = to
    ? (typeof to === 'number' ? to : new Date(to).getTime() + 86_400_000)
    : Number.MAX_SAFE_INTEGER;

  const serverIds = new Set();
  for (const r of records || []) {
    if (!r.sessionId) continue;
    serverIds.add(r.sessionId);
    cache.byId[r.sessionId] = { ...cache.byId[r.sessionId], ...r };
  }

  // Drop cached entries within the window that the server didn't return,
  // unless they have unsynced local changes.
  for (const [id, rec] of Object.entries(cache.byId)) {
    if (rec.completedAt < fromMs || rec.completedAt >= toMs) continue;
    if (serverIds.has(id)) continue;
    if (rec.syncStatus && rec.syncStatus !== 'synced') continue;
    delete cache.byId[id];
  }

  cache.lastSyncAt = Date.now();
  pruneInPlace(cache);
  await save(cache);
}

export async function getLastSyncAt() {
  const cache = await load();
  return cache.lastSyncAt;
}

// --- Migration from legacy completedSessions[] ---

async function deriveStableId(s) {
  const key = `${s.repo}|${s.issueNumber}|${s.completedAt}|${s.durationMs}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function migrateFromCompletedSessions() {
  const { completedSessions = [] } = await chrome.storage.local.get('completedSessions');
  if (completedSessions.length === 0) return { migrated: 0 };

  const cache = await load();
  let migrated = 0;
  for (const s of completedSessions) {
    const sessionId = s.sessionId || (await deriveStableId(s));
    if (cache.byId[sessionId]) continue; // already in cache
    cache.byId[sessionId] = {
      sessionId,
      repo: s.repo,
      issueNumber: s.issueNumber,
      issueTitle: s.issueTitle ?? null,
      issueUrl: null,
      sourceUrl: s.sourceUrl ?? null,
      startedAt: s.startedAtMs ?? (s.completedAt - s.durationMs),
      completedAt: s.completedAt,
      durationMs: s.durationMs,
      durationHours: Math.round((s.durationMs / 3_600_000) * 4) / 4,
      syncedToProject: false,
      projectTitles: [],
      taktVersion: null,
      syncStatus: 'pending',
      syncedAt: null,
    };
    migrated += 1;
  }
  pruneInPlace(cache);
  await save(cache);
  return { migrated };
}

// --- Counts (for UI status pip / debug) ---

export async function counts() {
  const cache = await load();
  let pending = 0, dirty = 0, synced = 0;
  for (const r of Object.values(cache.byId)) {
    if (r.syncStatus === 'pending') pending += 1;
    else if (r.syncStatus === 'dirty') dirty += 1;
    else synced += 1;
  }
  return { total: pending + dirty + synced, pending, dirty, synced };
}
