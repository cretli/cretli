/**
 * HTTP contract of the TODO usage endpoints.
 *
 * `GET /api/todos/usage` (workspace) and `GET /api/todos/:id/usage` (one todo)
 * are read-only views over the existing ledger: window defaults and caps,
 * cursor pagination, 400/404/unavailable mapping, and the literal `usage`
 * segment being registered before the parametric routes.
 *
 * The isolated data dir helper must be the first import: delegation paths are
 * resolved at module load.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { addTodo, loadTodosData } from '../lib/persist/todos-persist.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { recordUsage } from '../lib/usage/usage-ledger.js';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const dataDir = ISOLATED_DATA_DIR;
// Inside the default 30-day window regardless of when the suite runs.
const AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

/**
 * @param {string} iso
 * @param {number} ms
 * @returns {string}
 */
function plusMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/**
 * @returns {{ invoke: (method: string, route: string, req?: object) => Promise<{ status: number, body: object }> }}
 */
function makeApp(cwd) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) {
      handlers.set(`GET ${p}`, fn);
    },
    post(p, fn) {
      handlers.set(`POST ${p}`, fn);
    },
    patch(p, fn) {
      handlers.set(`PATCH ${p}`, fn);
    },
    delete(p, fn) {
      handlers.set(`DELETE ${p}`, fn);
    },
    put(p, fn) {
      handlers.set(`PUT ${p}`, fn);
    },
  };
  registerTodosRoutes(app, {
    dataDir,
    getCurrentCwd: () => cwd,
    getCurrentWorkspaceFile: () => cwd,
    agentModel: 'auto',
    getLocalCallbackBaseUrl: () => 'http://127.0.0.1:9999',
    useHttps: false,
  });
  const invoke = (method, route, req = {}) => {
    const fn = handlers.get(`${method} ${route}`);
    assert.ok(fn, `${method} ${route} must be registered`);
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          res.statusCode = code;
          return res;
        },
        json(payload) {
          res.body = payload;
          resolve({ status: res.statusCode, body: payload });
          return res;
        },
      };
      fn({ params: req.params || {}, query: req.query || {}, body: req.body || {} }, res);
    });
  };
  return { invoke };
}

/**
 * @returns {string}
 */
function newCwd() {
  return mkdtempSync(path.join(tmpdir(), 'cretli-todo-usage-'));
}

/**
 * @param {string} cwd
 * @param {object} input
 * @returns {object}
 */
function delegation(cwd, input = {}) {
  return createDelegationRecord({
    workspaceFolder: cwd,
    parentChatId: 'chat-parent',
    executor: { harness: 'opencode', model: 'm' },
    ...input,
  });
}

/**
 * @param {object} input
 * @returns {object}
 */
function usage(input) {
  return recordUsage(
    {
      provider: 'openrouter',
      feature: 'chat',
      harness: 'openrouter',
      model: 'some/model',
      role: 'implement',
      at: AT,
      tokens: {
        textInput: 100,
        textOutput: 10,
        audioInput: 0,
        audioOutput: 0,
        cachedInput: 0,
        cacheWrite: 0,
        reasoning: 0,
      },
      ...input,
    },
    { dataDir },
  );
}

test.after(() => {
  removeIsolatedDataDir();
});

