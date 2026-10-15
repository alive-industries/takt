import { withLock } from './lock.js';
import { pushSession } from './takt-api.js';

const STORAGE_KEY = 'syncQueue';
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 5 * 1000;

let activeFlush = null;

async function loadQueue() {
  const { [STORAGE_KEY]: queue = [] } = await chrome.storage.local.get(STORAGE_KEY);
  return (Array.isArray(queue) ? queue : []).map((item) => ({
    kind: item.kind || 'session',
    sessionId: item.sessionId ?? item.payload?.session_id ?? null,
    payload: item.payload || {},
    attempts: Number.isFinite(item.attempts) ? item.attempts : 0,
    nextAttemptAt: Number.isFinite(item.nextAttemptAt) ? item.nextAttemptAt : 0,
    state: item.state === 'failed' ? 'failed' : 'pending',
    lastError: item.lastError ?? null,
    enqueuedAt: Number.isFinite(item.enqueuedAt) ? item.enqueuedAt : Date.now(),
    rev: Number.isFinite(item.rev) ? item.rev : 0,
  }));
}

async function saveQueue(queue) {
  await chrome.storage.local.set({ [STORAGE_KEY]: queue });
}

function nextDelay(attempts) {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function errorDetails(err) {
  return {
    status: Number.isFinite(err?.status) ? err.status : null,
    code: err?.code ?? null,
    message: err?.message || String(err),
  };
}

function isRetryable(error) {
  const { status } = error;
  return (
    status === null
    || status === 0
    || status === 401
    || status === 403
    || status === 408
    || status === 429
    || status >= 500
    || status < 400
  );
}

function recordFailure(item, error) {
  item.attempts += 1;
  item.lastError = error;
  if (isRetryable(error)) {
    item.state = 'pending';
    item.nextAttemptAt = Date.now() + nextDelay(item.attempts);
  } else {
    item.state = 'failed';
    item.nextAttemptAt = 0;
  }
}

export async function enqueueSession(payload, { holdMs = 0 } = {}) {
  const sessionId = payload?.session_id;
  if (!sessionId) throw new TypeError('Session payload must include session_id.');

  return withLock('syncQueue', async () => {
    const queue = await loadQueue();
    const now = Date.now();
    const existing = queue.find((item) => item.sessionId === sessionId);
    if (existing) {
      existing.payload = payload;
      existing.state = 'pending';
      existing.attempts = 0;
      existing.nextAttemptAt = now + holdMs;
      existing.lastError = null;
      existing.rev += 1;
    } else {
      queue.push({
        kind: 'session',
        sessionId,
        payload,
        attempts: 0,
        nextAttemptAt: now + holdMs,
        state: 'pending',
        lastError: null,
        enqueuedAt: now,
        rev: 1,
      });
    }
    await saveQueue(queue);
  });
}

export async function queueLength() {
  return withLock('syncQueue', async () => {
    const queue = await loadQueue();
    await saveQueue(queue);
    return queue.length;
  });
}

export async function queueStatus() {
  return withLock('syncQueue', async () => {
    const queue = await loadQueue();
    await saveQueue(queue);
    const pending = queue.filter((item) => item.state === 'pending');
    const failed = queue
      .filter((item) => item.state === 'failed')
      .map(({ sessionId, payload, lastError }) => ({ sessionId, payload, lastError }));
    return {
      pending: pending.length,
      failed,
      authBlocked: pending.some(
        (item) => item.lastError?.status === 401 || item.lastError?.status === 403
      ),
    };
  });
}

export async function retryFailed(sessionId) {
  return withLock('syncQueue', async () => {
    const queue = await loadQueue();
    let retried = 0;
    for (const item of queue) {
      if (item.state !== 'failed' || (sessionId && item.sessionId !== sessionId)) continue;
      item.state = 'pending';
      item.attempts = 0;
      item.nextAttemptAt = 0;
      item.lastError = null;
      retried += 1;
    }
    await saveQueue(queue);
    return retried;
  });
}

export async function discardFailed(sessionId) {
  return withLock('syncQueue', async () => {
    const queue = await loadQueue();
    const index = queue.findIndex(
      (item) => item.sessionId === sessionId && item.state === 'failed'
    );
    if (index < 0) {
      await saveQueue(queue);
      return false;
    }
    queue.splice(index, 1);
    await saveQueue(queue);
    return true;
  });
}

export async function pushOne(payload) {
  const sessionId = payload?.session_id;
  if (!sessionId) throw new TypeError('Session payload must include session_id.');

  const attempt = await withLock('syncQueue', async () => {
    const queue = await loadQueue();
    let item = queue.find((entry) => entry.sessionId === sessionId);
    if (!item) {
      item = {
        kind: 'session',
        sessionId,
        payload,
        attempts: 0,
        nextAttemptAt: 0,
        state: 'pending',
        lastError: null,
        enqueuedAt: Date.now(),
        rev: 0,
      };
      queue.push(item);
    } else if (JSON.stringify(item.payload) !== JSON.stringify(payload)) {
      item.payload = payload;
      item.rev += 1;
    }
    await saveQueue(queue);
    return { rev: item.rev };
  });

  try {
    const response = await pushSession(payload);
    await withLock('syncQueue', async () => {
      const queue = await loadQueue();
      const index = queue.findIndex(
        (item) => item.sessionId === sessionId && item.rev === attempt.rev
      );
      if (index >= 0) queue.splice(index, 1);
      await saveQueue(queue);
    });
    return { ok: true, response, error: null, failed: false };
  } catch (err) {
    const error = errorDetails(err);
    const failed = !isRetryable(error);
    await withLock('syncQueue', async () => {
      const queue = await loadQueue();
      const item = queue.find(
        (entry) => entry.sessionId === sessionId && entry.rev === attempt.rev
      );
      if (item) {
        item.payload = payload;
        recordFailure(item, error);
      }
      await saveQueue(queue);
    });
    return { ok: false, response: null, error, failed };
  }
}

async function flushQueueWork() {
  const snapshot = await withLock('syncQueue', async () => {
    const queue = await loadQueue();
    await saveQueue(queue);
    const now = Date.now();
    return queue
      .filter(
        (item) => item.kind === 'session'
          && item.payload.session_id
          && item.state === 'pending'
          && item.nextAttemptAt <= now
      )
      .map(({ sessionId, rev, payload }) => ({ sessionId, rev, payload }));
  });
  const outcomes = [];

  for (const item of snapshot) {
    try {
      outcomes.push({ ...item, response: await pushSession(item.payload), error: null });
    } catch (err) {
      outcomes.push({ ...item, response: null, error: errorDetails(err) });
    }
  }

  return withLock('syncQueue', async () => {
    const queue = await loadQueue();
    const drained = [];
    const failed = [];

    for (const outcome of outcomes) {
      const index = queue.findIndex(
        (item) => item.sessionId === outcome.sessionId && item.rev === outcome.rev
      );
      if (index < 0) continue;

      const item = queue[index];
      if (!outcome.error) {
        queue.splice(index, 1);
        drained.push({ payload: outcome.payload, response: outcome.response });
        continue;
      }

      recordFailure(item, outcome.error);
      if (item.state === 'failed') {
        failed.push({ payload: item.payload, error: outcome.error });
      }
    }

    await saveQueue(queue);
    return {
      processed: outcomes.length,
      remaining: queue.length,
      drained,
      failed,
    };
  });
}

export function flushQueue() {
  if (!activeFlush) {
    activeFlush = flushQueueWork().finally(() => {
      activeFlush = null;
    });
  }
  return activeFlush;
}
