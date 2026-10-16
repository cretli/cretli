/**
 * Workspace Watcher review gate (`docs/workspace-watcher-review-gate.md`).
 *
 * Exercises the real selection / close / recovery paths, not only the helpers:
 * REST `PATCH /api/todos/:id`, the in-process MCP client, the report close (C1),
 * the runtime reconcile (C3), the boot reconcile (C4) and the claim release.
 * Every case uses a scratch data dir and workspace under os.tmpdir().
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  normalizeWorkspaceWatcherPolicy,
  normalizeWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
  acquireWorkspaceWatcherLease,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  addTodo,
  getTodoById,
  loadTodosData,
  updateTodo,
  writeTodoReview,
} from '../lib/persist/todos-persist.js';
import {
  WORKSPACE_WATCHER_CYCLE_BLOCKED_REASON_CODES,
  beginWorkspaceWatcherCycleMetric,
  getWorkspaceWatcherCycleMetric,
} from '../lib/persist/workspace-watcher-cycle-metrics-persist.js';
import {
  reconcileWorkspaceWatcherCycle,
  reportWorkspaceWatcherCycle,
} from '../lib/workspace-watcher-cycle.js';
import {
  buildWorkspaceWatcherCycleClosePatch,
  reconcileWorkspaceWatcherReviewWaits,
  releaseWorkspaceWatcherCycleTodoClaim,
  resolveWorkspaceWatcherCycleBlockedReasonCode,
  resolveWorkspaceWatcherCycleCloseOutcome,
  resolveWorkspaceWatcherCycleReviewGate,
} from '../lib/workspace-watcher-cycle-close.js';
import {
  evaluateReviewGate,
  guardCycleDoneWrite,
  isReviewGateBlockedReason,
  resolveReviewGateMaxAttempts,
} from '../lib/workspace-watcher-review-gate.js';
import { registerTodosRoutes } from '../lib/routes/todos-routes.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';
import { buildWorkspaceWatcherCyclePromptPlan } from '../lib/workspace-watcher-prompt.js';
import { classifyWorkspaceDoingTodo } from '../lib/workspace-watcher-recovery.js';
import { reconcileWorkspaceWatchersOnBoot, releaseStaleWorkspaceTodoClaims } from '../lib/workspace-watcher.js';
import { markTodoIntegrationReady } from '../lib/workspace-watcher-integration.js';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-review-gate-'));

/** @param {string} name */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} name */
function makeWorkspace(name) {
  const dir = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {string} cwd
 * @param {string} dataDir
 * @param {object} [policy]
 */
function setAutopilot(cwd, dataDir, policy = {}) {
  return upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 50,
      maxParallel: 5,
      maxConsecutiveFailures: 3,
      requireReviewForDone: 'enforce',
      ...policy,
    },
  }, { dataDir });
}

/**
 * @param {string} cwd
 * @param {string} dataDir
 * @param {{ cycleId: string, chatId: string, todoIds: string[], reportedOutcome?: string }} input
 */
function seedActiveCycle(cwd, dataDir, input) {
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: {
      cycleId: input.cycleId,
      todoIds: input.todoIds,
      startedAt: iso(T0),
      chatId: input.chatId,
      runId: 'run-seed',
      phase: 'running',
      mode: 'implement',
      planOnly: false,
      ...(input.reportedOutcome ? { reportedOutcome: input.reportedOutcome, reportedAt: iso(T0 + 1000) } : {}),
    },
    lease: acquireWorkspaceWatcherLease(row, { token: 'seed-token', ttlMs: 60_000, now: T0 }).lease,
  }), { dataDir });
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: input.cycleId,
    workspaceFolder: cwd,
    mode: 'implement',
    orchestratorChatId: input.chatId,
    todoIds: input.todoIds,
    startedAt: iso(T0),
  });
}

/**
 * A claimed `doing` leaf, as a running cycle leaves it.
 *
 * @param {string} cwd
 * @param {string} dataDir
 * @param {string} chatId
 * @param {string} [title]
 */
function addClaimedLeaf(cwd, dataDir, chatId, title = 'leaf') {
  const leaf = addTodo(dataDir, cwd, { title, status: 'ready' }).item;
  updateTodo(dataDir, cwd, leaf.id, {
    status: 'doing',
    claimedByChatId: chatId,
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
  });
  return leaf;
}

/**
 * @param {string} cwd
 * @param {string} dataDir
 * @param {string} todoId
 * @param {{ state?: string, implementer?: boolean, current?: boolean, independent?: boolean, revision?: string }} [options]
 */
function writeCodeReview(cwd, dataDir, todoId, options = {}) {
  const state = options.state || 'passed';
  writeTodoReview(dataDir, cwd, todoId, {
    code: {
      state,
      stateReason: 'fresh_review',
      subject: 'code',
      subjectSource: 'explicit',
      reviewers: [{
        delegationId: `d-${todoId}`,
        attemptId: `a-${todoId}`,
        leafId: todoId,
        harness: 'deepseek',
        model: 'flash',
        status: 'completed',
        verdict: state === 'failed' ? 'FAIL' : 'PASS',
        usable: true,
        independence: options.independent === false ? 'same_base_model' : 'different_base_model',
      }],
      implementer: options.implementer === false ? null : {
        delegationId: `i-${todoId}`,
        attemptId: `ia-${todoId}`,
        role: 'implement',
        harness: 'codex',
        model: 'gpt-5',
      },
      independence: {
        independent: options.independent !== false,
        class: options.independent === false ? 'same_base_model' : 'different_base_model',
        reference: 'implementer',
      },
      material: {
        current: options.current !== false,
        kind: 'trusted',
        reason: 'fresh_review',
        revision: options.revision || 'rev-1',
      },
    },
  });
}

/**
 * Report a success for the seeded cycle.
 *
 * @param {string} cwd
 * @param {string} dataDir
 * @param {string} chatId
 * @param {string} todoId
 * @param {string} cycleId
 */
function reportSuccess(cwd, dataDir, chatId, todoId, cycleId) {
  return reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 60_000,
    sourceChatId: chatId,
    outcome: 'success',
    todoIds: [todoId],
    cycleId,
    reportId: `r-${cycleId}`,
  });
}

/**
 * Run one full unsatisfied close for a leaf and return the watcher row.
 *
 * @param {{ cwd: string, dataDir: string, n: number, todoId: string }} input
 */
function closeUnsatisfied(input) {
  const chatId = `orch-${input.n}`;
  const cycleId = `c-${input.n}`;
  const current = getTodoById(input.dataDir, input.cwd, input.todoId);
  if (current.status === 'ready') {
    updateTodo(input.dataDir, input.cwd, input.todoId, {
      status: 'doing',
      claimedByChatId: chatId,
      expectedUpdatedAt: current.updatedAt,
    });
  } else {
    updateTodo(input.dataDir, input.cwd, input.todoId, {
      claimedByChatId: chatId,
      expectedUpdatedAt: current.updatedAt,
    });
  }
  seedActiveCycle(input.cwd, input.dataDir, { cycleId, chatId, todoIds: [input.todoId] });
  const result = reportSuccess(input.cwd, input.dataDir, chatId, input.todoId, cycleId);
  assert.equal(result.ok, true, result.reason);
  return getWorkspaceWatcher(input.cwd, { dataDir: input.dataDir });
}

