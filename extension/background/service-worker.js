import {
  syncIssueTimeToProjects,
  getLinkedProjects,
  postTimeComment,
  fetchAllProjects,
  fetchProjectNumberFields,
  fetchOrgRepos,
  fetchRepoProjects,
  fetchProjectIssues,
  fetchUserOrgs,
  TAKT_ORG,
} from './github-api.js';
import {
  discardFailed,
  enqueueSession,
  flushQueue,
  pushOne,
  queueLength,
  queueStatus,
  retryFailed,
} from './sync-queue.js';
import { withLock } from './lock.js';
import {
  getMe as getBackendMe,
  ping as pingBackend,
  listSessions as listBackendSessions,
  updateSession as updateBackendSession,
  deleteSession as deleteBackendSession,
  listMembers as listBackendMembers,
  upsertMember as upsertBackendMember,
  getOrgConfig as getBackendOrgConfig,
  putOrgConfig as putBackendOrgConfig,
  getSessionTotals,
  getBigQuerySyncStatus,
  pushBigQuery,
  listClients as listBackendClients,
  createClient as createBackendClient,
  mapClientProject as mapBackendClientProject,
  mapProjectRepository as mapBackendProjectRepository,
  syncProjects as syncBackendProjects,
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

function computeElapsed(session) {
  if (!session) return 0;
  const running =
    session.status === 'running' ? Date.now() - session.startedAt : 0;
  return session.accumulatedMs + running;
}

// --- Backend payload shaping ---

function toBackendSession(completed, linkedProjects = []) {
  const source = completed.source
    || (completed.sourceUrl && completed.issueNumber > 0 ? 'github' : 'manual');
  const orderedProjects = [...linkedProjects].sort((a, b) =>
    String(a.projectId || '').localeCompare(String(b.projectId || ''))
  );
  let selectedProject = completed.reportingProjectId
    ? { projectId: completed.reportingProjectId, title: completed.project }
    : orderedProjects[0] || null;
  if (!selectedProject && source === 'github' && completed.repo) {
    selectedProject = { projectId: `repo:${completed.repo}`, title: completed.repo };
  }
  const entryType = source === 'github'
    ? 'delivery'
    : (completed.entryType || (selectedProject ? 'delivery' : 'ops'));
  const repo = entryType === 'ops' ? null : (completed.repo || null);
  const issueNumber = entryType === 'ops' ? 0 : (completed.issueNumber || 0);
  const isGh = /^[^/\s]+\/[^/\s]+$/.test(repo || '');
  const issueUrl = (isGh && issueNumber > 0)
    ? `https://github.com/${repo}/issues/${issueNumber}` : null;
  const associations = [...orderedProjects];
  if (selectedProject?.projectId
      && !associations.some((project) => project.projectId === selectedProject.projectId)) {
    associations.push(selectedProject);
  }
  const projectIds = associations.map((project) => project.projectId).filter(Boolean);
  const projectTitles = associations.map((project) => project.title);
  const durationHours = Math.round((completed.durationMs / 3600000) * 4) / 4;
  const githubMetadata = source === 'github'
    ? {
        schema_version: 1,
        repository: repo,
        issue_number: issueNumber,
        issue_title: completed.issueTitle || null,
        issue_url: issueUrl,
        source_url: completed.sourceUrl || null,
        linked_projects: associations.map((project) => ({
          project_id: project.projectId,
          title: project.title,
        })),
      }
    : {};

  return {
    session_id: completed.sessionId,
    source,
    type: entryType,
    client_id: completed.clientId ?? null,
    repo,
    reporting_project_id: selectedProject?.projectId || null,
    project: selectedProject?.title || null,
    issue_number: issueNumber,
    issue_title: completed.issueTitle || null,
    description: completed.description || completed.issueTitle || null,
    github_metadata: githubMetadata,
    issue_url: issueUrl,
    started_at: new Date(completed.startedAtMs).toISOString(),
    completed_at: new Date(completed.completedAt).toISOString(),
    duration_ms: completed.durationMs,
    duration_hours: durationHours,
    source_url: completed.sourceUrl || null,
    synced_to_project: projectIds.length > 0,
    project_titles: projectTitles,
    project_ids: projectIds,
    takt_version: TAKT_VERSION,
    client_ts: new Date().toISOString(),
    // Only historical manual entries may be attributed by an admin. Live
    // timers deliberately omit this so the server attributes them to caller.
    ...(completed.memberLogin ? { member_login: completed.memberLogin } : {}),
  };
}

// Pull the authoritative total from the backend for (repo, issue) and
// overwrite the linked GitHub Project field with it. Replaces the old
// additive STOP-time sync so edits and deletes also propagate.
//
// Safe to call even when nothing should happen — short-circuits when:
//   - issue_number is the manual-entry sentinel (0)
//   - the repo isn't an owner/name slug (freeform meeting/PM label)
//   - PAT or backend isn't configured
//
// Returns the shape the old syncToGitHub used to produce, so the STOP
// handler can keep showing the same in-page status pill.
async function recomputeProjectField(repo, issueNumber) {
  if (!issueNumber || issueNumber <= 0) {
    return { skipped: true, reason: 'No linked issue' };
  }
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { skipped: true, reason: 'Not a GitHub repo' };
  }
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!settings.pat) return { skipped: true, reason: 'No PAT configured' };

  let totalHours;
  let fallbackUsed = false;
  try {
    const resp = await getSessionTotals(repo, issueNumber);
    totalHours = resp.total_hours || 0;
  } catch (err) {
    // Server may be on an older deploy that doesn't have /v1/sessions/totals
    // (FastAPI routes "/totals" to the /{session_id} PUT/DELETE pattern and
    // returns 405). Fall back to summing the local cache so the project
    // field still reflects at least the current user's just-saved time.
    // After the server is redeployed, the next mutation pulls the
    // authoritative total and the field converges.
    const localSessions = await cache.listSessions({ limit: 5000 });
    // Sum durationMs (exact) rather than durationHours (quarter-hour
    // rounded) — otherwise short sessions vanish from the total and
    // we'd write 0 to the field, wiping the existing value.
    const localTotalMs = localSessions
      .filter((s) => s.repo === repo && s.issueNumber === issueNumber)
      .reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const localTotal = localTotalMs / 3_600_000;
    if (localTotal <= 0) {
      // No local rows — writing 0 would wipe whatever the field already
      // holds for other users. Safer to leave it alone and surface the
      // upstream error so the user knows to redeploy the backend.
      return { error: `Totals fetch failed: ${err.message}` };
    }
    totalHours = localTotal;
    fallbackUsed = true;
    console.warn(
      '[Takt] /v1/sessions/totals unavailable, falling back to local cache sum (',
      totalHours, 'h). Redeploy the backend to get cross-user totals.',
      err
    );
  }
  const result = await syncIssueTimeToProjects(
    settings.pat, repo, issueNumber, totalHours, settings
  );
  if (fallbackUsed) result.fallback = 'local_cache';
  return result;
}

