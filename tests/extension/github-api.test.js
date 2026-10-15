import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  formatCommentDuration,
  getLinkedProjects,
  postTimeComment,
} from '../../extension/background/github-api.js';

afterEach(() => {
  delete globalThis.fetch;
});

test('comment duration rounds minutes and formats hours', () => {
  assert.equal(formatCommentDuration(59_000), '1m');
  assert.equal(formatCommentDuration(12 * 60_000), '12m');
  assert.equal(formatCommentDuration(60 * 60_000), '1h 00m');
  assert.equal(formatCommentDuration(65 * 60_000), '1h 05m');
  assert.equal(formatCommentDuration(3 * 60 * 60_000 + 59 * 60_000 + 30_000), '4h 00m');
});

test('short issue comments are skipped', async () => {
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called');
  };

  await postTimeComment('token', 'org', 'repo', 1, 59_999, 'user');
});

test('issue project items are fetched across cursor pages', async () => {
  const cursors = [];
  globalThis.fetch = async (_url, options) => {
    const { variables } = JSON.parse(options.body);
    cursors.push(variables.cursor);
    const firstPage = variables.cursor == null;
    return {
      ok: true,
      async json() {
        return {
          data: {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{
                    id: firstPage ? 'item-1' : 'item-2',
                    project: {
                      id: firstPage ? 'project-1' : 'project-2',
                      title: firstPage ? 'First' : 'Second',
                    },
                  }],
                  pageInfo: firstPage
                    ? { hasNextPage: true, endCursor: 'next-page' }
                    : { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        };
      },
    };
  };

  const projects = await getLinkedProjects('token', 'org/repo', 42);

  assert.deepEqual(cursors, [null, 'next-page']);
  assert.deepEqual(projects, [
    { projectId: 'project-1', title: 'First' },
    { projectId: 'project-2', title: 'Second' },
  ]);
});