/**
 * Fake express app around the real todos routes.
 *
 * @param {string} dataDir
 * @param {string} cwd
 */
function makeRouteInvoker(dataDir, cwd) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(p, fn) { handlers.set(`GET ${p}`, fn); },
    post(p, fn) { handlers.set(`POST ${p}`, fn); },
    patch(p, fn) { handlers.set(`PATCH ${p}`, fn); },
    delete(p, fn) { handlers.set(`DELETE ${p}`, fn); },
  };
  registerTodosRoutes(app, {
    dataDir,
    getCurrentCwd: () => cwd,
    getCurrentWorkspaceFile: () => path.join(cwd, 'proj.code-workspace'),
    agentModel: 'auto',
    getLocalCallbackBaseUrl: () => 'http://127.0.0.1:9999',
    useHttps: false,
  });
  return (method, urlPath, req = {}) => {
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
}

// --- Policy ----------------------------------------------------------------

test('policy defaults are off / false / 2 and invalid values normalize', () => {
  const defaults = normalizeWorkspaceWatcherPolicy({});
  assert.equal(defaults.requireReviewForDone, 'off');
  assert.equal(defaults.requireIndependentReview, false);
  assert.equal(defaults.reviewGateMaxAttempts, 2);
  const bad = normalizeWorkspaceWatcherPolicy({
    requireReviewForDone: 'ENFORCE-ish', requireIndependentReview: 'yes', reviewGateMaxAttempts: 99,
  });
  assert.equal(bad.requireReviewForDone, 'off');
  assert.equal(bad.requireIndependentReview, false);
  assert.equal(bad.reviewGateMaxAttempts, 5);
  assert.equal(normalizeWorkspaceWatcherPolicy({ requireReviewForDone: 'warn' }).requireReviewForDone, 'warn');
  assert.equal(resolveReviewGateMaxAttempts({ reviewGateMaxAttempts: 0 }), 2);
});

test('reviewWaits survives a row normalization round-trip (restart)', () => {
  const row = normalizeWorkspaceWatcherRow({
    workspaceFolder: '/tmp/my-app',
    reviewWaits: {
      leaf: { since: iso(T0), attempts: 2, materialRevision: 'r1', phase: 'fix', worktree: true, junk: 1 },
      '': { attempts: 1 },
    },
  });
  assert.deepEqual(row.reviewWaits, {
    leaf: { since: iso(T0), attempts: 2, materialRevision: 'r1', phase: 'fix', worktree: true },
  });
  assert.deepEqual(normalizeWorkspaceWatcherRow(JSON.parse(JSON.stringify(row))).reviewWaits, row.reviewWaits);
});

test('control patch rejects invalid review-gate policy values', async () => {
  const { applyWorkspaceWatcherPatch } = await import('../lib/workspace-watcher-control.js');
  const dataDir = freshDataDir('control-validate');
  const cwd = makeWorkspace('control-validate');
  for (const policy of [
    { requireReviewForDone: 'sometimes' },
    { requireIndependentReview: 'true' },
    { reviewGateMaxAttempts: 9 },
  ]) {
    assert.throws(
      () => applyWorkspaceWatcherPatch({ workspaceFolder: cwd, dataDir, patch: { policy } }),
      (error) => error.code === 'VALIDATION',
    );
  }
});

// --- Matrix (§3) -----------------------------------------------------------

test('policy x review-state matrix for a gated agent done write', () => {
  const gatedRow = (mode, extra = {}) => ({
    policy: { requireReviewForDone: mode, ...extra },
    activeCycles: [{ chatId: 'orch', todoIds: ['leaf'] }],
    reviewWaits: {},
  });
  const todoWith = (code) => ({ id: 'leaf', status: 'doing', review: code ? { code } : undefined });
  const passed = {
    state: 'passed',
    implementer: { role: 'implement' },
    independence: { independent: true, class: 'different_base_model' },
    material: { current: true },
  };
  const rows = [
    ['passed+implementer', passed, 'allow', {}],
    ['passed no implementer', { ...passed, implementer: null }, 'reject', {}],
    ['manual', { state: 'manual', implementer: null, material: { current: true } }, 'allow', {}],
    ['none', null, 'reject', {}],
    ['stale', { ...passed, state: 'stale' }, 'reject', {}],
    ['unknown', { ...passed, state: 'unknown' }, 'reject', {}],
    ['failed', { ...passed, state: 'failed' }, 'reject', {}],
    ['pending', { ...passed, state: 'pending' }, 'reject', {}],
    ['passed material not current', { ...passed, material: { current: false } }, 'reject', {}],
    ['same model, independence required', { ...passed, independence: { independent: false, class: 'same_base_model' } }, 'reject', { requireIndependentReview: true }],
    ['unknown class, independence required', { ...passed, independence: { independent: false, class: 'unknown' } }, 'reject', { requireIndependentReview: true }],
    ['same model, independence not required', { ...passed, independence: { independent: false, class: 'same_base_model' } }, 'allow', {}],
    ['manual with independence required', { state: 'manual', implementer: null, material: { current: true } }, 'allow', { requireIndependentReview: true }],
  ];
  for (const [label, code, enforceExpect, policyExtra] of rows) {
    const todo = todoWith(code);
    const off = guardCycleDoneWrite({ todo, patch: { status: 'done' }, caller: { kind: 'mcp', chatId: 'orch' }, row: gatedRow('off', policyExtra) });
    assert.equal(off.allowed, true, `${label}: off`);
    assert.equal(off.gate, null, `${label}: off never reads todo.review`);
    const warn = guardCycleDoneWrite({ todo, patch: { status: 'done' }, caller: { kind: 'mcp', chatId: 'orch' }, row: gatedRow('warn', policyExtra) });
    assert.equal(warn.allowed, true, `${label}: warn`);
    assert.equal(warn.warn, enforceExpect === 'reject', `${label}: warn records only when unsatisfied`);
    const enforce = guardCycleDoneWrite({ todo, patch: { status: 'done' }, caller: { kind: 'mcp', chatId: 'orch' }, row: gatedRow('enforce', policyExtra) });
    assert.equal(enforce.allowed, enforceExpect === 'allow', `${label}: enforce`);
    const session = guardCycleDoneWrite({ todo, patch: { status: 'done' }, caller: { kind: 'session' }, row: gatedRow('enforce', policyExtra) });
    assert.equal(session.allowed, true, `${label}: a browser session is never gated`);
  }
  // A plan-only review never satisfies.
  const planOnly = { id: 'leaf', status: 'doing', review: { plan: { ...passed, subject: 'plan' } } };
  assert.equal(evaluateReviewGate({ todo: planOnly, policy: {} }).satisfied, false);
});

