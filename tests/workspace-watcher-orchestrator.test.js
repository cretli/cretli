/**
 * Workspace Watcher orchestrator contract (stage 4).
 *
 * Covers the prompt contract, the durable cycle report (identity, idempotency,
 * deferred reports with live children), reconcile of a report, the real
 * chat-run transport through the shared mock adapter, CAS claim isolation and
 * `orchestrator_chat_id` stamping on the claimed subtree.
 *
 * The suite uses the isolated data dir helper: chat/todo/watcher stores are
 * scratch copies, never a contributor's real `data/`.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChat, loadChats } from '../lib/persist/chats-persist.js';
import { addTodo, getTodoById, updateTodo } from '../lib/persist/todos-persist.js';
import {
  acquireWorkspaceWatcherLease,
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
  WORKSPACE_WATCHER_CYCLE_OUTCOMES,
} from '../lib/persist/workspace-watchers-persist.js';
import {
  buildWorkspaceWatcherCyclePrompt,
  collectWorkspaceWatcherPromptTodoIds,
  reconcileWorkspaceWatcherCycle,
  reportWorkspaceWatcherCycle,
  stampCycleOrchestratorOnTodoTree,
  startWorkspaceWatcherCycle,
} from '../lib/workspace-watcher-cycle.js';
import { buildWorkspaceWatcherPreviousChatsBlock } from '../lib/workspace-watcher-prompt.js';
import { saveWorkspaceWatcherTodoPlanDraft } from '../lib/workspace-watcher-control.js';
import {
  isWorkspaceWatcherOrchestratorModelUsageLimited,
  resolveWorkspaceWatcherOrchestrator,
} from '../lib/workspace-watcher-orchestrator.js';
import {
  MCP_CAPABILITY_DENIED,
  ORCHESTRATOR_MCP_CONTRACT_TOOLS,
  createMcpCapabilityProbe,
  hasWorkspaceWatcherOrchestratorMcpTools,
  missingWorkspaceWatcherOrchestratorMcpTools,
} from '../lib/mcp/mcp-orchestrator-contract.js';
import { listBuiltinCretliCatalogToolNames } from '../lib/mcp/mcp-orchestrator-contract.js';
import { clearMcpBridgeToolsListed, markMcpBridgeToolsListed, waitForMcpBridgeToolsListed } from '../lib/mcp/mcp-bridge-ready.js';
import { installCodeBuddyMcpReadyGate } from '../lib/codebuddy/codebuddy-live-session.js';
import { reconcileWorkspaceWatchersOnBoot } from '../lib/workspace-watcher.js';
import {
  getMockChatRun,
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-orch-'));
const T0 = Date.parse('2026-02-01T10:00:00.000Z');

let failed = 0;
/** @type {Array<() => Promise<void>>} */
const cases = [];

function runCase(name, fn) {
  cases.push(async () => {
    try {
      await fn();
      console.log('OK:', name);
    } catch (err) {
      failed += 1;
      console.error('FAIL:', name);
      console.error(err && err.stack ? err.stack : String(err));
    }
  });
}

function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeWorkspace(name) {
  const dir = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function addReadyTodo(dataDir, cwd, title, extra = {}) {
  return addTodo(dataDir, cwd, { title, status: 'ready', ...extra }).item;
}

/**
 * A watcher row with autopilot policy loose enough to start a cycle.
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
      ...policy,
    },
  }, { dataDir });
}

/**
 * Fabricate an active cycle that points at a real todo (no chat run needed).
 */
function seedActiveCycle(cwd, dataDir, { cycleId, chatId, todoId, planOnly = false, todoIds, planTargetId }) {
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    activeCycle: {
      cycleId,
      todoIds: todoIds || [todoId],
      startedAt: new Date(T0).toISOString(),
      chatId,
      runId: 'run-seed',
      phase: 'running',
      planOnly,
      ...(planTargetId ? { planTargetId } : {}),
    },
    lease: acquireWorkspaceWatcherLease(row, { token: 'seed-token', ttlMs: 60_000, now: T0 }).lease,
  }), { dataDir });
}

runCase('cycle prompt encodes snapshot/ref, CAS plan, delegations, report and no self-cycle', () => {
  const watcher = {
    policy: { pickRoles: ['plan', 'implement', 'review'], allowedHarnesses: ['mock'], requirePlanApproval: true },
    cycleChats: [
      { id: 'prev-chat-1', cycleId: 'prev-cycle-1', todoIds: ['t0'], at: '2026-01-31T00:00:00.000Z', outcome: 'success' },
    ],
  };
  const planPrompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: '/w',
    watcher,
    decision: { kind: 'plan_gate', planOnly: true },
    todo: { id: 't1', title: 'Plan me' },
    orchestrator: { harness: 'mock', model: 'm', source: 'policy' },
    previousChats: watcher.cycleChats,
    activeUsageLimits: [{ harness: 'limited', resetAt: new Date(T0 + 60_000).toISOString() }],
    cycleId: 'cycle-1',
    chatId: 'chat-1',
  });
  assert.match(planPrompt, /cretli-ref todo=t1/);
  assert.match(planPrompt, /watcher_show/);
  assert.match(planPrompt, /action "save_plan"/);
  assert.match(planPrompt, /expected_updated_at/);
  assert.match(planPrompt, /NEVER set plan\.approvedAt/);
  assert.match(planPrompt, /PLAN ONLY/);
  assert.match(planPrompt, /prev-chat-1/);
  assert.match(planPrompt, /action "report"/);
  assert.match(planPrompt, /outcome: "success" \| "blocked" \| "failure"/);
  assert.match(planPrompt, /cycle_id: "cycle-1"/);
  assert.match(planPrompt, /report_id: "cycle-1"/);
  assert.match(planPrompt, /Never spawn another watcher cycle/);

  const implementPrompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: '/w',
    watcher,
    decision: { kind: 'start_cycle', planOnly: false },
    todo: { id: 't1', title: 'Do me' },
    orchestrator: { harness: 'mock', model: 'm', source: 'policy' },
    cycleId: 'cycle-2',
    chatId: 'chat-2',
  });
  assert.match(implementPrompt, /delegation_start/);
  assert.match(implementPrompt, /MCP contract \(blocking precondition\)/);
  assert.match(implementPrompt, /do NOT implement the work yourself/);
  assert.match(implementPrompt, /never touch files under `data\/`/);
  assert.doesNotMatch(implementPrompt, /NEVER set plan\.approvedAt/);
  assert.match(implementPrompt, /Do not commit or push/);
  assert.match(implementPrompt, /mark this todo done/);
  assert.match(implementPrompt, /wait for human approval/);
  assert.match(implementPrompt, /review PASS/);
  assert.doesNotMatch(implementPrompt, /prev-chat-1/);

  const ungatedPrompt = buildWorkspaceWatcherCyclePrompt({
    workspaceFolder: '/w',
    watcher: { policy: { requirePlanApproval: false } },
    decision: { kind: 'start_cycle' },
    todo: { id: 't1' },
    orchestrator: {},
  });
  assert.match(ungatedPrompt, /proceed directly to implementation/);
  assert.doesNotMatch(ungatedPrompt, /wait for.*approval/);
});

