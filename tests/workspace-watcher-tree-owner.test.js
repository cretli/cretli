import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideWorkspaceWatcherAction,
  pickNextWorkspaceReadyTodo,
  snapshotWorkspaceWatcher,
} from '../lib/workspace-watcher.js';
import {
  collectWorkspaceWatcherExternalOwners,
  findWorkspaceWatcherExternalTreeOwner,
  resolveWorkspaceWatcherReserveOwnerAbort,
  WORKSPACE_WATCHER_EXTERNAL_OWNER_GRACE_MS,
} from '../lib/workspace-watcher-tree-owner.js';
import { stampCycleOrchestratorOnTodoTree } from '../lib/workspace-watcher-cycle.js';
import { workspaceWatcherCycleChatIds } from '../lib/persist/workspace-watchers-persist.js';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-persist.js';
import { resolveRequestLeafContext } from '../lib/orchestrator-leaf-resolution.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const workspaceFolder = '/tmp/cretli-tree-owner-ws';
const policy = { maxParallel: 10, requirePlanApproval: false, executionMode: 'project' };

// The incident shape: a manually started root, a finished server leaf, and a
// client leaf that became ready because its sequential sibling closed.
const root = { id: 'root', status: 'doing', runMode: 'sequential', orchestratorChatId: 'manual-orch', updatedAt: 'r0' };
const serverLeaf = { id: 'server', status: 'done', parentId: 'root', siblingIndex: 0, chatId: 'leaf-chat', updatedAt: 'r1' };
const clientLeaf = { id: 'client', status: 'ready', parentId: 'root', siblingIndex: 1, updatedAt: 'r2' };
const otherLeaf = { id: 'other', status: 'ready', siblingIndex: 2, updatedAt: 'r3' };
const items = [root, serverLeaf, clientLeaf, otherLeaf];

const noOwners = { liveChatIds: [], delegationLeafIds: [], recentOrchestratorChatIds: [] };

function decide(externalOwners) {
  const readyLeaves = [clientLeaf, otherLeaf];
  return decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy },
    snapshot: { readyTodoCount: readyLeaves.length, readyLeaves, items, activeAgentCount: 1, errors: [], externalOwners },
    now,
  });
}

test('a leaf whose tree has a live non-watcher orchestrator is not picked', () => {
  const owners = { ...noOwners, liveChatIds: ['manual-orch'] };
  assert.deepEqual(findWorkspaceWatcherExternalTreeOwner(clientLeaf, items, owners), {
    chatId: 'manual-orch', todoId: 'root', reason: 'live_chat',
  });
  assert.equal(pickNextWorkspaceReadyTodo({ items, externalOwners: owners }).id, 'other');
  assert.equal(decide(owners).nextTodoId, 'other');
});

test('a busy chat on a sibling leaf (chatId stamp) owns the whole tree', () => {
  const owners = { ...noOwners, liveChatIds: ['leaf-chat'] };
  assert.equal(findWorkspaceWatcherExternalTreeOwner(clientLeaf, items, owners)?.todoId, 'server');
  assert.equal(findWorkspaceWatcherExternalTreeOwner(otherLeaf, items, owners), null, 'other trees stay free');
});

test('an active delegation on any node of the tree owns it', () => {
  const owners = { ...noOwners, delegationLeafIds: ['server'] };
  assert.equal(findWorkspaceWatcherExternalTreeOwner(clientLeaf, items, owners)?.reason, 'live_delegation');
});

test('an idle manual orchestrator stamped on an ancestor holds the tree within the grace window', () => {
  const owners = { ...noOwners, recentOrchestratorChatIds: ['manual-orch'] };
  assert.equal(findWorkspaceWatcherExternalTreeOwner(clientLeaf, items, owners)?.reason, 'recent_orchestrator');
});

test('without an owner the leaf is picked as before', () => {
  assert.equal(pickNextWorkspaceReadyTodo({ items, externalOwners: noOwners }).id, 'client');
  assert.equal(pickNextWorkspaceReadyTodo({ items }).id, 'client', 'callers without owners are unchanged');
});

test('the decision names the cause when every ready leaf is externally owned', () => {
  const owners = { ...noOwners, liveChatIds: ['manual-orch'] };
  const decision = decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy },
    snapshot: { readyTodoCount: 1, readyLeaves: [clientLeaf], items, activeAgentCount: 1, errors: [], externalOwners: owners },
    now,
  });
  assert.equal(decision.kind, 'idle_no_work');
  assert.equal(decision.reason, 'tree_owned_by_live_orchestrator');
});