// --- Identity (D1/D2) ------------------------------------------------------

test('REST PATCH: MCP token (with and without chatId) and widget are gated, browser and unrelated writes pass', async () => {
  const dataDir = freshDataDir('rest');
  const cwd = makeWorkspace('rest');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-rest');
  const other = addTodo(dataDir, cwd, { title: 'outside the cycle', status: 'doing' }).item;
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-rest', chatId: 'orch-rest', todoIds: [leaf.id] });
  const invoke = makeRouteInvoker(dataDir, cwd);
  const patchDone = (id, req) => invoke('PATCH', '/api/todos/:id', {
    params: { id },
    body: { status: 'done', expected_updated_at: undefined, chatId: 'orch-rest' },
    ...req,
  });
  const withChat = await patchDone(leaf.id, { mcpIntegration: { chatId: 'orch-rest' } });
  assert.equal(withChat.status, 400);
  assert.match(String(withChat.body.error), /review_missing/);
  const noChat = await patchDone(leaf.id, { mcpIntegration: {} });
  assert.equal(noChat.status, 400);
  const widget = await patchDone(leaf.id, { widgetAccess: { sub: 'w' } });
  assert.equal(widget.status, 400);
  // A forged body.chatId is data, never identity: a bearer without a chat is still gated.
  const forged = await invoke('PATCH', '/api/todos/:id', {
    params: { id: leaf.id },
    body: { status: 'done', chatId: 'orch-rest' },
    mcpIntegration: { chatId: 'someone-else' },
  });
  assert.equal(forged.status, 400);
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'doing');
  // Outside the gated target the write passes.
  const outside = await patchDone(other.id, { mcpIntegration: { chatId: 'orch-rest' } });
  assert.equal(outside.status, 200);
  // A browser session (no token) is never gated.
  const session = await patchDone(leaf.id, {});
  assert.equal(session.status, 200);
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'done');
});

test('in-process MCP client: callerChatId is judged; doing-then-done does not bypass; marker survives label clear', async () => {
  // The in-process client reads the process data dir, so use it directly.
  const dataDir = resolveDataPath();
  const cwd = makeWorkspace('mcp');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-mcp');
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-mcp', chatId: 'orch-mcp', todoIds: [leaf.id] });
  const chat = addChat('sess-gate', 'Gate chat', null, cwd, 'model', { agentTransport: 'sdk', sdkMode: 'agent' });
  const client = createInProcessMcpClient({ harness: 'sdk', chatId: chat.id, workspaceFolder: cwd });
  await assert.rejects(
    () => client.updateTodo({
      workspaceFolder: cwd,
      todoId: leaf.id,
      expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
      status: 'done',
      callerChatId: 'orch-mcp',
    }),
    (error) => error.code === 'VALIDATION' && error.reason === 'review_missing',
  );
  // Close unsatisfied -> marker. Then bypass attempts through status writes.
  const row = closeUnsatisfied({ cwd, dataDir, n: 1, todoId: leaf.id });
  assert.equal(row.reviewWaits[leaf.id].attempts, 1);
  await client.updateTodo({
    workspaceFolder: cwd,
    todoId: leaf.id,
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
    status: 'doing',
    callerChatId: chat.id,
  });
  await assert.rejects(
    () => client.updateTodo({
      workspaceFolder: cwd,
      todoId: leaf.id,
      expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
      status: 'done',
      callerChatId: chat.id,
    }),
    (error) => error.reason === 'review_missing',
  );
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits[leaf.id], 'marker survives the status write');
  // A qualifying PASS lets the write through and clears the marker.
  writeCodeReview(cwd, dataDir, leaf.id);
  await client.updateTodo({
    workspaceFolder: cwd,
    todoId: leaf.id,
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
    status: 'done',
    callerChatId: chat.id,
  });
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'done');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits[leaf.id], undefined);
});

// --- Close paths -----------------------------------------------------------

test('C1 report: enforce + unsatisfied -> blocked/review_missing, marker, no failure, no backoff, leaf released to ready', () => {
  const dataDir = freshDataDir('c1');
  const cwd = makeWorkspace('c1');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  mutateWorkspaceWatcherRow(cwd, () => ({ failures: { [leaf.id]: 1 } }), { dataDir });
  const row = closeUnsatisfied({ cwd, dataDir, n: 1, todoId: leaf.id });
  assert.equal(row.activeCycles.length, 0);
  assert.equal(row.reviewWaits[leaf.id].attempts, 1);
  assert.equal(row.reviewWaits[leaf.id].phase, 'review');
  assert.equal(row.reviewWaits[leaf.id].worktree, false);
  assert.equal(row.failures[leaf.id], 1, 'failure counter preserved, not incremented or deleted');
  assert.equal(row.blockedBackoff[leaf.id], undefined, 'no blocked backoff growth');
  assert.equal(row.cycleChats.at(-1).outcome, 'blocked');
  assert.ok(row.decisions.some((d) => d.kind === 'review_gate_blocked'));
  const todo = getTodoById(dataDir, cwd, leaf.id);
  assert.equal(todo.status, 'ready', 'non-worktree leaf stays schedulable (review-only next cycle)');
  assert.equal(todo.blockedReason, undefined, 'no label below the cap');
  assert.equal(todo.claimedByChatId, undefined);
  const metric = getWorkspaceWatcherCycleMetric(row.cycleChats.at(-1).cycleId, { dataDir });
  assert.equal(metric.closeOutcome, 'blocked');
  assert.equal(metric.blockedReasonCode, 'review_missing');
});

