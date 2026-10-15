import '../lib/time-format.js';
import '../lib/ui.js';
import { syncIssueTimeToProjects } from './github-api.js';
import { flushQueue, queueStatus } from './sync-queue.js';
import { withLock } from './lock.js';
import {
  getSessionTotals,
  syncProjects as syncBackendProjects,
} from './takt-api.js';
import * as cache from './local-store.js';

export const ALARM_NAME = 'takt-tick';
export const TAKT_VERSION = chrome.runtime.getManifest().version;

export async function getState() {
  const { activeSession = null } =
    await chrome.storage.local.get(['activeSession']);
  return { activeSession };
}

export async function saveSession(activeSession) {
  await chrome.storage.local.set({ activeSession });
}

export function toBackendSession(completed, linkedProjects = []) {
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
  const durationHours = self.TaktTime.roundQuarterHours(completed.durationMs);
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

export async function recomputeProjectField(repo, issueNumber) {
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
    const localSessions = await cache.listSessions({ limit: 5000 });
    const localTotalMs = localSessions
      .filter((session) => session.repo === repo && session.issueNumber === issueNumber)
      .reduce((sum, session) => sum + (session.durationMs || 0), 0);
    const localTotal = localTotalMs / 3_600_000;
    if (localTotal <= 0) {
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

export async function afterPush(payload, response) {
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

export async function drainQueue() {
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

export function startAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

function clearAlarm() {
  chrome.alarms.clear(ALARM_NAME);
}

export async function maybeClearAlarm() {
  const active = await withLock('timer', async () => {
    const { activeSession } = await getState();
    return Boolean(activeSession);
  });
  if (!active && (await queueStatus()).pending === 0) clearAlarm();
}