test('owners exclude watcher cycle chats, watcher orchestrator rows, archived and stale chats', () => {
  const owners = collectWorkspaceWatcherExternalOwners({
    activeChatIds: ['manual-orch', 'cycle-chat'],
    activeDelegations: [
      { id: 'd1', parentChatId: 'manual-orch', childChatId: 'child-1', leafId: 'server', status: 'running' },
      { id: 'd2', parentChatId: 'cycle-chat', childChatId: 'child-2', leafId: 'other', status: 'running' },
    ],
    chatRows: [
      { id: 'recent-manual', lastFinishedAt: new Date(now - 60_000).toISOString() },
      { id: 'stale-manual', lastFinishedAt: new Date(now - WORKSPACE_WATCHER_EXTERNAL_OWNER_GRACE_MS - 1).toISOString() },
      { id: 'old-cycle', pickPurpose: 'watcher-orchestrator', lastFinishedAt: new Date(now - 60_000).toISOString() },
      { id: 'archived', archivedAt: 'x', lastFinishedAt: new Date(now - 60_000).toISOString() },
    ],
    excludeChatIds: ['cycle-chat'],
    now,
  });
  assert.deepEqual(owners.liveChatIds.sort(), ['child-1', 'manual-orch']);
  assert.deepEqual(owners.delegationLeafIds, ['server']);
  assert.deepEqual(owners.recentOrchestratorChatIds, ['recent-manual']);
});

test('snapshot reports external owners from live chats and delegations', () => {
  const snapshot = snapshotWorkspaceWatcher({
    workspaceFolder,
    now,
    deps: {
      loadTodosData: () => ({ items }),
      loadDelegations: () => [{
        id: 'impl', parentChatId: 'leaf-chat', childChatId: 'impl-child', leafId: 'server',
        status: 'running', workspaceFolder,
      }],
      listWorkspaceChats: () => [
        { id: 'manual-orch', lastFinishedAt: new Date(now - 60_000).toISOString() },
        { id: 'leaf-chat' },
      ],
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      getChatRunState: () => null,
    },
  });
  assert.deepEqual(snapshot.externalOwners.delegationLeafIds, ['server']);
  assert.ok(snapshot.externalOwners.liveChatIds.includes('leaf-chat'));
  assert.deepEqual(snapshot.externalOwners.recentOrchestratorChatIds, ['manual-orch']);
  assert.equal(findWorkspaceWatcherExternalTreeOwner(clientLeaf, snapshot.items, snapshot.externalOwners)?.todoId, 'server');
});

test('stamping a cycle keeps a manual orchestrator on ancestors and stamps the leaf', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-'));
  const parent = addTodo(dataDir, workspaceFolder, { title: 'Root', status: 'ready', orchestratorChatId: 'manual-orch' }).item;
  const leaf = addTodo(dataDir, workspaceFolder, { title: 'Leaf', status: 'ready', parentId: parent.id }).item;
  const chats = {
    'manual-orch': { id: 'manual-orch' },
    'old-cycle': { id: 'old-cycle', pickPurpose: 'watcher-orchestrator' },
  };
  stampCycleOrchestratorOnTodoTree({
    workspaceFolder, dataDir, todoId: leaf.id, chatId: 'cycle-chat', getChat: (id) => chats[id] || null,
  });
  let byId = Object.fromEntries(loadTodosData(dataDir, workspaceFolder).items.map((row) => [row.id, row]));
  assert.equal(byId[parent.id].orchestratorChatId, 'manual-orch', 'manual stamp survives');
  assert.equal(byId[leaf.id].orchestratorChatId, 'cycle-chat', 'cycle authorizes through its leaf');
  // A stale stamp from an earlier watcher cycle is replaced as before.
  const current = loadTodosData(dataDir, workspaceFolder).items.find((row) => row.id === parent.id);
  updateTodo(dataDir, workspaceFolder, parent.id, { orchestratorChatId: 'old-cycle', expectedUpdatedAt: current.updatedAt });
  stampCycleOrchestratorOnTodoTree({
    workspaceFolder, dataDir, todoId: leaf.id, chatId: 'cycle-chat-2', getChat: (id) => chats[id] || null,
  });
  byId = Object.fromEntries(loadTodosData(dataDir, workspaceFolder).items.map((row) => [row.id, row]));
  assert.equal(byId[parent.id].orchestratorChatId, 'cycle-chat-2');
});