test('/api/todos/usage is registered before the parametric routes', async () => {
  const cwd = newCwd();
  const { invoke } = makeApp(cwd);
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../lib/routes/todos-routes.js', import.meta.url), 'utf8'));
  const registrationOrder = [...source.matchAll(/app\.get\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(registrationOrder.indexOf('/api/todos/usage') < registrationOrder.indexOf('/api/todos/:id/usage'));
  const list = await invoke('GET', '/api/todos/usage');
  assert.equal(list.status, 200);
  assert.equal(list.body.ok, true);
  const one = await invoke('GET', '/api/todos/:id/usage', { params: { id: 'x' } });
  assert.equal(one.status, 404, 'an unknown todo is 404, not the workspace list');
});

test('workspace usage window defaults to 30 days and is capped', async () => {
  const cwd = newCwd();
  const { invoke } = makeApp(cwd);
  const ok = await invoke('GET', '/api/todos/usage');
  assert.equal(ok.body.window.ok, true);
  assert.equal(ok.body.window.range, '30d');
  assert.equal(ok.body.window.days, 30);

  const tooWide = await invoke('GET', '/api/todos/usage', {
    query: { from: '2026-01-01', to: '2026-09-30' },
  });
  assert.equal(tooWide.status, 400);
  assert.equal(tooWide.body.ok, false);
  assert.match(tooWide.body.error, /92 days/);

  const badLimit = await invoke('GET', '/api/todos/usage', { query: { limit: '500' } });
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.body.code, 'VALIDATION');

  const badCursor = await invoke('GET', '/api/todos/usage', { query: { cursor: '!!!' } });
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.code, 'VALIDATION');
});

