/**
 * Read-only delegation tree view with an access scope.
 *
 * A tree is every delegation row sharing one recorded root. Visibility is
 * derived from the *viewing chat*, never from a requested tree id:
 *  - a root chat (no delegation row has it as `childChatId`) sees every row it
 *    started, all descendants included;
 *  - a delegation child chat sees its own row (`self`), the ancestors that
 *    delegated down to it (read-only) and its own descendants. Siblings and
 *    other branches of the same tree are out of scope, and a foreign tree is
 *    unreachable because the lookup starts from the viewing chat.
 *
 * Nodes carry compact status fields only: no report/plan bodies, outbox,
 * folders or run identifiers, so the view stays within the existing redaction.
 */

import { delegationController } from './delegation-control.js';
import { listDelegationsForRootChat, findDelegationByChildChatId } from './persist/delegations-persist.js';
import { getDelegationWorkflow } from './persist/delegation-workflows-persist.js';
import { resolveRecordTreeFields } from './delegation-tree.js';
import { resolveDelegationEnv } from './delegation-settings.js';
import { listOccupiedTreeSlots, readDelegationTreeSlotLimit } from './delegation-width.js';
import { summarizeDelegationTreeUsage } from './delegation-workflow-budget.js';
import { isActiveDelegationStatus, isDelegationSlotOccupied } from './delegation-status.js';
import { resolveDelegationRecordVerdict } from './delegation-verdict.js';
import { paginateList } from './mcp/builtin/paging.js';

/** Hard cap on walked ancestors/descendants, a guard against corrupted cycles. */
const MAX_TREE_WALK = 2000;

/**
 * @param {object} row
 * @returns {string}
 */
function rowId(row) {
  return String(row?.id || '').trim();
}

/**
 * Delegation row (inside the tree) that created the given parent chat, i.e. the
 * row whose executor child chat is `chatId`.
 *
 * @param {object[]} rows
 * @param {string} chatId
 * @returns {object | null}
 */
function findRowByChildChat(rows, chatId) {
  const id = String(chatId || '').trim();
  if (!id) return null;
  return rows.find((row) => String(row?.childChatId || '').trim() === id) || null;
}

/**
 * Pure scope selection over the rows of one root chat.
 *
 * @param {{ rows: object[], viewerChatId: string, viewerRow?: object | null }} input
 * @returns {{ rows: Array<{ row: object, relation: 'self' | 'ancestor' | 'descendant' }>, viewer: 'root' | 'child' }}
 */
export function selectVisibleTreeRows(input) {
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const viewerChatId = String(input?.viewerChatId || '').trim();
  const viewerRow = input?.viewerRow || null;
  if (!viewerChatId) return { rows: [], viewer: 'root' };
  if (!viewerRow) {
    return {
      rows: rows.map((row) => ({ row, relation: 'descendant' })),
      viewer: 'root',
    };
  }
  const treeRootId = resolveRecordTreeFields(viewerRow).rootDelegationId;
  const inTree = rows.filter((row) => resolveRecordTreeFields(row).rootDelegationId === treeRootId);
  const picked = new Map();
  picked.set(rowId(viewerRow), { row: viewerRow, relation: 'self' });
  // Ancestors: follow "which row created the chat that started this row".
  let cursor = viewerRow;
  for (let step = 0; step < MAX_TREE_WALK && cursor; step += 1) {
    const parent = findRowByChildChat(inTree, delegationController(cursor));
    if (!parent || picked.has(rowId(parent))) break;
    picked.set(rowId(parent), { row: parent, relation: 'ancestor' });
    cursor = parent;
  }
  // Descendants: breadth-first over chats the viewer (transitively) started.
  const frontier = [viewerChatId];
  const seenChats = new Set(frontier);
  for (let walked = 0; frontier.length > 0 && walked < MAX_TREE_WALK; walked += 1) {
    const chatId = frontier.shift();
    for (const row of inTree) {
      if (delegationController(row) !== chatId) continue;
      if (!picked.has(rowId(row))) picked.set(rowId(row), { row, relation: 'descendant' });
      const child = String(row?.childChatId || '').trim();
      if (child && !seenChats.has(child)) {
        seenChats.add(child);
        frontier.push(child);
      }
    }
  }
  return { rows: [...picked.values()], viewer: 'child' };
}

