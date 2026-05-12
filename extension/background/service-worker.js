import { syncToGitHub, postTimeComment, fetchAllProjects, fetchProjectNumberFields } from './github-api.js';
import { enqueueSession, flushQueue, queueLength } from './sync-queue.js';
import {
  pushSession,
  ping as pingBackend,
  listSessions as listBackendSessions,
  updateSession as updateBackendSession,
  deleteSession as deleteBackendSession,
  listMembers as listBackendMembers,
  upsertMember as upsertBackendMember,
  getOrgConfig as getBackendOrgConfig,
  putOrgConfig as putBackendOrgConfig,
} from './takt-api.js';
import * as cache from './local-store.js';

const ALARM_NAME = 'takt-tick';
const TAKT_VERSION = chrome.runtime.getManifest().version;

// --- State helpers ---

async function getState() {
  const { activeSession = null } =
    await chrome.storage.local.get(['activeSession']);
  return { activeSession };
}

async function saveSession(activeSession) {
  await chrome.storage.local.set({ activeSession });
}

// Read legacy completedSessions[] for one-shot operations like backfill.
// New sessions are written into the cache only (see local-store.js).
async function getLegacyCompleted() {
  const { completedSessions = [] } =
    await chrome.storage.local.get(['completedSessions']);
  return completedSessions;
}

function computeElapsed(session) {
  if (!session) return 0;
  const running =
    session.status === 'running' ? Date.now() - session.startedAt : 0;
  return session.accumulatedMs + running;
}

// --- Backend payload shaping ---

function toBackendSession(completed, syncResult) {
  // Map our internal completed-session shape to the wire format the
  // FastAPI backend expects (see server/app/models.py SessionIn).
  const repo = completed.repo;
  const issueNumber = completed.issueNumber;
  const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
  const projectTitles = (syncResult?.results || [])
    .filter((r) => r.synced)
    .map((r) => r.project);
  const syncedToProject = projectTitles.length > 0;
  const durationHours = Math.round((completed.durationMs / 3600000) * 4) / 4;

  return {
    session_id: completed.sessionId,
    repo,
    issue_number: issueNumber,
    issue_title: completed.issueTitle || null,
    issue_url: issueUrl,
    started_at: new Date(completed.startedAtMs).toISOString(),
    completed_at: new Date(completed.completedAt).toISOString(),
    duration_ms: completed.durationMs,
    duration_hours: durationHours,
    source_url: completed.sourceUrl || null,
    synced_to_project: syncedToProject,
    project_titles: projectTitles,
    takt_version: TAKT_VERSION,
    client_ts: new Date().toISOString(),
  };
}

// Deterministic UUID-shaped id for legacy local sessions that were created
// before we generated session ids on START. Uses SHA-256 of the natural key
// formatted as a UUID v5-ish string. Idempotent per-record so backfill is
// safe to run multiple times.
async function stableSessionId(localSession) {
  const key = `${localSession.repo}|${localSession.issueNumber}|${localSession.completedAt}|${localSession.durationMs}`;
  const enc = new TextEncoder().encode(key);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Format as UUID-shaped string (not a real v5 — just convenient)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function pushCompletedToBackend(completed, syncResult) {
  const payload = toBackendSession(completed, syncResult);
  try {
    await pushSession(payload);
    // Backend confirmed — update the cache entry's sync metadata.
    await cache.upsertSession({
      sessionId: payload.session_id,
      syncedToProject: payload.synced_to_project,
      projectTitles: payload.project_titles,
      syncStatus: 'synced',
      syncedAt: Date.now(),
    });
    return { ok: true, session_id: payload.session_id };
  } catch (err) {
    // Enqueue for retry. Permanent errors will still be dropped by the
    // queue's permanent-error filter on the next flush. Cache stays at
    // 'pending'.
    await enqueueSession(payload);
    return { ok: false, queued: true, error: err.message, code: err.code };
  }
}

// --- Alarm keep-alive ---

function startAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

function clearAlarm() {
  chrome.alarms.clear(ALARM_NAME);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  // Always try to drain the sync queue — handles offline-then-online recovery.
  try {
    await flushQueue();
  } catch (err) {
    console.warn('[Takt] flushQueue error:', err);
  }

  const { activeSession } = await getState();
  if (!activeSession) {
    // Only clear the alarm if there's nothing in the queue either; otherwise
    // we want to keep ticking until the queue drains.
    if ((await queueLength()) === 0) clearAlarm();
    return;
  }
  // Broadcast tick so any open content scripts / popup can sync
  broadcastTick(activeSession);
});