test('attempt cap: past reviewGateMaxAttempts the leaf stays doing with review_gate_exhausted and is never auto-released', () => {
  const dataDir = freshDataDir('cap');
  const cwd = makeWorkspace('cap');
  setAutopilot(cwd, dataDir, { reviewGateMaxAttempts: 2 });
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  closeUnsatisfied({ cwd, dataDir, n: 1, todoId: leaf.id });
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'ready');
  closeUnsatisfied({ cwd, dataDir, n: 2, todoId: leaf.id });
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'ready', 'attempt 2 is still within the cap');
  const row = closeUnsatisfied({ cwd, dataDir, n: 3, todoId: leaf.id });
  assert.equal(row.reviewWaits[leaf.id].attempts, 3);
  const todo = getTodoById(dataDir, cwd, leaf.id);
  assert.equal(todo.status, 'doing', 'status is not reset to ready');
  assert.equal(todo.claimedByChatId, undefined);
  assert.equal(isReviewGateBlockedReason(todo.blockedReason), true);
  assert.match(todo.blockedReason, /review_gate_exhausted/);
  assert.equal(row.decisions.at(-2).reason === 'review_missing' || row.decisions.some((d) => d.reason === 'review_gate_exhausted'), true);
  // Recovery must not take it back to ready (non-blocking review note).
  const { released } = releaseStaleWorkspaceTodoClaims({
    workspaceFolder: cwd,
    dataDir,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'chat_missing' }),
    now: T0 + 3_600_000,
  });
  assert.deepEqual(released, []);
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'doing');
  const items = loadTodosData(dataDir, cwd).items;
  const state = classifyWorkspaceDoingTodo({
    item: getTodoById(dataDir, cwd, leaf.id),
    items,
    index: new Map(items.map((i) => [i.id, i])),
    childParentIds: new Set(),
    delegations: [],
    cycles: [],
    probe: () => ({ known: true, busy: false, reason: 'chat_missing' }),
    isCycleChatAlive: () => false,
    now: T0,
    reviewWaits: getWorkspaceWatcher(cwd, { dataDir }).reviewWaits,
    reviewPolicy: getWorkspaceWatcher(cwd, { dataDir }).policy,
  });
  assert.equal(state.state, 'user_action');
});

test('FAIL -> fix phase; a material change resets attempts; a PASS removes the marker at the next close', () => {
  const dataDir = freshDataDir('fail-fix');
  const cwd = makeWorkspace('fail-fix');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  writeCodeReview(cwd, dataDir, leaf.id, { state: 'failed', revision: 'rev-A' });
  let row = closeUnsatisfied({ cwd, dataDir, n: 1, todoId: leaf.id });
  assert.equal(row.reviewWaits[leaf.id].phase, 'fix');
  assert.equal(row.reviewWaits[leaf.id].attempts, 1);
  // The next cycle's prompt is a fix prompt for a marker leaf (scheduler unchanged).
  const plan = buildWorkspaceWatcherCyclePromptPlan({
    workspaceFolder: cwd,
    watcher: row,
    decision: { kind: 'start_cycle' },
    todo: getTodoById(dataDir, cwd, leaf.id),
    orchestrator: { harness: 'mock', model: 'cheap', source: 'policy' },
    todoIds: [leaf.id],
    cycleId: 'next',
  });
  assert.match(plan.prompt, /Review gate \(enforced\)/);
  assert.match(plan.prompt, /FIX of the review findings/);
  // Material changed after a fix -> attempts restart at 1.
  writeCodeReview(cwd, dataDir, leaf.id, { state: 'unknown', revision: 'rev-B' });
  row = closeUnsatisfied({ cwd, dataDir, n: 2, todoId: leaf.id });
  assert.equal(row.reviewWaits[leaf.id].attempts, 1);
  assert.equal(row.reviewWaits[leaf.id].materialRevision, 'rev-B');
  assert.equal(row.reviewWaits[leaf.id].phase, 'review');
  // PASS: the close is not gated and the marker is dropped.
  writeCodeReview(cwd, dataDir, leaf.id, { state: 'passed', revision: 'rev-C' });
  const chatId = 'orch-3';
  updateTodo(dataDir, cwd, leaf.id, {
    status: 'doing',
    claimedByChatId: chatId,
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
  });
  updateTodo(dataDir, cwd, leaf.id, {
    status: 'done',
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
  });
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-3', chatId, todoIds: [leaf.id] });
  const result = reportSuccess(cwd, dataDir, chatId, leaf.id, 'c-3');
  assert.equal(result.ok, true);
  row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycleChats.at(-1).outcome, 'success');
  assert.equal(row.reviewWaits[leaf.id], undefined);
});

test('default off: an unreviewed success keeps today\'s outcome and writes no marker', () => {
  const dataDir = freshDataDir('off');
  const cwd = makeWorkspace('off');
  setAutopilot(cwd, dataDir, { requireReviewForDone: 'off' });
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  const row = closeUnsatisfied({ cwd, dataDir, n: 1, todoId: leaf.id });
  assert.deepEqual(row.reviewWaits, {});
  assert.equal(row.cycleChats.at(-1).outcome, 'failure', 'cycle_incomplete exactly as before');
  assert.equal(row.failures[leaf.id], 1);
});

test('warn records a decision and changelog but never changes the cycle outcome', () => {
  const dataDir = freshDataDir('warn');
  const cwd = makeWorkspace('warn');
  setAutopilot(cwd, dataDir, { requireReviewForDone: 'warn' });
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  const row = closeUnsatisfied({ cwd, dataDir, n: 1, todoId: leaf.id });
  assert.deepEqual(row.reviewWaits, {});
  assert.equal(row.cycleChats.at(-1).outcome, 'failure', 'outcome identical to off');
  assert.ok(row.decisions.some((d) => d.kind === 'review_gate_warn' && d.reason === 'review_missing'));
  const changelog = JSON.stringify(getTodoById(dataDir, cwd, leaf.id).changelog || []);
  assert.match(changelog, /review_missing/);
});

test('C3 runtime reconcile of a deferred success without review closes blocked/review_missing', () => {
  const dataDir = freshDataDir('c3');
  const cwd = makeWorkspace('c3');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-dead');
  seedActiveCycle(cwd, dataDir, {
    cycleId: 'c-dead', chatId: 'orch-dead', todoIds: [leaf.id], reportedOutcome: 'success',
  });
  const result = reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 3_600_000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(result.closed, true, JSON.stringify(result));
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.reviewWaits[leaf.id].attempts, 1);
  assert.equal(row.cycleChats.at(-1).outcome, 'blocked');
  assert.equal(row.failures[leaf.id], undefined);
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'ready');
  assert.equal(getWorkspaceWatcherCycleMetric('c-dead', { dataDir }).blockedReasonCode, 'review_missing');
});

test('C4 boot reconcile of a deferred success without review closes blocked/review_missing', () => {
  const dataDir = freshDataDir('c4');
  const cwd = makeWorkspace('c4');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-boot');
  seedActiveCycle(cwd, dataDir, {
    cycleId: 'c-boot', chatId: 'orch-boot', todoIds: [leaf.id], reportedOutcome: 'success',
  });
  reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0 + 3_600_000,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    loadDelegations: () => [],
  });
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycles.length, 0);
  assert.equal(row.reviewWaits[leaf.id].attempts, 1);
  assert.equal(row.cycleChats.at(-1).outcome, 'blocked');
  assert.equal(getWorkspaceWatcherCycleMetric('c-boot', { dataDir }).blockedReasonCode, 'review_missing');
});

