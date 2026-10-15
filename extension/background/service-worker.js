import '../lib/time-format.js';
import '../lib/ui.js';
import { adminHandlers } from './handlers/admin.js';
import { githubHandlers } from './handlers/github.js';
import { sessionHandlers } from './handlers/sessions.js';
import { timerHandlers } from './handlers/timer.js';
import {
  ALARM_NAME,
  drainQueue,
  getState,
  maybeClearAlarm,
} from './worker-shared.js';

export const dispatchMap = Object.freeze({
  ...timerHandlers,
  ...sessionHandlers,
  ...githubHandlers,
  ...adminHandlers,
});

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
  }
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(
    sendResponse,
    (err) => sendResponse({ ok: false, error: err?.message || String(err) })
  );
  return true;
});

export async function handleMessage({ action, payload }) {
  if (!Object.prototype.hasOwnProperty.call(dispatchMap, action)) {
    return { error: `Unknown action: ${action}` };
  }
  return dispatchMap[action](payload);
}
