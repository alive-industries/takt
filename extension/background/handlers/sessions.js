import * as cache from '../local-store.js';
import {
  discardFailed,
  enqueueSession,
  flushQueue,
  pushOne,
  queueLength,
  queueStatus,
  retryFailed,
} from '../sync-queue.js';
import {
  deleteSession as deleteBackendSession,
  getMe as getBackendMe,
  listSessions as listBackendSessions,
  ping as pingBackend,
  updateSession as updateBackendSession,
} from '../takt-api.js';
import {
  afterPush,
  drainQueue,
  maybeClearAlarm,
  recomputeProjectField,
  startAlarm,
  TAKT_VERSION,
  toBackendSession,
} from '../worker-shared.js';

export const sessionHandlers = {
  BACKEND_PING: async () => pingBackend(),

  FLUSH_QUEUE: async () => {
    const result = await drainQueue();
    return { ok: true, ...result };
  },

  QUEUE_STATUS: async () => ({ ok: true, ...(await queueStatus()) }),

  QUEUE_LENGTH: async () => ({ ok: true, length: await queueLength() }),

  RETRY_FAILED: async (payload) => {
    await retryFailed(payload?.sessionId);
    return { ok: true, ...(await drainQueue()) };
  },

  DISCARD_FAILED: async (payload) => {
    const discarded = await discardFailed(payload?.sessionId);
    if (discarded && payload?.sessionId) await cache.removeSession(payload.sessionId);
    return { ok: true, discarded };
  },

  LIST_LOCAL_SESSIONS: async (payload) => {
    const sessions = await cache.listSessions(payload || {});
    const counts = await cache.counts();
    const lastSyncAt = await cache.getLastSyncAt();
    return { ok: true, sessions, counts, lastSyncAt };
  },

  LIST_BACKEND_SESSIONS: async (payload) => {
    try {
      const {
        skipReconcile,
        backendOnly = false,
        reconcileFrom,
        reconcileTo,
        ...apiParams
      } = payload || {};
      const sessions = await listBackendSessions(apiParams);
      const records = sessions.map(cache.fromBackendSession);
      if (!skipReconcile && !backendOnly) {
        await cache.reconcileWindow({
          from: reconcileFrom ?? apiParams.from,
          to: reconcileTo ?? apiParams.to,
          records,
        });
      }
      return { ok: true, sessions, records };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  UPDATE_BACKEND_SESSION: async (payload) => {
    const before = payload.backendOnly ? null : await cache.getSession(payload.sessionId);
    if (before && payload.patch?.duration_ms !== undefined) {
      const newMs = payload.patch.duration_ms;
      await cache.upsertSession({
        ...before,
        durationMs: newMs,
        durationHours: self.TaktTime.roundQuarterHours(newMs),
        startedAt: before.completedAt - newMs,
        syncStatus: 'dirty',
      });
    }
    try {
      const updated = await updateBackendSession(payload.sessionId, payload.patch);
      if (!payload.backendOnly) await cache.upsertSession(cache.fromBackendSession(updated));
      recomputeProjectField(updated.repo, updated.issue_number)
        .catch((err) => console.warn('[Takt] project recompute (update) failed:', err));
      return { ok: true, session: updated };
    } catch (err) {
      if (before) await cache.upsertSession(before);
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  DELETE_BACKEND_SESSION: async (payload) => {
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
  },

  GET_BACKEND_ME: async () => {
    try {
      const me = await getBackendMe();
      return { ok: true, me };
    } catch (err) {
      return { ok: false, error: { code: err.code, message: err.message, status: err.status } };
    }
  },

  CACHE_COUNTS: async () => ({
    ok: true,
    ...(await cache.counts()),
    lastSyncAt: await cache.getLastSyncAt(),
  }),

  ADD_MANUAL_SESSION: async (payload) => {
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
    const durationHoursForCache = self.TaktTime.roundQuarterHours(durationMs);
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
  },
};
