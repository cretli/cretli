/**
 * Route tests for the Workspace Watcher API.
 *
 * Uses the isolated data dir helper and a temp cwd so no live project data is
 * touched. Registering the routes on a tiny fake express app keeps the test
 * free of HTTP and auth.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs, { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import { getWorkspaceWatcher, mutateWorkspaceWatcherRow } from '../lib/persist/workspace-watchers-persist.js';
import { registerWorkspaceWatcherRoutes } from '../lib/routes/workspace-watcher-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

let failed = 0;
/** @type {Array<{ name: string, fn: Function }>} */
const cases = [];

function runCase(name, fn) {
  cases.push({ name, fn });
}

function fail(name, err) {
  failed += 1;
  console.error('FAIL:', name);
  console.error(err && err.stack ? err.stack : String(err));
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cwd = mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-routes-'));
const otherCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-routes-other-'));
const dataDir = path.join(cwd, 'data');

/**
 * @returns {{ invoke: (method: string, urlPath: string, req?: object) => Promise<{status: number, body: object}> }}
 */
function makeApp() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
    patch(p, fn) { handlers.set(`PATCH ${p}`, fn); },
    delete(p, fn) { handlers.set(`DELETE ${p}`, fn); },
  };
  registerWorkspaceWatcherRoutes(app, { dataDir, getCurrentCwd: () => cwd });
  const invoke = (method, urlPath, req = {}) => {
    const fn = handlers.get(`${method} ${urlPath}`);
    if (!fn) throw new Error(`no handler ${method} ${urlPath}`);
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { resolve({ status: this.statusCode, body }); },
      };
      fn({ params: {}, query: {}, body: {}, ...req }, res);
    });
  };
  return { invoke };
}

function withApp(fn) {
  return () => fn(makeApp().invoke);
}

runCase('GET returns an off default without creating a row', withApp(async (invoke) => {
  const res = await invoke('GET', '/api/workspace-watcher');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.watcher.mode, 'off');
  assert.equal(res.body.watcher.enabled, false);
  assert.ok(res.body.snapshot);
  assert.equal(res.body.snapshot.items, undefined);
  assert.equal(res.body.snapshot.readyLeaves, undefined);
  assert.ok(Array.isArray(res.body.snapshot.readyTodoIds));
  assert.ok(res.body.guardrails);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }), null, 'a read must not persist a row');
}));

runCase('GET omits todo documents and keeps ready counts', withApp(async (invoke) => {
  const doc = addTodo(dataDir, cwd, { title: 'Ready leaf', status: 'ready' });
  const res = await invoke('GET', '/api/workspace-watcher');
  assert.equal(res.status, 200);
  assert.equal(res.body.snapshot.items, undefined);
  assert.equal(res.body.snapshot.readyLeaves, undefined);
  assert.equal(res.body.snapshot.readyTodoCount, 1);
  assert.deepEqual(res.body.snapshot.readyTodoIds, [doc.item.id]);
  updateTodo(dataDir, cwd, doc.item.id, { status: 'done' });
}));

runCase('save-plan persists a draft, invalidates approval, and rejects stale or foreign todos', withApp(async (invoke) => {
  const doc = addTodo(dataDir, cwd, { title: 'Draft route', status: 'idea' });
  const todo = doc.items[0];
  updateTodo(dataDir, cwd, todo.id, { plan: { markdown: 'Old plan', approvedAt: new Date().toISOString() } });
  const current = getTodoById(dataDir, cwd, todo.id);
  const body = { todoId: todo.id, expectedUpdatedAt: current.updatedAt, planMarkdown: 'New draft' };
  const saved = await invoke('POST', '/api/workspace-watcher/save-plan', { body });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.item.plan.markdown, 'New draft');
  assert.ok(!saved.body.item.plan.approvedAt);
  assert.equal((await invoke('POST', '/api/workspace-watcher/save-plan', { body })).status, 409);
  assert.equal((await invoke('POST', '/api/workspace-watcher/save-plan', {
    body: { ...body, workspaceFolder: otherCwd },
  })).status, 404);
  updateTodo(dataDir, cwd, todo.id, { status: 'done' });
}));