runCase('plan draft is a real CAS write and never approves', () => {
  const dataDir = freshDataDir('plan-cas');
  const cwd = makeWorkspace('plan-cas');
  const todo = addReadyTodo(dataDir, cwd, 'plan cas');
  const before = getTodoById(dataDir, cwd, todo.id);
  const saved = saveWorkspaceWatcherTodoPlanDraft({
    dataDir,
    workspaceFolder: cwd,
    todoId: todo.id,
    expectedUpdatedAt: before.updatedAt,
    planMarkdown: '# Draft plan',
    sourceChatId: 'orch-plan',
  });
  assert.equal(saved.item.plan.markdown, '# Draft plan');
  assert.ok(!saved.item.plan.approvedAt, 'the watcher never approves a plan');
  assert.throws(() => saveWorkspaceWatcherTodoPlanDraft({
    dataDir,
    workspaceFolder: cwd,
    todoId: todo.id,
    expectedUpdatedAt: before.updatedAt,
    planMarkdown: '# Stale plan',
  }), /updated/);
});

runCase('previous chats block is empty-safe and newest-first', () => {
  assert.equal(buildWorkspaceWatcherPreviousChatsBlock([]), '');
  // Deliberately unsorted input: the builder must sort by close time `at`, not
  // rely on the append order of `cycleChats`.
  const block = buildWorkspaceWatcherPreviousChatsBlock([
    { id: 'c-old', todoIds: ['a'], outcome: 'failure', at: '2026-01-01T00:00:00.000Z' },
    { id: 'c-new', todoIds: ['b'], outcome: 'success', at: '2026-02-01T00:00:00.000Z' },
  ], { todoIds: ['b'] });
  assert.ok(block.indexOf('c-new') < block.indexOf('c-old'));
  assert.match(block, /chat_show/);
  assert.match(block, /- \[relevance\] c-new/);
  assert.doesNotMatch(block, /- \[relevance\] c-old/);
});

runCase('orchestrator resolution honors explicit policy, allow-list and usage limits', async () => {
  const catalog = [
    { id: 'mock', enabled: true, ready: true, can_delegate: true },
    { id: 'blocked-harness', enabled: true, ready: true, can_delegate: true },
  ];
  const models = async ({ harness }) => ({
    items: harness === 'mock' ? [{ id: 'cheap' }] : [{ id: 'other' }],
  });
  const explicit = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { orchestrator: { harness: 'mock', model: 'cheap' } } },
    deps: { listHarnessCatalog: async () => catalog, listHarnessModels: models, mcpCapabilityProbe: () => ({ ok: true }) },
  });
  assert.deepEqual({ ok: explicit.ok, harness: explicit.harness, model: explicit.model, source: explicit.source },
    { ok: true, harness: 'mock', model: 'cheap', source: 'policy' });

  const notAllowed = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { allowedHarnesses: ['mock'], orchestrator: { harness: 'blocked-harness', model: 'other' } } },
    deps: { listHarnessCatalog: async () => catalog, listHarnessModels: models, mcpCapabilityProbe: () => ({ ok: true }) },
  });
  assert.equal(notAllowed.ok, false);
  assert.equal(notAllowed.reason, 'orchestrator_harness_not_allowed');

  const limited = isWorkspaceWatcherOrchestratorModelUsageLimited(
    'mock', 'cheap', [{ harness: 'mock', model: 'cheap', resetAt: new Date(Date.now() + 60_000).toISOString() }],
  );
  assert.equal(limited, true);
  const expired = isWorkspaceWatcherOrchestratorModelUsageLimited(
    'mock', 'cheap', [{ harness: 'mock', model: 'cheap', resetAt: new Date(Date.now() - 60_000).toISOString() }],
  );
  assert.equal(expired, false);

  const picked = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { allowedHarnesses: ['mock'] } },
    activeUsageLimits: [{ harness: 'mock', resetAt: new Date(Date.now() + 60_000).toISOString() }],
    deps: {
      listHarnessCatalog: async () => catalog,
      listHarnessModels: models,
      mcpCapabilityProbe: () => ({ ok: true }),
    },
  });
  assert.equal(picked.ok, false, 'a fully limited favorite must not be picked');
});

runCase('executor selection skips a harness that cannot deliver the MCP contract', async () => {
  const catalog = [
    { id: 'with-mcp', enabled: true, ready: true, can_delegate: true },
    { id: 'without-mcp', enabled: true, ready: true, can_delegate: true },
  ];
  const models = async ({ harness }) => ({ favorites_configured: true, items: [{ id: `${harness}-cheap`, roles: ['implement'] }] });
  const probe = ({ harness }) => (harness === 'with-mcp'
    ? { ok: true }
    : { ok: false, reason: MCP_CAPABILITY_DENIED.TOOLS });

  const picked = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: {} },
    deps: { listHarnessCatalog: async () => catalog, listHarnessModels: models, mcpCapabilityProbe: probe },
  });
  assert.equal(picked.ok, true, picked.reason);
  assert.equal(picked.harness, 'with-mcp', 'a harness without MCP tools is never picked automatically');

  const explicit = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { orchestrator: { harness: 'without-mcp', model: 'without-mcp-cheap' } } },
    deps: { listHarnessCatalog: async () => catalog, listHarnessModels: models, mcpCapabilityProbe: probe },
  });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.reason, MCP_CAPABILITY_DENIED.TOOLS, 'explicit policy is refused with the MCP reason');
  assert.equal(explicit.source, 'policy');

  const none = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { allowedHarnesses: ['without-mcp'] } },
    deps: { listHarnessCatalog: async () => catalog, listHarnessModels: models, mcpCapabilityProbe: probe },
  });
  assert.equal(none.ok, false);
  assert.equal(none.reason, MCP_CAPABILITY_DENIED.TOOLS);
  assert.deepEqual(none.mcpDeniedHarnesses, [{ harness: 'without-mcp', reason: MCP_CAPABILITY_DENIED.TOOLS }]);

  // Scout shares the resolver but neither delegates nor reports, so it does not
  // need the orchestrator contract and must keep its previous selection.
  const scout = await resolveWorkspaceWatcherOrchestrator({
    watcher: { policy: { allowedHarnesses: ['without-mcp'] } },
    purpose: 'scout',
    deps: {
      listHarnessCatalog: async () => catalog,
      listHarnessModels: models,
      mcpCapabilityProbe: () => ({ ok: false, reason: MCP_CAPABILITY_DENIED.TOOLS }),
      selectModelPick: () => ({ ok: true, pick: { harness: 'without-mcp', model: 'without-mcp-cheap' } }),
    },
  });
  assert.equal(scout.ok, true, 'a scout run is not held to the orchestrator MCP contract');
  assert.equal(scout.harness, 'without-mcp');
});

