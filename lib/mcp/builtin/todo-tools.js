/**
 * Builtin Cretli MCP TODO tools (workspace of the calling chat).
 */

import { TODO_STATUSES, describeBodyTruncation } from '../../persist/todos-persist.js';
import { findApprovedPlanAncestor, listReadyTodoLeaves, readTodoExecutionState } from '../../todo-tree.js';
import { getWorkspaceWatcher } from '../../persist/workspace-watchers-persist.js';
import { getBuiltinMcpRuntimeDeps } from './runtime-deps.js';
import { assessParallelRunModeForSiblings } from '../../todo-parallel-scope.js';
import { bodyDeclaresLeafScope } from '../../workspace-watcher-scheduler.js';
import { resolveProjectPath } from '../../runtime-paths.js';
import {
  buildTodoReviewReadModel,
  parseTodoReviewFilter,
  summarizeTodoReviewForList,
  todoReviewMatchesFilter,
} from '../../todo-review-read.js';
import { attachTodoIntegrationReadModels } from '../../todo-integration-read.js';
import { formatTodoLeafMaterialDiagnostics } from '../../todo-leaf-material.js';
import { TODO_MOVE_ERROR_CODES } from '../../todo-move.js';
import { isFeedbackDerivedTodo } from '../../persist/feedback-store.js';
import { resolveDelegationMaxDepth, remainingDelegationDepth } from '../../delegation-tree.js';
import { resolveDelegationEnv } from '../../delegation-settings.js';
import { resolveCretliToolContext } from './tool-context.js';
import { requireClientMethod } from './client-scope.js';
import { paginateList, paginateDetail, decodeListCursor, clampListLimit } from './paging.js';
import { mcpToolResult, truncateText } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

/**
 * @param {{ truncated: boolean, truncated_chars: number, max_body_len: number }} cut
 * @returns {string}
 */
function bodyTruncationNotice(cut) {
  return cut.truncated
    ? ` WARNING: body truncated to ${cut.max_body_len} chars (${cut.truncated_chars} chars cut); keep the body short or move detail to plan.markdown.`
    : '';
}

/**
 * @param {{ truncated: boolean, truncated_chars: number, max_body_len: number }} cut
 */
function bodyTruncationFields(cut) {
  return cut.truncated
    ? { truncated: true, truncated_chars: cut.truncated_chars, max_body_len: cut.max_body_len }
    : { truncated: false };
}

/**
 * Resolve the effective body of a todo_update patch. `body_append` is joined to
 * the stored body server-side, so a client that never read the body cannot
 * overwrite it. A base that is unknown, or a body that starts with the literal
 * "undefined" (a stringified missing value), is refused instead of written.
 * @param {any} patch
 * @param {any} current
 * @returns {string | undefined}
 */
export function resolveBodyPatch(patch, current) {
  const fail = (/** @type {string} */ msg) => new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, msg);
  const undef = /^undefined(?![A-Za-z0-9_])/;
  let body = patch.body;
  if (patch.body_append != null) {
    if (body != null) throw fail('patch.body and patch.body_append are mutually exclusive');
    if (typeof patch.body_append !== 'string') throw fail('patch.body_append must be a string');
    if (typeof current?.body !== 'string') {
      throw fail('Cannot append: the existing todo body is unknown. Call todo_show (field=body) first and send the full patch.body.');
    }
    body = current.body ? `${current.body}\n\n${patch.body_append}` : patch.body_append;
  }
  if (body == null) return undefined;
  if (typeof body !== 'string') throw fail('patch.body must be a string');
  if (undef.test(body) && !undef.test(String(current?.body || ''))) {
    throw fail('patch.body starts with the literal "undefined" (a missing base body was stringified); refusing to overwrite the todo body.');
  }
  return body;
}

const TODO_PATCH_KEYS = new Set(['title', 'body', 'body_append', 'status', 'priority', 'parent_id', 'sibling_index', 'assignee', 'run_mode', 'non_blocking', 'execution_mode', 'reviewer_pair', 'orchestrator_chat_id', 'source_todo_id', 'watcher_phases', 'plan', 'deferred_until', 'deferred_reason', 'move_to_later', 'restore_to_tree']);

const ASSIGNEE_SCHEMA = {
  type: 'object',
  description: 'Executor assignment: harness + optional model and role (plan|implement|review).',
  properties: {
    harness: { type: 'string', description: 'Harness transport, e.g. sdk, opencode, deepseek, codex, qwen, claude, codebuddy, openrouter' },
    model: { type: 'string' },
    role: { type: 'string', description: 'One of plan, implement, review' },
  },
  required: ['harness', 'role'],
};

/**
 * Compact list-row projection. `options.isContainer` flips the review summary to
 * its empty container form (`docs/todo-review-contract.md` §10.6, §12.2).
 *
 * @param {Record<string, any>} item
 * @param {{ isContainer?: boolean, items?: any[], policy?: Record<string, any> | null, executionState?: string }} [options]
 */
function summarizeTodo(item, options = {}) {
  const body = truncateText(item.body || '', 160);
  return {
    id: item.id,
    title: item.title || '',
    status: item.status || 'idea',
    ...(options.executionState != null ? { execution_state: options.executionState }
      : options.items ? { execution_state: (todoToolsTestHooks.onExecutionState?.(item), readTodoExecutionState(options.items, item, options.policy)) } : {}),
    ...(item.status === 'deferred' ? { deferred_until: item.deferredUntil || '', deferred_reason: item.deferredReason || '' } : {}),
    updated_at: item.updatedAt || '',
    chat_id: item.chatId || '',
    created_by_chat_id: item.createdByChatId || '',
    linked_chat_ids: Array.isArray(item.linkedChatIds) ? item.linkedChatIds : [],
    parent_id: item.parentId || '',
    sibling_index: Number.isInteger(item.siblingIndex) ? item.siblingIndex : 0,
    assignee: item.assignee || null,
    priority: item.priority || 'normal',
    reserved_by: item.reservedBy || null,
    run_mode: item.runMode || 'sequential',
    ...(item.nonBlocking ? { non_blocking: true } : {}),
    execution_mode: item.executionMode || 'inherit',
    ...(item.reviewerPair ? { reviewer_pair: item.reviewerPair } : {}),
    claimed_by_chat_id: item.claimedByChatId || '',
    claimed_at: item.claimedAt || '',
    claim_lease_until: item.claimLeaseUntil || '',
    blocked_reason: item.blockedReason || '',
    orchestrator_chat_id: item.orchestratorChatId || '',
    source_todo_id: item.sourceTodoId || '',
    watcher_phases: item.watcherPhases || null,
    has_plan: Boolean(String(item.plan?.markdown || '').trim()),
    plan_approved_at: item.plan?.approvedAt || '',
    plan_approved_by: item.plan?.approvedBy || null,
    integration_state: item.integration?.state || '',
    integration_result_path: item.integration?.resultPath || '',
    integration_summary: item.integrationSummary || null,
    ...summarizeTodoReviewForList(item, { isContainer: options.isContainer === true }),
    body_preview: body.text,
    truncated: body.truncated,
  };
}

/**
 * Direct-parent id set, so a list row can tell a leaf from a container without
 * another store read.
 *
 * @param {Array<{ id?: string, parentId?: string }>} items
 * @returns {Set<string>}
 */
function collectContainerIds(items) {
  const ids = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const parentId = String(item?.parentId || '').trim();
    if (parentId) ids.add(parentId);
  }
  return ids;
}

/**
 * One readable review line for `todo_show` so an orchestrator can confirm the
 * server-side snapshot without parsing the structured block.
 *
 * @param {Record<string, any>} review
 * @returns {string}
 */
function formatTodoReviewLine(review) {
  const code = String(review?.code?.state || 'none');
  const plan = String(review?.plan?.state || 'none');
  const independence = String(review?.code?.independence?.class || 'unknown');
  const reviewer = review?.code?.reviewers?.[0];
  const reviewerText = reviewer
    ? `${reviewer.harness || '?'}:${reviewer.model || '?'}`
    : '-';
  const aggregate = review?.aggregate
    ? ` aggregate(code passed=${review.aggregate.code?.passed || 0} failed=${review.aggregate.code?.failed || 0})`
    : '';
  return `review: code=${code} plan=${plan} independence=${independence} reviewer=${reviewerText}${aggregate}`;
}

/**
 * Plan gate as the tree evaluates it (`lib/todo-tree.js`): open when this node
 * or any ancestor has a human-approved plan; a closer unapproved draft does not
 * close it. Otherwise closed: execution waits for a human approval.
 *
 * @param {Record<string, any>} item
 * @param {{ id: string } | null} approvedAncestor
 * @returns {'open' | 'closed'}
 */
function resolvePlanGate(item, approvedAncestor) {
  const ownApproved = Boolean(String(item?.plan?.approvedAt || '').trim());
  return ownApproved || approvedAncestor ? 'open' : 'closed';
}

/**
 * @param {Record<string, any>} item
 * @param {{ id: string, title: string } | null} approvedAncestor
 * @returns {string}
 */