runCase('PATCH merges a partial policy and preserves defaults', withApp(async (invoke) => {
  const res = await invoke('PATCH', '/api/workspace-watcher', {
    body: { mode: 'autopilot', policy: { maxParallel: 2, quietHours: { start: '22:00', end: '06:00' } } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.watcher.mode, 'autopilot');
  assert.equal(res.body.watcher.policy.maxParallel, 2);
  assert.equal(res.body.watcher.policy.quietHours.start, '22:00');
  // Untouched defaults survive the partial patch.
  assert.equal(res.body.watcher.policy.maxCyclesPerDay, 20);
  assert.equal(res.body.watcher.policy.requirePlanApproval, true);
  assert.equal(res.body.watcher.policy.orchestrator.harness, '');
  const read = await invoke('GET', '/api/workspace-watcher');
  assert.equal(read.body.watcher.policy.maxParallel, 2);
  assert.equal(read.body.watcher.policy.cooldownMs, 30_000);
}));

runCase('PATCH rejects an invalid mode with 400', withApp(async (invoke) => {
  const res = await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'turbo' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
}));

runCase('PATCH stopReason stops the watcher; empty clears it', withApp(async (invoke) => {
  await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'observe', stopReason: 'maintenance' } });
  let read = await invoke('GET', '/api/workspace-watcher');
  assert.equal(read.body.watcher.stopReason, 'maintenance');
  await invoke('PATCH', '/api/workspace-watcher', { body: { stopReason: '' } });
  read = await invoke('GET', '/api/workspace-watcher');
  assert.equal(read.body.watcher.stopReason, '');
}));

runCase('PATCH paused toggles the global pause and preserves failures, backoff and findings', withApp(async (invoke) => {
  await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'autopilot', paused: true } });
  mutateWorkspaceWatcherRow(cwd, () => ({
    failures: { todoX: 2 },
    backoffUntil: '2026-01-01T00:01:00.000Z',
    findings: { byTodo: { 'todo-a': { hash: 'keep', streak: 2 } } },
  }), { dataDir });
  let read = await invoke('GET', '/api/workspace-watcher');
  assert.equal(read.body.watcher.paused, true);
  assert.equal(read.body.guardrails.kind, 'paused');
  assert.deepEqual(read.body.watcher.failures, { todoX: 2 });
  assert.equal(read.body.watcher.backoffUntil, '2026-01-01T00:01:00.000Z');
  assert.equal(read.body.watcher.findings.byTodo['todo-a'].hash, 'keep');

  await invoke('PATCH', '/api/workspace-watcher', { body: { paused: false } });
  read = await invoke('GET', '/api/workspace-watcher');
  assert.equal(read.body.watcher.paused, false);
  assert.deepEqual(read.body.watcher.failures, { todoX: 2 }, 'unpausing keeps the counters');
  assert.equal(read.body.watcher.findings.byTodo['todo-a'].streak, 2);
  // Leave the shared row clean for the later cases.
  mutateWorkspaceWatcherRow(cwd, () => ({
    failures: {},
    backoffUntil: '',
    findings: { byTodo: {} },
  }), { dataDir });
}));

runCase('POST pause/resume/clear-stop return 503 when the watcher document is locked', withApp(async (invoke) => {
  const routesSource = fs.readFileSync(
    path.join(repoRoot, 'lib/routes/workspace-watcher-routes.js'),
    'utf8',
  );
  assert.match(routesSource, /workspaceWatcherMutationStatus/);
  for (const segment of [
    '/api/workspace-watcher/pause',
    '/api/workspace-watcher/resume',
    '/api/workspace-watcher/clear-stop',
  ]) {
    const start = routesSource.indexOf(`app.post('${segment}'`);
    assert.ok(start >= 0, `missing route ${segment}`);
    const nextRoute = routesSource.indexOf('\n  app.', start + 10);
    const chunk = routesSource.slice(start, nextRoute === -1 ? undefined : nextRoute);
    assert.match(chunk, /workspaceWatcherMutationStatus\(err\)/);
  }
}));

runCase('POST pause/resume/clear-stop and GET decisions expose the control surface', withApp(async (invoke) => {
  await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'observe', stopReason: 'maintenance' } });
  const paused = await invoke('POST', '/api/workspace-watcher/pause', { body: {} });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.watcher.paused, true);
  const resumed = await invoke('POST', '/api/workspace-watcher/resume', { body: {} });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.watcher.paused, false);
  const cleared = await invoke('POST', '/api/workspace-watcher/clear-stop', { body: {} });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.watcher.stopReason, '');
  await invoke('POST', '/api/workspace-watcher/tick', { body: {} });
  const decisions = await invoke('GET', '/api/workspace-watcher/decisions', { query: { limit: '5' } });
  assert.equal(decisions.status, 200);
  assert.ok(Array.isArray(decisions.body.decisions));
  if (decisions.body.decisions.length) {
    const row = decisions.body.decisions.at(-1);
    assert.ok(row.at);
    assert.ok(row.kind);
    assert.ok('reason' in row);
  }
}));