async function onWake() {
  // Drain the queue if anything's pending.
  if ((await queueLength()) > 0) {
    startAlarm();
    flushQueue().catch(() => {});
  }
  // One-shot migration: if the new sessionCache is empty but we have
  // legacy completedSessions, fold them in so the user doesn't see an
  // empty My Time after upgrading.
  try {
    const counts = await cache.counts();
    if (counts.total === 0) {
      const result = await cache.migrateFromCompletedSessions();
      if (result.migrated > 0) {
        console.log('[Takt] migrated', result.migrated, 'legacy sessions into cache');
      }
    }
  } catch (err) {
    console.warn('[Takt] cache migration failed:', err);
  }
}

chrome.runtime.onStartup.addListener(onWake);
chrome.runtime.onInstalled.addListener(onWake);

function broadcastTick(session) {
  const elapsedMs = computeElapsed(session);
  const message = { action: 'TICK', payload: { elapsedMs, session } };
  // Send to all tabs with content scripts
  chrome.tabs.query({ url: 'https://github.com/*/*/issues/*' }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

// --- Message handling ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // async response
});

async function handleMessage({ action, payload }) {
  const { activeSession } = await getState();

  switch (action) {
    case 'START': {
      if (activeSession) {
        return {
          error: `Timer already active on ${activeSession.repo}#${activeSession.issueNumber}`,
        };
      }
      const session = {
        // session_id is generated at START so it's stable across pause/resume
        // and matches the BigQuery `session_id` we'll push on STOP.
        sessionId: crypto.randomUUID(),
        repo: payload.repo,
        issueNumber: payload.issueNumber,
        issueTitle: payload.issueTitle,
        sourceUrl: payload.sourceUrl || null,
        startedAt: Date.now(),
        accumulatedMs: 0,
        status: 'running',
      };
      await saveSession(session);
      startAlarm();
      return { ok: true, session };
    }

    case 'PAUSE': {
      if (!activeSession || activeSession.status !== 'running') {
        return { error: 'No running session to pause' };
      }
      activeSession.accumulatedMs += Date.now() - activeSession.startedAt;
      activeSession.startedAt = null;
      activeSession.status = 'paused';
      await saveSession(activeSession);
      clearAlarm();
      return { ok: true, session: activeSession };
    }

    case 'RESUME': {
      if (!activeSession || activeSession.status !== 'paused') {
        return { error: 'No paused session to resume' };
      }
      activeSession.startedAt = Date.now();
      activeSession.status = 'running';
      await saveSession(activeSession);
      startAlarm();
      return { ok: true, session: activeSession };
    }

    case 'SET_TIME': {
      if (!activeSession) {
        return { error: 'No active session to update' };
      }
      // payload.ms is the total elapsed time the user wants
      const newMs = payload.ms;
      if (typeof newMs !== 'number' || newMs < 0) {
        return { error: 'Invalid time value' };
      }
      if (activeSession.status === 'running') {
        // Reset startedAt to now, put everything into accumulatedMs
        activeSession.accumulatedMs = newMs;
        activeSession.startedAt = Date.now();
      } else {
        // Paused — just set accumulated
        activeSession.accumulatedMs = newMs;
      }
      await saveSession(activeSession);
      return { ok: true, session: activeSession };
    }

    case 'STOP': {
      if (!activeSession) {
        return { error: 'No active session to stop' };
      }
      const durationMs = computeElapsed(activeSession);
      const completedAt = Date.now();
      const startedAtMs = activeSession.startedAt
        // For paused sessions startedAt is null; estimate started time
        // from completedAt - durationMs.
        ?? (completedAt - durationMs);
      const completed = {
        // Backend-aligned identifiers
        sessionId: activeSession.sessionId || crypto.randomUUID(),
        repo: activeSession.repo,
        issueNumber: activeSession.issueNumber,
        issueTitle: activeSession.issueTitle,
        sourceUrl: activeSession.sourceUrl || null,
        startedAtMs,
        durationMs,
        completedAt,
      };
      await saveSession(null);
      clearAlarm();

      // Write into the local cache immediately as 'pending'. Marked
      // 'synced' below once the backend confirms (or stays pending and
      // gets retried by the queue).
      const durationHoursForCache =
        Math.round((completed.durationMs / 3600000) * 4) / 4;
      await cache.upsertSession({
        sessionId: completed.sessionId,
        repo: completed.repo,
        issueNumber: completed.issueNumber,
        issueTitle: completed.issueTitle ?? null,
        issueUrl: `https://github.com/${completed.repo}/issues/${completed.issueNumber}`,
        sourceUrl: completed.sourceUrl,
        startedAt: completed.startedAtMs,
        completedAt: completed.completedAt,
        durationMs: completed.durationMs,
        durationHours: durationHoursForCache,
        syncedToProject: false, // updated below if syncResult succeeded
        projectTitles: [],
        taktVersion: TAKT_VERSION,
        syncStatus: 'pending',
        syncedAt: null,
      });

      // Attempt GitHub sync
      let syncResult = null;
      try {
        syncResult = await syncToGitHub(completed);
      } catch (err) {
        syncResult = { error: err.message };
      }

      // Post comment on the issue
      let commentResult = null;
      try {
        const { settings } = await chrome.storage.local.get('settings');
        if (settings?.pat) {
          // Resolve username — fetch if not cached
          let username = settings.username;
          if (!username) {
            const resp = await fetch('https://api.github.com/user', {
              headers: { Authorization: `Bearer ${settings.pat}`, Accept: 'application/vnd.github+json' },
            });
            if (resp.ok) {
              const user = await resp.json();
              username = user.login;
              await chrome.storage.local.set({ settings: { ...settings, username } });
            }
          }
          if (username) {
            const [owner, repo] = completed.repo.split('/');
            const durationHours = Math.round((completed.durationMs / 3600000) * 4) / 4;
            await postTimeComment(
              settings.pat, owner, repo, completed.issueNumber,
              durationHours, username
            );
            commentResult = { ok: true };
          }
        }
      } catch (err) {
        commentResult = { error: err.message };
      }

      // Push to Takt backend (BigQuery). Best-effort; failures enqueue
      // for retry. Local My Time stays the source of truth offline.
      let backendResult = null;
      try {
        backendResult = await pushCompletedToBackend(completed, syncResult);
      } catch (err) {
        backendResult = { error: err.message };
      }

      return { ok: true, completed, syncResult, commentResult, backendResult };
    }

    case 'GET_STATE': {
      return {
        activeSession,
        elapsedMs: computeElapsed(activeSession),
      };
    }

    case 'FETCH_ALL_PROJECTS': {
      const result = await fetchAllProjects(payload.pat);
      return { ok: true, orgs: result.orgs, projects: result.projects };
    }

    case 'FETCH_PROJECT_FIELDS': {
      const fields = await fetchProjectNumberFields(payload.pat, payload.projectId);
      return { ok: true, fields };
    }

    case 'BACKEND_PING': {
      // Used by options/popup to show a green/red status pip.
      const result = await pingBackend();
      return result;
    }

    case 'FLUSH_QUEUE': {
      const result = await flushQueue();
      return { ok: true, ...result };
    }

    case 'QUEUE_LENGTH': {
      return { ok: true, length: await queueLength() };
    }

    case 'LIST_LOCAL_SESSIONS': {
      // Synchronous-style read from the cache. Used by My Time / popup
      // for the instant-render path before the backend revalidate fires.
      const sessions = await cache.listSessions(payload || {});
      const counts = await cache.counts();
      const lastSyncAt = await cache.getLastSyncAt();
      return { ok: true, sessions, counts, lastSyncAt };
    }

    case 'LIST_BACKEND_SESSIONS': {
      // Pulls from the backend AND (by default) reconciles the cache for
      // the queried window. Caller (My Time) typically calls
      // LIST_LOCAL_SESSIONS first for instant render and this in the
      // background to refresh.
      //
      // `skipReconcile: true` is used when the caller is querying a window
      // older than the cache's 30-day retention — reconciling would write
      // those rows in then immediately prune them on save.
      try {
        const { skipReconcile, ...apiParams } = payload || {};
        const sessions = await listBackendSessions(apiParams);
        const records = sessions.map(cache.fromBackendSession);
        if (!skipReconcile) {
          await cache.reconcileWindow({
            from: apiParams.from,
            to: apiParams.to,
            records,
          });
        }
        return { ok: true, sessions, records };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'UPDATE_BACKEND_SESSION': {
      // Optimistic local update first, then push. On failure, restore the
      // cached pre-edit version so the UI doesn't show a stale value.
      const before = await cache.getSession(payload.sessionId);
      if (before && payload.patch?.duration_ms !== undefined) {
        const newMs = payload.patch.duration_ms;
        await cache.upsertSession({
          ...before,
          durationMs: newMs,
          durationHours: Math.round((newMs / 3_600_000) * 4) / 4,
          startedAt: before.completedAt - newMs,
          syncStatus: 'dirty',
        });
      }
      try {
        const updated = await updateBackendSession(payload.sessionId, payload.patch);
        await cache.upsertSession(cache.fromBackendSession(updated));
        return { ok: true, session: updated };
      } catch (err) {
        if (before) await cache.upsertSession(before); // restore
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'DELETE_BACKEND_SESSION': {
      // Optimistic local removal, restore on failure.
      const before = await cache.removeSession(payload.sessionId);
      try {
        await deleteBackendSession(payload.sessionId);
        return { ok: true };
      } catch (err) {
        if (before) await cache.upsertSession(before);
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'ADMIN_LIST_MEMBERS': {
      try {
        const members = await listBackendMembers();
        return { ok: true, members };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'ADMIN_UPSERT_MEMBER': {
      try {
        const member = await upsertBackendMember(payload);
        return { ok: true, member };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'ADMIN_GET_ORG_CONFIG': {
      try {
        const config = await getBackendOrgConfig();
        return { ok: true, config };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'ADMIN_PUT_ORG_CONFIG': {
      try {
        const config = await putBackendOrgConfig(payload);
        return { ok: true, config };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'CACHE_COUNTS': {
      return { ok: true, ...(await cache.counts()), lastSyncAt: await cache.getLastSyncAt() };
    }

    case 'BACKFILL_LOCAL': {
      // Push every item in legacy completedSessions[] that isn't already on
      // the backend. We have no way to know "already on the backend" without
      // a round-trip per item; cheap heuristic: synthesise a session_id from
      // (repo, issue_number, completedAt) so re-runs are idempotent.
      const legacy = await getLegacyCompleted();
      const queued = [];
      for (const s of legacy) {
        const stableId = await stableSessionId(s);
        const payload = toBackendSession(
          {
            sessionId: stableId,
            repo: s.repo,
            issueNumber: s.issueNumber,
            issueTitle: s.issueTitle,
            sourceUrl: null,
            startedAtMs: s.completedAt - s.durationMs,
            durationMs: s.durationMs,
            completedAt: s.completedAt,
          },
          null
        );
        await enqueueSession(payload);
        queued.push(stableId);
      }
      startAlarm();
      const flushed = await flushQueue();
      return { ok: true, queued: queued.length, flushed };
    }

    default:
      return { error: `Unknown action: ${action}` };
  }
}
