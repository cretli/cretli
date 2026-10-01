/**
 * Behaviour tests for getDelegationStats() in app_front/api.js.
 *
 * The Settings → Usage panel must scope the aggregate to the workspace selected
 * in the header, exactly like getWorkspaceDelegations(). An unscoped call would
 * make the server aggregate every chat of the installation, so these tests pin
 * the workspaceFolder/workspaceFile query and the URL-keyed dedupe behaviour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getDelegationStats } from '../app_front/api.js';

/**
 * Replaces globalThis.fetch with a stub whose responses resolve on demand.
 * Returns the recorded requests plus a restore() for the finally block.
 */
function stubFetch() {
  const previous = globalThis.fetch;
  /** @type {Array<{ url: string, init: object, respond: Function }>} */
  const requests = [];
  globalThis.fetch = (url, init = {}) => {
    let respond;
    const responsePromise = new Promise((resolve) => {
      respond = resolve;
    });
    requests.push({
      url: String(url),
      init,
      respond: (payload) => respond({ status: 200, json: async () => payload }),
    });
    return responsePromise;
  };
  return { requests, restore: () => { globalThis.fetch = previous; } };
}

/**
 * @param {string} rawUrl
 * @returns {URL}
 */
function parseUrl(rawUrl) {
  return new URL(rawUrl, 'http://localhost');
}

test('getDelegationStats forwards workspaceFolder and workspaceFile', async () => {
  const { requests, restore } = stubFetch();
  try {
    const pending = getDelegationStats({
      workspaceFolder: '/home/me/workspace-a',
      workspaceFile: '/home/me/workspace-a/cretli.code-workspace',
    });
    assert.equal(requests.length, 1);
    const url = parseUrl(requests[0].url);
    assert.equal(url.pathname, '/api/delegations/stats');
    assert.equal(url.searchParams.get('workspaceFolder'), '/home/me/workspace-a');
    assert.equal(url.searchParams.get('workspaceFile'), '/home/me/workspace-a/cretli.code-workspace');

    requests[0].respond({ ok: true, list: [] });
    assert.deepEqual(await pending, { ok: true, list: [] });
  } finally {
    restore();
  }
});

test('an empty scope stays param-free and keeps the server default', async () => {
  const { requests, restore } = stubFetch();
  try {
    const pending = getDelegationStats();
    assert.equal(requests[0].url, '/api/delegations/stats', 'no workspace query without an active scope');
    requests[0].respond({ ok: true, list: [] });
    await pending;
  } finally {
    restore();
  }
});

test('different workspace scopes do not share one in-flight GET', async () => {
  const { requests, restore } = stubFetch();
  try {
    const workspaceA = getDelegationStats({ workspaceFolder: '/w/a' });
    const workspaceB = getDelegationStats({ workspaceFolder: '/w/b' });
    assert.equal(requests.length, 2, 'each scope is its own URL and must fetch separately');
    assert.notEqual(requests[0].url, requests[1].url);

    requests[0].respond({ ok: true, list: [{ harness: 'a' }] });
    requests[1].respond({ ok: true, list: [{ harness: 'b' }] });
    assert.deepEqual(await workspaceA, { ok: true, list: [{ harness: 'a' }] });
    assert.deepEqual(await workspaceB, { ok: true, list: [{ harness: 'b' }] });
  } finally {
    restore();
  }
});

test('identical scoped requests still dedupe to one HTTP fetch', async () => {
  const { requests, restore } = stubFetch();
  try {
    const scope = { workspaceFolder: '/w/a', workspaceFile: '/w/a.code-workspace' };
    const first = getDelegationStats(scope);
    const second = getDelegationStats(scope);
    assert.equal(requests.length, 1, 'the same scoped URL must dedupe');
    requests[0].respond({ ok: true, list: [] });
    assert.deepEqual(await first, { ok: true, list: [] });
    assert.deepEqual(await second, { ok: true, list: [] });
  } finally {
    restore();
  }
});