/** Persist the incident tree: root stamped by a manual orchestrator, leaf 1 done, leaf 2 ready. */
function createIncidentTree(dataDir, extraRoot = {}) {
  const parent = addTodo(dataDir, workspaceFolder, {
    title: 'Root', status: 'doing', runMode: 'sequential', orchestratorChatId: 'manual-orch', ...extraRoot,
  }).item;
  const first = addTodo(dataDir, workspaceFolder, { title: 'Server', status: 'ready', parentId: parent.id }).item;
  const second = addTodo(dataDir, workspaceFolder, { title: 'Client', status: 'ready', parentId: parent.id }).item;
  const doneRow = loadTodosData(dataDir, workspaceFolder).items.find((row) => row.id === first.id);
  updateTodo(dataDir, workspaceFolder, first.id, { status: 'done', expectedUpdatedAt: doneRow.updatedAt });
  return { parent, first, second };
}

function snapshotAt(dataDir, at, chatRows, options = {}) {
  return snapshotWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    now: at,
    ...options,
    deps: {
      loadTodosData: (dir, folder) => loadTodosData(dir, folder),
      loadDelegations: () => [],
      listWorkspaceChats: () => chatRows,
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      getChatRunState: () => null,
    },
  });
}

function decideFromSnapshot(snapshot) {
  return decideWorkspaceWatcherAction({
    watcher: { mode: 'autopilot', enabled: true, policy },
    snapshot,
    now: snapshot ? Date.parse(snapshot.at) : now,
  });
}

test('live scenario: persisted 2-leaf tree is held for 30 minutes after the manual orchestrator, then freed', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-live-'));
  const { second } = createIncidentTree(dataDir);
  const lastActive = now - 5 * 60_000;
  const chatRows = [{ id: 'manual-orch', lastFinishedAt: new Date(lastActive).toISOString() }];
  const held = snapshotAt(dataDir, now, chatRows);
  assert.deepEqual(held.readyTodoIds, [second.id], 'sequential gating made only leaf 2 ready');
  assert.equal(pickNextWorkspaceReadyTodo({ items: held.items, externalOwners: held.externalOwners }), null);
  const heldDecision = decideFromSnapshot(held);
  assert.equal(heldDecision.kind, 'idle_no_work');
  assert.equal(heldDecision.reason, 'tree_owned_by_live_orchestrator');
  // Still held right before the grace boundary.
  const edge = snapshotAt(dataDir, lastActive + WORKSPACE_WATCHER_EXTERNAL_OWNER_GRACE_MS - 1, chatRows);
  assert.equal(decideFromSnapshot(edge).reason, 'tree_owned_by_live_orchestrator');
  // Free once the grace elapsed.
  const freed = snapshotAt(dataDir, lastActive + WORKSPACE_WATCHER_EXTERNAL_OWNER_GRACE_MS + 1, chatRows);
  assert.equal(pickNextWorkspaceReadyTodo({ items: freed.items, externalOwners: freed.externalOwners }).id, second.id);
  assert.notEqual(decideFromSnapshot(freed).reason, 'tree_owned_by_live_orchestrator');
});

test('live scenario: an active delegation of the manual orchestrator holds the tree regardless of the grace window', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-busy-'));
  const { first } = createIncidentTree(dataDir);
  const longAgo = new Date(now - 3 * 60 * 60_000).toISOString();
  const snapshot = snapshotAt(dataDir, now, [{ id: 'manual-orch', lastFinishedAt: longAgo }]);
  assert.ok(decideFromSnapshot(snapshot).nextTodoId, 'idle and long gone: not owned, the leaf is picked');
  const busy = snapshotWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    now,
    deps: {
      loadTodosData: (dir, folder) => loadTodosData(dir, folder),
      loadDelegations: () => [{
        id: 'd-manual', parentChatId: 'unrelated-parent', childChatId: 'manual-child', leafId: first.id,
        status: 'running', workspaceFolder,
      }],
      listWorkspaceChats: () => [{ id: 'manual-orch', lastFinishedAt: longAgo }],
      probeChatRunLiveness: () => ({ known: true, busy: false, reason: 'idle' }),
      getChatRunState: () => null,
    },
  });
  assert.equal(decideFromSnapshot(busy).reason, 'tree_owned_by_live_orchestrator');
  // The root stamp is an idle, long-gone chat, so only the delegation can hold it.
  assert.deepEqual(busy.externalOwners.recentOrchestratorChatIds, []);
  assert.ok(!busy.externalOwners.liveChatIds.includes('manual-orch'));
  assert.deepEqual(busy.externalOwners.delegationLeafIds, [first.id]);
  assert.equal(findWorkspaceWatcherExternalTreeOwner(first, busy.items, busy.externalOwners)?.reason, 'live_delegation');
});