/**
 * @param {object} row
 * @param {'self' | 'ancestor' | 'descendant'} relation
 * @param {object[]} allRows Rows of the tree, to resolve the parent row id.
 * @returns {object}
 */
function toTreeNode(row, relation, allRows) {
  const fields = resolveRecordTreeFields(row);
  const parentRow = findRowByChildChat(allRows, delegationController(row));
  const executor = row?.executor && typeof row.executor === 'object' ? row.executor : {};
  const node = {
    id: rowId(row),
    parent_delegation_id: parentRow ? rowId(parentRow) : '',
    relation,
    depth: fields.depth,
    root_delegation_id: fields.rootDelegationId,
    status: String(row.status || ''),
    assignment: String(row.assignment || ''),
    harness: String(executor.transport || ''),
    model: String(executor.model || ''),
    parent_chat_id: String(row.parentChatId || ''),
    controller_chat_id: delegationController(row),
    child_chat_id: String(row.childChatId || ''),
    allow_child_delegations: row.allowChildDelegations === true,
    slot_occupied: isDelegationSlotOccupied(row),
    queued: String(row.status || '') === 'queued',
    active: isActiveDelegationStatus(row.status),
    run_stopping: Boolean(String(row.runStoppingAt || '').trim()),
    task_outcome: String(row.taskOutcome || 'unspecified'),
    verdict: resolveDelegationRecordVerdict(row),
    created_at: String(row.createdAt || ''),
    started_at: String(row.startedAt || ''),
    finished_at: String(row.finishedAt || ''),
  };
  // A read-only ancestor never exposes failure detail to the descendant.
  if (relation !== 'ancestor') node.error = String(row.error || '').slice(0, 240);
  return node;
}

/**
 * Resolve the viewpoint of a chat: its tree root chat and, for a delegation
 * child chat, the row that created it. Returns null when the chat is a child
 * chat whose row is missing (nothing can be shown safely).
 *
 * @param {{ chat?: object | null, chatId: string }} input
 * @returns {{ rootChatId: string, viewerRow: object | null } | null}
 */
function resolveViewpoint(input) {
  const chatId = String(input.chatId || '').trim();
  const viewerRow = findDelegationByChildChatId(chatId);
  if (viewerRow) {
    return { rootChatId: resolveRecordTreeFields(viewerRow).rootChatId, viewerRow };
  }
  const chat = input.chat || null;
  if (chat && String(chat.delegationParentChatId || '').trim()) return null;
  return { rootChatId: chatId, viewerRow: null };
}

/**
 * Tree snapshot for one viewing chat. `slots` counts by `rootDelegationId`
 * (the slot-accounting tree); `budget` counts by `rootChatId` (the shared
 * budget tree). The scopes are labelled in the payload because they differ.
 *
 * @param {{
 *   chatId: string,
 *   chat?: object | null,
 *   rootDelegationId?: string,
 *   status?: string,
 *   cursor?: unknown,
 *   limit?: unknown,
 *   now?: unknown,
 * }} input
 * @returns {object}
 */