runCase('capability probe distinguishes no adapter, no bridge and missing tools', () => {
  const fullCatalog = listBuiltinCretliCatalogToolNames();
  const builtin = [{ id: 'builtin-cretli', kind: 'builtin-cretli' }];
  assert.equal(
    createMcpCapabilityProbe()({ harness: 'definitely-not-a-harness' }).reason,
    MCP_CAPABILITY_DENIED.ADAPTER,
  );
  assert.equal(
    createMcpCapabilityProbe({ listServers: () => [], catalogToolNames: () => fullCatalog })({ harness: 'codebuddy' }).reason,
    MCP_CAPABILITY_DENIED.CONFIG,
    'no builtin Cretli server is a configuration/scope failure',
  );
  const missing = createMcpCapabilityProbe({
    listServers: () => builtin,
    catalogToolNames: () => ['todo_show'],
  })({ harness: 'codebuddy' });
  assert.equal(missing.reason, MCP_CAPABILITY_DENIED.TOOLS);
  assert.ok(missing.missing.includes('watcher_update'));
  assert.equal(createMcpCapabilityProbe({
    listServers: () => builtin,
    catalogToolNames: () => fullCatalog,
  })({ harness: 'codebuddy' }).ok, true);
});

runCase('orchestrator contract resolves encoded and legacy tool names, rejects foreign ones', () => {
  const encoded = ORCHESTRATOR_MCP_CONTRACT_TOOLS.map((name) => `mcp__cretli_builtincretl__${name}`);
  assert.equal(hasWorkspaceWatcherOrchestratorMcpTools(encoded), true);
  assert.equal(hasWorkspaceWatcherOrchestratorMcpTools([...ORCHESTRATOR_MCP_CONTRACT_TOOLS, 'mcp__cretli_builtincretl__workspace_watcher_show']), true, 'legacy names map to canonical ones');
  assert.equal(hasWorkspaceWatcherOrchestratorMcpTools([]), false);
  assert.ok(missingWorkspaceWatcherOrchestratorMcpTools(['todo_show']).includes('watcher_update'));
  assert.equal(hasWorkspaceWatcherOrchestratorMcpTools(['mcp__github__todo_show', 'mcp__github__watcher_update']), false, 'a foreign server never satisfies the contract');
});

/**
 * @returns {{ session: object, sent: object[], handled: object[] }}
 */
function createMcpGateFixture() {
  /** @type {object[]} */
  const sent = [];
  /** @type {object[]} */
  const handled = [];
  const session = {
    initialized: false,
    transport: {
      options: {},
      sendControlRequest: async (payload) => {
        sent.push(payload);
        return {};
      },
      sendControlResponse: (requestId, payload) => {
        sent.push({ requestId, payload });
      },
    },
    initialize: async () => {
      throw new Error('the stock initialize must be replaced');
    },
    handleControlRequest: async (request) => {
      handled.push(request);
    },
  };
  return { session, sent, handled };
}

/**
 * @param {ReturnType<typeof createMcpGateFixture>} fixture
 * @returns {Promise<object>}
 */
async function firstHookRequest(fixture) {
  await fixture.session.initialize();
  const callbackId = fixture.sent[0].hooks.UserPromptSubmit[0].hookCallbackIds[0];
  return { request_id: 'hook-1', request: { subtype: 'hook_callback', callback_id: callbackId } };
}

runCase('MCP readiness gate blocks an orchestrator without the full tool catalog', async () => {
  // Bridge marks are per chat and a stale mark must not release a fresh run.
  clearMcpBridgeToolsListed('gate-stale');
  markMcpBridgeToolsListed('gate-stale', { now: 100, toolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS });
  assert.equal(await waitForMcpBridgeToolsListed('', { since: 0, timeoutMs: 0 }), null);
  assert.equal((await waitForMcpBridgeToolsListed('gate-stale', { since: 0, timeoutMs: 0 }))?.at, 100);
  assert.equal(await waitForMcpBridgeToolsListed('gate-stale', { since: 101, timeoutMs: 5 }), null, 'an older mark does not count');

  // No wait function -> no hook installed.
  assert.equal(
    installCodeBuddyMcpReadyGate(createMcpGateFixture().session, undefined, { contractTools: ORCHESTRATOR_MCP_CONTRACT_TOOLS }),
    false,
  );
  // No response channel -> an orchestrator session is unusable.
  assert.equal(
    installCodeBuddyMcpReadyGate({ transport: { sendControlRequest: async () => ({}) } }, async () => null, { contractTools: ORCHESTRATOR_MCP_CONTRACT_TOOLS }),
    false,
  );

  // A full contract catalog releases the first prompt.
  const valid = createMcpGateFixture();
  clearMcpBridgeToolsListed('gate-valid');
  markMcpBridgeToolsListed('gate-valid', { now: Date.now(), toolNames: ORCHESTRATOR_MCP_CONTRACT_TOOLS });
  let blocked = null;
  assert.equal(installCodeBuddyMcpReadyGate(
    valid.session,
    () => waitForMcpBridgeToolsListed('gate-valid', { since: 0 }),
    { contractTools: ORCHESTRATOR_MCP_CONTRACT_TOOLS, onBlock: (info) => { blocked = info; } },
  ), true);
  const validHook = await firstHookRequest(valid);
  await valid.session.handleControlRequest(validHook);
  assert.equal(valid.handled.length, 1, 'a ready bridge with every contract tool lets the prompt through');
  assert.equal(blocked, null);

  // A short catalog blocks the prompt outright.
  const short = createMcpGateFixture();
  clearMcpBridgeToolsListed('gate-short');
  markMcpBridgeToolsListed('gate-short', { now: Date.now(), toolNames: ['todo_show'] });
  blocked = null;
  installCodeBuddyMcpReadyGate(
    short.session,
    () => waitForMcpBridgeToolsListed('gate-short', { since: 0 }),
    { contractTools: ORCHESTRATOR_MCP_CONTRACT_TOOLS, onBlock: (info) => { blocked = info; } },
  );
  const shortHook = await firstHookRequest(short);
  await short.session.handleControlRequest(shortHook);
  assert.equal(short.handled.length, 0, 'a short catalog never releases the prompt');
  assert.equal(blocked.code, 'mcp_tools_missing');
  assert.ok(blocked.missing.includes('watcher_update'));

  // A wait that rejects is a not-ready block, never a silent pass.
  const thrown = createMcpGateFixture();
  blocked = null;
  installCodeBuddyMcpReadyGate(
    thrown.session,
    async () => { throw new Error('bridge down'); },
    { contractTools: ORCHESTRATOR_MCP_CONTRACT_TOOLS, onBlock: (info) => { blocked = info; } },
  );
  const thrownHook = await firstHookRequest(thrown);
  await thrown.session.handleControlRequest(thrownHook);
  assert.equal(thrown.handled.length, 0);
  assert.equal(blocked.code, 'mcp_not_ready');

  // A timeout (no catalog at all) is a readiness block, never a missing-tools one.
  const timedOut = createMcpGateFixture();
  clearMcpBridgeToolsListed('gate-timeout');
  blocked = null;
  installCodeBuddyMcpReadyGate(
    timedOut.session,
    () => waitForMcpBridgeToolsListed('gate-timeout', { since: 0, timeoutMs: 0 }),
    { contractTools: ORCHESTRATOR_MCP_CONTRACT_TOOLS, onBlock: (info) => { blocked = info; } },
  );
  const timeoutHook = await firstHookRequest(timedOut);
  await timedOut.session.handleControlRequest(timeoutHook);
  assert.equal(timedOut.handled.length, 0);
  assert.equal(blocked.code, 'mcp_not_ready');

  // An ordinary chat keeps the previous behaviour: wait, then never block.
  const ordinary = createMcpGateFixture();
  installCodeBuddyMcpReadyGate(ordinary.session, async () => null, {});
  const ordinaryHook = await firstHookRequest(ordinary);
  await ordinary.session.handleControlRequest(ordinaryHook);
  assert.equal(ordinary.handled.length, 1, 'an ordinary chat is never refused');
});

