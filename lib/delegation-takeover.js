/** Recoverable takeover protocol. Callers own store → parent → chat locks. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadDelegations, reassignDelegationController } from './persist/delegations-persist.js';
import { loadChats, saveChats } from './persist/chats-persist.js';
import { loadTodosData, saveTodosData } from './persist/todos-persist.js';
import { loadDelegationWorkflows, reassignDelegationWorkflows } from './persist/delegation-workflows-persist.js';
import { loadMailboxMessages } from './persist/delegation-mailbox-persist.js';
import { loadDelegationTakeovers, saveDelegationTakeover } from './persist/delegation-takeovers-persist.js';
import { delegationController } from './delegation-control.js';
import { readDelegationWorkflowLeafIdFromRow } from './delegation-workflow-leaf.js';
import { withWorkspaceWatchersFileLock, getWorkspaceWatcher, getWorkspaceWatcherActiveCycles } from './persist/workspace-watchers-persist.js';
import { summarizeChatRunStates } from './agent-run-state.js';
import { getChatRunState } from './chat-run-service.js';
import { resolveDataPath } from './runtime-paths.js';
import { broadcastTodoReviewChanged } from './chat-list-updates.js';
import { redirectMailboxToController } from './delegation-mailbox.js';

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

const PHASES = ['started', 'rows', 'workflows', 'mailbox', 'todo', 'done'];

function refuse(code, details = {}) {
  const error = new Error(code);
  Object.assign(error, { code, status: 409, ...details });
  throw error;
}

function subtree(items, id) {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const item of items) {
      if (!ids.has(item.parentId) || ids.has(item.id)) continue;
      ids.add(item.id);
      changed = true;
    }
  }
  return ids;
}

function ownerOf(items, todo) {
  const seen = new Set();
  for (let row = todo; row && !seen.has(row.id); row = items.find((item) => item.id === row.parentId)) {
    seen.add(row.id);
    if (row.orchestratorChatId) return row.orchestratorChatId;
  }
  return todo.chatId || todo.createdByChatId || '';
}

/** Seeds plus every row controlled by a child chat of an already selected row (any depth). */
function collectNestedRows(jobs, seeds, workspaceFolder) {
  const picked = new Map(seeds.map((row) => [row.id, row]));
  const queue = [...seeds];
  while (queue.length) {
    const node = queue.shift();
    if (!node.childChatId) continue;
    for (const row of jobs) {
      if (picked.has(row.id) || delegationController(row) !== node.childChatId) continue;
      if (path.resolve(row.workspaceFolder || '.') !== path.resolve(workspaceFolder)) continue;
      picked.set(row.id, row);
      queue.push(row);
    }
  }
  return [...picked.values()];
}