async function afterPush(payload, response) {
  const projects = (payload.project_ids || [])
    .map((projectId, index) => ({
      project_id: projectId,
      title: payload.project_titles?.[index],
    }))
    .filter((project) => project.project_id && project.title);
  if (projects.length) {
    try {
      await syncBackendProjects(projects);
    } catch (err) {
      console.warn('[Takt] Project sync failed (non-fatal):', err.message);
    }
  }

  if (!payload.member_login) {
    if (response?.session_id) {
      await cache.upsertSession(cache.fromBackendSession(response));
    } else {
      await cache.upsertSession({
        sessionId: payload.session_id,
        syncedToProject: payload.synced_to_project,
        projectTitles: payload.project_titles,
        projectIds: payload.project_ids,
        syncStatus: 'synced',
        syncedAt: Date.now(),
      });
    }
  }
}

async function drainQueue() {
  const result = await flushQueue();
  const recompute = new Map();

  for (const { payload, response } of result.drained) {
    await afterPush(payload, response);
    if (payload.issue_number > 0) {
      const key = `${payload.repo}#${payload.issue_number}`;
      recompute.set(key, [payload.repo, payload.issue_number]);
    }
  }

  for (const [repo, issueNumber] of recompute.values()) {
    recomputeProjectField(repo, issueNumber).catch((err) =>
      console.warn('[Takt] project recompute (drain) failed:', err)
    );
  }

  for (const { payload, error } of result.failed) {
    if (payload.member_login) continue;
    await cache.upsertSession({
      sessionId: payload.session_id,
      syncStatus: 'error',
      syncError: error?.message || String(error),
    });
  }

  if ((await queueStatus()).pending > 0) startAlarm();
  return result;
}