runCase('missing report closes as failure even when the todo is done', () => {
  const dataDir = freshDataDir('close-missing-done');
  const cwd = makeWorkspace('close-missing-done');
  const todo = addReadyTodo(dataDir, cwd, 'done without report');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-mr', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-mr', chatId: 'orch-mr', todoId: todo.id });
  updateTodo(dataDir, cwd, todo.id, { status: 'done', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });

  const closed = reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(closed.closed, true, closed.reason);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycleChats[0].outcome, 'failure');
  assert.equal(row.failures[todo.id], 1, 'a missing report counts a failure even on a done todo');
  assert.ok(row.backoffUntil, 'a missing report arms the backoff');
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
});

runCase('missing report on an unfinished or absent todo is failure/missing_report', () => {
  const dataDir = freshDataDir('close-missing-doing');
  const cwd = makeWorkspace('close-missing-doing');
  const todo = addReadyTodo(dataDir, cwd, 'still doing');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-doing', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-doing', chatId: 'orch-doing', todoId: todo.id });
  const closed = reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(closed.closed, true, closed.reason);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todo.id], 1);
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'ready', 'the failed cycle releases the doing claim');

  // A cycle whose primary todo vanished still closes as failure/missing_report.
  const ghostDir = freshDataDir('close-missing-ghost');
  const ghostCwd = makeWorkspace('close-missing-ghost');
  setAutopilot(ghostCwd, ghostDir);
  seedActiveCycle(ghostCwd, ghostDir, { cycleId: 'c-ghost', chatId: 'orch-ghost', todoId: 'ghost-todo' });
  const ghost = reconcileWorkspaceWatcherCycle({
    workspaceFolder: ghostCwd,
    dataDir: ghostDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(ghost.closed, true, ghost.reason);
  assert.equal(getWorkspaceWatcher(ghostCwd, { dataDir: ghostDir }).decisions.at(-1).reason, 'missing_report');
});

runCase('missing report waits for active children and prefers a concrete MCP error', () => {
  const dataDir = freshDataDir('close-children');
  const cwd = makeWorkspace('close-children');
  const todo = addReadyTodo(dataDir, cwd, 'live child');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-child', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-child', chatId: 'orch-child', todoId: todo.id });
  const held = reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [{ id: 'child-1', parentChatId: 'orch-child', status: 'running' }],
      notify: () => false,
    },
  });
  assert.equal(held.closed, false);
  assert.equal(held.reason, 'cycle_children_active');
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, 'a live child keeps the cycle open');

  // The MCP gate failure of the finished run outranks the generic missing_report.
  const mcpDir = freshDataDir('close-mcp-error');
  const mcpCwd = makeWorkspace('close-mcp-error');
  const mcpTodo = addReadyTodo(mcpDir, mcpCwd, 'mcp blocked');
  updateTodo(mcpDir, mcpCwd, mcpTodo.id, { status: 'doing', claimedByChatId: 'orch-mcp', expectedUpdatedAt: getTodoById(mcpDir, mcpCwd, mcpTodo.id).updatedAt });
  setAutopilot(mcpCwd, mcpDir);
  seedActiveCycle(mcpCwd, mcpDir, { cycleId: 'c-mcp', chatId: 'orch-mcp', todoId: mcpTodo.id });
  const mcpClosed = reconcileWorkspaceWatcherCycle({
    workspaceFolder: mcpCwd,
    dataDir: mcpDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle', errorCode: 'mcp_not_ready' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(mcpClosed.closed, true, mcpClosed.reason);
  const mcpRow = getWorkspaceWatcher(mcpCwd, { dataDir: mcpDir });
  assert.equal(mcpRow.decisions.at(-1).reason, 'mcp_not_ready');
  assert.equal(mcpRow.failures[mcpTodo.id], 1);
});

