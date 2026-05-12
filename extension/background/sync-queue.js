// Durable retry queue for backend pushes.
//
// Stored under `chrome.storage.local.syncQueue` as an array of:
//   { kind: 'session', payload: <SessionIn>, attempts, nextAttemptAt }
//
// We back off exponentially up to a cap. Permanent failures (4xx that aren't
// 429) are dropped to prevent the queue from poisoning forever. Network /
// 5xx / 429 errors are kept and retried.

import { pushSession, TaktApiError } from './takt-api.js';

const STORAGE_KEY = 'syncQueue';
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 min
const BASE_BACKOFF_MS = 5 * 1000; // 5 sec

async function loadQueue() {
  const { [STORAGE_KEY]: queue = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return queue;
}

async function saveQueue(queue) {
  await chrome.storage.local.set({ [STORAGE_KEY]: queue });
}

function nextDelay(attempts) {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

export async function enqueueSession(session) {
  const queue = await loadQueue();
  queue.push({ kind: 'session', payload: session, attempts: 0, nextAttemptAt: 0 });
  await saveQueue(queue);
}

export async function queueLength() {
  return (await loadQueue()).length;
}

// True if the error is "permanent" — no retry, drop the item.
function isPermanentError(err) {
  if (!(err instanceof TaktApiError)) return false;
  if (err.status === 429) return false; // rate-limited, retry
  if (err.status >= 400 && err.status < 500) {
    // 401 (invalid PAT), 403 (not authorised), 422 (validation) — retrying won't help.
    // Exception: dropping a session entirely is destructive, so log loudly.
    return true;
  }
  return false;
}

// Attempt to flush the queue. Returns { processed, remaining, errors }.
export async function flushQueue() {
  const queue = await loadQueue();
  if (queue.length === 0) return { processed: 0, remaining: 0, errors: [] };

  const now = Date.now();
  const remaining = [];
  const errors = [];
  let processed = 0;

  for (const item of queue) {
    if (item.nextAttemptAt > now) {
      remaining.push(item);
      continue;
    }

    try {
      if (item.kind === 'session') {
        await pushSession(item.payload);
        processed += 1;
      } else {
        // Unknown kind — drop it.
        console.warn('[Takt] dropping unknown queue item kind:', item.kind);
      }
    } catch (err) {
      const isPermanent = isPermanentError(err);
      errors.push({ item, error: { code: err.code, message: err.message, status: err.status }, dropped: isPermanent });
      if (isPermanent) {
        console.error('[Takt] dropping queue item after permanent error:', err.code, err.message, item);
      } else {
        item.attempts = (item.attempts || 0) + 1;
        item.nextAttemptAt = now + nextDelay(item.attempts);
        remaining.push(item);
      }
    }
  }

  await saveQueue(remaining);
  return { processed, remaining: remaining.length, errors };
}

export async function clearQueue() {
  await saveQueue([]);
}