test('crash between marker write and release is repaired idempotently at boot', () => {
  const dataDir = freshDataDir('crash');
  const cwd = makeWorkspace('crash');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-crashed');
  mutateWorkspaceWatcherRow(cwd, () => ({
    reviewWaits: { [leaf.id]: { since: iso(T0), attempts: 3, materialRevision: '', phase: 'review', worktree: false } },
  }), { dataDir });
  const first = reconcileWorkspaceWatcherReviewWaits({ workspaceFolder: cwd, dataDir });
  assert.deepEqual(first.released, [leaf.id]);
  const todo = getTodoById(dataDir, cwd, leaf.id);
  assert.equal(todo.claimedByChatId, undefined);
  assert.equal(todo.status, 'doing', 'past the cap the status is not reset to ready');
  const second = reconcileWorkspaceWatcherReviewWaits({ workspaceFolder: cwd, dataDir });
  assert.equal(isReviewGateBlockedReason(getTodoById(dataDir, cwd, leaf.id).blockedReason), true);
  assert.deepEqual(second.released, []);
  // A done / missing todo prunes its marker.
  updateTodo(dataDir, cwd, leaf.id, {
    status: 'done',
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
  });
  assert.deepEqual(reconcileWorkspaceWatcherReviewWaits({ workspaceFolder: cwd, dataDir }).pruned, [leaf.id]);
  assert.deepEqual(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits, {});
});

test('close outcome / blocked-reason dictionaries accept review_missing; unknown stays unknown', () => {
  assert.ok(WORKSPACE_WATCHER_CYCLE_BLOCKED_REASON_CODES.includes('review_missing'));
  assert.equal(resolveWorkspaceWatcherCycleBlockedReasonCode({
    closeOutcome: 'blocked', closeReason: 'review_missing', planOnly: false, todoOutcomes: [{ outcome: 'attempted' }],
  }), 'review_missing');
  assert.equal(resolveWorkspaceWatcherCycleBlockedReasonCode({
    closeOutcome: 'blocked', closeReason: '', planOnly: false, todoOutcomes: [{ outcome: 'attempted' }],
  }), 'unknown');
  const outcome = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle: { todoIds: ['t'] },
    row: {},
    todo: { id: 't', status: 'doing' },
    reportedOutcomeRaw: 'success',
    leafOutcomes: { primaryOutcome: 'attempted' },
    integrationReady: true,
    reviewGateUnsatisfied: true,
  });
  assert.equal(outcome.closeOutcome, 'blocked', 'the gate precedes integrationReady');
  assert.equal(outcome.closeReason, 'review_missing');
  const patch = buildWorkspaceWatcherCycleClosePatch({
    row: normalizeWorkspaceWatcherRow({ workspaceFolder: '/tmp/my-app', failures: { t: 2 } }),
    cycle: { cycleId: 'c', todoIds: ['t'] },
    outcome: 'blocked',
    decisionReason: 'review_missing',
    now: T0,
  });
  assert.equal(patch.failures.t, 2);
  assert.equal(patch.blockedBackoff.t, undefined);
});

// --- Marker preservation / non-clearing paths -------------------------------

test('MCP-token REST retry and todo_integration confirm preserve the marker; a browser session clears it', async () => {
  const dataDir = freshDataDir('preserve');
  const cwd = makeWorkspace('preserve');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  closeUnsatisfied({ cwd, dataDir, n: 1, todoId: leaf.id });
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits[leaf.id]);
  const invoke = makeRouteInvoker(dataDir, cwd);
  const viaToken = await invoke('PATCH', '/api/todos/:id', {
    params: { id: leaf.id },
    body: { status: 'doing' },
    mcpIntegration: { chatId: 'orch-1' },
  });
  assert.equal(viaToken.status, 200);
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits[leaf.id], 'MCP-token REST retry keeps the marker');
  const { confirmWorkspaceTodoIntegration } = await import('../lib/workspace-watcher-integration.js');
  const confirm = confirmWorkspaceTodoIntegration({
    workspaceFolder: cwd,
    dataDir,
    todoId: leaf.id,
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
    proof: { simple: true },
  });
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status === 'done', false, JSON.stringify(confirm));
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits[leaf.id], 'confirm does not clear the marker');
  const viaSession = await invoke('PATCH', '/api/todos/:id', {
    params: { id: leaf.id },
    body: { status: 'doing' },
  });
  assert.equal(viaSession.status, 200);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits[leaf.id], undefined);
});

test('worktree leaf: claim-only release, label after release, never ready; result writer refuses without review', () => {
  const dataDir = freshDataDir('wt');
  const cwd = makeWorkspace('wt');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-wt');
  mutateWorkspaceWatcherRow(cwd, () => ({
    reviewWaits: { [leaf.id]: { since: iso(T0), attempts: 1, materialRevision: '', phase: 'review', worktree: true } },
  }), { dataDir });
  releaseWorkspaceWatcherCycleTodoClaim({ workspaceFolder: cwd, todoId: leaf.id, chatId: 'orch-wt', dataDir });
  const todo = getTodoById(dataDir, cwd, leaf.id);
  assert.equal(todo.status, 'doing');
  assert.equal(todo.claimedByChatId, undefined);
  assert.match(todo.blockedReason, /review_missing/);
  assert.deepEqual(
    markTodoIntegrationReady({ todoId: leaf.id, workspaceFolder: cwd, cycleId: 'x', result: { resultHash: 'h' }, dataDir }),
    { ok: false, changed: false, reason: 'review_missing' },
  );
});

// --- D3 auto-close and prompt ----------------------------------------------

test('D3 auto-close: a PASS without an implementer is refused only while the gate is active; closing clears the marker', async () => {
  const { closeTodoLeafAfterReview } = await import('../lib/todo-review-sync-hooks.js');
  const dataDir = resolveDataPath();
  const reviewOnly = (leafId) => [{
    id: `review-${leafId}`,
    workspaceFolder: '/tmp/ws',
    leafId,
    parentChatId: 'parent',
    assignment: 'review',
    executionMode: 'agent',
    status: 'completed',
    attemptId: `att-${leafId}`,
    queuedAt: iso(T0),
    createdAt: iso(T0),
    startedAt: iso(T0),
    finishedAt: iso(T0),
    executor: { transport: 'opencode', model: 'deepseek-chat' },
    reviewSubject: 'code',
    reviewSubjectSource: 'explicit',
    reportVerdict: 'PASS',
    verifyRequired: false,
    report: 'TASK: review\nVERDICT: PASS',
  }];
  // Gate off: the (experimental) auto-close behaves exactly as before.
  const offCwd = makeWorkspace('d3-off');
  const offLeaf = addTodo(dataDir, offCwd, { title: 'leaf', status: 'doing' }).item;
  const off = closeTodoLeafAfterReview({ dataDir, workspaceFolder: offCwd, todoId: offLeaf.id, rows: reviewOnly(offLeaf.id) });
  assert.equal(off.closed, true);
  // Gate enforced: no implementer -> not gate-qualifying -> refused, marker kept.
  const cwd = makeWorkspace('d3-enforce');
  setAutopilot(cwd, dataDir);
  const leaf = addTodo(dataDir, cwd, { title: 'leaf', status: 'doing' }).item;
  mutateWorkspaceWatcherRow(cwd, () => ({
    reviewWaits: { [leaf.id]: { since: iso(T0), attempts: 1, materialRevision: '', phase: 'review', worktree: false } },
  }), { dataDir });
  const refused = closeTodoLeafAfterReview({ dataDir, workspaceFolder: cwd, todoId: leaf.id, rows: reviewOnly(leaf.id) });
  assert.equal(refused.closed, false);
  assert.equal(refused.reason, 'no_implementer');
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits[leaf.id]);
  // With an implementer the PASS qualifies, closes the leaf and clears the marker.
  const implement = { ...reviewOnly(leaf.id)[0], id: 'impl-1', assignment: 'implement', attemptId: 'att-impl', queuedAt: iso(T0 - 60_000), createdAt: iso(T0 - 60_000), startedAt: iso(T0 - 60_000), finishedAt: iso(T0 - 60_000), report: '' };
  delete implement.reviewSubject;
  delete implement.reportVerdict;
  const closed = closeTodoLeafAfterReview({
    dataDir, workspaceFolder: cwd, todoId: leaf.id, rows: [implement, ...reviewOnly(leaf.id)],
  });
  assert.equal(closed.closed, true, closed.reason);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).reviewWaits[leaf.id], undefined);
});