function formatTodoPlanGateLine(item, approvedAncestor) {
  const gate = resolvePlanGate(item, approvedAncestor);
  const via = approvedAncestor && !String(item?.plan?.approvedAt || '').trim()
    ? ` (approved on ancestor ${approvedAncestor.id} "${approvedAncestor.title.slice(0, 80)}"; no own approval needed)`
    : '';
  return `plan_gate: ${gate}${via}`;
}

function formatTodoIntegrationLine(summary) {
  const state = String(summary?.state || 'unconfirmed');
  const detail = summary?.detail ? ` detail=${summary.detail}` : '';
  const target = summary?.targetBranch
    ? ` target=${summary.targetBranch}@${summary.targetCommit || '-'}`
    : '';
  return `integration: ${state}${detail}${target}`;
}

export const TODO_LIST_COMPACT_FIELDS = Object.freeze(['id', 'status', 'title']);
export const TODO_LIST_COMPACT_TITLE_CHARS = 80;
export const TODO_LIST_DEFAULT_MAX_CHARS = 16000;
export const TODO_LIST_MAX_CHARS = 60000;

/** @param {unknown} raw */
export function clampTodoListMaxChars(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return TODO_LIST_DEFAULT_MAX_CHARS;
  return Math.min(TODO_LIST_MAX_CHARS, Math.max(500, Math.floor(n)));
}

/**
 * @param {Record<string, any> | undefined} args
 * @returns {string[] | null} null = full rows
 */
export function resolveTodoListFields(args) {
  const raw = Array.isArray(args?.fields) ? args.fields : typeof args?.fields === 'string' ? args.fields.split(',') : [];
  const names = raw.map((name) => String(name).trim()).filter(Boolean);
  if (names.length === 0) return args?.compact === true ? [...TODO_LIST_COMPACT_FIELDS] : null;
  return [...new Set(['id', ...names])];
}

/**
 * @param {Record<string, any>} row
 * @param {string[]} fields
 */
function projectTodoRow(row, fields) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of fields) {
    if (!(name in row)) continue;
    out[name] = name === 'title' ? truncateText(row.title || '', TODO_LIST_COMPACT_TITLE_CHARS).text : row[name];
  }
  return out;
}

/**
 * The workspace watcher policy that defines the plan gate, or null when the
 * workspace has no watcher row (then `waiting_plan` is never claimed).
 * @param {string} workspaceFolder
 * @returns {Record<string, any> | null}
 */
function readWatcherPolicy(workspaceFolder) {
  try {
    const dataDir = String(getBuiltinMcpRuntimeDeps()?.dataDir || '').trim();
    const row = getWorkspaceWatcher(workspaceFolder, dataDir ? { dataDir } : {});
    return row?.policy && typeof row.policy === 'object' ? row.policy : null;
  } catch {
    return null;
  }
}

function formatTodoLine(item, { compact = false } = {}) {
  if (compact) return `${item.execution_state || item.status || 'idea'}  ${truncateText(item.title || '(untitled)', TODO_LIST_COMPACT_TITLE_CHARS).text}  ${String(item.id).slice(0, 8)}`;
  const parent = item.parent_id ? ` (parent ${String(item.parent_id).slice(0, 8)})` : '';
  const assignee = item.assignee
    ? ` [${item.assignee.harness}${item.assignee.model ? `:${item.assignee.model}` : ''}/${item.assignee.role}]`
    : '';
  const integration = ` [integration ${item.integration_summary?.detail === 'no_code_changes'
    ? 'no code changes'
    : item.integration_summary?.state || (item.integration_state === 'ready' ? 'awaiting' : 'unconfirmed')}]`;
  return `${item.execution_state || item.status || 'idea'}  ${item.title || '(untitled)'}  ${String(item.id).slice(0, 8)}${parent}${assignee}${integration}`;
}

const TODO_ID_PREFIX_MIN_LENGTH = 8;

/**
 * Whole-workspace list for clients without the bounded read methods and for the
 * legacy read paths kept as the parity reference.
 *
 * @param {Record<string, any>} client
 * @param {{ workspaceFolder: string, workspaceFile?: string }} ctx
 * @returns {Promise<Record<string, any>[]>}
 */
async function loadWholeTodoList(client, ctx) {
  return client.listTodos({ workspaceFolder: ctx.workspaceFolder, workspaceFile: ctx.workspaceFile });
}

/**
 * Resolve a full todo id or a unique id prefix (>= 8 chars) inside the calling
 * chat's workspace. A prefix that matches several items is a validation error
 * so the agent can pick a longer one.
 *
 * @param {Record<string, any>} client
 * @param {{ workspaceFolder: string, workspaceFile?: string }} ctx
 * @param {unknown} rawId
 * @returns {Promise<{ ok: true, item: Record<string, any> } | { ok: false, code: string, matches?: Record<string, any>[] }>}
 */
export async function resolveTodoIdOrPrefix(client, ctx, rawId) {
  const requested = String(rawId || '').trim();
  if (!requested) return { ok: false, code: 'NOT_FOUND' };
  // Bounded point read when the client offers it; otherwise the legacy list scan.
  if (typeof client?.resolveTodo === 'function') {
    return client.resolveTodo({ workspaceFolder: ctx.workspaceFolder, workspaceFile: ctx.workspaceFile, todoId: requested });
  }
  return resolveTodoIdOrPrefixLegacy(client, ctx, requested);
}

/**
 * Legacy resolution over the whole list (parity reference and fallback).
 *
 * @param {Record<string, any>} client
 * @param {{ workspaceFolder: string, workspaceFile?: string }} ctx
 * @param {string} requested
 * @returns {Promise<{ ok: true, item: Record<string, any> } | { ok: false, code: string, matches?: Record<string, any>[] }>}
 */
export async function resolveTodoIdOrPrefixLegacy(client, ctx, requested) {
  const items = await loadWholeTodoList(client, ctx);
  const exact = items.find((row) => String(row?.id || '') === requested);
  if (exact) return { ok: true, item: exact };
  const prefix = requested.toLowerCase();
  if (prefix.length < TODO_ID_PREFIX_MIN_LENGTH) return { ok: false, code: 'NOT_FOUND' };
  const matches = items.filter((row) => String(row?.id || '').toLowerCase().startsWith(prefix));
  if (matches.length === 0) return { ok: false, code: 'NOT_FOUND' };
  if (matches.length > 1) return { ok: false, code: 'VALIDATION_ERROR', matches };
  return { ok: true, item: matches[0] };
}

/**
 * @param {unknown} rawId
 * @param {{ ok: false, code: string, matches?: Record<string, any>[] }} resolution
 * @returns {CretliMcpToolError}
 */
