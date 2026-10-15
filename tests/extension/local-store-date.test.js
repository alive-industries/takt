process.env.TZ = 'Europe/London';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createChromeStub } from './chrome-stub.js';

const { listSessions, reconcileWindow } = await import(
  '../../extension/background/local-store.js'
);

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

test('date-only bounds use local days and numeric to is exclusive', async () => {
  const completedAt = new Date(2027, 6, 15, 0, 30).getTime();
  await globalThis.chrome.storage.local.set({
    sessionCache: {
      byId: {
        local: {
          sessionId: 'local',
          completedAt,
          syncStatus: 'synced',
        },
      },
      lastSyncAt: null,
    },
  });

  const sameDay = await listSessions({ from: '2027-07-15', to: '2027-07-15' });
  const previousDay = await listSessions({ from: '2027-07-14', to: '2027-07-14' });
  const numericExclusive = await listSessions({
    from: new Date(2027, 6, 15).getTime(),
    to: completedAt,
  });

  assert.deepEqual(sameDay.map((session) => session.sessionId), ['local']);
  assert.deepEqual(previousDay, []);
  assert.deepEqual(numericExclusive, []);
});

test('reconciliation treats a numeric end bound as exclusive', async () => {
  const completedAt = new Date(2027, 6, 15, 0, 30).getTime();
  await globalThis.chrome.storage.local.set({
    sessionCache: {
      byId: {
        local: {
          sessionId: 'local',
          completedAt,
          syncStatus: 'synced',
        },
      },
      lastSyncAt: null,
    },
  });

  await reconcileWindow({
    from: new Date(2027, 6, 15).getTime(),
    to: completedAt,
    records: [],
  });

  assert.equal(storage.sessionCache.byId.local.sessionId, 'local');
});