test('prompt: off adds nothing; enforce states the rejection and the refused-done recovery', () => {
  const build = (policy) => buildWorkspaceWatcherCyclePromptPlan({
    workspaceFolder: '/tmp/my-app',
    watcher: { policy: { requirePlanApproval: false, ...policy }, reviewWaits: {} },
    decision: { kind: 'start_cycle' },
    todo: { id: 'leaf', title: 'x' },
    orchestrator: { harness: 'mock', model: 'cheap', source: 'policy' },
    cycleId: 'c',
  }).prompt;
  assert.doesNotMatch(build({ requireReviewForDone: 'off' }), /Review gate/);
  const enforced = build({ requireReviewForDone: 'enforce', requireIndependentReview: true });
  assert.match(enforced, /REJECTED by the server/);
  assert.match(enforced, /do NOT retry it/);
  assert.match(enforced, /independent of the implementer/);
});

// --- Worktree close (table B) on a real git worktree ------------------------

test('worktree C1: unsatisfied gate -> no integration result, leaf stays doing with review_missing, then a PASS yields the result', async (t) => {
  const { createTempRepo, tempDir, worktreeConfig } = await import('./helpers/temp-git-repo.js');
  const { startWorkspaceWatcherCycle } = await import('../lib/workspace-watcher-cycle.js');
  const { getWorktreeRecord } = await import('../lib/persist/worktree-registry-persist.js');
  const { isTodoAwaitingIntegration } = await import('../lib/workspace-watcher-integration.js');
  const dataDir = tempDir('cretli-gate-data-');
  const baseDir = tempDir('cretli-gate-base-');
  const repo = createTempRepo().dir;
  t.after(() => {
    for (const dir of [dataDir, baseDir, repo]) fs.rmSync(dir, { recursive: true, force: true });
  });
  upsertWorkspaceWatcher(repo, {
    mode: 'autopilot',
    policy: {
      requirePlanApproval: false,
      cooldownMs: 0,
      maxCyclesPerDay: 25,
      maxParallel: 1,
      executionMode: 'worktree',
      worktree: worktreeConfig(baseDir),
      requireReviewForDone: 'enforce',
    },
  }, { dataDir });
  const todo = addTodo(dataDir, repo, { title: 'worktree leaf', status: 'ready', executionMode: 'worktree' }).item;
  const deps = {
    addChat: (_s, title, _wf, _folder, _model, extras) => ({ id: extras.id, title }),
    startChatRun: async () => ({ runId: 'run-1', accepted: true }),
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    notify: () => false,
  };
  const start = async (token) => {
    const started = await startWorkspaceWatcherCycle({
      workspaceFolder: repo,
      dataDir,
      now: T0,
      tick: {
        watcher: getWorkspaceWatcher(repo, { dataDir }),
        decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
        snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, repo, todo.id).updatedAt, title: todo.title }] },
      },
      token,
      deps,
    });
    assert.equal(started.started, true, JSON.stringify(started));
    return { chatId: String(started.cycle.chatId), cycleId: String(started.cycle.cycleId) };
  };
  const first = await start('lease-1');
  const record = getWorktreeRecord(todo.id, { dataDir });
  fs.writeFileSync(path.join(record.worktreePath, 'feature.js'), 'export const x = 1;\n');
  const reported = reportWorkspaceWatcherCycle({
    workspaceFolder: repo, dataDir, now: T0 + 60_000, sourceChatId: first.chatId, outcome: 'success', todoIds: [todo.id], cycleId: first.cycleId, reportId: 'r-wt-1',
  });
  assert.equal(reported.closed, true, JSON.stringify(reported));
  const row = getWorkspaceWatcher(repo, { dataDir });
  assert.equal(row.reviewWaits[todo.id].worktree, true);
  assert.equal(row.cycleChats.at(-1).outcome, 'blocked');
  const after = getTodoById(dataDir, repo, todo.id);
  assert.equal(after.status, 'doing', 'a worktree leaf is never returned to ready');
  assert.equal(after.claimedByChatId, undefined);
  assert.match(after.blockedReason, /review_missing/);
  assert.equal(isTodoAwaitingIntegration(after), false, 'no integration result');
  assert.equal(getWorktreeRecord(todo.id, { dataDir }).integrationState === 'ready', false);
  assert.deepEqual(getWorktreeRecord(todo.id, { dataDir }).results || {}, {});
  // The labelled leaf is not picked automatically (blockedReason on the branch).
  const { listReadyTodoLeaves } = await import('../lib/todo-tree.js');
  assert.equal(listReadyTodoLeaves(loadTodosData(dataDir, repo).items).length, 0);
});

// --- Review findings cff1d3af9a28 ------------------------------------------

test('F1: status case/whitespace variants cannot bypass the gate (guard, REST token + widget, MCP)', async () => {
  const dataDir = freshDataDir('f1');
  const cwd = makeWorkspace('f1');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-f1');
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-f1', chatId: 'orch-f1', todoIds: [leaf.id] });
  const row = getWorkspaceWatcher(cwd, { dataDir });
  const todo = getTodoById(dataDir, cwd, leaf.id);
  for (const status of ['Done', 'DONE', ' done ', '\tDone\n']) {
    const decision = guardCycleDoneWrite({
      todo, patch: { status }, caller: { kind: 'mcp', chatId: 'orch-f1' }, row, items: [todo],
    });
    assert.equal(decision.allowed, false, JSON.stringify(status));
  }
  const invoke = makeRouteInvoker(dataDir, cwd);
  for (const status of ['Done', 'DONE', ' done ']) {
    for (const req of [{ mcpIntegration: { chatId: 'orch-f1' } }, { mcpIntegration: {} }, { widgetAccess: { sub: 'w' } }]) {
      const res = await invoke('PATCH', '/api/todos/:id', { params: { id: leaf.id }, body: { status }, ...req });
      assert.equal(res.status, 400, `${JSON.stringify(status)} ${JSON.stringify(req)}`);
    }
  }
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'doing');
});