export function todoIdResolutionError(rawId, resolution) {
  const requested = String(rawId || '').trim();
  if (resolution.code === 'VALIDATION_ERROR') {
    const candidates = (resolution.matches || [])
      .map((row) => `${row.id} (${row.title || '(untitled)'})`)
      .join(', ');
    return new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `Todo id prefix "${requested}" matches more than one item: ${candidates}`,
    );
  }
  return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Todo not found: ${requested}`);
}

/**
 * @param {unknown} err
 * @returns {unknown}
 */
function mapTodoMoveError(err) {
  const code = /** @type {{ code?: string }} */ (err)?.code;
  const message = err instanceof Error ? err.message : String(err);
  const reasons = /** @type {{ reasons?: string[] }} */ (err)?.reasons;
  const detail = Array.isArray(reasons) && reasons.length > 0 ? `${message}:\n- ${reasons.join('\n- ')}` : message;
  if (code === TODO_MOVE_ERROR_CODES.NOT_FOUND) return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, detail);
  if (code === TODO_MOVE_ERROR_CODES.CONFLICT || code === TODO_MOVE_ERROR_CODES.HAS_HISTORY) {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.CONFLICT, detail);
  }
  if (code === TODO_MOVE_ERROR_CODES.VALIDATION) return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, detail);
  return err;
}

const HOLD_RELEASE_HINT = 'Set orchestrator_chat_id to an empty string to hand the todo back to the Watcher.';

/**
 * `watcher_held_by_orchestrator` warning for a write that leaves a ready leaf
 * owned by the calling chat, or null. Advisory only: the write already happened.
 *
 * @param {any} client
 * @param {{ chatId?: string, workspaceFolder?: string, workspaceFile?: string }} ctx
 * @param {Record<string, any>} item
 * @returns {Promise<{ code: string, text: string } | null>}
 */
async function buildWatcherHeldWarning(client, ctx, item) {
  const caller = String(ctx.chatId || '').trim();
  if (!caller || String(item?.status || '') !== 'ready') return null;
  if (String(item?.orchestratorChatId || '').trim() !== caller) return null;
  try {
    const rows = await client.listTodos({ workspaceFolder: ctx.workspaceFolder, workspaceFile: ctx.workspaceFile });
    if ((Array.isArray(rows) ? rows : []).some((row) => String(/** @type {any} */ (row)?.parentId || '') === String(item.id))) return null;
  } catch {
    // Not a leaf we can prove: stay silent rather than warn wrongly.
    return null;
  }
  return {
    code: 'watcher_held_by_orchestrator',
    text: `The Watcher will not start this todo while orchestrator_chat_id is set to this chat or while this chat is alive. ${HOLD_RELEASE_HINT}`,
  };
}

/**
 * `watcher_hold` for a ready leaf covered by the latest stored Watcher
 * decision. Reads the stored decision only; absent when the watcher is off or
 * no rejection names the leaf.
 *
 * @param {any} client
 * @param {{ workspaceFolder?: string }} ctx
 * @param {Record<string, any>} item
 * @returns {Promise<Record<string, string> | null>}
 */
async function readWatcherHold(client, ctx, item) {
  if (String(item?.status || '') !== 'ready' || typeof client?.workspaceWatcherLastDecision !== 'function') return null;
  try {
    const last = await client.workspaceWatcherLastDecision({ workspaceFolder: ctx.workspaceFolder });
    if (!last || last.enabled === false || !['observe', 'autopilot'].includes(String(last.mode || ''))) return null;
    const rejection = (Array.isArray(last.decision?.rejections) ? last.decision.rejections : [])
      .find((r) => String(r?.id || '') === String(item.id) && r.filter === 'tree_owned_by_live_orchestrator');
    if (!rejection) return null;
    return {
      code: 'tree_owned_by_live_orchestrator',
      owner_chat_id: String(rejection.ownerChatId || ''),
      owner_todo_id: String(rejection.ownerTodoId || ''),
      owner_reason: String(rejection.ownerReason || ''),
      decided_at: String(last.decision.at || ''),
    };
  } catch {
    return null;
  }
}


/** Restore a first-start status when chat preparation succeeded but delegation creation failed. */
async function restoreTodoStatusAfterStartFailure(client, workspaceFolder, originalTodo) {
  const originalStatus = String(originalTodo?.status || '');
  if (!['idea', 'ready'].includes(originalStatus) || typeof client?.updateTodo !== 'function') return;
  try {
    const todos = await client.listTodos({ workspaceFolder });
    const current = (Array.isArray(todos) ? todos : todos?.items || []).find((row) => row.id === originalTodo.id);
    if (current?.status !== 'doing') return;
    await client.updateTodo({
      workspaceFolder,
      todoId: originalTodo.id,
      expectedUpdatedAt: current.updatedAt,
      status: originalStatus,
    });
  } catch {
    // Preserve the delegation failure; cleanup is best-effort and CAS-protected.
  }
}

/**
 * Undo the chat a failed todo_start created: unlink it from the todo (restoring
 * the previous chat fields and status) and delete it. Best-effort; a reused chat
 * is never touched. The chat is deleted only when `deleteChat` is true (no
 * delegation record can exist) and the unlink succeeded. Returns the new chat id
 * whenever it is left behind (kept on purpose or a rollback step failed).
 */
async function rollbackTodoStartChat(client, workspaceFolder, originalTodo, started, { deleteChat = false } = {}) {
  const chatId = String(started?.chat?.id || '').trim();
  if (!chatId || started?.reused === true) {
    await restoreTodoStatusAfterStartFailure(client, workspaceFolder, originalTodo);
    return '';
  }
  let unlinked = true;
  try {
    const todos = await client.listTodos({ workspaceFolder });
    const current = (Array.isArray(todos) ? todos : todos?.items || []).find((row) => row.id === originalTodo.id);
    if (current && typeof client.updateTodo === 'function') {
      const originalStatus = String(originalTodo?.status || '');
      const patch = { workspaceFolder, todoId: originalTodo.id, expectedUpdatedAt: current.updatedAt };
      if (String(current.chatId || '') === chatId) patch.chatId = originalTodo.chatId || null;
      if (String(current.orchestratorChatId || '') === chatId) patch.orchestratorChatId = originalTodo.orchestratorChatId || '';
      if (current.status === 'doing' && ['idea', 'ready'].includes(originalStatus)) patch.status = originalStatus;
      if (Object.keys(patch).length > 3) await client.updateTodo(patch);
    }
  } catch {
    unlinked = false;
  }
  // Never delete a chat that is still linked or may own a delegation record.
  if (!unlinked || !deleteChat || typeof client.deleteChat !== 'function') return chatId;
  try {
    await client.deleteChat(chatId);
  } catch {
    return chatId;
  }
  return '';
}

/**
 * Legacy `todo_list` read: loads the whole workspace list and filters it. Kept as
 * the parity reference for the bounded path and for clients without
 * `readTodoList`.
 *
 * @param {Record<string, any>} client
 * @param {{ workspaceFolder: string }} ctx
 * @param {{ status: string, reviewFilter: any, needle: string, integrationFilter: string, offset: number, limit: number, policy: Record<string, any> | null }} q
 */
export async function readTodoListLegacy(client, ctx, q) {
  const items = attachTodoIntegrationReadModels(await loadWholeTodoList(client, { workspaceFolder: ctx.workspaceFolder }));
  const containerIds = collectContainerIds(items);
  const filtered = items.filter((item) => {
    if (q.status && /** @type {any} */ (item).status !== q.status) return false;
    if (!todoReviewMatchesFilter(item, containerIds.has(String(/** @type {any} */ (item)?.id || '')), q.reviewFilter)) return false;
    if (q.integrationFilter && /** @type {any} */ (item).integrationSummary?.state !== q.integrationFilter
      && /** @type {any} */ (item).integrationSummary?.detail !== q.integrationFilter) return false;
    if (!q.needle) return true;
    const hay = `${/** @type {any} */ (item).title || ''} ${/** @type {any} */ (item).body || ''}`.toLowerCase();
    return hay.includes(q.needle);
  });
  return {
    total: filtered.length,
    entries: filtered.slice(q.offset, q.offset + q.limit).map((item) => ({
      item,
      isContainer: containerIds.has(String(/** @type {any} */ (item)?.id || '')),
      executionState: readTodoExecutionState(items, item, q.policy),
    })),
  };
}

/** Bounded `todo_list` read through the todo repository (one window, exact total). */
async function readTodoListBounded(client, ctx, q) {
  return client.readTodoList({
    workspaceFolder: ctx.workspaceFolder,
    workspaceFile: ctx.workspaceFile,
    filter: { status: q.status, review: { subject: q.reviewFilter.subject, state: q.reviewFilter.state }, integration: q.integrationFilter, text: q.needle },
    offset: q.offset,
    limit: q.limit,
    policy: q.policy,
  });
}

/**
 * Legacy `todo_show` read (whole list in memory); parity reference.
 *
 * @param {Record<string, any>} client
 * @param {{ workspaceFolder: string, workspaceFile?: string }} ctx
 * @param {string} todoId
 * @param {{ offset: number, limit: number, policy: Record<string, any> | null }} q
 */
export async function readTodoShowLegacy(client, ctx, todoId, q) {
  const resolution = await resolveTodoIdOrPrefixLegacy(client, ctx, todoId);
  if (!resolution.ok) return resolution;
  const item = resolution.item;
  const workspaceItems = attachTodoIntegrationReadModels(await loadWholeTodoList(client, ctx));
  const readItem = workspaceItems.find((row) => String(/** @type {any} */ (row)?.id || '') === String(item.id)) || item;
  const children = workspaceItems
    .filter((row) => /** @type {any} */ (row).parentId === item.id)
    .sort((a, b) => (/** @type {any} */ (a).siblingIndex ?? 0) - (/** @type {any} */ (b).siblingIndex ?? 0));
  const followUps = workspaceItems.filter((row) => /** @type {any} */ (row).sourceTodoId === item.id);
  const containerIds = collectContainerIds(workspaceItems);
  const rowOf = (/** @type {any} */ child) => ({ item: child, isContainer: containerIds.has(String(child?.id || '')) });
  return {
    ok: /** @type {const} */ (true),
    item,
    readItem,
    children: children.map(rowOf),
    childrenPage: children.slice(q.offset, q.offset + q.limit).map((child) => ({
      ...rowOf(child),
      executionState: readTodoExecutionState(workspaceItems, child, q.policy),
    })),
    followUps: followUps.map((row) => ({ id: /** @type {any} */ (row).id, title: /** @type {any} */ (row).title })),
    approvedAncestor: findApprovedPlanAncestor(workspaceItems, item),
    executionState: readTodoExecutionState(workspaceItems, item, q.policy),
  };
}

/** Test seam: observes every execution-state evaluation done for a tool row. */
export const todoToolsTestHooks = { onExecutionState: /** @type {((item: Record<string, any>) => void) | null} */ (null) };

export const TODO_MCP_TOOLS = Object.freeze([
  {
    name: 'todo_list',
    readOnly: true,
    description: 'List TODO items for this chat workspace (not the UI global folder). Each row carries a compact server-computed `review` summary and the optional `review` filter narrows by it; the field is read-only and never set by an agent.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: `Filter: ${TODO_STATUSES.join(', ')}` },
        query: { type: 'string', description: 'Filter by title or body substring.' },
        review: { type: 'string', description: 'Filter by review state: a bare state (code subject) or subject:state (e.g. plan:none). States: none, pending, passed, failed, manual, stale, unknown.' },
        integration: { type: 'string', description: 'Filter by derived integration state: unconfirmed, awaiting, integrated, partial, rejected, conflict or no_code_changes.' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
        compact: { type: 'boolean', description: `Shorthand for fields=${TODO_LIST_COMPACT_FIELDS.join(',')} (title clipped to ${TODO_LIST_COMPACT_TITLE_CHARS} chars).` },
        fields: { type: 'array', items: { type: 'string' }, description: 'Project each row to these fields (for example id, status, title, parent_id). Unknown names are ignored; id is always kept. Titles are clipped when only projected fields are requested.' },
        max_chars: { type: 'number', description: `Hard cap on the serialized size of one page (default ${TODO_LIST_DEFAULT_MAX_CHARS}, max ${TODO_LIST_MAX_CHARS}). The page ends early with next_cursor when the next row would exceed it; always at least one row.` },
      },
    },
    async handler(args, { client, session }) {
      if (typeof client?.readTodoList !== 'function') requireClientMethod(client, 'listTodos');
      const ctx = resolveCretliToolContext(session);
      const status = args?.status == null || args?.status === '' ? '' : String(args.status).trim().toLowerCase();
      if (status && !TODO_STATUSES.includes(status)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `Invalid todo status "${args.status}"`);
      }
      const reviewFilter = parseTodoReviewFilter(args?.review);
      if (!reviewFilter.ok) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, /** @type {any} */ (reviewFilter).message);
      }
      const needle = String(args?.query || '').trim().toLowerCase();
      const integrationFilter = String(args?.integration || '').trim().toLowerCase();
      const validIntegrationFilters = new Set(['unconfirmed', 'awaiting', 'integrated', 'partial', 'rejected', 'conflict', 'no_code_changes']);
      if (integrationFilter && !validIntegrationFilters.has(integrationFilter)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `Invalid integration filter "${integrationFilter}"`);
      }
      const policy = readWatcherPolicy(ctx.workspaceFolder);
      const offset = decodeListCursor(args?.cursor);
      const limit = clampListLimit(args?.limit);
      const read = typeof client.readTodoList === 'function' ? readTodoListBounded : readTodoListLegacy;
      const { entries, total } = await read(client, ctx, { status, reviewFilter, needle, integrationFilter, offset, limit, policy });
      const fields = resolveTodoListFields(args);
      const maxChars = clampTodoListMaxChars(args?.max_chars);
      const rows = [];
      const lines = [];
      let used = 0;
      let consumed = 0;
      for (const entry of entries) {
        const full = summarizeTodo(entry.item, { executionState: entry.executionState, isContainer: entry.isContainer });
        const row = fields ? projectTodoRow(full, fields) : full;
        const line = formatTodoLine(full, { compact: Boolean(fields) });
        const cost = JSON.stringify(row).length + line.length + 2;
        // Hard size cap: stop before the row that would overflow, but never return an empty page.
        if (rows.length > 0 && used + cost > maxChars) break;
        rows.push(row);
        lines.push(line);
        used += cost;
        consumed += 1;
      }
      const nextOffset = offset + consumed;
      const nextCursor = nextOffset < total ? String(nextOffset) : '';
      const text = rows.length === 0 ? '(no todos)' : lines.join('\n');
      return mcpToolResult(text, { items: rows, next_cursor: nextCursor, total, ...(nextCursor && consumed < Math.min(limit, total - offset) ? { truncated_by_size: true } : {}) });
    },
  },
  {
    name: 'todo_show',
    readOnly: true,
    description: 'Show one TODO given its full id or a unique id prefix (>= 8 chars): paginated body/plan, ordered children, plan approval, chats, and recent changelog. A `cretli-ref todo=<id>` line means load this task; executing a parent means orchestrating all descendants with implementation and review subchats. When the body/plan page is truncated, follow the `next_cursor` line with cursor=... until truncated is false; use children_cursor for further children. The response includes the server-written `review` block (per-subject state: none, pending, passed, failed, manual, stale, unknown). `passed` means an independent reviewer PASSed with satisfied verify and no implement/fix was queued after it; `manual` appears only after a human accepted a review attempt in the UI. A plan review is not a code review. Check it before closing a leaf.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or a unique id prefix of at least 8 characters.' },
        field: { type: 'string', description: 'body (default) or plan' },
        cursor: { type: 'string', description: 'Opaque page cursor from `next_cursor` of a truncated body/plan page. It is bound to the todo revision and field; a malformed cursor is a VALIDATION_ERROR and a stale one is a CONFLICT.' },
        children_cursor: { type: 'string', description: 'Offset from next_children_cursor to read more direct children.' },
      },
      required: ['todo_id'],
    },
    async handler(args, { client, session }) {
      if (typeof client?.readTodoShow !== 'function') requireClientMethod(client, 'listTodos');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      if (!todoId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'todo_id is required');
      }
      const policy = readWatcherPolicy(ctx.workspaceFolder);
      const childrenOffset = decodeListCursor(args?.children_cursor);
      const childrenLimit = clampListLimit(undefined);
      const model = typeof client.readTodoShow === 'function'
        ? await client.readTodoShow({ workspaceFolder: ctx.workspaceFolder, workspaceFile: ctx.workspaceFile, todoId, childrenOffset, childrenLimit, policy })
        : await readTodoShowLegacy(client, ctx, todoId, { offset: childrenOffset, limit: childrenLimit, policy });
      if (!model.ok) throw todoIdResolutionError(todoId, /** @type {any} */ (model));
      const { item, readItem, approvedAncestor } = model;
      const children = model.children.map((entry) => entry.item);
      const followUps = model.followUps;
      const nextChildrenOffset = childrenOffset + model.childrenPage.length;
      const childrenPage = { next_cursor: nextChildrenOffset < children.length ? String(nextChildrenOffset) : '' };
      const isContainer = children.length > 0;
      const childRows = model.childrenPage.map((child) => summarizeTodo(child.item, {
        executionState: child.executionState,
        isContainer: child.isContainer,
      }));
      const review = buildTodoReviewReadModel(item, { children });
      const watcherHold = children.length === 0 ? await readWatcherHold(client, ctx, readItem) : null;
      const field = String(args?.field || 'body').trim() || 'body';
      if (field !== 'body' && field !== 'plan') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'field must be body or plan');
      }
      const revision = String(item.updatedAt || '');
      const source = field === 'plan' ? (item.plan?.markdown || '') : (item.body || '');
      const page = paginateDetail(source, { cursor: args?.cursor, revision, field });
      const assignee = item.assignee
        ? `${item.assignee.harness}${item.assignee.model ? `:${item.assignee.model}` : ''} (${item.assignee.role})`
        : '-';
      const chats = Array.isArray(item.chats) ? item.chats : [];
      const chatSummary = chats.length === 0
        ? '-'
        : chats
          .map((row) => `${row.roles.join('/')}:${String(row.id).slice(0, 8)}${row.deleted ? '(deleted)' : ''}`)
          .join(' ');
      const text = [
        `# ${item.title} (${item.id})`,
        `status: ${item.status}  updated: ${item.updatedAt}`,
        `execution_state: ${model.executionState}`,
        `chat: ${item.chatId || '-'}  parent: ${item.parentId || '-'}  run_mode: ${item.runMode || 'sequential'}`,
        `execution_mode: ${item.executionMode || 'inherit'}`,
        ...(item.sourceTodoId ? [`source_todo: ${item.sourceTodoId}`] : []),
        ...(followUps.length ? [`follow_ups: ${followUps.map((row) => `${String(row.id).slice(0, 8)} ${row.title}`).join('; ')}`] : []),
        `execution_protocol_path: ${resolveProjectPath('lib', 'todo-execution-prompt.js')}`,
        `chats: ${chatSummary}`,
        `assignee: ${assignee}`,
        `plan: ${String(item.plan?.markdown || '').trim() ? (item.plan?.approvedAt ? 'approved' : 'awaiting approval') : 'none'}`,
        formatTodoPlanGateLine(item, approvedAncestor),
        formatTodoReviewLine(review),
        ...(watcherHold ? [`watcher_hold: ${watcherHold.owner_reason || '-'} owner chat=${watcherHold.owner_chat_id || '-'} todo=${watcherHold.owner_todo_id || '-'}. ${HOLD_RELEASE_HINT}`] : []),
        formatTodoLeafMaterialDiagnostics(item),
        formatTodoIntegrationLine(/** @type {any} */ (readItem).integrationSummary),
        `children: ${children.length}`,
        ...childRows.map((row) => formatTodoLine(row)),
        ...(childrenPage.next_cursor ? [`More children: call todo_show with children_cursor="${childrenPage.next_cursor}".`] : []),
        `field: ${field}`,
        ...(page.truncated ? [`truncated=true next_cursor=${page.next_cursor}`] : []),
        page.text,
        ...(children.length ? [
          'When the user requests execution of this parent, read execution_protocol_path and follow its TODO_EXECUTION_WORKFLOW for the entire subtree. Respect human plan approval. Inspection or planning alone does not authorize execution.',
        ] : []),
      ].join('\n');
      return mcpToolResult(text, {
        item: {
          ...summarizeTodo(readItem, { isContainer, executionState: model.executionState }),
          plan_gate: resolvePlanGate(item, approvedAncestor),
          ...(approvedAncestor ? { plan_approved_by_ancestor: approvedAncestor } : {}),
          chats,
          review,
          ...(watcherHold ? { watcher_hold: watcherHold } : {}),
          takeovers: item.takeovers || [],
          children: childRows,
          children_count: children.length,
          field,
          [field]: page.text,
          changelog: Array.isArray(item.changelog) ? item.changelog.slice(-10) : [],
        },
        truncated: page.truncated,
        next_cursor: page.next_cursor,
        next_children_cursor: childrenPage.next_cursor,
        execution_protocol_path: resolveProjectPath('lib', 'todo-execution-prompt.js'),
        revision,
      });
    },
  },
  {
    name: 'todo_create',
    readOnly: false,
    description: 'Create a TODO in this workspace and record the calling chat. Does not start an agent. Replay with the same idempotency_key.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', description: `One of ${TODO_STATUSES.join(', ')}. deferred = parked on purpose; never picked up by todo_next_ready or the Watcher until an explicit patch restores it to idea or ready.` },
        priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low', 'background'], description: 'Optional scheduling priority; perf-tagged todos default to high.' },
        deferred_until: { type: 'string', description: 'Optional ISO date; only meaningful with status deferred.' },
        deferred_reason: { type: 'string', description: 'Optional reason (max 500 chars); only meaningful with status deferred.' },
        parent_id: { type: 'string', description: 'Optional parent TODO id — makes this a subtask.' },
        sibling_index: { type: 'number', description: 'Position inside the sibling group (>= 0). Default: first for roots, last for children.' },
        assignee: ASSIGNEE_SCHEMA,
        run_mode: { type: 'string', description: 'sequential (default) or explicit parallel — how this node runs its children. Parent status follows its children.' },
        non_blocking: { type: 'boolean', description: 'Opt-in: while this todo is idea, later siblings in a sequential tree are not held back by it. Default false.' },
        execution_mode: { type: 'string', description: 'Per-leaf execution folder override: inherit (default), worktree or project. Watcher worktree mode only applies when the workspace enables it.' },
        reviewer_pair: { type: 'object', description: 'Per-todo reviewer pair override { enabled?: boolean, members?: [{harness, model}, {harness, model}] }. enabled:true with two members forces that pair for this todo; enabled:false disables the pool for this todo even when the workspace enables it; absent/empty keeps workspace behavior.', properties: { enabled: { type: 'boolean' }, members: { type: 'array', items: { type: 'object', properties: { harness: { type: 'string' }, model: { type: 'string' } }, required: ['harness', 'model'] } } } },
        orchestrator_chat_id: { type: 'string', description: 'Chat that orchestrates this subtree (separate from the node chat).' },
        source_todo_id: { type: 'string', description: 'Todo this one originates from (follow-up, out-of-scope finding, preexisting failure). Full id; shown as a link on both todos.' },
        idempotency_key: { type: 'string' },
      },
      required: ['title', 'idempotency_key'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'createTodo');
      if (Object.hasOwn(args || {}, 'feedbackOrigin') || Object.hasOwn(args || {}, 'feedback_origin')) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'Feedback origin is server-managed');
      }
      const ctx = resolveCretliToolContext(session);
      const title = String(args?.title || '').trim();
      const idempotencyKey = String(args?.idempotency_key || '').trim();
      if (!title) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'title is required');
      }
      if (!idempotencyKey) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'idempotency_key is required');
      }
      const result = await client.createTodo({
        workspaceFolder: ctx.workspaceFolder,
        title,
        body: args?.body,
        status: args?.status,
        priority: args?.priority,
        deferredUntil: args?.deferred_until,
        deferredReason: args?.deferred_reason,
        parentId: args?.parent_id,
        siblingIndex: args?.sibling_index,
        assignee: args?.assignee,
        runMode: args?.run_mode,
        nonBlocking: args?.non_blocking,
        executionMode: args?.execution_mode,
        reviewerPair: args?.reviewer_pair,
        orchestratorChatId: args?.orchestrator_chat_id,
        sourceTodoId: args?.source_todo_id,
        createdByChatId: ctx.chatId || undefined,
        sourceHarness: ctx.harness || undefined,
        idempotencyKey,
      });
      const item = result.item || result;
      // A leaf in a parallel group without a declared `## Leaf scope` is held
      // back while any sibling runs; say so at creation time (hint, not a block).
      let hint = '';
      const parentId = String(args?.parent_id || '').trim();
      if (parentId && !bodyDeclaresLeafScope(args?.body)) {
        try {
          const parent = await resolveTodoIdOrPrefix(client, ctx, parentId);
          if (parent.ok && (parent.item?.runMode === 'parallel' || args?.run_mode === 'parallel')) {
            hint = 'parallel_scope_unknown: this leaf sits in a parallel group but its body has no "## Leaf scope" section (bullet list of files/dirs). Without it the Watcher holds the leaf while any sibling is doing. Add the section via todo_update.';
          }
        } catch {
          // The hint is advisory; a lookup failure must not fail the create.
        }
      }
      const bodyCut = describeBodyTruncation(args?.body);
      const heldWarning = await buildWatcherHeldWarning(client, ctx, item);
      // `warning` stays the scope hint string unless the hold warning is also
      // present; then the hold takes `warning` and the hint moves to `scope_warning`.
      return mcpToolResult(
        `${result.replayed ? 'Replayed' : 'Created'} TODO ${item.title} (${item.id})${bodyTruncationNotice(bodyCut)}${hint ? `\nWARNING: ${hint}` : ''}${heldWarning ? `\nWARNING ${heldWarning.code}: ${heldWarning.text}` : ''}`,
        {
          item: summarizeTodo(item),
          replayed: result.replayed === true,
          ...bodyTruncationFields(bodyCut),
          ...(heldWarning ? { warning: heldWarning, ...(hint ? { scope_warning: hint } : {}) } : (hint ? { warning: hint } : {})),
        },
      );
    },
  },
  {
    name: 'todo_start',
    readOnly: false,
    description: 'Start a TODO through the manual workspace start path. Prepares the selected worktree first, freezes it on the TODO orchestrator chat, then starts the orchestrator delegation. A tree root (TODO with children) needs CRETLI_DELEGATION_MAX_DEPTH >= 2 because its orchestrator runs as a depth-1 delegation child; with a lower limit no delegation is started and the result has orchestrator=true, delegation=null, a warning and next_step: run the returned initial_prompt in the returned chat_id (a depth-0 chat can delegate). For automatic orchestrator starts, call model_pick with chat_id set to the linked orchestrator chat and pass its pick_id together with the selected harness/model. Pass execution_mode=worktree to force worktree preparation for this start. Pass execution_mode=project to run in the project folder; if the tree already owns a worktree the start is refused unless release_worktree=true. Pass force_new=true to continue the TODO in a fresh orchestrator chat (the Todo panel "Continue in a new chat" action): the existing worktree is reused and the previous chats stay linked; every call creates another chat, so do not retry it blindly. Use model_list first and provide the selected harness/model.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full TODO id or unique prefix (at least 8 characters).' },
        harness: { type: 'string', description: 'Enabled harness to run the TODO orchestrator.' },
        model: { type: 'string', description: 'Enabled model id for the selected harness.' },
        pick_id: { type: 'string', description: 'Current model_pick proposal for the TODO orchestrator chat. Required for automatic orchestrator starts; obtain it with model_pick using the linked orchestrator chat_id.' },
        execution_mode: { type: 'string', enum: ['worktree', 'project'], description: 'Optional explicit execution folder choice. worktree is created and prepared before the agent starts.' },
        force_new: { type: 'boolean', description: 'true = always create a fresh orchestrator chat instead of reusing the linked one (default false).' },
        release_worktree: { type: 'boolean', description: 'With execution_mode=project: release the tree\'s existing worktree (kept on disk, record closed) and run in the project folder. Without it a frozen worktree makes the start fail with a conflict. Refused while a chat of the tree has a live run.' },
        idempotency_key: { type: 'string', description: 'Stable key for this start request.' },
      },
      required: ['todo_id', 'harness', 'model', 'idempotency_key'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'startTodoAgent');
      requireClientMethod(client, 'startDelegation');
      const ctx = resolveCretliToolContext(session);
      const resolution = await resolveTodoIdOrPrefix(client, ctx, args?.todo_id);
      if (!resolution.ok) throw todoIdResolutionError(args?.todo_id, /** @type {any} */ (resolution));
      const todo = resolution.item;
      const harness = String(args?.harness || '').trim();
      const model = String(args?.model || '').trim();
      const pickId = String(args?.pick_id || '').trim();
      const idempotencyKey = String(args?.idempotency_key || '').trim();
      const executionMode = String(args?.execution_mode || '').trim();
      if (!harness || !model || !idempotencyKey || !pickId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'harness, model, pick_id, and idempotency_key are required');
      }
      if (executionMode && !['worktree', 'project'].includes(executionMode)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'execution_mode must be worktree or project');
      }
      requireClientMethod(client, 'listTodos');
      const allTodos = await client.listTodos({ workspaceFolder: ctx.workspaceFolder, workspaceFile: ctx.workspaceFile });
      const planOnly = isFeedbackDerivedTodo(allTodos, todo) && !String(todo.plan?.approvedAt || '').trim();
      let started;
      try {
        started = await client.startTodoAgent({
          workspaceFolder: ctx.workspaceFolder,
          todoId: String(todo.id),
          body: {
            model,
            agentTransport: harness,
            ...(planOnly ? { mode: 'refine' } : {}),
            executionMode,
            forceNew: args?.force_new === true,
            releaseWorktree: args?.release_worktree === true,
            workspaceFile: ctx.workspaceFile,
            workspaceFolder: ctx.workspaceFolder,
          },
        });
      } catch (error) {
        const message = String(error?.message || error?.code || error?.key || 'TODO start failed');
        throw new CretliMcpToolError(
          error?.status === 409 ? MCP_BUILTIN_ERROR_CODES.CONFLICT : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          message,
          { reason: String(error?.code || '') },
        );
      }
      const chatId = String(started?.chat?.id || '').trim();
      if (!chatId) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.CONFLICT, 'TODO workspace was prepared but its orchestrator chat is missing.');
      const todoIdStr = String(todo.id);
      const hasChildren = allTodos.some((row) => String(row?.parentId || '') === todoIdStr);
      const maxDepth = resolveDelegationMaxDepth(resolveDelegationEnv(ctx.workspaceFolder));
      const depthInfo = { max_depth: maxDepth, depth: 1, remaining_depth: remainingDelegationDepth({ depth: 1, maxDepth }) };
      if (hasChildren && maxDepth < 2) {
        // The orchestrator would be a depth-1 delegation child and could never call
        // delegation_start (depth_exceeded). Hand the prepared chat back instead.
        const warning = `Tree root orchestrator was NOT started: CRETLI_DELEGATION_MAX_DEPTH=${maxDepth} (needs >= 2) so a delegation child could not delegate.`;
        const nextStep = `Run the returned initial_prompt in orchestrator chat ${chatId} (a depth-0 chat can delegate), or raise CRETLI_DELEGATION_MAX_DEPTH to >= 2 and call todo_start again.`;
        return mcpToolResult(
          `WARNING: ${warning}\nNEXT: ${nextStep}\nTODO ${todo.title} (${todo.id}) is prepared; orchestrator chat=${chatId} (${started.reused ? 'reused' : 'new'}), no delegation started.`,
          {
            todo: summarizeTodo(started.todo || todo),
            orchestrator: true,
            chat_id: chatId,
            chat_reused: started.reused === true,
            execution_folder: started.executionFolder || ctx.workspaceFolder,
            worktree: started.worktree === true,
            delegation: null,
            initial_prompt: String(started.initialPrompt || ''),
            ...depthInfo,
            warning,
            next_step: nextStep,
          },
        );
      }
      let delegation;
      try {
        delegation = await client.startDelegation({
          chatId,
          workspaceFolder: ctx.workspaceFolder,
          harness,
          model,
          pickId,
          idempotencyKey,
          sourceKind: 'text',
          taskText: String(started.initialPrompt || ''),
          executionMode: 'agent',
          assignment: 'implement',
          requestedRole: planOnly ? 'plan' : 'implement',
          leafId: String(todo.id),
          allowChildDelegations: true,
          returnWhenStarting: true,
        });
      } catch (error) {
        // The throw leaves the delegation state unknown: unlink but keep the chat.
        const leftover = await rollbackTodoStartChat(client, ctx.workspaceFolder, todo, started);
        if (leftover && error && typeof error === 'object') error.orphanChatId = leftover;
        throw error;
      }
      if (!delegation?.ok) {
        const hasRecord = !!(delegation?.delegation?.id || delegation?.id);
        const leftover = await rollbackTodoStartChat(client, ctx.workspaceFolder, todo, started, { deleteChat: !hasRecord });
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.CONFLICT,
          delegation?.error || 'TODO delegation failed to start.',
          leftover ? { orphan_chat_id: leftover } : undefined,
        );
      }
      return mcpToolResult(
        `Started TODO ${todo.title} (${todo.id}) in ${started.worktree ? 'worktree' : 'project'} mode; orchestrator chat=${chatId} (${started.reused ? 'reused' : 'new'}), delegation=${delegation.delegation?.id || ''}`,
        { todo: summarizeTodo(started.todo || todo), chat_id: chatId, chat_reused: started.reused === true, execution_folder: started.executionFolder || ctx.workspaceFolder, worktree: started.worktree === true, delegation: delegation.delegation || null, ...(hasChildren ? { orchestrator: true } : {}), ...depthInfo },
      );
    },
  },
  {
    name: 'todo_update',
    readOnly: false,
    description: 'Update TODO title, body, status, or tree fields (parent_id, sibling_index, assignee, run_mode, execution_mode). Accepts a full id or a unique id prefix (>= 8 chars). A `cretli-ref todo=<id>` line means call todo_show first and continue the task. Requires expected_updated_at from todo_show. The server may write the todo again shortly after a status change, so a later CAS operation requires a fresh read. The `review` field is server-written: a patch carrying `review` is rejected and it cannot be set or cleared through this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or a unique id prefix of at least 8 characters.' },
        expected_updated_at: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            body_append: { type: 'string', description: 'Text appended to the existing body (joined with a blank line). The server reads the current body itself; do not combine with body.' },
            status: { type: 'string', description: `One of ${TODO_STATUSES.join(', ')}. A deferred todo is only restored by an explicit patch to idea or ready (never straight to doing/done).` },
            priority: { type: 'string', enum: ['', 'urgent', 'high', 'normal', 'low', 'background'], description: 'Scheduling priority; empty string clears the override.' },
            deferred_until: { type: 'string', description: 'ISO date for a deferred todo; empty string clears it.' },
            deferred_reason: { type: 'string', description: 'Reason for a deferred todo (max 500 chars); empty string clears it.' },
            move_to_later: { description: 'With status deferred on a leaf: true moves it under the shared "Na później" root (created once); a string id moves it under that root. The old parent is kept in source_todo_id.' },
            restore_to_tree: { type: 'boolean', description: 'Moves a parked leaf back under its old parent (source_todo_id) if it still exists.' },
            parent_id: { type: 'string', description: 'Move under this parent; empty string moves back to root.' },
            sibling_index: { type: 'number', description: 'Position inside the sibling group (>= 0).' },
            assignee: { ...ASSIGNEE_SCHEMA, description: `${ASSIGNEE_SCHEMA.description} Send {"harness":"","role":""} to clear.` },
            run_mode: { type: 'string', description: 'sequential (default) or explicit parallel; empty string restores the default.' },
            non_blocking: { type: 'boolean', description: 'Opt-in: while this todo is idea, later siblings in a sequential tree are not held back by it. false clears it.' },
            execution_mode: { type: 'string', description: 'Per-leaf execution folder override: inherit, worktree or project; empty string restores inherit.' },
            reviewer_pair: { type: 'object', description: 'Per-todo reviewer pair override { enabled?: boolean, members?: [{harness, model}, {harness, model}] }. enabled:true with two members forces that pair for this todo; enabled:false disables the pool for this todo even when the workspace enables it; an empty object clears the override and keeps workspace behavior.', properties: { enabled: { type: 'boolean' }, members: { type: 'array', items: { type: 'object', properties: { harness: { type: 'string' }, model: { type: 'string' } }, required: ['harness', 'model'] } } } },
            orchestrator_chat_id: { type: 'string', description: 'Chat that orchestrates this subtree; empty string clears it.' },
            source_todo_id: { type: 'string', description: 'Todo this one originates from (follow-up link); empty string clears it.' },
            watcher_phases: { type: 'object', description: 'Per-todo override of the watcher phase scope: partial { plan, review, implement, integrate } booleans; {} clears it. An override can only turn a phase off (AND with the workspace policy); it never enables a disabled phase and never approves a plan.' },
            plan: {
              type: 'object',
              description: 'Draft plan only: { markdown }. Never set approvedAt (human approval is UI-only).',
              properties: {
                markdown: { type: 'string', description: 'Plan body markdown (draft).' },
              },
            },
          },
        },
      },
      required: ['todo_id', 'patch', 'expected_updated_at'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'updateTodo');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      const expectedUpdatedAt = String(args?.expected_updated_at || '').trim();
      const patch = args?.patch && typeof args.patch === 'object' ? /** @type {any} */ (args.patch) : null;
      if (!todoId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'todo_id is required');
      }
      if (!expectedUpdatedAt) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'expected_updated_at is required');
      }
      if (!patch) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'patch is required');
      }
      const extra = Object.keys(patch).filter((key) => !TODO_PATCH_KEYS.has(key));
      if (extra.length > 0) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `Unsupported patch fields: ${extra.join(', ')}`);
      }
      if (patch.plan != null) {
        if (typeof patch.plan !== 'object' || Array.isArray(patch.plan)) {
          throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'patch.plan must be an object');
        }
        const planKeys = Object.keys(patch.plan);
        const illegalPlanKeys = planKeys.filter((key) => key !== 'markdown');
        if (illegalPlanKeys.length > 0) {
          throw new CretliMcpToolError(
            MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
            `patch.plan may only include markdown (not ${illegalPlanKeys.join(', ')})`,
          );
        }
        if (patch.plan.markdown == null) {
          throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'patch.plan.markdown is required when plan is set');
        }
      }
      const resolution = await resolveTodoIdOrPrefix(client, ctx, todoId);
      if (!resolution.ok) throw todoIdResolutionError(todoId, /** @type {any} */ (resolution));
      const current = resolution.item;
      patch.body = resolveBodyPatch(patch, current);
      const nextStatus = patch.status == null ? '' : String(patch.status).trim().toLowerCase();
      const item = await client.updateTodo({
        workspaceFolder: ctx.workspaceFolder,
        workspaceFile: ctx.workspaceFile,
        todoId: String(current.id),
        expectedUpdatedAt,
        title: patch.title,
        body: patch.body,
        status: patch.status,
        priority: patch.priority,
        deferredUntil: patch.deferred_until,
        deferredReason: patch.deferred_reason,
        parentId: patch.parent_id,
        siblingIndex: patch.sibling_index,
        assignee: patch.assignee,
        runMode: patch.run_mode,
        nonBlocking: patch.non_blocking,
        executionMode: patch.execution_mode,
        reviewerPair: patch.reviewer_pair,
        orchestratorChatId: patch.orchestrator_chat_id,
        sourceTodoId: patch.source_todo_id,
        moveToLater: patch.move_to_later,
        restoreToTree: patch.restore_to_tree,
        watcherPhases: patch.watcher_phases,
        linkedChatId: ctx.chatId || undefined,
        // Identity for the review gate (D2); the remote client ignores it and
        // relies on the bearer token.
        callerChatId: ctx.chatId || undefined,
        plan: patch.plan ? {
          markdown: String(patch.plan.markdown || ''),
          sourceChatId: ctx.chatId || undefined,
        } : undefined,
        appendChangelog: nextStatus && nextStatus !== current.status
          ? { kind: 'note', text: `status: ${current.status}→${nextStatus}`, chatId: ctx.chatId || undefined }
          : undefined,
      });
      if (!item) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Todo not found: ${todoId}`);
      }
      const bodyCut = describeBodyTruncation(patch.body);
      const heldWarning = await buildWatcherHeldWarning(client, ctx, item);
      return mcpToolResult(
        `Updated TODO ${item.title} (${item.id})${bodyTruncationNotice(bodyCut)}${heldWarning ? `\nWARNING ${heldWarning.code}: ${heldWarning.text}` : ''}`,
        { item: summarizeTodo(item), ...bodyTruncationFields(bodyCut), ...(heldWarning ? { warning: heldWarning } : {}) },
      );
    },
  },
  {
    name: 'todo_integration',
    readOnly: false,
    description: 'Record TODO integration evidence (target-branch proof). Actions: prepare (refuses done/proven todos, preserves task status, builds the worktree result patch so integration reaches awaiting; touches neither the project folder nor git history; no reason or proof), confirm (proof.simple=true derives branch/HEAD from the workspace, or pass target_branch + target_commit + change_ref + change_attested), invalidate (needs reason), no_code (done TODO without code changes, needs reason), reject (needs reason). Requires expected_updated_at from a fresh todo_show; after a status change, read it again. Never commits, merges or pushes. `confirm` is a human attestation: only call it when the user asked you to and the changes were verified in the target branch (`git branch --contains`). `done` or review PASS alone is not proof. A CONFLICT reports the current updated_at so it can be retried.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or a unique id prefix of at least 8 characters.' },
        action: { type: 'string', description: 'prepare, confirm, invalidate, no_code or reject.' },
        expected_updated_at: { type: 'string' },
        reason: { type: 'string', description: 'Required for invalidate, no_code and reject.' },
        proof: {
          type: 'object',
          description: 'confirm only.',
          properties: {
            commit: { type: 'string', description: 'Operator-authorized assertion: full or abbreviated integration commit SHA on the workspace current branch; derives task/tree proof and closes the task. Supports squash. Descendants must already be done.' },
            simple: { type: 'boolean', description: 'Derive target branch and HEAD from the current workspace branch.' },
            target_branch: { type: 'string' },
            target_commit: { type: 'string', description: 'Full commit SHA.' },
            source_commit: { type: 'string' },
            material_revision: { type: 'string' },
            change_ref: { type: 'string' },
            change_attested: { type: 'boolean' },
            scope: { type: 'string', description: 'task or tree.' },
          },
        },
      },
      required: ['todo_id', 'action', 'expected_updated_at'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'recordTodoIntegration');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      const action = String(args?.action || '').trim().toLowerCase().replace('-', '_');
      const expectedUpdatedAt = String(args?.expected_updated_at || '').trim();
      if (!todoId || !expectedUpdatedAt) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'todo_id and expected_updated_at are required');
      }
      if (!['prepare', 'confirm', 'invalidate', 'no_code', 'reject'].includes(action)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'action must be prepare, confirm, invalidate, no_code or reject');
      }
      const resolution = await resolveTodoIdOrPrefix(client, ctx, todoId);
      if (!resolution.ok) throw todoIdResolutionError(todoId, /** @type {any} */ (resolution));
      // prepare has no revision CAS downstream; check the caller read the current todo.
      if (action === 'prepare' && String(resolution.item.updatedAt || '') !== expectedUpdatedAt) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.CONFLICT, 'TODO integration prepare failed: conflict (stale expected_updated_at; call todo_show again)', { reason: 'conflict' });
      }
      const p = args?.proof && typeof args.proof === 'object' ? /** @type {any} */ (args.proof) : {};
      const result = await client.recordTodoIntegration({
        workspaceFolder: ctx.workspaceFolder,
        todoId: String(resolution.item.id),
        action,
        expectedUpdatedAt,
        callerChatId: ctx.chatId || undefined,
        reason: String(args?.reason || '').trim(),
        proof: {
          commit: p.commit,
          targetBranch: p.target_branch,
          targetCommit: p.target_commit,
          sourceCommit: p.source_commit,
          materialRevision: p.material_revision,
          changeRef: p.change_ref,
          changeAttested: p.change_attested === true,
          scope: p.scope,
          simple: p.simple === true,
        },
      });
      if (!result?.ok) {
        const reason = String(result?.reason || 'integration failed');
        const code = ['conflict', 'not_ready', 'not_done', 'integration_ready', 'already_integrated', 'target_commit_not_on_branch', 'target_ref_missing', 'material_revision_mismatch', 'already_applied', 'busy', 'integration_locked', 'no_worktree', 'git_ownership'].includes(reason)
          ? MCP_BUILTIN_ERROR_CODES.CONFLICT
          : reason === 'not_found' ? MCP_BUILTIN_ERROR_CODES.NOT_FOUND : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR;
        const hints = {
          git_ownership: 'Git refused the repository because another user owns it; this is a server environment problem, not a wrong proof. Ask the user before changing global git config.',
          material_revision_mismatch: 'Do not call prepare again; use proof.simple=true. If the material changed after the cycle, start a new cycle.',
          integration_ready: 'The TODO has a patch; use confirm, not no_code.',
          not_done: 'First use todo_update with status:done, then read the TODO again with todo_show.',
          already_integrated: 'Nothing needs doing; use invalidate only deliberately.',
          expected_revision_required: 'Provide expected_updated_at from todo_show.',
          integration_locked: 'Another integration is in progress; wait and retry.',
          reason_required: 'Provide reason.',
        };

        if (reason === 'conflict' && result.currentUpdatedAt) {
          const targetId = String(result.targetTodoId || resolution.item.id);
          const targetShort = targetId.slice(0, 8);
          const ancestor = targetId !== String(resolution.item.id)
            ? ` Integration is recorded on ancestor ${targetShort} that owns the worktree; its updated_at is the one that counts.`
            : '';
          throw new CretliMcpToolError(
            code,
            `TODO integration ${action} failed: stale expected_updated_at for ${targetShort} (you sent ${expectedUpdatedAt}, current is ${result.currentUpdatedAt}). The server may write a todo again shortly after a status change; retry with expected_updated_at=${result.currentUpdatedAt}.${ancestor}`,
            { reason, current_updated_at: result.currentUpdatedAt, expected_updated_at: expectedUpdatedAt, target_todo_id: targetId },
          );
        }
        const hint = hints[reason] ? ` (${hints[reason]})` : '';
        const detail = String(result?.detail || '').trim();
        throw new CretliMcpToolError(code, `TODO integration ${action} failed: ${reason}${detail ? `: ${detail}` : ''}${hint}`, { reason, ...(detail ? { detail } : {}) });
      }
      const [read] = attachTodoIntegrationReadModels(result.item ? [result.item] : []);
      return mcpToolResult(
        `TODO ${resolution.item.title} (${String(resolution.item.id).slice(0, 8)}): integration ${action} ok`,
        { item: summarizeTodo(read || result.item || resolution.item) },
      );
    },
  },
  {
    name: 'smart_merge_report',
    readOnly: false,
    description: 'Report the outcome of a smart-merge / git-branch merge run (the MCP twin of the curl callback in the merge prompt). outcome: merged or failed (+ one-line summary). Clears the running marker and releases the integration lock. For a bulk-integrate entry also pass the batch fields given in the prompt. It does not confirm integration: on merged you still call todo_integration confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or a unique id prefix of at least 8 characters.' },
        outcome: { type: 'string', description: 'merged or failed.' },
        summary: { type: 'string', description: 'One short line.' },
        batch: {
          type: 'object',
          description: 'Bulk-integrate entries only: { batchId, entryId, attempt, epoch, token } exactly as in the prompt.',
          properties: {
            batchId: { type: 'string' },
            entryId: { type: 'string' },
            attempt: { type: 'number' },
            epoch: { type: 'number' },
            token: { type: 'string' },
          },
        },
      },
      required: ['todo_id', 'outcome'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'reportSmartMergeOutcome');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      const outcome = String(args?.outcome || '').trim().toLowerCase();
      if (!todoId) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'todo_id is required');
      if (outcome !== 'merged' && outcome !== 'failed') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'outcome must be merged or failed');
      }
      const resolution = await resolveTodoIdOrPrefix(client, ctx, todoId);
      if (!resolution.ok) throw todoIdResolutionError(todoId, /** @type {any} */ (resolution));
      const result = await client.reportSmartMergeOutcome({
        workspaceFolder: ctx.workspaceFolder,
        todoId: String(resolution.item.id),
        outcome,
        summary: String(args?.summary || '').trim(),
        batch: args?.batch && typeof args.batch === 'object' ? /** @type {any} */ (args.batch) : undefined,
      });
      if (!result?.ok) {
        const reason = String(result?.reason || 'report failed');
        const code = reason === 'not_found' ? MCP_BUILTIN_ERROR_CODES.NOT_FOUND
          : ['not_ready', 'batch_context_invalid'].includes(reason) ? MCP_BUILTIN_ERROR_CODES.CONFLICT
            : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR;
        throw new CretliMcpToolError(code, `Smart merge report failed: ${reason}`, { reason });
      }
      return mcpToolResult(
        `TODO ${resolution.item.title} (${String(resolution.item.id).slice(0, 8)}): merge report ${outcome} recorded`,
        { ok: true, outcome, ...(result.confirmed ? { confirmed: true } : {}) },
      );
    },
  },
  {
    name: 'integrate_next',
    readOnly: false,
    description: 'Bulk integrate: ask for the next todo of a batch, or report a finished entry and get the next one (the MCP twin of the curl `next` call in the batch prompt). Pass batch_id, epoch and token exactly as in the prompt; add entry_id, attempt, outcome (merged, verified, no_code or failed) and summary to report. The answer action is entry, pending_confirm, resolved or stop; an error (invalid_token, stale_epoch, unknown_entry, stale_attempt, entry_not_running, batch_paused) also means stop.',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string' },
        epoch: { type: 'number' },
        token: { type: 'string', description: 'Batch capability token from the prompt.' },
        entry_id: { type: 'string', description: 'Report only: the finished entry.' },
        attempt: { type: 'number', description: 'Report only: the entry attempt.' },
        outcome: { type: 'string', description: 'Report only: merged, verified, no_code or failed.' },
        summary: { type: 'string', description: 'Report only: one short line.' },
      },
      required: ['batch_id', 'epoch', 'token'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'integrateBatchNext');
      const ctx = resolveCretliToolContext(session);
      const batchId = String(args?.batch_id || '').trim();
      if (!batchId) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'batch_id is required');
      const entryId = String(args?.entry_id || '').trim();
      const result = await client.integrateBatchNext({
        workspaceFolder: ctx.workspaceFolder,
        body: {
          batchId,
          epoch: args?.epoch,
          token: String(args?.token || ''),
          ...(entryId ? {
            entryId,
            attempt: args?.attempt,
            outcome: String(args?.outcome || ''),
            summary: String(args?.summary || ''),
          } : {}),
        },
      });
      const body = result?.body || {};
      if (!body.ok) {
        const reason = String(body.error || 'next failed');
        const code = result?.status === 404 ? MCP_BUILTIN_ERROR_CODES.NOT_FOUND
          : result?.status === 400 ? MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR
            : MCP_BUILTIN_ERROR_CODES.CONFLICT;
        throw new CretliMcpToolError(code, `Integrate batch next failed: ${reason} (stop)`, { reason, status: result?.status });
      }
      const entry = body.entry || null;
      const head = body.action === 'entry' && entry
        ? `Batch entry ${entry.position}/${entry.total}: ${entry.entryId} attempt ${entry.attempt} [${entry.mode}] ${entry.title}\n\n${entry.prompt}\n\n${entry.rules}`
        : `Batch action: ${body.action}${body.reason ? ` (${body.reason})` : ''}`;
      return mcpToolResult(head, body);
    },
  },
  {
    name: 'todo_move',
    readOnly: false,
    description: 'Move a TODO subtree from this chat workspace to another workspace (todos are stored per workspace default folder; two workspaces with the same default folder share one todo list). The node becomes a root in the target; ids, bodies, plans, changelogs and chat links are kept. Only a tree without run history moves: it is refused while any node is doing, claimed, integrated, has leaf material or a live worktree, or is referenced by a delegation. Requires expected_updated_at from todo_show. Only move when the user asked for it.',
    inputSchema: {
      type: 'object',
      properties: {
        todo_id: { type: 'string', description: 'Full todo id or a unique id prefix of at least 8 characters.' },
        expected_updated_at: { type: 'string' },
        target_workspace_folder: { type: 'string', description: 'Target workspace: a registered workspace id (a .code-workspace path or folder-workspace id from wsreg_list), resolved to the default folder its chats and todo panel use, or an absolute folder path. Do not guess the first folder of a .code-workspace; pass the workspace id instead.' },
      },
      required: ['todo_id', 'expected_updated_at', 'target_workspace_folder'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'moveTodoTree');
      const ctx = resolveCretliToolContext(session);
      const todoId = String(args?.todo_id || '').trim();
      const resolution = await resolveTodoIdOrPrefix(client, ctx, todoId);
      if (resolution.ok === false) throw todoIdResolutionError(todoId, /** @type {any} */ (resolution));
      const item = /** @type {{ id: string }} */ (resolution.item);
      try {
        const result = await client.moveTodoTree({
          workspaceFolder: ctx.workspaceFolder,
          todoId: String(item.id),
          expectedUpdatedAt: String(args?.expected_updated_at || '').trim(),
          targetWorkspaceFolder: String(args?.target_workspace_folder || '').trim(),
          chatId: ctx.chatId || undefined,
        });
        return mcpToolResult(
          `Moved ${result.movedIds.length} todo(s) "${result.root.title}" to ${result.targetFolder}`,
          { root_id: result.root.id, moved_ids: result.movedIds, target_workspace_folder: result.targetFolder },
        );
      } catch (err) {
        throw mapTodoMoveError(err);
      }
    },
  },
  {
    name: 'todo_next_ready',
    readOnly: true,
    description: 'List ready TODO leaves: not done/doing and not blocked (parent plan unapproved, or a sequential earlier sibling). Optional root_id limits to a subtree.',
    inputSchema: {
      type: 'object',
      properties: {
        root_id: { type: 'string', description: 'Limit results to this subtree.' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'listTodos');
      const ctx = resolveCretliToolContext(session);
      // Stays document-based on purpose: readiness (plan gates, sequential order, parallel scope,
      // source chains) is branch state that needs node-local facts first
      // (docs/todo-scalable-architecture.md section 3.3, phase 2).
      const items = await loadWholeTodoList(client, { workspaceFolder: ctx.workspaceFolder });
      const rootId = String(args?.root_id || '').trim();
      if (rootId && !items.some((row) => row?.id === rootId)) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Todo not found: ${rootId}`);
      }
      const ready = listReadyTodoLeaves(items, { rootId: rootId || undefined });
      const page = paginateList(ready, args);
      // Execution state is evaluated for the returned page only.
      const policy = page.items.length ? readWatcherPolicy(ctx.workspaceFolder) : null;
      const rows = page.items.map((entry) => summarizeTodo(entry, { items, policy }));
      const text = rows.length === 0 ? '(no ready todos)' : rows.map((row) => formatTodoLine(row)).join('\n');
      /** @type {Record<string, Record<string, any>>} */
      const parallelHints = {};
      const parentIds = new Set(
        ready.map((row) => String(/** @type {any} */ (row)?.parentId || '').trim()).filter(Boolean),
      );
      for (const parentId of parentIds) {
        const assessment = assessParallelRunModeForSiblings(items, parentId);
        parallelHints[parentId] = assessment.ok
          ? { parallel_safe: true }
          : { parallel_safe: false, collisions: /** @type {any} */ (assessment).collisions };
      }
      return mcpToolResult(text, {
        items: rows,
        next_cursor: page.next_cursor,
        parallel_scope: Object.keys(parallelHints).length ? parallelHints : undefined,
      });
    },
  },
]);
