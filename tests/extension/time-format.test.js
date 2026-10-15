import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Europe/London';

const source = readFileSync(
  fileURLToPath(new URL('../../extension/lib/time-format.js', import.meta.url)),
  'utf8'
);
const context = {};
runInNewContext(source, context);

test('local day helpers use local dates across the BST boundary', () => {
  const { localDateKey, localDayStartMs, localDayEndExclusiveMs } = context.TaktTime;

  assert.equal(localDateKey(Date.parse('2025-03-30T23:30:00.000Z')), '2025-03-31');
  assert.equal(
    new Date(localDayStartMs('2025-03-31')).toISOString(),
    '2025-03-30T23:00:00.000Z'
  );
  assert.equal(
    localDayEndExclusiveMs('2025-03-30') - localDayStartMs('2025-03-30'),
    23 * 60 * 60 * 1000
  );
});
