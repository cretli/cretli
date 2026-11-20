import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideWorkspaceWatcherAction,
  planWorkspaceWatcherOwnerHoldNotify,
  WORKSPACE_WATCHER_OWNER_HOLD_NOTIFY_MS,
} from '../lib/workspace-watcher.js';
import { normalizeWorkspaceWatcherDecision } from '../lib/persist/workspace-watchers-persist.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const policy = { maxParallel: 10, requirePlanApproval: false, executionMode: 'project' };
const root = { id: 'root', status: 'doing', runMode: 'sequential', orchestratorChatId: 'manual-orch', updatedAt: 'r0' };
const leafA = { id: 'leaf-a', status: 'ready', parentId: 'root', siblingIndex: 0, updatedAt: 'r1' };
const leafB = { id: 'leaf-b', status: 'ready', parentId: 'root', siblingIndex: 1, updatedAt: 'r2' };
const noOwners = { liveChatIds: [], delegationLeafIds: [], recentOrchestratorChatIds: [] };

function decide(externalOwners, readyLeaves = [leafA]) {
  return decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy },
    snapshot: {
      readyTodoCount: readyLeaves.length, readyLeaves, items: [root, ...readyLeaves],
      activeAgentCount: 1, errors: [], externalOwners,
    },
    now,
  });
}

test('the rejection carries the owner for every ownerReason', () => {
  const cases = [
    [{ ...noOwners, liveChatIds: ['manual-orch'] }, { ownerChatId: 'manual-orch', ownerTodoId: 'root', ownerReason: 'live_chat' }],
    [{ ...noOwners, delegationLeafIds: ['leaf-a'] }, { ownerChatId: '', ownerTodoId: 'leaf-a', ownerReason: 'live_delegation' }],
    [{ ...noOwners, recentOrchestratorChatIds: ['manual-orch'] }, { ownerChatId: 'manual-orch', ownerTodoId: 'root', ownerReason: 'recent_orchestrator' }],
  ];
  for (const [owners, expected] of cases) {
    const decision = decide(owners);
    assert.equal(decision.kind, 'idle_no_work');
    assert.equal(decision.reason, 'tree_owned_by_live_orchestrator');
    assert.deepEqual(decision.rejections, [{ id: 'leaf-a', filter: 'tree_owned_by_live_orchestrator', ...expected }]);
  }
});

test('the stored decision keeps the rejection owner and bounds the list', () => {
  const entry = normalizeWorkspaceWatcherDecision({
    at: '2026-01-01T12:00:00.000Z', kind: 'idle_no_work', reason: 'tree_owned_by_live_orchestrator',
    rejections: [
      { id: 'leaf-a', filter: 'tree_owned_by_live_orchestrator', ownerChatId: 'c1', ownerTodoId: 'root', ownerReason: 'live_chat', junk: 'x' },
      { filter: 'no-id' },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, filter: 'blocked_backoff' })),
    ],
  });
  assert.equal(entry.rejections.length, 19, 'capped at 20 raw entries, invalid ones dropped');
  assert.deepEqual(entry.rejections[0], {
    id: 'leaf-a', filter: 'tree_owned_by_live_orchestrator', ownerChatId: 'c1', ownerTodoId: 'root', ownerReason: 'live_chat',
  });
});

// --- notification ---

function holdTicker(items) {
  let ownerHolds = {};
  return (offsetMs, owners, mode = 'autopilot') => {
    const leaves = items.filter((row) => row.status === 'ready');
    const result = planWorkspaceWatcherOwnerHoldNotify(
      { mode, ownerHolds },
      { items: [root, ...items], readyLeaves: leaves, externalOwners: owners },
      'idle_no_work',
      now + offsetMs,
    );
    if (result.nextHolds) ownerHolds = result.nextHolds;
    return result.messages;
  };
}

const MIN = 60_000;
const held = { ...noOwners, liveChatIds: ['manual-orch'] };

test('hold notification: none before 10 minutes, one after, none on later ticks', () => {
  const tick = holdTicker([leafA]);
  assert.equal(WORKSPACE_WATCHER_OWNER_HOLD_NOTIFY_MS, 10 * MIN);
  assert.deepEqual(tick(0, held), []);
  assert.deepEqual(tick(9 * MIN, held), []);
  const sent = tick(10 * MIN, held);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'owner_hold');
  assert.match(sent[0].body, /leaf-a/);
  assert.deepEqual(tick(11 * MIN, held), []);
  assert.deepEqual(tick(60 * MIN, held), []);
});

test('hold notification: releasing resets the episode and a re-hold notifies again', () => {
  const tick = holdTicker([leafA]);
  tick(0, held);
  assert.equal(tick(10 * MIN, held).length, 1);
  assert.deepEqual(tick(12 * MIN, noOwners), [], 'released');
  assert.deepEqual(tick(13 * MIN, held), [], 're-hold starts a new episode');
  assert.deepEqual(tick(22 * MIN, held), []);
  assert.equal(tick(23 * MIN, held).length, 1);
});