runCase('plan-only without report is failure/missing_report and keeps only a pending draft', () => {
  const dataDir = freshDataDir('close-plan-draft');
  const cwd = makeWorkspace('close-plan-draft');
  const todo = addReadyTodo(dataDir, cwd, 'plan draft');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-plan', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-plan', chatId: 'orch-plan', todoId: todo.id, planOnly: true });
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({ planRequests: { ...(row.planRequests || {}), [todo.id]: new Date(T0).toISOString() } }), { dataDir });
  const before = getTodoById(dataDir, cwd, todo.id);
  saveWorkspaceWatcherTodoPlanDraft({
    dataDir,
    workspaceFolder: cwd,
    todoId: todo.id,
    expectedUpdatedAt: before.updatedAt,
    planMarkdown: '# Pending draft',
    sourceChatId: 'orch-plan',
  });

  const closed = reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(closed.closed, true, closed.reason);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todo.id], 1, 'a plan-only cycle without a report counts a failure');
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
  assert.equal(row.planRequests[todo.id], new Date(T0).toISOString(), 'a pending draft keeps its plan request');
  assert.equal(getTodoById(dataDir, cwd, todo.id).plan.markdown, '# Pending draft');

  // No draft: the failed plan cycle clears its pending request like before.
  const emptyDir = freshDataDir('close-plan-empty');
  const emptyCwd = makeWorkspace('close-plan-empty');
  const emptyTodo = addReadyTodo(emptyDir, emptyCwd, 'plan empty');
  updateTodo(emptyDir, emptyCwd, emptyTodo.id, { status: 'doing', claimedByChatId: 'orch-plan-empty', expectedUpdatedAt: getTodoById(emptyDir, emptyCwd, emptyTodo.id).updatedAt });
  setAutopilot(emptyCwd, emptyDir);
  seedActiveCycle(emptyCwd, emptyDir, { cycleId: 'c-plan-empty', chatId: 'orch-plan-empty', todoId: emptyTodo.id, planOnly: true });
  mutateWorkspaceWatcherRow(emptyCwd, ({ row }) => ({ planRequests: { ...(row.planRequests || {}), [emptyTodo.id]: new Date(T0).toISOString() } }), { dataDir: emptyDir });
  const emptyClosed = reconcileWorkspaceWatcherCycle({
    workspaceFolder: emptyCwd,
    dataDir: emptyDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(emptyClosed.closed, true, emptyClosed.reason);
  assert.equal(getWorkspaceWatcher(emptyCwd, { dataDir: emptyDir }).planRequests[emptyTodo.id], undefined);
  assert.equal(getWorkspaceWatcher(emptyCwd, { dataDir: emptyDir }).failures[emptyTodo.id], 1);
});

runCase('plan-only failure keeps planRequests when draft lives on planTargetId root', () => {
  const dataDir = freshDataDir('close-plan-root');
  const cwd = makeWorkspace('close-plan-root');
  const root = addTodo(dataDir, cwd, { title: 'root plan', status: 'ready' }).item;
  const leaf = addTodo(dataDir, cwd, { title: 'leaf work', status: 'ready', parentId: root.id }).item;
  updateTodo(dataDir, cwd, leaf.id, { status: 'doing', claimedByChatId: 'orch-root', expectedUpdatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, {
    cycleId: 'c-plan-root',
    chatId: 'orch-root',
    todoId: leaf.id,
    planOnly: true,
    planTargetId: root.id,
  });
  mutateWorkspaceWatcherRow(cwd, ({ row }) => ({
    planRequests: { ...(row.planRequests || {}), [root.id]: new Date(T0).toISOString() },
  }), { dataDir });
  saveWorkspaceWatcherTodoPlanDraft({
    dataDir,
    workspaceFolder: cwd,
    todoId: root.id,
    expectedUpdatedAt: getTodoById(dataDir, cwd, root.id).updatedAt,
    planMarkdown: '# Root draft',
    sourceChatId: 'orch-root',
  });
  const closed = reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(closed.closed, true, closed.reason);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.decisions.at(-1).reason, 'missing_report');
  assert.equal(row.planRequests[root.id], new Date(T0).toISOString(), 'draft on root keeps planRequests under planTargetId');
  assert.equal(row.planRequests[leaf.id], undefined);
  assert.equal(getTodoById(dataDir, cwd, root.id).plan.markdown, '# Root draft');
});

runCase('boot reconcile prefers mcp_not_ready over a generic missing_report probe', () => {
  const dataDir = freshDataDir('boot-mcp-not-ready');
  const cwd = makeWorkspace('boot-mcp-not-ready');
  const todo = addReadyTodo(dataDir, cwd, 'boot mcp');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-boot-mcp', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-boot-mcp', chatId: 'orch-boot-mcp', todoId: todo.id });
  const boot = reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0 + 1000,
    probeChatRunLiveness: () => ({
      known: true,
      busy: false,
      reason: 'idle',
      errorCode: 'mcp_tools_missing',
    }),
    loadDelegations: () => [],
  });
  assert.equal(boot.reconciled, 1);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.decisions.at(-1).reason, 'mcp_tools_missing');
  assert.notEqual(row.decisions.at(-1).reason, 'missing_report');
});

runCase('boot reconcile ignores foreign errorCode for missing_report close reason', () => {
  const dataDir = freshDataDir('boot-foreign-error');
  const cwd = makeWorkspace('boot-foreign-error');
  const todo = addReadyTodo(dataDir, cwd, 'foreign err');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-foreign', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-foreign', chatId: 'orch-foreign', todoId: todo.id });
  const boot = reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0 + 1000,
    probeChatRunLiveness: () => ({
      known: true,
      busy: false,
      reason: 'idle',
      errorCode: 'codex_error',
    }),
    loadDelegations: () => [],
  });
  assert.equal(boot.reconciled, 1);
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).decisions.at(-1).reason, 'missing_report');
});

runCase('start cycle goes through the real chat-run service and the mock adapter', async () => {
  resetMockChatRuns();
  registerMockChatRunAdapter('mock');
  registerMockChatRunAdapter('sdk');
  const dataDir = freshDataDir('orch-transport');
  const cwd = makeWorkspace('orch-transport');
  const todo = addReadyTodo(dataDir, cwd, 'transport work');
  setAutopilot(cwd, dataDir);
  const watcher = getWorkspaceWatcher(cwd, { dataDir });
  const tick = {
    watcher,
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
  };
  const started = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    tick,
    token: 'transport',
    deps: {
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'test' }),
      addChat: (session, title, wf, folder, model, extras) => addChat(session, title, wf, folder, model, {
        ...(extras || {}),
        localHarnessTransport: true,
      }),
    },
  });
  assert.equal(started.started, true, started.reason);
  const chatId = started.cycle.chatId;
  const run = getMockChatRun(chatId);
  assert.ok(run, 'the mock adapter owns the run');
  assert.equal(run.requestId, started.cycle.cycleId);
  assert.match(run.prompt, /action "report"/);
  assert.match(run.prompt, /delegation_start/);
  const persisted = loadChats().find((chat) => chat.id === chatId);
  assert.ok(persisted, 'the orchestrator chat is persisted');
  assert.equal(persisted.todoId, todo.id);
  const claimed = getTodoById(dataDir, cwd, todo.id);
  assert.equal(claimed.status, 'doing');
  assert.equal(claimed.claimedByChatId, chatId);
  assert.equal(claimed.orchestratorChatId, chatId, 'the claimed todo points at its orchestrator');
  assert.equal(getWorkspaceWatcher(cwd, { dataDir }).activeCycle.phase, 'running');
});

