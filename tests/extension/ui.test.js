import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../../extension/lib/ui.js', import.meta.url)),
  'utf8'
);
const context = {};
runInNewContext(source, context);

test('shared UI helpers escape text and format durations', () => {
  const { escapeHtml, escapeAttribute, formatElapsed, formatDuration, computeElapsed } =
    context.TaktUI;

  assert.equal(escapeHtml(`<tag attr="x"> & 'y'`), '&lt;tag attr=&quot;x&quot;&gt; &amp; &#39;y&#39;');
  assert.equal(escapeAttribute('a"b'), 'a&quot;b');
  assert.equal(formatElapsed(3_661_000), '01:01:01');
  assert.equal(formatDuration(65 * 60_000), '1h 5m');
  assert.equal(computeElapsed({ status: 'paused', accumulatedMs: 90_000 }), 90_000);
});