test('reserve re-check: an owner stamped after the snapshot aborts the reserve', () => {
  const stale = { ...clientLeaf };
  const owners = { liveChatIds: ['late-orch'], delegationLeafIds: [], recentOrchestratorChatIds: [] };
  assert.equal(resolveWorkspaceWatcherReserveOwnerAbort(stale, items, owners), '');
  const liveItems = items.map((row) => (row.id === 'root' ? { ...row, orchestratorChatId: 'late-orch' } : row));
  assert.equal(resolveWorkspaceWatcherReserveOwnerAbort(stale, liveItems, owners), 'tree_owned_by_live_orchestrator');
  assert.equal(resolveWorkspaceWatcherReserveOwnerAbort(stale, liveItems, noOwners), '');
  assert.equal(resolveWorkspaceWatcherReserveOwnerAbort(stale, liveItems, null), '');
});

test('regression: an independent tree is still picked while another tree is owned', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-indep-'));
  createIncidentTree(dataDir);
  const free = addTodo(dataDir, workspaceFolder, { title: 'Independent', status: 'ready' }).item;
  const snapshot = snapshotAt(dataDir, now, [{ id: 'manual-orch', lastFinishedAt: new Date(now - 60_000).toISOString() }]);
  assert.equal(pickNextWorkspaceReadyTodo({ items: snapshot.items, externalOwners: snapshot.externalOwners }).id, free.id);
  assert.equal(decideFromSnapshot(snapshot).nextTodoId, free.id);
});

test('regression: a stale stamp from an earlier watcher cycle does not block', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-stale-'));
  const { second } = createIncidentTree(dataDir, { orchestratorChatId: 'old-cycle' });
  const fresh = new Date(now - 60_000).toISOString();
  const snapshot = snapshotAt(dataDir, now, [
    { id: 'old-cycle', pickPurpose: 'watcher-orchestrator', lastFinishedAt: fresh },
  ]);
  assert.equal(pickNextWorkspaceReadyTodo({ items: snapshot.items, externalOwners: snapshot.externalOwners }).id, second.id);
});

test('regression: the watcher own cycle chats (parallel mode) are not external owners', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-par-'));
  const parentA = addTodo(dataDir, workspaceFolder, { title: 'A', status: 'doing', orchestratorChatId: 'cycle-a' }).item;
  const leafA = addTodo(dataDir, workspaceFolder, { title: 'A leaf', status: 'doing', parentId: parentA.id, chatId: 'cycle-a-child' }).item;
  const leafB = addTodo(dataDir, workspaceFolder, { title: 'B', status: 'ready' }).item;
  // tickWorkspaceWatcher derives the exclusion from the persisted row with this
  // same helper; driving the tick needs a persisted watcher row, so the test
  // feeds the snapshot the helper's output for an equivalent in-memory row.
  const cycleChatIds = workspaceWatcherCycleChatIds({
    activeCycles: [{ cycleId: 'c-a', chatId: 'cycle-a' }, { cycleId: 'c-b', chatId: 'cycle-b' }],
  });
  assert.deepEqual(cycleChatIds, ['cycle-a', 'cycle-b']);
  const snapshot = snapshotWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    now,
    excludeChatIds: cycleChatIds,
    excludeDelegationParentChatIds: cycleChatIds,
    deps: {
      loadTodosData: (dir, folder) => loadTodosData(dir, folder),
      loadDelegations: () => [{
        id: 'd-cycle', parentChatId: 'cycle-a', childChatId: 'cycle-a-child', leafId: leafA.id,
        status: 'running', workspaceFolder,
      }],
      listWorkspaceChats: () => [
        { id: 'cycle-a', pickPurpose: 'watcher-orchestrator', lastStartedAt: new Date(now - 1000).toISOString() },
        { id: 'cycle-b', pickPurpose: 'watcher-orchestrator', lastStartedAt: new Date(now - 1000).toISOString() },
      ],
      probeChatRunLiveness: (id) => ({ known: true, busy: id === 'cycle-a', reason: 'running' }),
      getChatRunState: () => null,
    },
  });
  assert.deepEqual(snapshot.externalOwners.delegationLeafIds, []);
  assert.ok(!snapshot.externalOwners.liveChatIds.includes('cycle-a'));
  assert.equal(findWorkspaceWatcherExternalTreeOwner(leafB, snapshot.items, snapshot.externalOwners), null);
  assert.equal(findWorkspaceWatcherExternalTreeOwner(leafA, snapshot.items, snapshot.externalOwners), null);
});

