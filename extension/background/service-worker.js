import { syncToGitHub, fetchAllProjects, fetchProjectNumberFields } from './github-api.js';

const ALARM_NAME = 'takt-tick';
const MAX_COMPLETED = 50;

// --- State helpers ---

async function getState() {
  const { activeSession = null, completedSessions = [] } =
    await chrome.storage.local.get(['activeSession', 'completedSessions']);
  return { activeSession, completedSessions };
}

async function saveSession(activeSession) {
  await chrome.storage.local.set({ activeSession });
}

async function pushCompleted(session, completedSessions) {
  completedSessions.unshift(session);
  if (completedSessions.length > MAX_COMPLETED) {
    completedSessions.length = MAX_COMPLETED;
  }
  await chrome.storage.local.set({ completedSessions });
}

function computeElapsed(session) {
  if (!session) return 0;
  const running =
    session.status === 'running' ? Date.now() - session.startedAt : 0;
  return session.accumulatedMs + running;
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
  const { activeSession } = await getState();
  if (!activeSession) {
    clearAlarm();
    return;
  }
  // Broadcast tick so any open content scripts / popup can sync
  broadcastTick(activeSession);
});

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
  const { activeSession, completedSessions } = await getState();

  switch (action) {
    case 'START': {
      if (activeSession) {
        return {
          error: `Timer already active on ${activeSession.repo}#${activeSession.issueNumber}`,
        };
      }
      const session = {
        repo: payload.repo,
        issueNumber: payload.issueNumber,
        issueTitle: payload.issueTitle,
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
      const completed = {
        repo: activeSession.repo,
        issueNumber: activeSession.issueNumber,
        issueTitle: activeSession.issueTitle,
        durationMs,
        completedAt: Date.now(),
      };
      await saveSession(null);
      await pushCompleted(completed, completedSessions);
      clearAlarm();

      // Attempt GitHub sync (non-blocking for the response)
      let syncResult = null;
      try {
        syncResult = await syncToGitHub(completed);
      } catch (err) {
        syncResult = { error: err.message };
      }

      return { ok: true, completed, syncResult };
    }

    case 'GET_STATE': {
      return {
        activeSession,
        elapsedMs: computeElapsed(activeSession),
        completedSessions,
      };
    }

    case 'DELETE_SESSION': {
      const index = payload.index;
      if (typeof index !== 'number' || index < 0 || index >= completedSessions.length) {
        return { error: 'Invalid session index' };
      }
      completedSessions.splice(index, 1);
      await chrome.storage.local.set({ completedSessions });
      return { ok: true, completedSessions };
    }

    case 'FETCH_ALL_PROJECTS': {
      const result = await fetchAllProjects(payload.pat);
      return { ok: true, orgs: result.orgs, projects: result.projects };
    }

    case 'FETCH_PROJECT_FIELDS': {
      const fields = await fetchProjectNumberFields(payload.pat, payload.projectId);
      return { ok: true, fields };
    }

    default:
      return { error: `Unknown action: ${action}` };
  }
}