test('F1: MCP todo_update status "Done" is rejected in enforce', async () => {
  const dataDir = resolveDataPath();
  const cwd = makeWorkspace('f1-mcp');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-f1m');
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-f1m', chatId: 'orch-f1m', todoIds: [leaf.id] });
  const chat = addChat('sess-f1', 'F1 chat', null, cwd, 'model', { agentTransport: 'sdk', sdkMode: 'agent' });
  const client = createInProcessMcpClient({ harness: 'sdk', chatId: chat.id, workspaceFolder: cwd });
  for (const status of ['Done', 'DONE', ' done ']) {
    await assert.rejects(
      () => client.updateTodo({
        workspaceFolder: cwd, todoId: leaf.id, status, callerChatId: chat.id,
        expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
      }),
      (error) => error.reason === 'review_missing',
      JSON.stringify(status),
    );
  }
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'doing');
});

test('F2: warn lets a done write with expected_updated_at pass via REST and MCP, note recorded afterwards', async () => {
  const dataDir = freshDataDir('f2');
  const cwd = makeWorkspace('f2');
  setAutopilot(cwd, dataDir, { requireReviewForDone: 'warn' });
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-f2');
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-f2', chatId: 'orch-f2', todoIds: [leaf.id] });
  const invoke = makeRouteInvoker(dataDir, cwd);
  const res = await invoke('PATCH', '/api/todos/:id', {
    params: { id: leaf.id },
    body: { status: 'done', expected_updated_at: getTodoById(dataDir, cwd, leaf.id).updatedAt },
    mcpIntegration: { chatId: 'orch-f2' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const after = getTodoById(dataDir, cwd, leaf.id);
  assert.equal(after.status, 'done');
  assert.match(JSON.stringify(after.changelog || []), /review_missing/);
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).decisions.some((d) => d.kind === 'review_gate_warn'));
  assert.equal(res.body.item.updatedAt, after.updatedAt, 'response carries the persisted item');
});

test('F2/F4: warn MCP todo_update passes with expected_updated_at and returns the persisted updated_at', async () => {
  const dataDir = resolveDataPath();
  const cwd = makeWorkspace('f2-mcp');
  setAutopilot(cwd, dataDir, { requireReviewForDone: 'warn' });
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-f2m');
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-f2m', chatId: 'orch-f2m', todoIds: [leaf.id] });
  const chat = addChat('sess-f2', 'F2 chat', null, cwd, 'model', { agentTransport: 'sdk', sdkMode: 'agent' });
  const client = createInProcessMcpClient({ harness: 'sdk', chatId: chat.id, workspaceFolder: cwd });
  const item = await client.updateTodo({
    workspaceFolder: cwd, todoId: leaf.id, status: 'done', callerChatId: chat.id,
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
  });
  const persisted = getTodoById(dataDir, cwd, leaf.id);
  assert.equal(persisted.status, 'done');
  assert.equal(item.updatedAt, persisted.updatedAt);
  assert.match(JSON.stringify(persisted.changelog || []), /review_missing/);
});

test('F4: enforce held leaf — MCP write returns the item after the label reapply (next write does not CONFLICT)', async () => {
  const dataDir = resolveDataPath();
  const cwd = makeWorkspace('f4');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-f4');
  mutateWorkspaceWatcherRow(cwd, () => ({
    reviewWaits: { [leaf.id]: { since: iso(T0), attempts: 1, materialRevision: '', phase: 'review', worktree: true } },
  }), { dataDir });
  const chat = addChat('sess-f4', 'F4 chat', null, cwd, 'model', { agentTransport: 'sdk', sdkMode: 'agent' });
  const client = createInProcessMcpClient({ harness: 'sdk', chatId: chat.id, workspaceFolder: cwd });
  const item = await client.updateTodo({
    workspaceFolder: cwd, todoId: leaf.id, status: 'doing', callerChatId: chat.id,
    expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt,
  });
  const persisted = getTodoById(dataDir, cwd, leaf.id);
  assert.match(persisted.blockedReason, /review_missing/);
  assert.equal(item.updatedAt, persisted.updatedAt);
  assert.match(item.blockedReason, /review_missing/);
});

/**
 * @param {string} cwd
 * @param {string} dataDir
 * @param {{ n: number, todoId: string, outcome: string, message?: string }} input
 */
function closeWithReport(cwd, dataDir, input) {
  const chatId = `orch-${input.n}`;
  const cycleId = `c-${input.n}`;
  const current = getTodoById(dataDir, cwd, input.todoId);
  updateTodo(dataDir, cwd, input.todoId, {
    ...(current.status === 'ready' ? { status: 'doing' } : {}),
    claimedByChatId: chatId,
    expectedUpdatedAt: current.updatedAt,
  });
  seedActiveCycle(cwd, dataDir, { cycleId, chatId, todoIds: [input.todoId] });
  const result = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd, dataDir, now: T0 + 60_000, sourceChatId: chatId,
    outcome: input.outcome, todoIds: [input.todoId], cycleId, reportId: `r-${cycleId}`,
    message: input.message,
  });
  assert.equal(result.ok, true, result.reason);
  return getWorkspaceWatcher(cwd, { dataDir });
}

test('F3: unreviewed success report on a gated leaf writes the marker, closes blocked/review_missing, leaf released to ready', () => {
  const dataDir = freshDataDir('f3-blocked');
  const cwd = makeWorkspace('f3-blocked');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  const row = closeWithReport(cwd, dataDir, { n: 1, todoId: leaf.id, outcome: 'success', message: 'done, no passing review' });
  assert.equal(row.reviewWaits[leaf.id].attempts, 1);
  assert.equal(row.reviewWaits[leaf.id].phase, 'review');
  assert.equal(row.cycleChats.at(-1).outcome, 'blocked');
  assert.ok(row.decisions.some((d) => d.kind === 'review_gate_blocked'));
  assert.equal(row.blockedBackoff[leaf.id], undefined);
  assert.equal(getTodoById(dataDir, cwd, leaf.id).status, 'ready');
});

test('F3: unreviewed success report after a review FAIL sets phase=fix', () => {
  const dataDir = freshDataDir('f3-fail');
  const cwd = makeWorkspace('f3-fail');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  writeCodeReview(cwd, dataDir, leaf.id, { state: 'failed' });
  const row = closeWithReport(cwd, dataDir, { n: 1, todoId: leaf.id, outcome: 'success' });
  assert.equal(row.reviewWaits[leaf.id].phase, 'fix');
});