test('subtree authorization: the cycle delegation on its leaf resolves despite a manual ancestor stamp', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-auth-'));
  const { parent, second } = createIncidentTree(dataDir);
  stampCycleOrchestratorOnTodoTree({
    workspaceFolder, dataDir, todoId: second.id, chatId: 'cycle-chat',
    getChat: (id) => (id === 'manual-orch' ? { id } : null),
  });
  const items = loadTodosData(dataDir, workspaceFolder).items;
  assert.equal(items.find((row) => row.id === parent.id).orchestratorChatId, 'manual-orch');
  const explicit = resolveRequestLeafContext({
    input: { leaf_id: second.id }, parentChatId: 'cycle-chat', workspaceFolder, dataDir, items,
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.leafId, second.id);
  const siblingLeaf = items.find((row) => row.title === 'Server');
  const outside = resolveRequestLeafContext({
    input: { leaf_id: siblingLeaf.id }, parentChatId: 'cycle-chat', workspaceFolder, dataDir, items,
  });
  // Orchestrator roots resolve to the tree root, so the stamped leaf authorizes the cycle tree-wide.
  assert.equal(outside.ok, true);
  // The manual orchestrator keeps authority over the whole tree, including the cycle leaf.
  const manual = resolveRequestLeafContext({
    input: { leaf_id: second.id }, parentChatId: 'manual-orch', workspaceFolder, dataDir, items,
  });
  assert.equal(manual.ok, true);
});

// Edge case decisions (documented in docs/workspace-watcher.md): a busy chat
// stamped only as `chatId` on a done leaf blocks the whole tree while it runs,
// and a todo created with orchestrator_chat_id = creator blocks for the grace
// window after the creator's last activity. Both are intentional: they are
// short-lived and err on the side of not sharing a worktree.
test('edge: a busy chatId on a done leaf blocks the tree only while the chat is busy', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-edge-'));
  const { first, second } = createIncidentTree(dataDir, { orchestratorChatId: undefined });
  const current = loadTodosData(dataDir, workspaceFolder).items.find((row) => row.id === first.id);
  updateTodo(dataDir, workspaceFolder, first.id, { chatId: 'user-chat', expectedUpdatedAt: current.updatedAt });
  const makeSnapshot = (busy) => snapshotWorkspaceWatcher({
    workspaceFolder,
    dataDir,
    now,
    deps: {
      loadTodosData: (dir, folder) => loadTodosData(dir, folder),
      loadDelegations: () => [],
      listWorkspaceChats: () => [{ id: 'user-chat', lastFinishedAt: new Date(now - 3 * 60 * 60_000).toISOString() }],
      probeChatRunLiveness: () => ({ known: true, busy, reason: busy ? 'running' : 'idle' }),
      getChatRunState: () => null,
    },
  });
  const busySnapshot = makeSnapshot(true);
  assert.equal(findWorkspaceWatcherExternalTreeOwner(
    busySnapshot.items.find((row) => row.id === second.id), busySnapshot.items, busySnapshot.externalOwners,
  )?.reason, 'live_chat');
  const idleSnapshot = makeSnapshot(false);
  assert.equal(pickNextWorkspaceReadyTodo({ items: idleSnapshot.items, externalOwners: idleSnapshot.externalOwners }).id, second.id);
});

test('edge: a todo created with orchestrator_chat_id = creator is held for the grace window after creator activity', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-tree-owner-creator-'));
  const standalone = addTodo(dataDir, workspaceFolder, {
    title: 'Created by a chat', status: 'ready', orchestratorChatId: 'creator-chat',
  }).item;
  const rows = [{ id: 'creator-chat', lastFinishedAt: new Date(now - 10 * 60_000).toISOString() }];
  const held = snapshotAt(dataDir, now, rows);
  assert.equal(findWorkspaceWatcherExternalTreeOwner(standalone, held.items, held.externalOwners)?.reason, 'recent_orchestrator');
  const later = snapshotAt(dataDir, now + WORKSPACE_WATCHER_EXTERNAL_OWNER_GRACE_MS, rows);
  assert.equal(findWorkspaceWatcherExternalTreeOwner(standalone, later.items, later.externalOwners), null);
});
