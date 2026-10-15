import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  discardFailed,
  enqueueSession,
  flushQueue,
  queueLength,
  queueStatus,
  retryFailed,
} from '../../extension/background/sync-queue.js';
import { createChromeStub } from './chrome-stub.js';

let storage;

function okResponse(status = 201) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return status >= 400
        ? { detail: { code: `http_${status}`, message: `HTTP ${status}` } }
        : { session_id: 'server-session' };
    },
  };
}

function makePayload(sessionId, description = sessionId) {
  return {
    session_id: sessionId,
    description,
    started_at: '2025-01-01T00:00:00.000Z',
    completed_at: '2025-01-01T01:00:00.000Z',
    duration_ms: 3_600_000,
    duration_hours: 1,
  };
}

beforeEach(() => {
  const stub = createChromeStub({
    settings: { pat: 'test-token', backendUrl: 'http://localhost:8000' },
  });
  globalThis.chrome = stub.chrome;
  storage = stub.storage;
  globalThis.fetch = async () => okResponse();
});

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
});

test('enqueue upserts by session ID and retains the latest payload', async () => {
  await enqueueSession(makePayload('same', 'old'));
  await enqueueSession(makePayload('same', 'latest'));

  const status = await queueStatus();
  assert.equal(status.pending, 1);
  assert.equal(status.failed.length, 0);
  assert.equal(storage.syncQueue[0].payload.description, 'latest');
});

test('enqueue during a flush preserves the newer queue revision', async () => {
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const requestGate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    started();
    await requestGate;
    return okResponse();
  };
  await enqueueSession(makePayload('racing', 'initial'));

  const flushing = flushQueue();
  await requestStarted;
  await enqueueSession(makePayload('racing', 'newer'));
  release();
  await flushing;

  assert.equal(storage.syncQueue.length, 1);
  assert.equal(storage.syncQueue[0].payload.description, 'newer');
});

test('500 responses stay pending with exponential retry metadata', async () => {
  globalThis.fetch = async () => okResponse(500);
  await enqueueSession(makePayload('server-error'));

  await flushQueue();

  const [item] = storage.syncQueue;
  assert.equal(item.state, 'pending');
  assert.equal(item.attempts, 1);
  assert.ok(item.nextAttemptAt > Date.now());
  assert.equal(item.lastError.status, 500);
});

test('401 responses stay pending and report auth blocked', async () => {
  globalThis.fetch = async () => okResponse(401);
  await enqueueSession(makePayload('unauthorized'));

  await flushQueue();

  const status = await queueStatus();
  assert.equal(status.pending, 1);
  assert.equal(status.authBlocked, true);
});

test('422 responses remain failed until explicitly retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse(calls === 1 ? 422 : 201);
  };
  await enqueueSession(makePayload('invalid'));

  await flushQueue();
  assert.equal((await queueStatus()).failed.length, 1);
  await flushQueue();
  assert.equal(calls, 1);

  assert.equal(await retryFailed('invalid'), 1);
  const result = await flushQueue();
  assert.equal(result.drained.length, 1);
  assert.equal(calls, 2);
  assert.equal(await queueLength(), 0);
});

test('Pydantic 422 details are retained as validation errors', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 422,
    async json() {
      return {
        detail: [
          { msg: 'started_at is invalid' },
          { msg: 'completed_at must not be before started_at' },
        ],
      };
    },
  });
  await enqueueSession(makePayload('pydantic-invalid'));

  await flushQueue();

  const [item] = storage.syncQueue;
  assert.equal(item.state, 'failed');
  assert.equal(item.lastError.status, 422);
  assert.equal(item.lastError.code, 'validation_error');
  assert.equal(
    item.lastError.message,
    'started_at is invalid; completed_at must not be before started_at'
  );
});

test('concurrent flush calls share one request per item', async () => {
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let release;
  const requestGate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    started();
    await requestGate;
    return okResponse();
  };
  await enqueueSession(makePayload('single-flight'));

  const first = flushQueue();
  const second = flushQueue();
  assert.equal(first, second);
  await requestStarted;
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
});

test('holdMs delays queue delivery until its due time', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse();
  };
  await enqueueSession(makePayload('held'), { holdMs: 60_000 });

  const result = await flushQueue();

  assert.equal(result.processed, 0);
  assert.equal(calls, 0);
  assert.equal(await queueLength(), 1);
});

test('normalizes and pushes legacy queue items', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse();
  };
  await globalThis.chrome.storage.local.set({
    syncQueue: [{
      kind: 'session',
      payload: makePayload('legacy'),
      attempts: 0,
      nextAttemptAt: 0,
    }],
  });

  const result = await flushQueue();

  assert.equal(result.drained.length, 1);
  assert.equal(calls, 1);
  assert.equal(await queueLength(), 0);
});

test('discardFailed removes only a failed item', async () => {
  globalThis.fetch = async () => okResponse(422);
  await enqueueSession(makePayload('discard'));
  await flushQueue();

  assert.equal(await discardFailed('discard'), true);
  assert.equal(await queueLength(), 0);
});
