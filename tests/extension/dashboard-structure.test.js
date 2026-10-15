import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dashboardPath = fileURLToPath(
  new URL('../../extension/dashboard/dashboard.html', import.meta.url)
);
const dashboardHtml = readFileSync(dashboardPath, 'utf8');
const dashboardIds = [
  ...dashboardHtml.matchAll(/\sid=["']([^"']+)["']/g),
].map((match) => match[1]);
const viewScripts = ['time.js', 'settings.js', 'admin.js'].map((file) =>
  fileURLToPath(new URL(`../../extension/dashboard/views/${file}`, import.meta.url))
);

test('dashboard views share one document with unique IDs', () => {
  const seen = new Set();
  const duplicates = dashboardIds.filter((id) => {
    if (seen.has(id)) return true;
    seen.add(id);
    return false;
  });

  assert.deepEqual(duplicates, []);
  assert.doesNotMatch(dashboardHtml, /<iframe\b/i);
  assert.doesNotMatch(dashboardHtml, /\sstyle\s*=/i);
  for (const page of [
    '../../extension/mytime/mytime.html',
    '../../extension/options/options.html',
    '../../extension/admin/admin.html',
  ]) {
    assert.equal(existsSync(fileURLToPath(new URL(page, import.meta.url))), false);
  }
});

test('lazy-loaded view scripts only query IDs present in the dashboard', () => {
  const availableIds = new Set(dashboardIds);

  for (const scriptPath of viewScripts) {
    const source = readFileSync(scriptPath, 'utf8');
    const queriedIds = [
      ...source.matchAll(/document\.getElementById\(\s*(['"])([^'"]+)\1\s*\)/g),
    ].map((match) => match[2]);
    const missing = queriedIds.filter((id) => !availableIds.has(id));
    assert.deepEqual(missing, [], `${scriptPath} queries missing IDs`);
  }
});