/** Read-only preparation; repeated after locks to avoid stale validation. */
export function prepareOrchestrationTakeover(input) {
  const to = String(input.chatId || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const dataDir = resolveDataPath();
  const todoId = String(input.todoId || '').trim();
  const key = String(input.idempotencyKey || '').trim();
  if (!key || !to || !workspaceFolder || !todoId) refuse('takeover_arguments_required');
  if (input.scope && !['subtree', 'all'].includes(input.scope)) refuse('takeover_scope_invalid');
  const chats = loadChats();
  const caller = chats.find((row) => row.id === to);
  if (!caller || path.resolve(caller.workspaceFolder || '.') !== path.resolve(workspaceFolder)) refuse('takeover_workspace');
  const jobs = /** @type {DelegationRecord[]} */ (loadDelegations());
  if (caller.delegationParentChatId || jobs.some((row) => row.childChatId === to)) refuse('takeover_child_chat');
  const records = loadDelegationTakeovers();
  const replay = records.find((row) => row.idempotencyKey === key);
  if (replay) {
    if (replay.to !== to || replay.todoId !== todoId || replay.workspaceFolder !== workspaceFolder) refuse('idempotency_conflict');
    return { ...replay, replayed: true };
  }
  const doc = loadTodosData(dataDir, workspaceFolder);
  const todo = doc.items.find((row) => row.id === todoId);
  if (!todo) refuse('takeover_todo_not_found');
  const from = ownerOf(doc.items, todo);
  if (!from) refuse('takeover_owner_missing');
  if (from === to) {
    const previous = records.findLast((row) => row.todoId === todoId && row.to === to && row.phase === 'done');
    if (previous) return { ...previous, noop: true, replayed: false };
    refuse('takeover_same_chat');
  }
  const source = chats.find((row) => row.id === from);
  if (source && path.resolve(source.workspaceFolder || '.') !== path.resolve(workspaceFolder)) refuse('takeover_workspace');
  const presence = summarizeChatRunStates([from])[from];
  const run = getChatRunState({ chatId: from });
  if (!input.forceUnavailable && (run?.busy || run?.waitingForInput || (presence?.state === 'busy' && !presence?.waitingAgentCount))) refuse('takeover_source_live');
  const todoIds = [...subtree(doc.items, todoId)];
  const localOwners = doc.items.filter((row) => todoIds.includes(row.id) && row.orchestratorChatId && ![from, to].includes(row.orchestratorChatId));
  if (localOwners.length) refuse('takeover_local_owner', { todoIds: localOwners.map((row) => row.id) });
  const cycles = getWorkspaceWatcherActiveCycles(getWorkspaceWatcher(workspaceFolder));
  if (cycles.some((/** @type {Record<string, any>} */ cycle) => cycle.chatId === from || cycle.todoIds?.some((id) => todoIds.includes(id)))) refuse('takeover_watcher_cycle_active');
  const seeds = jobs.filter((row) => delegationController(row) === from
    && path.resolve(row.workspaceFolder || '.') === path.resolve(workspaceFolder)
    && (todoIds.includes(readDelegationWorkflowLeafIdFromRow(row)) || (input.scope === 'all' && !readDelegationWorkflowLeafIdFromRow(row))));
  const selected = collectNestedRows(jobs, seeds, workspaceFolder);
  const workflows = loadDelegationWorkflows();
  const leafIds = [...new Set([...selected.map(readDelegationWorkflowLeafIdFromRow), ...workflows.filter((/** @type {Record<string, any>} */ row) => row.parentChatId === from && todoIds.includes(row.leafId)).map((/** @type {Record<string, any>} */ row) => row.leafId)].filter(Boolean))];
  if (workflows.some((/** @type {Record<string, any>} */ row) => row.parentChatId === to && leafIds.includes(row.leafId))) refuse('takeover_workflow_conflict');
  if (records.some((row) => row.phase !== 'done' && (row.from === from || row.to === to || row.todoId === todoId))) refuse('takeover_in_progress');
  return { id: randomUUID(), idempotencyKey: key, todoId, from, to, reason: String(input.reason || ''), at: new Date().toISOString(), phase: 'started', workspaceFolder, todoIds, delegationIds: selected.map((row) => row.id), leafIds,
    moved: { delegations: selected.length, workflows: workflows.filter((/** @type {Record<string, any>} */ row) => row.parentChatId === from && leafIds.includes(row.leafId)).length, mailbox: loadMailboxMessages().filter((/** @type {Record<string, any>} */ row) => row.status === 'queued' && row.toChatId === from && selected.some((job) => job.id === row.delegationId)).length } };
}

/** All steps replay safely when a crash occurs before the phase checkpoint. */
export async function executeOrchestrationTakeoverUnlocked(record, afterPhase = () => {}) {
  let current = record;
  if (current.phase === 'done' || current.noop) return takeoverResult(current);
  saveDelegationTakeover(current);
  await afterPhase('started', current);
  const checkpoint = async (phase) => {
    current = saveDelegationTakeover({ ...current, phase });
    await afterPhase(phase, current);
  };
  if (PHASES.indexOf(current.phase) < 1) {
    // Nested rows keep historical parentChatId/rootDelegationId; only control and tree root move.
    // Workflow rows of nested chats (parentChatId = child chat) are deliberately left in place:
    // they are keyed by the child chat and the tree budget lives on the root chat-wide row.
    reassignDelegationController(current.delegationIds, current.to);
    const children = new Set(loadDelegations().filter((/** @type {Record<string, any>} */ row) => current.delegationIds.includes(row.id)).map((/** @type {Record<string, any>} */ row) => row.childChatId));
    saveChats(loadChats().map((chat) => children.has(chat.id) ? { ...chat, delegationParentChatId: current.to, delegationRootChatId: current.to } : chat));
    await checkpoint('rows');
  }
  if (PHASES.indexOf(current.phase) < 2) {
    reassignDelegationWorkflows(current.from, current.to, current.leafIds);
    await checkpoint('workflows');
  }
  if (PHASES.indexOf(current.phase) < 3) {
    for (const message of /** @type {Record<string, any>[]} */ (loadMailboxMessages())) {
      if (current.delegationIds.includes(message.delegationId)) redirectMailboxToController(message);
    }
    await checkpoint('mailbox');
  }
  if (PHASES.indexOf(current.phase) < 4) {
    withWorkspaceWatchersFileLock(() => {
      const doc = loadTodosData(resolveDataPath(), current.workspaceFolder);
      for (const todo of doc.items) {
        if (!current.todoIds.includes(todo.id)) continue;
        const previousOwner = todo.orchestratorChatId;
        if (todo.id === current.todoId) todo.orchestratorChatId = current.to;
        else if (todo.orchestratorChatId === current.from) delete todo.orchestratorChatId;
        if (previousOwner !== todo.orchestratorChatId) {
          const previous = Date.parse(todo.updatedAt || '');
          todo.updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
        }
        if (todo.id === current.todoId && !(todo.changelog || []).some((row) => row.text === `Orchestration takeover ${current.id}`)) {
          todo.changelog = [...(todo.changelog || []), { kind: 'note', text: `Orchestration takeover ${current.id}`, chatId: current.to, at: current.at }];
        }
      }
      saveTodosData(resolveDataPath(), current.workspaceFolder, doc);
    }, { dataDir: resolveDataPath() });
    broadcastTodoReviewChanged({ workspaceFolder: current.workspaceFolder, todoId: current.todoId, reason: 'orchestration_takeover' });
    await checkpoint('todo');
  }
  await checkpoint('done');
  return takeoverResult(current);
}

function takeoverResult(record) {
  return { ok: true, takeover_id: record.id, from: record.from, to: record.to, moved: record.moved, replayed: record.replayed === true, ...(record.noop ? { noop: true } : {}) };
}
