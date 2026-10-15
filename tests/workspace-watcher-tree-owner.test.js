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
  WORKSPACE_WATCHER_EXTERNAL_OWNER_GRACE_MS,
} from '../lib/workspace-watcher-tree-owner.js';
import { stampCycleOrchestratorOnTodoTree } from '../lib/workspace-watcher-cycle.js';
import { addTodo, loadTodosData, updateTodo } from '../lib/persist/todos-persist.js';

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