runCase('claim-next refuses with no ready work and succeeds with a ready todo', withApp(async (invoke) => {
  const empty = await invoke('POST', '/api/workspace-watcher/claim-next', { body: { claimedByChatId: 'chat-1' } });
  assert.equal(empty.body.claimed, false);
  assert.equal(empty.body.reason, 'no_ready_work');
  addTodo(dataDir, cwd, { title: 'Route claim', status: 'ready' });
  const claimed = await invoke('POST', '/api/workspace-watcher/claim-next', { body: { claimedByChatId: 'chat-1', ttlMs: 1000 } });
  assert.equal(claimed.body.claimed, true);
  assert.equal(claimed.body.item.claimedByChatId, 'chat-1');
  assert.equal(claimed.body.item.status, 'doing');
  assert.equal(Date.parse(claimed.body.item.claimLeaseUntil) - Date.parse(claimed.body.item.claimedAt), 1000);
}));

runCase('reset-plan-requests clears the anti-loop memory', withApp(async (invoke) => {
  await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'autopilot' } });
  await invoke('POST', '/api/workspace-watcher/reset-plan-requests', { body: {} });
  const read = await invoke('GET', '/api/workspace-watcher');
  assert.deepEqual(read.body.watcher.planRequests, {});
}));

runCase('findings route records a streak for identical hashes', withApp(async (invoke) => {
  await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'observe' } });
  const todoId = 'findings-route-todo';
  await invoke('POST', '/api/workspace-watcher/findings', { body: { hash: 'find-1', todoId } });
  const second = await invoke('POST', '/api/workspace-watcher/findings', { body: { hash: 'find-1', todoId } });
  assert.equal(second.body.hash, 'find-1');
  assert.equal(second.body.streak, 2);
  const different = await invoke('POST', '/api/workspace-watcher/findings', { body: { hash: 'find-2', todoId } });
  assert.equal(different.body.streak, 1);
}));

runCase('tick runs and reports a decision', withApp(async (invoke) => {
  await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'observe' } });
  const res = await invoke('POST', '/api/workspace-watcher/tick', { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.tick);
  assert.ok(['idle_no_work', 'observe_ready', 'wait_active', 'snapshot_error'].includes(res.body.tick.action));
}));

runCase('run-cycle on a workspace without an autopilot row scans nothing', withApp(async (invoke) => {
  const res = await invoke('POST', '/api/workspace-watcher/run-cycle', {
    body: { workspaceFolder: otherCwd },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.scanned, 0);
}));

runCase('report accepts only the active cycle orchestrator and replays idempotently', withApp(async (invoke) => {
  const doc = addTodo(dataDir, cwd, { title: 'Report route', status: 'doing' });
  const todo = doc.items[0];
  await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'autopilot' } });
  mutateWorkspaceWatcherRow(cwd, () => ({
    activeCycle: {
      cycleId: 'route-cycle',
      todoIds: [todo.id],
      startedAt: new Date().toISOString(),
      chatId: 'orch-route',
      runId: 'run-route',
      phase: 'running',
    },
  }), { dataDir });

  const foreign = await invoke('POST', '/api/workspace-watcher/report', {
    body: { outcome: 'success', sourceChatId: 'someone-else', cycleId: 'route-cycle' },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.ok, false);
  assert.equal(foreign.body.reason, 'not_orchestrator');
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, 'a foreign chat cannot close the cycle');

  const reported = await invoke('POST', '/api/workspace-watcher/report', {
    body: { outcome: 'success', sourceChatId: 'orch-route', cycleId: 'route-cycle', reportId: 'route-report' },
  });
  assert.equal(reported.status, 200);
  assert.equal(reported.body.closed, true);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, null);

  const replay = await invoke('POST', '/api/workspace-watcher/report', {
    body: { outcome: 'failure', sourceChatId: 'orch-route', cycleId: 'route-cycle', reportId: 'route-report' },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.closed, undefined);
}));

runCase('DELETE removes the watcher row', withApp(async (invoke) => {
  await invoke('PATCH', '/api/workspace-watcher', { body: { mode: 'observe' } });
  const removed = await invoke('DELETE', '/api/workspace-watcher');
  assert.equal(removed.body.removed, true);
  const again = await invoke('DELETE', '/api/workspace-watcher');
  assert.equal(again.body.removed, false);
}));

// Cases are sequential: they share one watcher row, so an interleaved write
// would make the assertions order-dependent.
for (const { name, fn } of cases) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') await result;
    console.log('OK:', name);
  } catch (err) {
    fail(name, err);
  }
}
removeIsolatedDataDir();
if (failed > 0) {
  console.error(`\n${failed} workspace watcher route test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace watcher route tests passed');