test('workspace usage paginates with a cursor and keeps rows unique', async () => {
  const cwd = newCwd();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const created = addTodo(dataDir, cwd, { title: `t${i}`, status: 'ready' });
    ids.push(created.item.id);
    delegation(cwd, { id: `pag${i}`, leafId: created.item.id, attemptId: `a${i}`, runId: `r${i}` });
    usage({ delegationId: `pag${i}`, attemptId: `a${i}`, runId: `r${i}`, reportedUsd: 1 });
  }
  const { invoke } = makeApp(cwd);

  const first = await invoke('GET', '/api/todos/usage', { query: { limit: '2' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.limit, 2);
  assert.equal(first.body.returned, 2);
  assert.equal(first.body.total, 3);
  assert.ok(first.body.nextCursor);

  const second = await invoke('GET', '/api/todos/usage', {
    query: { limit: '2', cursor: first.body.nextCursor },
  });
  assert.equal(second.status, 200, 'a rolling window must not stale the cursor');
  assert.equal(second.body.returned, 1);
  assert.equal(second.body.nextCursor, null);
  const seen = [...first.body.todos, ...second.body.todos].map((row) => row.todoId);
  assert.equal(new Set(seen).size, 3);
  assert.deepEqual(second.body.workspace.usd, first.body.workspace.usd);
  assert.equal(second.body.workspace.reportedUsd, first.body.workspace.reportedUsd);
  assert.equal(first.body.workspace.reportedUsd, 3);

  usage({ delegationId: 'pag0', attemptId: 'a0', runId: 'r0', reportedUsd: 1, logicalEventKey: 'late' });
  const stale = await invoke('GET', '/api/todos/usage', {
    query: { limit: '2', cursor: first.body.nextCursor },
  });
  assert.equal(stale.status, 409, 'new ledger events invalidate the cursor');
  assert.equal(stale.body.code, 'CONFLICT');
});

test('one todo usage splits own and consolidated and reports coverage', async () => {
  const cwd = newCwd();
  const root = addTodo(dataDir, cwd, { title: 'root', status: 'ready' }).item;
  const child = addTodo(dataDir, cwd, { title: 'child', status: 'ready', parentId: root.id }).item;
  delegation(cwd, { id: 'tree-1', leafId: root.id, attemptId: 'a1', runId: 'r1' });
  delegation(cwd, { id: 'tree-2', leafId: child.id, attemptId: 'a2', runId: 'r2' });
  updateDelegationRecord('tree-1', { queuedAt: plusMs(AT, -5000), startedAt: AT, finishedAt: plusMs(AT, 60_000) });
  updateDelegationRecord('tree-2', { queuedAt: plusMs(AT, -5000), startedAt: AT, finishedAt: plusMs(AT, 120_000) });
  usage({ delegationId: 'tree-1', attemptId: 'a1', runId: 'r1', reportedUsd: 1 });
  usage({ delegationId: 'tree-2', attemptId: 'a2', runId: 'r2', reportedUsd: 2 });

  const { invoke } = makeApp(cwd);
  const res = await invoke('GET', '/api/todos/:id/usage', { params: { id: root.id } });
  assert.equal(res.status, 200);
  assert.equal(res.body.usage.own.usd, 1);
  assert.equal(res.body.usage.consolidated.usd, 2);
  assert.equal(res.body.usage.mixed, true);
  assert.equal(res.body.usage.usd, undefined, 'no combined total');
  assert.equal(res.body.usage.own.attemptsDurationMs, 60_000);
  assert.equal(res.body.usage.consolidated.attemptsDurationMs, 120_000);
  // Elapsed is the wall-clock span (queue of the first attempt to the last
  // finish), a different metric from the sum of attempt durations.
  assert.equal(res.body.usage.consolidated.elapsedMs, 125_000);
  assert.equal(res.body.window.ok, true);
});

test('a todo without usage is null with coverage, not zero', async () => {
  const cwd = newCwd();
  const only = addTodo(dataDir, cwd, { title: 'idle', status: 'idea' }).item;
  const { invoke } = makeApp(cwd);
  const res = await invoke('GET', '/api/todos/:id/usage', { params: { id: only.id } });
  assert.equal(res.status, 200);
  assert.equal(res.body.usage.own.usd, null);
  assert.equal(res.body.usage.own.tokens, null);
  assert.equal(res.body.usage.own.coverage.state, 'no_data');
  assert.equal(res.body.usage.own.coverage.costSource, 'none');
});

test('an unknown todo is 404 and a bad window is 400', async () => {
  const cwd = newCwd();
  const { invoke } = makeApp(cwd);
  const missing = await invoke('GET', '/api/todos/:id/usage', { params: { id: 'nope' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);

  const bad = await invoke('GET', '/api/todos/:id/usage', {
    params: { id: 'nope' },
    query: { from: '2026-01-01', to: '2026-09-30' },
  });
  assert.equal(bad.status, 400, 'validation wins over the unknown id');
  assert.equal(bad.body.code, 'VALIDATION');
});

test('a retry of one delegation does not double the numbers', async () => {
  const cwd = newCwd();
  const only = addTodo(dataDir, cwd, { title: 'retry', status: 'doing' }).item;
  delegation(cwd, { id: 'dr', leafId: only.id, attemptId: 'a1', runId: 'r1' });
  usage({ delegationId: 'dr', attemptId: 'a1', runId: 'r1', reportedUsd: 1 });
  // Retry: the first attempt is archived and a new attempt/run takes over.
  updateDelegationRecord('dr', {
    attempts: [{ attemptId: 'a1', runId: 'r1', status: 'failed' }],
    attemptId: 'a2',
    runId: 'r2',
  });
  usage({ delegationId: 'dr', attemptId: 'a2', runId: 'r2', reportedUsd: 2 });

  const { invoke } = makeApp(cwd);
  const res = await invoke('GET', '/api/todos/:id/usage', { params: { id: only.id } });
  assert.equal(res.body.usage.own.attempts, 2, 'two attempts');
  assert.equal(res.body.usage.own.delegations, 1, 'one delegation');
  assert.equal(res.body.usage.own.usd, 3);
});

test('workspace scope only sees the todos of the requested workspace', async () => {
  const cwd = newCwd();
  const other = newCwd();
  const mine = addTodo(dataDir, cwd, { title: 'mine', status: 'ready' }).item;
  addTodo(dataDir, other, { title: 'other', status: 'ready' });
  delegation(cwd, { id: 'dm', leafId: mine.id, attemptId: 'a1', runId: 'r1' });
  usage({ delegationId: 'dm', attemptId: 'a1', runId: 'r1', reportedUsd: 4 });

  const { invoke } = makeApp(cwd);
  const res = await invoke('GET', '/api/todos/usage');
  assert.equal(res.body.todos.length, 1);
  assert.equal(res.body.todos[0].todoId, mine.id);
  assert.equal(res.body.workspace.usd, 4);
  assert.equal(loadTodosData(dataDir, cwd).items.length, 1);
});

test('the ledger being unreadable answers unavailable (503)', async () => {
  const cwd = newCwd();
  const only = addTodo(dataDir, cwd, { title: 'x', status: 'ready' }).item;
  const { invoke } = makeApp(cwd);
  // The usage directory is a real file, so the journal read fails.
  const fs = await import('node:fs');
  const usageDir = path.join(dataDir, 'usage');
  fs.rmSync(usageDir, { recursive: true, force: true });
  fs.writeFileSync(usageDir, 'not-a-directory');
  try {
    const res = await invoke('GET', '/api/todos/:id/usage', { params: { id: only.id } });
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, 'USAGE_UNAVAILABLE');
    const list = await invoke('GET', '/api/todos/usage');
    assert.equal(list.status, 503);
    assert.equal(list.body.code, 'USAGE_UNAVAILABLE');
  } finally {
    fs.rmSync(usageDir, { recursive: true, force: true });
  }
});

test('responses carry no absolute paths or workspace folder', async () => {
  const cwd = newCwd();
  const only = addTodo(dataDir, cwd, { title: 'paths', status: 'ready' }).item;
  delegation(cwd, { id: 'dpath', leafId: only.id, attemptId: 'a1', runId: 'r1' });
  usage({ delegationId: 'dpath', attemptId: 'a1', runId: 'r1', reportedUsd: 1 });
  const { invoke } = makeApp(cwd);
  const list = await invoke('GET', '/api/todos/usage');
  const one = await invoke('GET', '/api/todos/:id/usage', { params: { id: only.id } });
  for (const res of [list, one]) {
    assert.equal(res.status, 200);
    const serialised = JSON.stringify(res.body);
    assert.ok(!('cwd' in res.body), 'no cwd field');
    assert.ok(!serialised.includes(cwd), 'workspace folder must not leak');
    assert.ok(!serialised.includes('/home/'), 'no absolute home path');
    assert.ok(!serialised.includes(tmpdir()), 'no temp path');
  }
});

test('contractual.complete reflects the real ledger read path', async () => {
  const cwd = newCwd();
  const only = addTodo(dataDir, cwd, { title: 'complete', status: 'ready' }).item;
  delegation(cwd, { id: 'dcomplete', leafId: only.id, attemptId: 'a1', runId: 'r1' });
  usage({ delegationId: 'dcomplete', attemptId: 'a1', runId: 'r1', reportedUsd: 1 });
  const { invoke } = makeApp(cwd);
  const day = AT.slice(0, 10);
  const to = plusMs(AT, 2 * 24 * 60 * 60 * 1000).slice(0, 10);

  // The window starts on the oldest retained day: every day is provable.
  const tight = await invoke('GET', '/api/todos/:id/usage', {
    params: { id: only.id },
    query: { from: day, to, tz: 'UTC' },
  });
  assert.equal(tight.status, 200);
  assert.equal(tight.body.usage.own.coverage.ledger.corrupt, 0);
  assert.equal(tight.body.usage.own.coverage.ledger.retainedOut, 0);
  assert.equal(tight.body.usage.own.coverage.contractual.complete, true);

  // A window reaching back before the oldest day file cannot be proven.
  const wide = await invoke('GET', '/api/todos/:id/usage', {
    params: { id: only.id },
    query: { from: plusMs(AT, -5 * 24 * 60 * 60 * 1000).slice(0, 10), to, tz: 'UTC' },
  });
  assert.equal(wide.body.usage.own.coverage.ledger.retainedOut, 1);
  assert.equal(wide.body.usage.own.coverage.contractual.complete, false);
});