runCase('a rejected start rolls the cycle back and releases the claim', async () => {
  resetMockChatRuns();
  registerMockChatRunAdapter('mock');
  const dataDir = freshDataDir('orch-start-fail');
  const cwd = makeWorkspace('orch-start-fail');
  const todo = addReadyTodo(dataDir, cwd, 'reject me');
  setAutopilot(cwd, dataDir);
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [getTodoById(dataDir, cwd, todo.id)] },
  };
  const started = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    tick,
    token: 'start-fail',
    deps: {
      resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap' }),
      addChat: (session, title, wf, folder, model, extras) => addChat(session, title, wf, folder, model, {
        ...(extras || {}),
        localHarnessTransport: true,
      }),
      // A known pre-accept rejection code is a clean rollback, never uncertain.
      startChatRun: async () => {
        const error = new Error('executor unavailable');
        error.code = 'adapter_unavailable';
        throw error;
      },
    },
  });
  assert.equal(started.started, false);
  assert.equal(started.reason, 'start_failed');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null, 'a clean rollback clears the cycle');
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'ready', 'the claim is released');
});

runCase('report: success closes the cycle, records history and is idempotent', () => {
  const dataDir = freshDataDir('report-success');
  const cwd = makeWorkspace('report-success');
  const todo = addReadyTodo(dataDir, cwd, 'report me');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-success', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-success', chatId: 'orch-success', todoId: todo.id });
  updateTodo(dataDir, cwd, todo.id, { status: 'done', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });

  const first = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-success',
    outcome: 'success',
    todoIds: [todo.id],
    cycleId: 'c-success',
    reportId: 'c-success',
    message: 'done',
  });
  assert.equal(first.ok, true, first.reason);
  assert.equal(first.closed, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.cycleCount, 1);
  assert.equal(row.reports.length, 1);
  assert.equal(row.reports[0].outcome, 'success');
  assert.equal(row.reports[0].deferred, false);
  assert.equal(row.cycleChats.length, 1);
  assert.equal(row.cycleChats[0].id, 'orch-success');
  assert.equal(row.failures[todo.id], undefined, 'success does not count a failure');

  const replay = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    sourceChatId: 'orch-success',
    outcome: 'failure',
    todoIds: [todo.id],
    cycleId: 'c-success',
    reportId: 'c-success',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  const after = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(after.cycleCount, 1, 'a replay never bumps cycleCount');
  assert.equal(after.failures[todo.id], undefined, 'a replay never changes failures');
});

runCase('report: failure counts a failure and a foreign chat cannot report', () => {
  const dataDir = freshDataDir('report-failure');
  const cwd = makeWorkspace('report-failure');
  const todo = addReadyTodo(dataDir, cwd, 'fail me');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-fail', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-fail', chatId: 'orch-fail', todoId: todo.id });

  const foreign = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'someone-else',
    outcome: 'failure',
    todoIds: [todo.id],
    cycleId: 'c-fail',
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'not_orchestrator');
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle, 'a foreign report cannot close the cycle');

  const mismatch = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-fail',
    outcome: 'failure',
    todoIds: [todo.id],
    cycleId: 'other-cycle',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'cycle_mismatch');

  const bad = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-fail',
    outcome: 'nonsense',
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_outcome');

  const closed = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-fail',
    outcome: 'failure',
    todoIds: [todo.id],
    cycleId: 'c-fail',
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.cycleCount, 1);
  assert.equal(row.failures[todo.id], 1);
  assert.ok(row.backoffUntil, 'a failure arms the backoff');
  assert.equal(getTodoById(dataDir, cwd, todo.id).status, 'ready', 'the failed cycle releases the doing claim');
});

runCase('report closes only the reporting slot and leaves a live sibling with its lease', () => {
  const dataDir = freshDataDir('report-multi-slot');
  const cwd = makeWorkspace('report-multi-slot');
  const todoA = addReadyTodo(dataDir, cwd, 'slot a');
  const todoB = addReadyTodo(dataDir, cwd, 'slot b');
  for (const [todo, chatId] of [[todoA, 'orch-a'], [todoB, 'orch-b']]) {
    updateTodo(dataDir, cwd, todo.id, {
      status: 'doing',
      claimedByChatId: chatId,
      expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
    });
  }
  setAutopilot(cwd, dataDir);
  const lease = { ownerPid: 7, token: 'multi-slot-lease', expiresAt: new Date(T0 + 60_000).toISOString() };
  upsertWorkspaceWatcher(cwd, {
    activeCycles: [
      { cycleId: 'c-a', chatId: 'orch-a', todoIds: [todoA.id], startedAt: new Date(T0).toISOString(), runId: 'run-a', phase: 'running' },
      { cycleId: 'c-b', chatId: 'orch-b', todoIds: [todoB.id], startedAt: new Date(T0 + 1).toISOString(), runId: 'run-b', phase: 'running' },
    ],
    lease,
  }, { dataDir });

  // A slot owner cannot report/close the sibling slot it does not own.
  const mismatch = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 10,
    sourceChatId: 'orch-a',
    outcome: 'success',
    cycleId: 'c-b',
    deps: { loadDelegations: () => [] },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'cycle_mismatch');

  const closed = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    sourceChatId: 'orch-a',
    outcome: 'success',
    cycleId: 'c-a',
    todoIds: [todoA.id],
    deps: { loadDelegations: () => [] },
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycles.length, 1, 'only the reporting slot is closed');
  assert.equal(row.activeCycles[0].cycleId, 'c-b');
  assert.equal(row.activeCycle.cycleId, 'c-b', 'the v1 mirror follows the surviving slot');
  assert.equal(row.lease.token, 'multi-slot-lease', 'the shared lease survives a sibling close');
  assert.equal(getTodoById(dataDir, cwd, todoB.id).status, 'doing', 'the live sibling keeps its claim');
  assert.equal(getTodoById(dataDir, cwd, todoB.id).claimedByChatId, 'orch-b');
  assert.equal(row.cycleCount, 1);
});