export function buildDelegationTreeSnapshot(input) {
  const chatId = String(input?.chatId || '').trim();
  const workspaceFolder = String(input?.workspaceFolder || input?.chat?.workspaceFolder || '').trim();
  const empty = {
    viewer: 'root',
    viewer_chat_id: chatId,
    root_chat_id: chatId,
    root_delegation_ids: [],
    nodes: [],
    next_cursor: '',
    total: 0,
    counters: buildCounters({ rootChatId: chatId, treeRows: [], now: input?.now, workspaceFolder }),
  };
  const viewpoint = resolveViewpoint({ chat: input?.chat, chatId });
  if (!viewpoint) return { ...empty, viewer: 'child' };
  const treeRows = listDelegationsForRootChat(viewpoint.rootChatId);
  const visible = selectVisibleTreeRows({
    rows: treeRows,
    viewerChatId: chatId,
    viewerRow: viewpoint.viewerRow,
  });
  const wantedRoot = String(input?.rootDelegationId || '').trim();
  const wantedStatus = String(input?.status || '').trim();
  const filtered = visible.rows
    .filter((item) => !wantedRoot || resolveRecordTreeFields(item.row).rootDelegationId === wantedRoot)
    .filter((item) => !wantedStatus || String(item.row.status || '') === wantedStatus)
    .sort((left, right) => {
      const byTime = String(left.row.createdAt || '').localeCompare(String(right.row.createdAt || ''));
      return byTime || rowId(left.row).localeCompare(rowId(right.row));
    });
  const page = paginateList(filtered, { cursor: input?.cursor, limit: input?.limit });
  const rootIds = [...new Set(visible.rows.map((item) => resolveRecordTreeFields(item.row).rootDelegationId))];
  return {
    viewer: visible.viewer,
    viewer_chat_id: chatId,
    root_chat_id: viewpoint.rootChatId,
    root_delegation_ids: rootIds,
    nodes: page.items.map((item) => toTreeNode(item.row, item.relation, treeRows)),
    next_cursor: page.next_cursor,
    total: filtered.length,
    counters: buildCounters({
      rootChatId: viewpoint.rootChatId,
      treeRows,
      rootDelegationIds: rootIds,
      now: input?.now,
      workspaceFolder,
    }),
  };
}

/**
 * Aggregate counters only: no delegation ids and no usage event bodies.
 *
 * @param {{ rootChatId: string, treeRows: object[], rootDelegationIds?: string[], now?: unknown, workspaceFolder?: string }} input
 * @returns {object}
 */
function buildCounters(input) {
  const limit = readDelegationTreeSlotLimit(input.workspaceFolder ? resolveDelegationEnv(input.workspaceFolder) : process.env);
  const trees = (input.rootDelegationIds || []).map((rootDelegationId) => {
    const members = input.treeRows.filter(
      (row) => resolveRecordTreeFields(row).rootDelegationId === rootDelegationId,
    );
    return {
      root_delegation_id: rootDelegationId,
      occupied: listOccupiedTreeSlots({ active: members, rootDelegationId }).length,
      queued: members.filter((row) => String(row.status || '') === 'queued').length,
    };
  });
  let budgetTokens = 0;
  let budgetUsd = 0;
  try {
    const workflow = input.rootChatId ? getDelegationWorkflow(input.rootChatId, '') : null;
    budgetTokens = Number(workflow?.treeBudgetTokens) || 0;
    budgetUsd = Number(workflow?.treeBudgetCostUsd) || 0;
  } catch {
    budgetTokens = 0;
    budgetUsd = 0;
  }
  const usage = input.treeRows.length > 0
    ? summarizeDelegationTreeUsage({ rootChatId: input.rootChatId, now: input.now })
    : { measured: false, tokens: 0, usd: 0, eventCount: 0 };
  return {
    slots: {
      scope: 'root_delegation_id',
      limit,
      occupied_total: trees.reduce((sum, tree) => sum + tree.occupied, 0),
      trees,
    },
    budget: {
      scope: 'root_chat_id',
      root_chat_id: input.rootChatId,
      measured: usage.measured === true,
      tokens: usage.tokens,
      usd: usage.usd,
      event_count: usage.eventCount,
      budget_tokens: budgetTokens,
      budget_usd: budgetUsd,
    },
  };
}