test('hold notification: two todos of one owner notify separately with distinct tags', () => {
  const tick = holdTicker([leafA, leafB]);
  tick(0, held);
  const sent = tick(10 * MIN, held);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].tag, sent[1].tag);
});

test('hold notification: observe rows and snapshot errors do not track holds', () => {
  const tick = holdTicker([leafA]);
  tick(0, held, 'observe');
  assert.deepEqual(tick(10 * MIN, held, 'observe'), []);
  const keep = planWorkspaceWatcherOwnerHoldNotify(
    { mode: 'autopilot', ownerHolds: { 'leaf-a|manual-orch': { since: 'x', notified: true } } },
    { items: [], readyLeaves: [], externalOwners: noOwners },
    'snapshot_error',
    now,
  );
  assert.equal(keep.nextHolds, null);
});

// --- MCP ---

function mcpHandlers(overrides = {}) {
  const rows = overrides.rows || [];
  const client = {
    listTodos: async () => rows,
    updateTodo: async () => overrides.updated,
    createTodo: async () => ({ item: overrides.updated }),
    workspaceWatcherLastDecision: async () => overrides.last,
  };
  return createCretliMcpToolHandlers(client, {
    workspaceFolder: '/tmp/my-app', chatId: 'me', harness: 'sdk', mode: 'agent', builtinClient: client,
  });
}

const readyRow = (extra = {}) => ({
  id: '11111111-2222-4333-8444-555555555555', title: 'T', status: 'ready', updatedAt: 'u1', createdAt: 'c1',
  orchestratorChatId: 'me', ...extra,
});

test('todo_update warns when a ready leaf is owned by the calling chat, and never blocks', async () => {
  const mine = readyRow();
  const result = await mcpHandlers({ rows: [mine], updated: mine }).todo_update({
    todo_id: mine.id, expected_updated_at: 'u1', patch: { status: 'ready' },
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.warning.code, 'watcher_held_by_orchestrator');
  assert.match(result.structuredContent.warning.text, /empty string/);
  assert.equal(result.structuredContent.item.id, mine.id);
});

test('todo_update does not warn for a foreign, empty or non-ready orchestrator', async () => {
  for (const extra of [{ orchestratorChatId: 'someone-else' }, { orchestratorChatId: '' }, { status: 'doing' }]) {
    const row = readyRow(extra);
    const result = await mcpHandlers({ rows: [row], updated: row }).todo_update({
      todo_id: row.id, expected_updated_at: 'u1', patch: { title: 'x' },
    });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.warning, undefined);
  }
});

test('todo_create warns the same way', async () => {
  const mine = readyRow();
  const handlers = mcpHandlers({ rows: [mine], updated: mine });
  const result = await handlers.todo_create({ title: 'T', status: 'ready', orchestrator_chat_id: 'me', idempotency_key: 'k-1' });
  assert.equal(result.structuredContent.warning.code, 'watcher_held_by_orchestrator');
  const other = readyRow({ orchestratorChatId: '' });
  const plain = await mcpHandlers({ rows: [other], updated: other }).todo_create({ title: 'T', status: 'ready', idempotency_key: 'k-2' });
  assert.equal(plain.structuredContent.warning, undefined);
});

test('todo_show reports watcher_hold from the stored decision only', async () => {
  const row = readyRow({ orchestratorChatId: '' });
  const decision = {
    at: '2026-01-01T12:00:00.000Z', kind: 'idle_no_work', reason: 'tree_owned_by_live_orchestrator',
    rejections: [{ id: row.id, filter: 'tree_owned_by_live_orchestrator', ownerChatId: 'c1', ownerTodoId: 'root', ownerReason: 'live_chat' }],
  };
  const show = (last) => mcpHandlers({ rows: [row], last }).todo_show({ todo_id: row.id });
  const withHold = await show({ mode: 'autopilot', enabled: true, decision });
  assert.deepEqual(withHold.structuredContent.item.watcher_hold, {
    code: 'tree_owned_by_live_orchestrator', owner_chat_id: 'c1', owner_todo_id: 'root',
    owner_reason: 'live_chat', decided_at: decision.at,
  });
  const noRejection = await show({ mode: 'autopilot', enabled: true, decision: { ...decision, rejections: [] } });
  assert.equal(noRejection.structuredContent.item.watcher_hold, undefined);
  const noDecision = await show({ mode: 'autopilot', enabled: true, decision: null });
  assert.equal(noDecision.structuredContent.item.watcher_hold, undefined);
  const disabled = await show({ mode: 'off', enabled: true, decision });
  assert.equal(disabled.structuredContent.item.watcher_hold, undefined);
});