test('F3: failure report on a gated leaf writes the marker; failure is still counted', () => {
  const dataDir = freshDataDir('f3-failure');
  const cwd = makeWorkspace('f3-failure');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  const row = closeWithReport(cwd, dataDir, { n: 1, todoId: leaf.id, outcome: 'failure' });
  assert.equal(row.reviewWaits[leaf.id].attempts, 1);
  assert.equal(row.cycleChats.at(-1).outcome, 'failure');
  assert.equal(row.failures[leaf.id], 1);
});

test('F3: blocked/failure reports with a satisfied gate, in off, and in warn mode write no marker', () => {
  const dataDir = freshDataDir('f3-none');
  const cwd = makeWorkspace('f3-none');
  setAutopilot(cwd, dataDir);
  const reviewed = addClaimedLeaf(cwd, dataDir, 'orch-1', 'reviewed');
  writeCodeReview(cwd, dataDir, reviewed.id);
  assert.deepEqual(closeWithReport(cwd, dataDir, { n: 1, todoId: reviewed.id, outcome: 'blocked' }).reviewWaits, {});
  setAutopilot(cwd, dataDir, { requireReviewForDone: 'warn' });
  const warnLeaf = addClaimedLeaf(cwd, dataDir, 'orch-2', 'warn leaf');
  const warnRow = closeWithReport(cwd, dataDir, { n: 2, todoId: warnLeaf.id, outcome: 'failure' });
  assert.deepEqual(warnRow.reviewWaits, {});
  assert.equal(warnRow.cycleChats.at(-1).outcome, 'failure');
  assert.ok(!warnRow.decisions.some((d) => d.kind === 'review_gate_warn'));
  setAutopilot(cwd, dataDir, { requireReviewForDone: 'off' });
  const offLeaf = addClaimedLeaf(cwd, dataDir, 'orch-3', 'off leaf');
  assert.deepEqual(closeWithReport(cwd, dataDir, { n: 3, todoId: offLeaf.id, outcome: 'blocked' }).reviewWaits, {});
});

test('F3: unreviewed success report on a worktree-marked leaf keeps it doing with review_missing; failure too', () => {
  for (const outcome of ['success', 'failure']) {
    const dataDir = freshDataDir(`f3-wt-${outcome}`);
    const cwd = makeWorkspace(`f3-wt-${outcome}`);
    setAutopilot(cwd, dataDir);
    const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
    mutateWorkspaceWatcherRow(cwd, () => ({
      reviewWaits: { [leaf.id]: { since: iso(T0), attempts: 1, materialRevision: '', phase: 'review', worktree: true } },
    }), { dataDir });
    const row = closeWithReport(cwd, dataDir, { n: 1, todoId: leaf.id, outcome });
    assert.equal(row.reviewWaits[leaf.id].attempts, 2);
    const todo = getTodoById(dataDir, cwd, leaf.id);
    assert.equal(todo.status, 'doing', outcome);
    assert.equal(todo.claimedByChatId, undefined);
    assert.match(todo.blockedReason, /review_missing/);
  }
});

test('F3/F6: a released non-worktree gated leaf is reselected through the real snapshot/decision path', async () => {
  const { snapshotWorkspaceWatcher, decideWorkspaceWatcherAction } = await import('../lib/workspace-watcher.js');
  const dataDir = freshDataDir('f3-resel');
  const cwd = makeWorkspace('f3-resel');
  setAutopilot(cwd, dataDir);
  const leaf = addClaimedLeaf(cwd, dataDir, 'orch-1');
  const row = closeWithReport(cwd, dataDir, { n: 1, todoId: leaf.id, outcome: 'success' });
  const snapshot = snapshotWorkspaceWatcher({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 120_000,
    deps: { loadDelegations: () => [], listWorkspaceChats: () => [] },
  });
  assert.deepEqual(snapshot.readyTodoIds, [leaf.id]);
  const decision = decideWorkspaceWatcherAction({
    watcher: { ...row, enabled: true },
    snapshot,
    now: T0 + 120_000,
  });
  assert.equal(decision.kind, 'start_cycle', JSON.stringify(decision));
  assert.equal(decision.nextTodoId, leaf.id);
});

test('F5: boot reconcile only lists a leaf as released when the release actually happened', () => {
  const dataDir = freshDataDir('f5');
  const cwd = makeWorkspace('f5');
  setAutopilot(cwd, dataDir);
  const fenced = addClaimedLeaf(cwd, dataDir, 'dead-chat', 'fenced');
  // An attempt id without a matching cycle id fences the release: it is a no-op.
  updateTodo(dataDir, cwd, fenced.id, {
    execution: { attemptId: 'attempt-1', cycleId: 'c-old' },
    expectedUpdatedAt: getTodoById(dataDir, cwd, fenced.id).updatedAt,
  });
  const plain = addClaimedLeaf(cwd, dataDir, 'dead-chat-2', 'plain');
  const marker = { since: iso(T0), attempts: 1, materialRevision: '', phase: 'review', worktree: false };
  mutateWorkspaceWatcherRow(cwd, () => ({
    reviewWaits: { [fenced.id]: marker, [plain.id]: marker },
  }), { dataDir });
  const out = reconcileWorkspaceWatcherReviewWaits({ workspaceFolder: cwd, dataDir });
  assert.deepEqual(out.released, [plain.id]);
  assert.equal(getTodoById(dataDir, cwd, fenced.id).claimedByChatId, 'dead-chat');
  assert.equal(getTodoById(dataDir, cwd, plain.id).claimedByChatId, undefined);
});

test('enforce: a blocked report with a non-review cause keeps reported_blocked and its backoff', () => {
  const unsatisfied = resolveWorkspaceWatcherCycleCloseOutcome({
    cycle: { todoIds: ['t'] },
    row: {},
    todo: { id: 't', status: 'doing' },
    reportedOutcomeRaw: 'blocked',
    leafOutcomes: { primaryOutcome: 'attempted' },
    reviewGateUnsatisfied: true,
  });
  assert.equal(unsatisfied.closeOutcome, 'blocked');
  assert.equal(unsatisfied.closeReason, 'cycle_blocked');
  assert.equal(unsatisfied.countIncompleteFailure, true);
  assert.equal(resolveWorkspaceWatcherCycleBlockedReasonCode({
    closeOutcome: 'blocked', closeReason: unsatisfied.closeReason, planOnly: false, todoOutcomes: [{ outcome: 'attempted' }],
  }), 'reported_blocked');
  const gate = resolveWorkspaceWatcherCycleReviewGate({
    row: { policy: { reviewGate: 'enforce' } },
    cycle: { todoIds: ['t'] },
    todo: { id: 't', status: 'doing' },
    reportedOutcome: 'blocked',
    at: T0,
  });
  assert.equal(gate.unsatisfied, false);
  assert.equal(gate.reviewWaits, null);
});