runCase('deferred report keeps a live child claim, reconcile closes with the reported outcome', () => {
  const dataDir = freshDataDir('report-deferred');
  const cwd = makeWorkspace('report-deferred');
  const todo = addReadyTodo(dataDir, cwd, 'deferred child');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-defer', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-defer', chatId: 'orch-defer', todoId: todo.id });

  const liveChild = () => [{ id: 'child-1', parentChatId: 'orch-defer', status: 'running' }];
  const deferred = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-defer',
    outcome: 'success',
    todoIds: [todo.id],
    cycleId: 'c-defer',
    deps: { loadDelegations: liveChild },
  });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.deferred, true);
  const held = getWorkspaceWatcher(cwd, { dataDir });
  assert.ok(held.activeCycle, 'a live child keeps the cycle open');
  assert.equal(held.activeCycle.reportedOutcome, 'success');
  assert.equal(getTodoById(dataDir, cwd, todo.id).claimedByChatId, 'orch-defer', 'the live child keeps its claim');
  assert.equal(held.failures[todo.id], undefined);
  updateTodo(dataDir, cwd, todo.id, { status: 'done', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });

  const closed = reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [{ id: 'child-1', parentChatId: 'orch-defer', status: 'completed' }],
      notify: () => false,
    },
  });
  assert.equal(closed.closed, true, closed.reason);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.failures[todo.id], undefined, 'a reported success is not re-counted as a failure');
  assert.equal(row.reports[0].deferred, false, 'reconcile resolves the deferred report');
  assert.equal(row.cycleChats.length, 1);
});

runCase('boot reconcile closes deferred success after child terminal (not failure)', () => {
  const dataDir = freshDataDir('boot-deferred-success');
  const cwd = makeWorkspace('boot-deferred-success');
  const todo = addReadyTodo(dataDir, cwd, 'boot deferred');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-boot', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-boot', chatId: 'orch-boot', todoId: todo.id });
  updateTodo(dataDir, cwd, todo.id, { status: 'done', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-boot',
    outcome: 'success',
    todoIds: [todo.id],
    cycleId: 'c-boot',
    deps: { loadDelegations: () => [{ id: 'child-live', parentChatId: 'orch-boot', status: 'running' }] },
  });
  const probe = () => ({ known: true, busy: false, reason: 'idle' });
  const boot1 = reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0 + 500,
    probeChatRunLiveness: probe,
    loadDelegations: () => [{ id: 'child-live', parentChatId: 'orch-boot', status: 'running' }],
  });
  assert.equal(boot1.reconciled, 0, 'live child keeps the cycle during boot');
  assert.ok(getWorkspaceWatcher(cwd, { dataDir }).activeCycle);
  const boot2 = reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0 + 1000,
    probeChatRunLiveness: probe,
    loadDelegations: () => [],
  });
  assert.equal(boot2.reconciled, 1);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.failures[todo.id], undefined);
  assert.equal(row.cycleCount, 1);
  assert.equal(row.reports[0].deferred, false);
  const boot3 = reconcileWorkspaceWatchersOnBoot({ dataDir, now: T0 + 2000, probeChatRunLiveness: probe });
  assert.equal(boot3.reconciled, 0, 'second boot is idempotent');
});

runCase('boot reconcile counts exactly one failure for deferred failure report', () => {
  const dataDir = freshDataDir('boot-deferred-fail');
  const cwd = makeWorkspace('boot-deferred-fail');
  const todo = addReadyTodo(dataDir, cwd, 'boot fail');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-boot-fail', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-boot-fail', chatId: 'orch-boot-fail', todoId: todo.id });
  reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-boot-fail',
    outcome: 'failure',
    todoIds: [todo.id],
    cycleId: 'c-boot-fail',
    deps: { loadDelegations: () => [{ id: 'child-f', parentChatId: 'orch-boot-fail', status: 'running' }] },
  });
  const boot = reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0 + 1000,
    probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
    loadDelegations: () => [],
  });
  assert.equal(boot.reconciled, 1);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todo.id], 1);
  assert.equal(row.decisions.at(-1).kind, 'cycle_failed');
});

runCase('reported success on incomplete todo closes as failure', () => {
  const dataDir = freshDataDir('success-incomplete');
  const cwd = makeWorkspace('success-incomplete');
  const todo = addReadyTodo(dataDir, cwd, 'still doing');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-inc', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-inc', chatId: 'orch-inc', todoId: todo.id });
  const reported = reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-inc',
    outcome: 'success',
    todoIds: [todo.id],
    cycleId: 'c-inc',
    deps: { loadDelegations: () => [] },
  });
  assert.equal(reported.closed, true);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todo.id], 1);
  assert.equal(row.cycleChats[0].outcome, 'failure');
});

runCase('deferred failure survives reconcile as a failure', () => {
  const dataDir = freshDataDir('report-deferred-fail');
  const cwd = makeWorkspace('report-deferred-fail');
  const todo = addReadyTodo(dataDir, cwd, 'deferred failure');
  updateTodo(dataDir, cwd, todo.id, { status: 'doing', claimedByChatId: 'orch-defer-fail', expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt });
  setAutopilot(cwd, dataDir);
  seedActiveCycle(cwd, dataDir, { cycleId: 'c-defer-fail', chatId: 'orch-defer-fail', todoId: todo.id });
  reportWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    sourceChatId: 'orch-defer-fail',
    outcome: 'failure',
    todoIds: [todo.id],
    cycleId: 'c-defer-fail',
    deps: { loadDelegations: () => [{ id: 'child-1', parentChatId: 'orch-defer-fail', status: 'running' }] },
  });
  const closed = reconcileWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0 + 1000,
    deps: {
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      loadDelegations: () => [],
      notify: () => false,
    },
  });
  assert.equal(closed.closed, true, closed.reason);
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.failures[todo.id], 1);
});

runCase('orchestrator chat is stamped on the claimed todo and its ancestors', () => {
  const dataDir = freshDataDir('orch-stamp');
  const cwd = makeWorkspace('orch-stamp');
  const parent = addTodo(dataDir, cwd, { title: 'parent', status: 'ready' }).item;
  const child = addTodo(dataDir, cwd, { title: 'child', status: 'ready', parentId: parent.id }).item;
  stampCycleOrchestratorOnTodoTree({ workspaceFolder: cwd, dataDir, todoId: child.id, chatId: 'orch-stamp-chat' });
  assert.equal(getTodoById(dataDir, cwd, child.id).orchestratorChatId, 'orch-stamp-chat');
  assert.equal(getTodoById(dataDir, cwd, parent.id).orchestratorChatId, 'orch-stamp-chat', 'ancestors are stamped too');
});

