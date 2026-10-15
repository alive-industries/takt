import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { getSession, upsertSession } from '../../extension/background/local-store.js';
import { createChromeStub } from './chrome-stub.js';

let storage;

beforeEach(() => {
  const stub = createChromeStub({
    settings: { pat: 'test-token', backendUrl: 'http://localhost:8000' },
  });
  globalThis.chrome = stub.chrome;
  storage = stub.storage;
});

afterEach(() => {
  delete globalThis.chrome;
});

test('concurrent session upserts preserve both records', async () => {
  await Promise.all([
    upsertSession({ sessionId: 'first', completedAt: Date.now(), syncStatus: 'pending' }),
    upsertSession({ sessionId: 'second', completedAt: Date.now(), syncStatus: 'pending' }),
  ]);

  assert.equal((await getSession('first')).sessionId, 'first');
  assert.equal((await getSession('second')).sessionId, 'second');
});

test('prunes old synced rows but keeps old pending rows', async () => {
  const old = Date.now() - 31 * 86_400_000;
  await globalThis.chrome.storage.local.set({
    sessionCache: {
      byId: {
        synced: { sessionId: 'synced', completedAt: old, syncStatus: 'synced' },
        pending: { sessionId: 'pending', completedAt: old, syncStatus: 'pending' },
        missing: { sessionId: 'missing', completedAt: old },
      },
      lastSyncAt: null,
    },
  });
  await upsertSession({
    sessionId: 'new',
    completedAt: Date.now(),
    syncStatus: 'pending',
  });

  assert.equal(await getSession('synced'), null);
  assert.equal((await getSession('pending')).sessionId, 'pending');
  assert.equal(await getSession('missing'), null);
});
