import { withLock } from '../lock.js';
import * as cache from '../local-store.js';
import { enqueueSession, pushOne } from '../sync-queue.js';
import { getLinkedProjects, postTimeComment } from '../github-api.js';
import {
  afterPush,
  getState,
  maybeClearAlarm,
  recomputeProjectField,
  saveSession,
  startAlarm,
  TAKT_VERSION,
  toBackendSession,
} from '../worker-shared.js';

export const timerHandlers = {
  START: async (payload) => withLock('timer', async () => {
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
  }),

  PAUSE: async () => {
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
  },

  RESUME: async () => withLock('timer', async () => {
    const { activeSession } = await getState();
    if (!activeSession || activeSession.status !== 'paused') {
      return { error: 'No paused session to resume' };
    }
    activeSession.startedAt = Date.now();
    activeSession.status = 'running';
    await saveSession(activeSession);
    startAlarm();
    return { ok: true, session: activeSession };
  }),

  SET_TIME: async (payload) => withLock('timer', async () => {
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
  }),

  STOP: async () => {
    const completed = await withLock('timer', async () => {
      const { activeSession } = await getState();
      if (!activeSession) return null;
      const durationMs = self.TaktUI.computeElapsed(activeSession);
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
      self.TaktTime.roundQuarterHours(completed.durationMs);
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
      syncedToProject: false,
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
      if (completed.durationMs >= 60_000 && ghRepo && completed.issueNumber > 0) {
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
            await postTimeComment(
              settings.pat, owner, repo, completed.issueNumber,
              completed.durationMs, username
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
  },

  GET_STATE: async () => {
    const { activeSession } = await getState();
    return {
      activeSession,
      elapsedMs: self.TaktUI.computeElapsed(activeSession),
    };
  },
};