runCase('reports and cycle chats normalize defensively', () => {
  assert.deepEqual(WORKSPACE_WATCHER_CYCLE_OUTCOMES, ['success', 'blocked', 'failure']);
  const dataDir = freshDataDir('normalize');
  const cwd = makeWorkspace('normalize');
  upsertWorkspaceWatcher(cwd, {
    mode: 'observe',
    reports: [{ reportId: 'r1', outcome: 'bogus' }, { outcome: '' }, { reportId: 'r2', outcome: 'success', todoIds: ['a', 'a'] }],
    cycleChats: [{ id: 'chat-1', outcome: 'weird' }, { cycleId: 'no-id' }],
  }, { dataDir });
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.reports.length, 2);
  assert.equal(row.reports[0].outcome, 'failure');
  assert.equal(row.reports[1].outcome, 'success');
  assert.deepEqual(row.reports[1].todoIds, ['a']);
  assert.equal(row.cycleChats.length, 1);
  assert.equal(row.cycleChats[0].id, 'chat-1');
  assert.equal(row.cycleChats[0].outcome, '');
});

runCase('collectWorkspaceWatcherPromptTodoIds walks ancestors, plan target and survives broken links', () => {
  const items = [
    { id: 'leaf', parentId: 'mid' },
    { id: 'mid', parentId: 'root' },
    { id: 'root' },
    { id: 'plan', parentId: 'planparent' },
    { id: 'planparent' },
    { id: 'cycle-a', parentId: 'cycle-b' },
    { id: 'cycle-b', parentId: 'cycle-a' },
  ];
  assert.deepEqual(
    collectWorkspaceWatcherPromptTodoIds({ todoId: 'leaf', planTargetId: 'plan', items }),
    ['leaf', 'mid', 'root', 'plan', 'planparent'],
  );
  assert.deepEqual(
    collectWorkspaceWatcherPromptTodoIds({ todoId: 'ghost', planTargetId: '', items }),
    ['ghost'],
    'a missing record ends the walk instead of throwing',
  );
  assert.deepEqual(
    collectWorkspaceWatcherPromptTodoIds({ todoId: 'cycle-a', items }),
    ['cycle-a', 'cycle-b'],
    'a parent cycle does not loop',
  );
  assert.deepEqual(collectWorkspaceWatcherPromptTodoIds({ todoId: '', items }), []);
});

runCase('startWorkspaceWatcherCycle: prompt_too_long refuses before the adapter and rolls back cleanly', async () => {
  const dataDir = freshDataDir('cycle-prompt-too-long');
  const cwd = makeWorkspace('cycle-prompt-too-long');
  const todo = addReadyTodo(dataDir, cwd, 'long contract');
  setAutopilot(cwd, dataDir, { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5 });
  let adapterCalls = 0;
  let chatCalls = 0;
  const deps = {
    promptCharBudget: 100,
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    startStartingLeaseRenewal: () => () => {},
    addChat: (_s, title, _wf, _folder, _m, extras) => { chatCalls += 1; return { id: extras.id, title }; },
    startChatRun: async () => { adapterCalls += 1; return { runId: 'never', accepted: true }; },
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
    notify: () => false,
  };
  const before = getWorkspaceWatcher(cwd, { dataDir });
  const tick = {
    watcher: before,
    decision: { kind: 'start_cycle', planOnly: false, nextTodoId: todo.id },
    snapshot: { readyLeaves: [{ id: todo.id, updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt, title: todo.title }] },
  };
  const result = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, token: 'too-long', deps });
  assert.equal(result.started, false);
  assert.equal(result.reason, 'prompt_too_long');
  assert.equal(result.error.code, 'prompt_too_long');
  assert.equal(adapterCalls, 0, 'the adapter is never called');
  assert.equal(chatCalls, 0, 'no orchestrator chat is created');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.activeCycles.length, 0, 'the cycle reservation is rolled back');
  assert.equal(row.activeCycle, null);
  assert.equal(row.failures[todo.id], undefined, 'no failure is counted');
  assert.ok(!row.backoffUntil, 'no backoff is armed');
  assert.equal(row.cycles.count, before.cycles.count, 'the daily budget is rolled back');
  assert.ok(!row.lease || !row.lease.token, 'the workspace lease is released');
  const reloaded = getTodoById(dataDir, cwd, todo.id);
  assert.equal(reloaded.status, 'ready');
  assert.ok(!reloaded.claimedByChatId, 'the todo claim is released');
  assert.ok(row.decisions.some((decision) => decision.kind === 'prompt_too_long'), 'the refusal reason is durable');
});

runCase('startWorkspaceWatcherCycle: prompt_too_long keeps the plan draft and drops only the reservation', async () => {
  const dataDir = freshDataDir('cycle-too-long-plan');
  const cwd = makeWorkspace('cycle-too-long-plan');
  const todo = addReadyTodo(dataDir, cwd, 'planned');
  updateTodo(dataDir, cwd, todo.id, {
    plan: { markdown: '# Existing draft' },
    expectedUpdatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
  });
  setAutopilot(cwd, dataDir, { requirePlanApproval: true, cooldownMs: 0, maxCyclesPerDay: 5 });
  const deps = {
    promptCharBudget: 100,
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    startStartingLeaseRenewal: () => () => {},
    addChat: () => { throw new Error('no chat may be created'); },
    startChatRun: async () => { throw new Error('no adapter may be called'); },
    probeChatRunLiveness: () => ({ known: false, busy: false, reason: 'chat_missing' }),
    notify: () => false,
  };
  const tick = {
    watcher: getWorkspaceWatcher(cwd, { dataDir }),
    decision: { kind: 'plan_gate', planOnly: true, nextTodoId: todo.id },
    snapshot: {
      readyLeaves: [{
        id: todo.id,
        updatedAt: getTodoById(dataDir, cwd, todo.id).updatedAt,
        title: todo.title,
        plan: { markdown: '# Existing draft' },
      }],
    },
  };
  const result = await startWorkspaceWatcherCycle({ workspaceFolder: cwd, dataDir, now: T0, tick, token: 'too-long-plan', deps });
  assert.equal(result.reason, 'prompt_too_long');
  const row = getWorkspaceWatcher(cwd, { dataDir });
  assert.equal(row.planRequests[todo.id], undefined, 'the plan reservation is rolled back, not left pending');
  assert.equal(
    getTodoById(dataDir, cwd, todo.id).plan.markdown,
    '# Existing draft',
    'the existing plan draft is preserved',
  );
});

for (const run of cases) {
  await run();
}
removeIsolatedDataDir();
if (failed > 0) {
  console.error(`\n${failed} workspace watcher orchestrator test case(s) failed`);
  process.exit(1);
}
console.log('\nworkspace watcher orchestrator tests passed');
