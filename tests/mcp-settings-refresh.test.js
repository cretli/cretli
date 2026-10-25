import test from 'node:test';
import assert from 'node:assert/strict';

/** Minimal DOM stub: the panel root only needs innerHTML, dataset and query helpers. */
function makeRoot() {
  const root = {
    dataset: {},
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    get firstElementChild() { return this._html ? {} : null; },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return root;
}

const root = makeRoot();
globalThis.document = { getElementById: (id) => (id === 'settings-mcp-root' ? root : null) };

const calls = [];
let release;
const gate = new Promise((resolve) => { release = resolve; });
globalThis.fetch = async (url) => {
  const path = String(url);
  calls.push({ path, start: calls.length });
  await gate;
  const bodies = {
    '/api/mcp/servers': { ok: true, revision: 3, servers: [{ id: 's1', name: 'alpha', transport: 'stdio' }] },
    '/api/mcp/status': { statuses: [] },
    '/api/workspaces': { workspaces: [] },
  };
  return { status: 200, ok: true, json: async () => bodies[path] };
};

const mod = await import('../app_front/features/settings/mcpSettings.js');

test('first entry sends each request once, all in flight together', async () => {
  mod.initMcpSettingsPanel();
  assert.equal(calls.length, 0, 'init must not fetch (tab switch calls refresh)');
  const p1 = mod.refreshMcpSettingsPanel();
  const p2 = mod.refreshMcpSettingsPanel(); // duplicate trigger while in flight
  await new Promise((r) => setTimeout(r, 10));
  // Gate still closed: all three requests started before any finished => parallel.
  assert.deepEqual(calls.map((c) => c.path).sort(), ['/api/mcp/servers', '/api/mcp/status', '/api/workspaces']);
  assert.match(root.innerHTML, /settings-hint/, 'Loading shown on first load');
  release();
  await Promise.all([p1, p2]);
  assert.equal(calls.length, 3, 'no duplicate requests');
  assert.match(root.innerHTML, /alpha/);
});

test('re-entry keeps the list visible (no Loading) while refreshing', async () => {
  const before = calls.length;
  const seen = [];
  const origSet = Object.getOwnPropertyDescriptor(root, 'innerHTML').set;
  Object.defineProperty(root, 'innerHTML', {
    configurable: true,
    get() { return this._html; },
    set(v) { seen.push(v); origSet.call(this, v); },
  });
  await mod.refreshMcpSettingsPanel();
  assert.equal(calls.length - before, 3);
  assert.match(root.innerHTML, /alpha/);
  assert.equal(seen.length, 0, 'unchanged data: no clearing, no re-render');
});

test('post-mutation refresh is not served by a pre-mutation in-flight request', async () => {
  const pending = [];
  let version = 'before';
  globalThis.fetch = (url) => new Promise((resolve) => {
    const path = String(url);
    // Snapshot the server state when the request is made, like a real server would.
    const snapshot = version;
    pending.push(() => resolve({
      status: 200,
      ok: true,
      json: async () => ({
        '/api/mcp/servers': { ok: true, revision: 4, servers: [{ id: 's1', name: `srv-${snapshot}`, transport: 'stdio' }] },
        '/api/mcp/status': { statuses: [] },
        '/api/workspaces': { workspaces: [] },
      }[path]),
    }));
  });
  const first = mod.refreshMcpSettingsPanel(); // tab-entry refresh, still pending
  version = 'after'; // a mutation lands while it is in flight
  const second = mod.refreshMcpSettingsPanel({ force: true });
  assert.notEqual(first, second, 'forced refresh starts its own fetch');
  assert.equal(pending.length, 6, 'three requests per refresh');
  // Release the newer responses first, then the stale ones: the stale render must not win.
  pending.slice(3).forEach((fn) => fn());
  await second;
  pending.slice(0, 3).forEach((fn) => fn());
  await first;
  assert.match(root.innerHTML, /srv-after/);
  assert.doesNotMatch(root.innerHTML, /srv-before/);
});