// --- Alarm keep-alive ---

function startAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

function clearAlarm() {
  chrome.alarms.clear(ALARM_NAME);
}

async function maybeClearAlarm() {
  const active = await withLock('timer', async () => {
    const { activeSession } = await getState();
    return Boolean(activeSession);
  });
  if (!active && (await queueStatus()).pending === 0) clearAlarm();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  try {
    await drainQueue();
  } catch (err) {
    console.warn('[Takt] queue drain error:', err);
  }

  const { activeSession } = await getState();
  if (!activeSession) {
    await maybeClearAlarm();
    return;
  }
  // Broadcast tick so any open content scripts / popup can sync
  broadcastTick(activeSession);
});

async function onWake() {
  try {
    await drainQueue();
  } catch (err) {
    console.warn('[Takt] queue drain on wake failed:', err);
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
  handleMessage(message).then(
    sendResponse,
    (err) => sendResponse({ ok: false, error: err?.message || String(err) })
  );
  return true; // async response
});

async function handleMessage({ action, payload }) {
  const activeSession = ['START', 'PAUSE', 'RESUME', 'SET_TIME', 'STOP'].includes(action)
    ? null
    : (await getState()).activeSession;

  switch (action) {
    case 'START': {
      return withLock('timer', async () => {
        const { activeSession } = await getState();
        if (activeSession) {
          const ref = activeSession.issueNumber > 0
            ? `${activeSession.repo}#${activeSession.issueNumber}`
            : (activeSession.description || activeSession.client || 'another task');
          return { error: `Timer already active on ${ref}` };
        }
        const issueNum = Number.isFinite(payload.issueNumber) && payload.issueNumber > 0
          ? payload.issueNumber : 0;
        const source = payload.source || (payload.sourceUrl && issueNum > 0 ? 'github' : 'manual');
        const entryType = source === 'github' ? 'delivery' : (payload.entryType || 'ops');
        const startedAt = Date.now();
        const session = {
          sessionId: crypto.randomUUID(),
          source,
          entryType,
          clientId: payload.clientId ?? null,
          client: payload.client || null,
          repo: entryType === 'ops' ? null : (payload.repo || null),
          reportingProjectId: payload.reportingProjectId || null,
          project: payload.project || null,
          issueNumber: entryType === 'ops' ? 0 : issueNum,
          issueTitle: entryType === 'ops' ? null : (payload.issueTitle || null),
          description: payload.description || payload.issueTitle || null,
          sourceUrl: payload.sourceUrl || null,
          startedAt,
          firstStartedAt: startedAt,
          accumulatedMs: 0,
          status: 'running',
        };
        await saveSession(session);
        startAlarm();
        return { ok: true, session };
      });
    }

    case 'PAUSE': {
      const result = await withLock('timer', async () => {
        const { activeSession } = await getState();
        if (!activeSession || activeSession.status !== 'running') {
          return { error: 'No running session to pause' };
        }
        activeSession.accumulatedMs += Date.now() - activeSession.startedAt;
        activeSession.startedAt = null;
        activeSession.status = 'paused';
        await saveSession(activeSession);
        return { ok: true, session: activeSession };
      });
      await maybeClearAlarm();
      return result;
    }

    case 'RESUME': {
      return withLock('timer', async () => {
        const { activeSession } = await getState();
        if (!activeSession || activeSession.status !== 'paused') {
          return { error: 'No paused session to resume' };
        }
        activeSession.startedAt = Date.now();
        activeSession.status = 'running';
        await saveSession(activeSession);
        startAlarm();
        return { ok: true, session: activeSession };
      });
    }

    case 'SET_TIME': {
      return withLock('timer', async () => {
        const { activeSession } = await getState();
        if (!activeSession) {
          return { error: 'No active session to update' };
        }
        const newMs = payload.ms;
        if (typeof newMs !== 'number' || newMs < 0) {
          return { error: 'Invalid time value' };
        }
        if (activeSession.status === 'running') {
          activeSession.accumulatedMs = newMs;
          activeSession.startedAt = Date.now();
        } else {
          activeSession.accumulatedMs = newMs;
        }
        await saveSession(activeSession);
        return { ok: true, session: activeSession };
      });
    }

    case 'STOP': {
      const completed = await withLock('timer', async () => {
        const { activeSession } = await getState();
        if (!activeSession) return null;
        const durationMs = computeElapsed(activeSession);
        const completedAt = Date.now();
        const startedAtMs = activeSession.firstStartedAt
          ?? (completedAt - durationMs);
        const completedSession = {
          sessionId: activeSession.sessionId || crypto.randomUUID(),
          source: activeSession.source || 'manual',
          entryType: activeSession.entryType || 'ops',
          clientId: activeSession.clientId ?? null,
          client: activeSession.client || null,
          repo: activeSession.repo,
          reportingProjectId: activeSession.reportingProjectId || null,
          project: activeSession.project || null,
          issueNumber: activeSession.issueNumber,
          issueTitle: activeSession.issueTitle,
          description: activeSession.description || activeSession.issueTitle || null,
          sourceUrl: activeSession.sourceUrl || null,
          startedAtMs,
          durationMs,
          completedAt,
        };
        await saveSession(null);
        return completedSession;
      });
      if (!completed) {
        console.log('[Takt] STOP: no active session');
        return { error: 'No active session to stop' };
      }

      console.log('[Takt] STOP:', completed.repo, '#' + completed.issueNumber);
      const durationHoursForCache =
        Math.round((completed.durationMs / 3600000) * 4) / 4;
      const isGhStop = /^[^/\s]+\/[^/\s]+$/.test(completed.repo || '');
      await cache.upsertSession({
        sessionId: completed.sessionId,
        source: completed.source,
        entryType: completed.entryType,
        clientId: completed.clientId,
        client: completed.client,
        repo: completed.repo,
        reportingProjectId: completed.reportingProjectId,
        project: completed.project,
        issueNumber: completed.issueNumber,
        issueTitle: completed.issueTitle ?? null,
        description: completed.description,
        githubMetadata: {},
        issueUrl: (isGhStop && completed.issueNumber > 0)
          ? `https://github.com/${completed.repo}/issues/${completed.issueNumber}`
          : null,
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

      const initialPayload = toBackendSession(completed, []);
      await enqueueSession(initialPayload, { holdMs: 60_000 });
      startAlarm();

      let linkedProjects = [];
      try {
        const { settings = {} } = await chrome.storage.local.get('settings');
        if (settings.pat && completed.entryType === 'delivery' && completed.issueNumber > 0) {
          linkedProjects = await getLinkedProjects(
            settings.pat, completed.repo, completed.issueNumber, settings
          );
        }
      } catch (err) {
        console.warn('[Takt] linked-projects lookup (stop) failed:', err.message);
      }

      const payload = toBackendSession(completed, linkedProjects);
      const pushResult = await pushOne(payload);
      const backendResult = pushResult.ok
        ? { ok: true, session_id: payload.session_id }
        : {
            ok: false,
            queued: !pushResult.failed,
            failed: pushResult.failed,
            error: pushResult.error.message,
            code: pushResult.error.code,
          };
      if (pushResult.ok) {
        await afterPush(payload, pushResult.response);
      } else if (pushResult.failed) {
        await cache.upsertSession({
          sessionId: completed.sessionId,
          syncStatus: 'error',
          syncError: pushResult.error.message,
        });
      }

      let syncResult = null;
      if (backendResult?.ok) {
        try {
          syncResult = await recomputeProjectField(
            completed.repo, completed.issueNumber
          );
        } catch (err) {
          syncResult = { error: err.message };
        }
      } else {
        syncResult = { skipped: true, reason: 'Backend push deferred — will sync on retry' };
      }

      let commentResult = null;
      try {
        const ghRepo = /^[^/\s]+\/[^/\s]+$/.test(completed.repo);
        if (backendResult?.ok && ghRepo && completed.issueNumber > 0) {
          const { settings } = await chrome.storage.local.get('settings');
          if (settings?.pat) {
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
        }
      } catch (err) {
        commentResult = { error: err.message };
      }

      await maybeClearAlarm();
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

    case 'FETCH_USER_REPOS': {
      // Pulls org repos from GitHub and caches them under
      // settings.knownReposByOrg[org] so the My Time "Add entry" picker can
      // render instantly without a round-trip per open. Defaults to the
      // primary Takt org for backward compat. Personal repos are
      // deliberately excluded — Takt is scoped to orgs.
      const { settings = {} } = await chrome.storage.local.get('settings');
      if (!settings.pat) {
        return { ok: false, error: { code: 'no_pat', message: 'No PAT configured' } };
      }
      const org = payload?.org || TAKT_ORG;
      try {
        const repos = await fetchOrgRepos(settings.pat, org);
        const knownReposByOrg = { ...(settings.knownReposByOrg || {}), [org]: repos };
        const next = { ...settings, knownReposByOrg };
        // Mirror the primary-org list into the legacy `knownRepos` field so
        // older surfaces that still read it keep working.
        if (org === TAKT_ORG) next.knownRepos = repos;
        await chrome.storage.local.set({ settings: next });
        return { ok: true, org, repos };
      } catch (err) {
        return { ok: false, error: { code: 'fetch_failed', message: err.message } };
      }
    }

    case 'FETCH_USER_ORGS': {
      // Lists GitHub orgs the PAT user belongs to so the Add-entry modal can
      // populate its Organization dropdown. Cached on settings.knownOrgs so
      // the modal opens without waiting on the network.
      const { settings = {} } = await chrome.storage.local.get('settings');
      if (!settings.pat) {
        return { ok: false, error: { code: 'no_pat', message: 'No PAT configured' } };
      }
      try {
        const orgs = await fetchUserOrgs(settings.pat);
        await chrome.storage.local.set({
          settings: { ...settings, knownOrgs: orgs },
        });
        return { ok: true, orgs };
      } catch (err) {
        return { ok: false, error: { code: 'fetch_failed', message: err.message } };
      }
    }

    case 'FETCH_REPO_PROJECTS': {
      // For the Add-entry cascading dropdown: list Projects v2 linked to
      // the chosen repo. Returns [{ id, title, number }].
      const { settings = {} } = await chrome.storage.local.get('settings');
      if (!settings.pat) {
        return { ok: false, error: { code: 'no_pat', message: 'No PAT configured' } };
      }
      const repo = payload?.repo;
      if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        return { ok: false, error: { code: 'invalid_repo', message: 'Repo must be owner/name.' } };
      }
      const [owner, name] = repo.split('/');
      try {
        const projects = await fetchRepoProjects(settings.pat, owner, name);
        return { ok: true, projects };
      } catch (err) {
        return { ok: false, error: { code: 'fetch_failed', message: err.message } };
      }
    }

    case 'FETCH_PROJECT_ISSUES': {
      // For the Add-entry cascading dropdown: list issues in a project,
      // optionally filtered to a specific repo. Returns
      // [{ number, title, repo, state }].
      const { settings = {} } = await chrome.storage.local.get('settings');
      if (!settings.pat) {
        return { ok: false, error: { code: 'no_pat', message: 'No PAT configured' } };
      }
      const projectId = payload?.projectId;
      const repoFilter = payload?.repo || null;
      if (!projectId) {
        return { ok: false, error: { code: 'invalid_input', message: 'projectId required.' } };
      }
      try {
        const issues = await fetchProjectIssues(settings.pat, projectId, repoFilter);
        return { ok: true, issues };
      } catch (err) {
        return { ok: false, error: { code: 'fetch_failed', message: err.message } };
      }
    }

    case 'FETCH_PROJECT_REPOS': {
      const { settings = {} } = await chrome.storage.local.get('settings');
      if (!settings.pat || !payload?.projectId) {
        return { ok: false, error: { code: 'invalid_input', message: 'PAT and project required.' } };
      }
      try {
        const issues = await fetchProjectIssues(settings.pat, payload.projectId);
        return { ok: true, repos: [...new Set(issues.map((issue) => issue.repo))].sort() };
      } catch (err) {
        return { ok: false, error: { code: 'fetch_failed', message: err.message } };
      }
    }

    case 'BACKEND_PING': {
      // Used by options/popup to show a green/red status pip.
      const result = await pingBackend();
      return result;
    }

    case 'FLUSH_QUEUE': {
      const result = await drainQueue();
      return { ok: true, ...result };
    }

    case 'QUEUE_STATUS': {
      return { ok: true, ...(await queueStatus()) };
    }

    case 'QUEUE_LENGTH': {
      return { ok: true, length: await queueLength() };
    }

    case 'RETRY_FAILED': {
      await retryFailed(payload?.sessionId);
      return { ok: true, ...(await drainQueue()) };
    }

    case 'DISCARD_FAILED': {
      await discardFailed(payload?.sessionId);
      if (payload?.sessionId) await cache.removeSession(payload.sessionId);
      return { ok: true };
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
        const { skipReconcile, backendOnly = false, ...apiParams } = payload || {};
        const sessions = await listBackendSessions(apiParams);
        const records = sessions.map(cache.fromBackendSession);
        // An admin viewing another member is a backend-only operation. Never
        // merge those records into the caller's local-first cache, otherwise
        // popup totals and later "My Time" reads would leak across users.
        if (!skipReconcile && !backendOnly) {
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
      const before = payload.backendOnly ? null : await cache.getSession(payload.sessionId);
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
        if (!payload.backendOnly) await cache.upsertSession(cache.fromBackendSession(updated));
        // Push the new total back to any linked GitHub Project. Fire-and-
        // forget — the UI doesn't block on this, errors get logged.
        recomputeProjectField(updated.repo, updated.issue_number)
          .catch((err) => console.warn('[Takt] project recompute (update) failed:', err));
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
        if (before) {
          recomputeProjectField(before.repo, before.issueNumber)
            .catch((err) => console.warn('[Takt] project recompute (delete) failed:', err));
        }
        return { ok: true };
      } catch (err) {
        if (before) await cache.upsertSession(before);
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'GET_BACKEND_ME': {
      try {
        const me = await getBackendMe();
        return { ok: true, me };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'GET_BIGQUERY_SYNC_STATUS': {
      try {
        return { ok: true, status: await getBigQuerySyncStatus() };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'PUSH_BIGQUERY': {
      try {
        return { ok: true, result: await pushBigQuery() };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'LIST_CLIENTS': {
      try {
        return { ok: true, clients: await listBackendClients() };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'ADMIN_CREATE_CLIENT': {
      try {
        return { ok: true, client: await createBackendClient(payload) };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'ADMIN_MAP_CLIENT_PROJECT': {
      try {
        return {
          ok: true,
          client: await mapBackendClientProject(payload.clientId, payload.project),
        };
      } catch (err) {
        return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
      }
    }

    case 'ADMIN_MAP_PROJECT_REPO': {
      try {
        return {
          ok: true,
          client: await mapBackendProjectRepository(
            payload.clientId, payload.projectId, payload.repo
          ),
        };
      } catch (err) {
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

    case 'ADD_MANUAL_SESSION': {
      // Manual entry from My Time. Mirrors the STOP write path: optimistic
      // cache insert, then push to backend; on failure the queue retries.
      // Unlike STOP, we don't post a GitHub comment (the user is
      // reconstructing past work, not closing a fresh timer). We DO
      // recompute the GitHub Project field — once the row is in BigQuery
      // it counts toward the issue's tracked total just like a STOP row.
      const {
        source = 'manual', entryType, clientId, client, repo,
        reportingProjectId, project, issueNumber, issueTitle, description,
        memberLogin, completedAt, durationMs,
      } = payload || {};
      const issueNum = Number.isFinite(issueNumber) && issueNumber > 0 ? issueNumber : 0;
      const delivery = entryType === 'delivery';
      const normalizedClientId = Number(clientId);
      const missing = [];
      if (!Number.isFinite(completedAt)) missing.push('date');
      if (!Number.isFinite(durationMs) || durationMs <= 0) missing.push('duration');
      if (!Number.isInteger(normalizedClientId) || normalizedClientId <= 0) missing.push('client');
      if (!String(description || '').trim()) missing.push('description');
      if (delivery && !String(reportingProjectId || '').trim()) missing.push('project ID');
      if (delivery && !String(project || '').trim()) missing.push('project name');
      if (!['delivery', 'ops'].includes(entryType)) missing.push('entry type');
      if (missing.length) {
        return {
          ok: false,
          error: {
            code: 'invalid_input',
            message: `Missing or invalid: ${missing.join(', ')}.`,
          },
        };
      }

      const sessionId = crypto.randomUUID();
      const startedAtMs = completedAt - durationMs;
      const durationHoursForCache = Math.round((durationMs / 3_600_000) * 4) / 4;
      const normalizedRepo = delivery ? (String(repo || '').trim() || null) : null;
      const normalizedIssue = delivery ? issueNum : 0;
      const linkedProjects = delivery
        ? [{ projectId: reportingProjectId, title: project }]
        : [];

      if (!memberLogin) await cache.upsertSession({
        sessionId,
        source,
        entryType,
        clientId: normalizedClientId,
        client,
        repo: normalizedRepo,
        reportingProjectId: delivery ? reportingProjectId : null,
        project: delivery ? project : null,
        issueNumber: normalizedIssue,
        issueTitle: normalizedIssue > 0 ? issueTitle : null,
        description,
        githubMetadata: {},
        issueUrl: normalizedRepo && normalizedIssue > 0
          ? `https://github.com/${normalizedRepo}/issues/${normalizedIssue}` : null,
        sourceUrl: null,
        startedAt: startedAtMs,
        completedAt,
        durationMs,
        durationHours: durationHoursForCache,
        durationHoursExact: durationMs / 3_600_000,
        syncedToProject: delivery,
        projectTitles: linkedProjects.map((item) => item.title),
        projectIds: linkedProjects.map((item) => item.projectId),
        taktVersion: TAKT_VERSION,
        syncStatus: 'pending',
        syncedAt: null,
      });

      const completed = {
        sessionId,
        source,
        entryType,
        clientId: normalizedClientId,
        client,
        repo: normalizedRepo,
        reportingProjectId: delivery ? reportingProjectId : null,
        project: delivery ? project : null,
        issueNumber: normalizedIssue,
        issueTitle: normalizedIssue > 0 ? issueTitle : null,
        description,
        memberLogin: memberLogin || null,
        sourceUrl: null,
        startedAtMs,
        durationMs,
        completedAt,
      };
      const backendPayload = toBackendSession(completed, linkedProjects);
      await enqueueSession(backendPayload);
      startAlarm();
      const pushResult = await pushOne(backendPayload);
      const backendResult = pushResult.ok
        ? { ok: true, session_id: backendPayload.session_id }
        : {
            ok: false,
            queued: !pushResult.failed,
            failed: pushResult.failed,
            error: pushResult.error.message,
            code: pushResult.error.code,
          };
      if (pushResult.ok) {
        await afterPush(backendPayload, pushResult.response);
      } else if (pushResult.failed && !memberLogin) {
        await cache.upsertSession({
          sessionId,
          syncStatus: 'error',
          syncError: pushResult.error.message,
        });
      }
      if (backendResult?.ok && normalizedIssue > 0) {
        recomputeProjectField(normalizedRepo, normalizedIssue)
          .catch((err) => console.warn('[Takt] project recompute (add) failed:', err));
      }
      await maybeClearAlarm();
      return { ok: true, sessionId, backendResult };
    }

    default:
      return { error: `Unknown action: ${action}` };
  }
}
