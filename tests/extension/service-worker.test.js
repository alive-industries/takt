import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChromeStub } from './chrome-stub.js';

const previousSwitchActions = [
  'START',
  'PAUSE',
  'RESUME',
  'SET_TIME',
  'STOP',
  'GET_STATE',
  'FETCH_ALL_PROJECTS',
  'FETCH_PROJECT_FIELDS',
  'FETCH_USER_REPOS',
  'FETCH_USER_ORGS',
  'FETCH_REPO_PROJECTS',
  'FETCH_PROJECT_ISSUES',
  'FETCH_PROJECT_REPOS',
  'BACKEND_PING',
  'FLUSH_QUEUE',
  'QUEUE_STATUS',
  'QUEUE_LENGTH',
  'RETRY_FAILED',
  'DISCARD_FAILED',
  'LIST_LOCAL_SESSIONS',
  'LIST_BACKEND_SESSIONS',
  'UPDATE_BACKEND_SESSION',
  'DELETE_BACKEND_SESSION',
  'GET_BACKEND_ME',
  'GET_BIGQUERY_SYNC_STATUS',
  'PUSH_BIGQUERY',
  'LIST_CLIENTS',
  'ADMIN_CREATE_CLIENT',
  'ADMIN_MAP_CLIENT_PROJECT',
  'ADMIN_MAP_PROJECT_REPO',
  'ADMIN_LIST_MEMBERS',
  'ADMIN_UPSERT_MEMBER',
  'ADMIN_GET_ORG_CONFIG',
  'ADMIN_PUT_ORG_CONFIG',
  'CACHE_COUNTS',
  'ADD_MANUAL_SESSION',
];

test('service-worker module graph imports and preserves the old action map', async () => {
  globalThis.chrome = createChromeStub().chrome;
  globalThis.self = globalThis;

  const { dispatchMap, handleMessage } = await import(
    '../../extension/background/service-worker.js'
  );

  assert.deepEqual(Object.keys(dispatchMap).sort(), [...previousSwitchActions].sort());
  assert.deepEqual(await handleMessage({ action: 'UNKNOWN' }), {
    error: 'Unknown action: UNKNOWN',
  });
});
