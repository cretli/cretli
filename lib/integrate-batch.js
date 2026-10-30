/**
 * Bulk "integrate with agent": one agent chat integrates several todos strictly
 * one after another, each on top of the already integrated HEAD.
 *
 * The server owns the queue. The agent asks `next` for one entry at a time; the
 * entry's real prompt is built by the existing smart-merge / verify builders only
 * at that moment. Nothing here pushes, commits, kills a run or discards work.
 * See `docs/todo-integration-contract.md` (Bulk integrate).
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listTodos, updateTodo } from './persist/todos-store.js';
import { readWorktreeRegistry } from './persist/worktree-registry-persist.js';
import { isLiveWorktreeRecord } from './todo-worktree-manual.js';
import { attachTodoIntegrationReadModels, summarizeTodoIntegration } from './todo-integration-read.js';
import {
  INTEGRATION_GUARD_NO_LOCAL_CHANGE_DESTRUCTIVE_ACTIONS,
  SMART_MERGE_RUNNING,
  buildSmartMergeRequest,
  buildClearSmartMergeMarkerPatch,
  buildVerifyIntegrationRequest,
  getWorktreeIntegrationRecord,
  isTodoAwaitingIntegration,
  resolveIntegrationTargetFromItems,
} from './workspace-watcher-integration.js';
import {
  acquireIntegrationLock,
  bindIntegrationLockChat,
  getIntegrationLock,
  mutateIntegrateBatchStore,
  readIntegrateBatchStore,
  releaseBatchIntegrationLock,
} from './integration-lock.js';
import { evaluateBoundary, inspectWorkspaceBoundary } from './integrate-batch-boundary.js';
import { probeChatRunLiveness } from './chat-run-service.js';
import { getPromptBlock, NO_DATA_DIR_BLOCK } from './prompts/index.js';
import { collectTodoSubtreeLeafIds } from './todo-tree.js';

export const BATCH_ACTIVE_STATUSES = Object.freeze(['running', 'paused', 'stalled', 'cancelling']);
export const BATCH_TERMINAL_STATUSES = Object.freeze(['completed', 'cancelled', 'abandoned']);
const ENTRY_OPEN_STATES = Object.freeze(['running', 'awaiting_confirmation']);
const ENTRY_TERMINAL_STATES = Object.freeze(['merged', 'verified', 'failed', 'skipped', 'cancelled']);
const REPORT_OUTCOMES = Object.freeze(['merged', 'verified', 'no_code', 'failed']);

/** Consecutive `pending_confirm` answers before an entry fails as `unconfirmed`. */
export const MAX_PENDING_CONFIRMS = 3;
/** Heartbeat age after which a batch may be judged stalled (with idle evidence). */
export const BATCH_STALE_HEARTBEAT_MS = 5 * 60_000;

/**
 * @typedef {any} BatchDeps
 * @property {typeof buildSmartMergeRequest} [buildSmartMergeRequest]
 * @property {typeof buildVerifyIntegrationRequest} [buildVerifyIntegrationRequest]
 * @property {typeof inspectWorkspaceBoundary} [inspectBoundary]
 * @property {typeof probeChatRunLiveness} [probeChatRunLiveness]
 * @property {() => number} [now]
 * @property {number} [staleMs]
 * @property {Record<string, any>} [worktreeDeps]
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return String(value ?? '').trim();
}

/** Stored in persisted entry prompts in place of the capability secret. */
const TOKEN_PLACEHOLDER = '<<CRETLI_BATCH_TOKEN>>';

/**
 * Canonical workspace identity: todos, locks and batches all key on the same
 * resolved path, so `/repo/.` and `/repo` are one workspace.
 *
 * @param {unknown} workspaceFolder
 * @returns {string}
 */
function canonicalWorkspace(workspaceFolder) {
  return path.resolve(readString(workspaceFolder) || '.');
}

/**
 * @param {BatchDeps | undefined} deps
 * @returns {string}
 */
function nowIso(deps) {
  return new Date(typeof deps?.now === 'function' ? deps.now() : Date.now()).toISOString();
}

/**
 * @param {string} secret
 * @returns {string}
 */
function hashSecret(secret) {
  return createHash('sha256').update(String(secret ?? ''), 'utf8').digest('hex');
}

/**
 * @param {string} secret
 * @param {string} expectedHash
 * @returns {boolean}
 */
function secretMatches(secret, expectedHash) {
  if (!secret || !expectedHash) return false;
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(String(expectedHash), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Eligibility and target resolution (shared by batch create, dispatch and the
// `batchEligibility` list field).
// ---------------------------------------------------------------------------

/**
 * @typedef {any} EligibilityContext
 * @property {string} dataDir
 * @property {string} workspaceFolder
 * @property {Record<string, any>[]} list Todos with `integrationSummary` attached.
 * @property {Map<string, Record<string, any>>} byId
 * @property {Record<string, Record<string, any>>} registry
 * @property {boolean} locked
 * @property {Set<string>} [awaitingAncestorIds] Lazily filled by hasAwaitingDescendantWorktree.
 */

/**
 * @param {{ dataDir: string, workspaceFolder: string, items?: Record<string, any>[], locked?: boolean }} input
 * @returns {Promise<EligibilityContext>}
 */
export async function buildEligibilityContext(input) {
  const raw = Array.isArray(input.items) ? input.items : (await listTodos(input.dataDir, input.workspaceFolder)).items;
  return buildEligibilityContextFromItems({ ...input, items: raw });
}

/**
 * Synchronous core of `buildEligibilityContext` for callers that already hold the items.
 *
 * @param {{ dataDir: string, workspaceFolder: string, items: Record<string, any>[], locked?: boolean }} input
 * @returns {EligibilityContext}
 */
function buildEligibilityContextFromItems(input) {
  const raw = input.items;
  const list = raw.every((row) => row && typeof row.integrationSummary === 'object')
    ? raw
    : attachTodoIntegrationReadModels(raw);
  let registry = {};
  try {
    registry = readWorktreeRegistry({ dataDir: input.dataDir })?.items || {};
  } catch {
    registry = {};
  }
  return {
    dataDir: input.dataDir,
    workspaceFolder: input.workspaceFolder,
    list,
    byId: new Map(list.map((row) => [readString(row?.id), row])),
    registry,
    locked: input.locked === true,
  };
}

/**
 * True when a descendant of `id` owns a live, not yet integrated worktree. The
 * set of such ancestors is computed once per context (walking up from each
 * pending worktree owner), so annotating a whole list stays linear.
 *
 * @param {EligibilityContext} ctx
 * @param {string} id
 * @returns {boolean}
 */
function hasAwaitingDescendantWorktree(ctx, id) {
  if (!ctx.awaitingAncestorIds) {
    /** @type {Set<string>} */
    const marked = new Set();
    for (const ownerId of Object.keys(ctx.registry || {})) {
      if (!ctx.byId.has(ownerId)) continue;
      const record = ctx.registry[ownerId];
      if (!isLiveWorktreeRecord(record) || readString(record?.integrationState) === 'integrated') continue;
      let parentId = readString(ctx.byId.get(ownerId)?.parentId);
      while (parentId && !marked.has(parentId)) {
        marked.add(parentId);
        parentId = readString(ctx.byId.get(parentId)?.parentId);
      }
    }
    ctx.awaitingAncestorIds = marked;
  }
  return ctx.awaitingAncestorIds.has(id);
}

/** A marker older than this is a leftover of a dead merge agent, not live work. */
const RUNNING_MARKER_STALE_MS = 30 * 60 * 1000;

/**
 * True when the todo carries a fresh `smart_merge_running` marker. Stale markers
 * (agent died without reporting) must not block a batch workspace-wide.
 *
 * @param {Record<string, any> | undefined} todo
 * @returns {boolean}
 */
function hasLiveRunningMarker(todo) {
  if (readString(todo?.integration?.reason) !== SMART_MERGE_RUNNING) return false;
  const stamp = Date.parse(readString(todo.integration.updatedAt));
  return !Number.isFinite(stamp) || Date.now() - stamp < RUNNING_MARKER_STALE_MS;
}

/**
 * Canonical eligibility of one todo for a bulk entry.
 *
 * @param {EligibilityContext} ctx
 * @param {string} todoId
 * @returns {{ mode: 'smart-merge' | 'verify' | 'none', reason: string, targetId: string }}
 */
export function resolveBatchEntry(ctx, todoId) {
  const id = readString(todoId);
  const none = (/** @type {string} */ reason, targetId = id) => ({ mode: /** @type {'none'} */ ('none'), reason, targetId });
  if (ctx.locked) return none('locked');
  const resolved = resolveIntegrationTargetFromItems(ctx.dataDir, id, ctx.list, ctx.registry);
  if (!resolved) return none('not_found');
  const requested = ctx.byId.get(id);
  const summary = requested?.integrationSummary;
  if (summary && (summary.state === 'integrated' || summary.detail === 'no_code_changes')) {
    return none('already_integrated', resolved.targetId);
  }
  const { targetId, target } = resolved;
  if (isLiveWorktreeRecord(ctx.registry[targetId])) {
    if (hasLiveRunningMarker(target)) return none('busy', targetId);
    if (!isTodoAwaitingIntegration(target)) return none('not_eligible', targetId);
    return { mode: 'smart-merge', reason: '', targetId };
  }
  if (readString(requested?.status) !== 'done') return none('not_eligible', id);
  if (hasLiveRunningMarker(requested)) return none('busy', id);
  // A parent whose subtree still holds un-merged worktree results has nothing
  // to verify in HEAD yet; integrate those descendants (rootId batch) first.
  if (hasAwaitingDescendantWorktree(ctx, id)) return none('descendants_awaiting', id);
  return { mode: 'verify', reason: '', targetId: id };
}

/**
 * Batch ids for "integrate the whole subtree": the eligible leaves under
 * `rootId` in tree order. Leaves that are already integrated or not finished
 * are left out instead of being reported as skipped, so the batch lists only
 * real work.
 *
 * @param {EligibilityContext} ctx
 * @param {string} rootId
 * @returns {string[]}
 */
export function listSubtreeBatchIds(ctx, rootId) {
  return collectTodoSubtreeLeafIds(ctx.list, rootId)
    .filter((id) => resolveBatchEntry(ctx, id).mode !== 'none');
}

/**
 * Add the read-only `batchEligibility` field to every todo of a list payload.
 *
 * @param {{ dataDir: string, workspaceFolder: string, items: Record<string, any>[], deps?: Record<string, any> }} input
 * @returns {Record<string, any>[]}
 */
export function annotateBatchEligibility(input) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!input.dataDir || !input.workspaceFolder || !items.length) return items;
  let locked = false;
  try {
    locked = Boolean(getIntegrationLock({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder, deps: input.deps }));
  } catch {
    locked = false;
  }
  const ctx = buildEligibilityContextFromItems({ dataDir: input.dataDir, workspaceFolder: input.workspaceFolder, items, locked });
  return items.map((item) => {
    const resolved = resolveBatchEntry(ctx, readString(item?.id));
    return { ...item, batchEligibility: { mode: resolved.mode, reason: resolved.reason } };
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, any>} entry
 * @returns {Record<string, any>}
 */
function toEntryView(entry) {
  return {
    entryId: entry.id,
    todoId: entry.todoId,
    targetId: entry.targetId,
    mode: entry.mode,
    title: entry.title,
    state: entry.state,
    attempt: entry.attempt,
    reason: entry.reason || '',
    summary: entry.summary || '',
    override: entry.override === true,
  };
}

/**
 * Client-safe batch view: never exposes the secret hashes or entry prompts.
 *
 * @param {Record<string, any>} batch
 * @param {Record<string, any>} [extra]
 * @returns {Record<string, any>}
 */
export function toBatchView(batch, extra = {}) {
  const counts = {};
  for (const entry of batch.entries) /** @type {Record<string, any>} */ (counts)[entry.state] = (/** @type {Record<string, any>} */ (counts)[entry.state] || 0) + 1;
  return {
    id: batch.id,
    workspaceFolder: batch.workspaceFolder,
    status: batch.status,
    pausedReason: batch.pausedReason || '',
    pausedPaths: batch.pausedPaths || [],
    pausedEntryId: batch.pausedEntryId || '',
    epoch: batch.epoch,
    chatId: batch.chatId || '',
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    heartbeatAt: batch.heartbeatAt,
    overrides: batch.overrides || [],
    entries: batch.entries.map(toEntryView),
    skipped: batch.skipped || [],
    counts,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * @param {{ baseUrl?: string, insecureTls?: boolean }} batch
 * @returns {string}
 */
function nextUrl(batch) {
  return `${readString(batch.baseUrl).replace(/\/$/, '')}/api/integrate-batch/next`;
}

/**
 * @param {Record<string, any>} batch
 * @param {string} token
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
function buildNextCurl(batch, token, fields) {
  const payload = JSON.stringify({ batchId: batch.id, epoch: batch.epoch, token, ...fields });
  return `curl -sS -X POST ${nextUrl(batch)}${batch.insecureTls ? ' -k' : ''} -H "Content-Type: application/json" -d '${payload}'`;
}

/**
 * Arguments of the MCP twin `integrate_next` (snake_case like every
 * Cretli MCP tool); same capability fields as the curl body.
 *
 * @param {Record<string, any>} batch
 * @param {string} token
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
function buildNextMcpArgs(batch, token, fields) {
  return { batch_id: batch.id, epoch: batch.epoch, token, ...fields };
}

/**
 * Mode-dependent rules returned with each entry.
 *
 * @param {'smart-merge' | 'verify'} mode
 * @returns {string}
 */
export function buildEntryRules(mode) {
  if (mode === 'verify') {
    return [
      'Rules for this verify entry:',
      '1. Check the change is in the checked-out branch.',
      '2. Confirm with todo_integration action confirm (proof.simple true), or action no-code with a reason when the todo changed nothing.',
      '3. Call next (MCP integrate_next) with outcome "verified" (or "no_code"; "failed" when you cannot verify). There is no smart_merge_report for a verify entry.',
    ].join('\n');
  }
  return [
    'Rules for this smart-merge entry:',
    '1. Commit the listed task paths unless already in HEAD.',
    '2. Report with the MCP tool smart_merge_report (arguments in the entry prompt), outcome "merged" or "failed"; the curl callback there is only a fallback when MCP is unavailable.',
    '3. On "merged" only: todo_integration action confirm (proof.simple true), with the change in HEAD.',
    '4. Call next (MCP integrate_next) with outcome "merged" (or "failed").',
  ].join('\n');
}

/**
 * The one prompt the batch chat starts with. It carries the ordered list, the
 * capability secret and the protocol, but never the per-todo instructions.
 *
 * @param {Record<string, any>} batch
 * @param {string} secret
 * @returns {string}
 */
export function buildBatchWrapperPrompt(batch, secret) {
  const lines = batch.entries.map((/** @type {any} */ entry, /** @type {any} */ index) => `${index + 1}. [${entry.mode}] ${entry.title} (todo ${entry.todoId})`);
  return [
    `Bulk integrate: integrate ${batch.entries.length} finished todo(s) into the main workspace strictly one after another.`,
    '',
    `Workspace (your working directory): ${batch.workspaceFolder}`,
    `Batch: ${batch.id}`,
    'Todos in order:',
    ...lines,
    '',
    'Protocol:',
    '- Work on ONE todo at a time. The instructions for a todo are handed out by the server only when it is that todo\'s turn.',
    '- Ask for the first todo (and again for every later one) with the next call below, without entry_id.',
    '- The answer has an action. "entry": follow its prompt and rules for exactly that entry. "pending_confirm": finish the confirmation and repeat the same report. "stop": stop immediately and do nothing else (cancelled, paused, completed). An invalid_token / stale_epoch / unknown_entry / stale_attempt / entry_not_running / batch_paused error (HTTP 401/409) also means stop. "resolved": that entry was already settled (a repeated report); ask for the next todo again with the next call below, without entry_id.',
    '- Report a finished entry by calling next again with its entry_id, attempt and outcome ("merged", "verified", "no_code" or "failed"); the answer then carries the next entry.',
    `- ${INTEGRATION_GUARD_NO_LOCAL_CHANGE_DESTRUCTIVE_ACTIONS} Unrelated uncommitted files are not yours: leave them untouched. ${NO_DATA_DIR_BLOCK}`,
    '',
    `${getPromptBlock('mcpFirst')} Call the Cretli MCP tool integrate_next.`,
    `Ask for the next todo: ${JSON.stringify(buildNextMcpArgs(batch, secret, {}))}`,
    `Report an entry (replace entry_id, attempt, outcome and summary): ${JSON.stringify(buildNextMcpArgs(batch, secret, { entry_id: '<entryId>', attempt: 1, outcome: 'merged', summary: '<one line>' }))}`,
    '',
    getPromptBlock('curlFallback'),
    buildNextCurl(batch, secret, {}),
    buildNextCurl(batch, secret, { entryId: '<entryId>', attempt: 1, outcome: 'merged', summary: '<one line>' }),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} dataDir
 * @param {string} batchId
 * @returns {Record<string, any> | null}
 */
function loadBatch(dataDir, batchId) {
  /** @type {any} */
  const batch = /** @type {Record<string, any>} */ (readIntegrateBatchStore(dataDir).batches)[readString(batchId)] || null;
  if (batch) batch.dataDir = dataDir;
  return batch;
}

/**
 * Persist a mutated batch record.
 *
 * @param {string} dataDir
 * @param {Record<string, any>} batch
 * @param {BatchDeps} [deps]
 */
function saveBatch(dataDir, batch, deps) {
  batch.updatedAt = nowIso(deps);
  // `dataDir` is a runtime field of the loaded record, never persisted.
  const persisted = { ...batch, dataDir: undefined };
  mutateIntegrateBatchStore(dataDir, (doc) => {
    doc.batches[batch.id] = persisted;
  });
}

/**
 * @param {Record<string, any>} batch
 * @returns {Record<string, any> | null}
 */
function currentEntry(batch) {
  return batch.entries.find((/** @type {any} */ entry) => ENTRY_OPEN_STATES.includes(entry.state)) || null;
}

/**
 * Read the confirmed state of the entry's target todo.
 *
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @param {Record<string, any>} entry
 * @returns {Promise<{ confirmed: boolean, noCode: boolean, todo: Record<string, any> | null }>}
 */
async function readEntryConfirmation(dataDir, workspaceFolder, entry) {
  let todo = null;
  try {
    todo = (await listTodos(dataDir, workspaceFolder)).items.find((row) => readString(row.id) === entry.targetId) || null;
  } catch {
    todo = null;
  }
  if (!todo) return { confirmed: false, noCode: false, todo: null };
  const summary = summarizeTodoIntegration(todo);
  const noCode = summary.detail === 'no_code_changes';
  return { confirmed: summary.state === 'integrated' || noCode, noCode, todo };
}

/**
 * True when the prepared worktree result of a smart-merge entry has no changes.
 * Anything that cannot be established counts as "has changes".
 *
 * @param {string} dataDir
 * @param {Record<string, any>} entry
 * @param {Record<string, any> | null} todo
 * @returns {boolean}
 */
function preparedResultIsEmpty(dataDir, entry, todo) {
  try {
    const patchPath = readString(todo?.integration?.resultPath);
    if (patchPath && fs.existsSync(patchPath) && fs.statSync(patchPath).size === 0) return true;
    const record = getWorktreeIntegrationRecord(entry.targetId, dataDir);
    const result = record?.results?.[readString(todo?.integration?.cycleId)];
    if (result && Array.isArray(result.changedFiles)) return result.changedFiles.length === 0;
  } catch {
    return false;
  }
  return false;
}

/**
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @param {string} targetId
 */
async function clearRunningMarker(dataDir, workspaceFolder, targetId) {
  try {
    const todo = (await listTodos(dataDir, workspaceFolder)).items.find((row) => readString(row.id) === targetId);
    const patch = buildClearSmartMergeMarkerPatch(todo);
    if (patch) await updateTodo(dataDir, workspaceFolder, targetId, patch);
  } catch {
    // Advisory marker only.
  }
}

/**
 * Structural boundary only (nothing unmerged, no merge / rebase / cherry-pick /
 * revert in progress); dirty-path drift is not judged. Required before any entry
 * is built, whatever state the batch comes from.
 *
 * @param {string} workspaceFolder
 * @param {BatchDeps} [deps]
 * @returns {{ safe: boolean, reasons: string[], paths: string[] }}
 */
function checkStructuralBoundary(workspaceFolder, deps) {
  const inspect = typeof deps?.inspectBoundary === 'function' ? deps.inspectBoundary : inspectWorkspaceBoundary;
  return evaluateBoundary({ snapshot: null, current: inspect({ workspaceFolder }), driftIgnored: true });
}

/**
 * @param {Record<string, any>} batch
 * @param {string} reason
 * @param {string[]} [paths]
 * @param {string} [entryId]
 */
function pauseBatch(batch, reason, paths = [], entryId = '') {
  // A cancelling batch stays cancelling: it still ends cancelled, never completed.
  if (batch.status !== 'cancelling') batch.status = 'paused';
  batch.pausedReason = reason;
  batch.pausedPaths = paths;
  batch.pausedEntryId = entryId;
}

/**
 * Skip queued entries that follow a failed one in a sequential parent.
 *
 * @param {Record<string, any>} batch
 * @param {Record<string, any>} failed
 * @param {BatchDeps} [deps]
 */
async function blockSequentialSiblings(batch, failed, deps) {
  let items = [];
  try {
    items = (await listTodos(batch.dataDir, batch.workspaceFolder)).items;
  } catch {
    return;
  }
  const byId = new Map(items.map((row) => [readString(row.id), row]));
  // The integration unit is the canonical target (an alias of an ancestor
  // worktree blocks the ancestor's siblings), not the clicked todo.
  /** @type {any} */
  const failedTodo = byId.get(readString(failed.targetId)) || byId.get(readString(failed.todoId));
  const parentId = readString(/** @type {any} */ (failedTodo)?.parentId);
  const parent = parentId ? byId.get(parentId) : null;
  if (!failedTodo || !parent || /** @type {any} */ (parent).runMode === 'parallel') return;
  const failedIndex = Number.isInteger(failedTodo.siblingIndex) ? failedTodo.siblingIndex : 0;
  for (const entry of batch.entries) {
    if (entry.state !== 'queued') continue;
    /** @type {any} */
    const todo = byId.get(readString(entry.targetId)) || byId.get(readString(entry.todoId));
    if (!todo || readString(todo.parentId) !== parentId) continue;
    const index = Number.isInteger(todo.siblingIndex) ? todo.siblingIndex : 0;
    if (index <= failedIndex) continue;
    entry.state = 'skipped';
    entry.reason = `blocked_by:${failed.id}`;
    entry.finishedAt = nowIso(deps);
  }
}

/**
 * A failed or unconfirmed entry: continue only from a safe boundary.
 *
 * @param {Record<string, any>} batch
 * @param {Record<string, any>} entry
 * @param {BatchDeps} [deps]
 * @returns {Promise<boolean>} true when the batch may continue
 */
async function settleFailedEntry(batch, entry, deps) {
  const inspect = typeof deps?.inspectBoundary === 'function' ? deps.inspectBoundary : inspectWorkspaceBoundary;
  const evaluated = evaluateBoundary({
    snapshot: entry.snapshot || null,
    current: inspect({ workspaceFolder: batch.workspaceFolder }),
  });
  if (!evaluated.safe) {
    pauseBatch(batch, evaluated.reasons.join(','), evaluated.paths, entry.id);
    return false;
  }
  await blockSequentialSiblings(batch, entry, deps);
  return true;
}

/**
 * Close the batch when nothing is left to do.
 *
 * @param {Record<string, any>} batch
 * @param {BatchDeps} [deps]
 * @returns {boolean}
 */
function finalizeIfDone(batch, deps) {
  if (BATCH_TERMINAL_STATUSES.includes(batch.status)) return true;
  if (batch.entries.some((/** @type {any} */ entry) => entry.state === 'queued' || ENTRY_OPEN_STATES.includes(entry.state))) return false;
  batch.status = batch.status === 'cancelling' ? 'cancelled' : 'completed';
  batch.finishedAt = nowIso(deps);
  releaseBatchIntegrationLock({ dataDir: batch.dataDir, workspaceFolder: batch.workspaceFolder, batchId: batch.id });
  return true;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a batch from the clicked todo ids (order preserved).
 *
 * @param {{ dataDir: string, workspaceFolder: string, todoIds?: string[], rootId?: string, baseUrl?: string, insecureTls?: boolean, deps?: BatchDeps }} input
 * @returns {Promise<{ ok: boolean, reason?: string, lock?: Record<string, any>, skipped?: Record<string, any>[], batch?: Record<string, any>, view?: Record<string, any>, secret?: string, prompt?: string }>}
 */
export async function createIntegrateBatch(input) {
  const { dataDir, deps } = input;
  const workspaceFolder = canonicalWorkspace(input.workspaceFolder);
  const rootId = readString(input.rootId);
  let ids = (Array.isArray(input.todoIds) ? input.todoIds : []).map(readString).filter(Boolean);
  if (!ids.length && !rootId) return { ok: false, reason: 'empty', skipped: [] };
  const lock = getIntegrationLock({ dataDir, workspaceFolder, deps });
  if (lock) return { ok: false, reason: 'integration_locked', lock };
  const items = (await listTodos(dataDir, workspaceFolder)).items;
  if (items.some(hasLiveRunningMarker)) {
    return { ok: false, reason: 'busy' };
  }
  const ctx = buildEligibilityContextFromItems({ dataDir, workspaceFolder, items });
  if (!ids.length) {
    if (!ctx.byId.has(rootId)) return { ok: false, reason: 'not_found', skipped: [] };
    ids = listSubtreeBatchIds(ctx, rootId);
    if (!ids.length) return { ok: false, reason: 'empty', skipped: [] };
  }
  const entries = [];
  const skipped = [];
  const seenTargets = new Map();
  for (const todoId of ids) {
    const resolved = resolveBatchEntry(ctx, todoId);
    if (resolved.mode === 'none') {
      skipped.push({ todoId, reason: resolved.reason });
      continue;
    }
    if (seenTargets.has(resolved.targetId)) {
      skipped.push({ todoId, reason: `aliased:${resolved.targetId}` });
      continue;
    }
    seenTargets.set(resolved.targetId, todoId);
    entries.push({
      id: `e${entries.length + 1}`,
      todoId,
      targetId: resolved.targetId,
      mode: resolved.mode,
      title: readString(ctx.byId.get(todoId)?.title) || todoId,
      state: 'queued',
      attempt: 0,
      pendingConfirms: 0,
      reason: '',
      summary: '',
      snapshot: null,
      prompt: '',
      override: false,
      startedAt: '',
      finishedAt: '',
    });
  }
  if (!entries.length) return { ok: false, reason: 'empty', skipped };
  const boundary = checkStructuralBoundary(workspaceFolder, deps);
  if (!boundary.safe) {
    return { ok: false, reason: 'boundary_unsafe', skipped, detail: { reasons: boundary.reasons, paths: boundary.paths } };
  }
  const now = nowIso(deps);
  const id = randomUUID();
  const acquired = acquireIntegrationLock({ dataDir, workspaceFolder, owner: 'batch', batchId: id, todoId: '', now, deps });
  if (!acquired.ok) return { ok: false, reason: 'integration_locked', lock: acquired.lock };
  const secret = randomBytes(24).toString('base64url');
  const batch = {
    id,
    dataDir,
    workspaceFolder,
    status: 'running',
    pausedReason: '',
    pausedPaths: [],
    pausedEntryId: '',
    epoch: 1,
    epochTokens: { 1: hashSecret(secret) },
    chatId: '',
    runId: '',
    baseUrl: readString(input.baseUrl),
    insecureTls: input.insecureTls === true,
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    overrides: [],
    entries,
    skipped,
  };
  saveBatch(dataDir, batch, deps);
  return { ok: true, batch, view: toBatchView(batch), secret, prompt: buildBatchWrapperPrompt(batch, secret), skipped };
}

/**
 * Bind the chat the route created to the batch and its lock.
 *
 * @param {{ dataDir: string, batchId: string, chatId: string, runId?: string, deps?: BatchDeps }} input
 * @returns {boolean}
 */
export function attachBatchChat(input) {
  const batch = loadBatch(input.dataDir, input.batchId);
  if (!batch) return false;
  batch.chatId = readString(input.chatId);
  batch.runId = readString(input.runId);
  batch.heartbeatAt = nowIso(input.deps);
  saveBatch(input.dataDir, batch, input.deps);
  bindIntegrationLockChat({ dataDir: input.dataDir, workspaceFolder: batch.workspaceFolder, batchId: batch.id, chatId: batch.chatId });
  return true;
}

// ---------------------------------------------------------------------------
// Dispatch and the `next` protocol
// ---------------------------------------------------------------------------

/**
 * Hand out the next entry (building its real prompt lazily) or settle the batch.
 *
 * @param {Record<string, any>} batch
 * @param {BatchDeps} deps
 * @returns {Promise<Record<string, any> | null>} the open entry, or null when the batch is done / paused
 */
async function dispatchNext(batch, deps) {
  const inspect = typeof deps?.inspectBoundary === 'function' ? deps.inspectBoundary : inspectWorkspaceBoundary;
  const buildSmart = deps?.buildSmartMergeRequest || buildSmartMergeRequest;
  const buildVerify = deps?.buildVerifyIntegrationRequest || buildVerifyIntegrationRequest;
  for (;;) {
    const open = currentEntry(batch);
    if (open) return open;
    if (batch.status !== 'running') return null;
    const entry = batch.entries.find((/** @type {any} */ row) => row.state === 'queued');
    if (!entry) {
      finalizeIfDone(batch, deps);
      return null;
    }
    const ctx = await buildEligibilityContext({ dataDir: batch.dataDir, workspaceFolder: batch.workspaceFolder });
    const resolved = resolveBatchEntry(ctx, entry.todoId);
    if (resolved.mode === 'none' || resolved.mode !== entry.mode || resolved.targetId !== entry.targetId) {
      entry.state = 'skipped';
      entry.reason = resolved.mode === 'none' ? resolved.reason : 'not_eligible';
      entry.finishedAt = nowIso(deps);
      continue;
    }
    const snapshot = inspect({ workspaceFolder: batch.workspaceFolder });
    if (!snapshot.ok) {
      pauseBatch(batch, `inspection_failed:${snapshot.reason || 'unknown'}`, [], entry.id);
      return null;
    }
    const structural = evaluateBoundary({ snapshot: null, current: snapshot, driftIgnored: true });
    if (!structural.safe) {
      pauseBatch(batch, `boundary_unsafe:${structural.reasons.join(',')}`, structural.paths, entry.id);
      return null;
    }
    entry.snapshot = snapshot.dirty;
    entry.attempt += 1;
    entry.pendingConfirms = 0;
    const built = entry.mode === 'verify'
      ? await buildVerify({ todoId: entry.todoId, workspaceFolder: batch.workspaceFolder, dataDir: batch.dataDir })
      : await buildSmart({
        todoId: entry.todoId,
        workspaceFolder: batch.workspaceFolder,
        dataDir: batch.dataDir,
        baseUrl: batch.baseUrl,
        insecureTls: batch.insecureTls,
        callbackContext: { batchId: batch.id, entryId: entry.id, attempt: entry.attempt, epoch: batch.epoch, token: TOKEN_PLACEHOLDER },
        deps: deps?.worktreeDeps,
      });
    if (!built.ok) {
      entry.state = 'failed';
      entry.reason = `build_failed:${built.reason || 'unknown'}`;
      entry.finishedAt = nowIso(deps);
      await clearRunningMarker(batch.dataDir, batch.workspaceFolder, entry.targetId);
      if (!(await settleFailedEntry(batch, entry, deps))) return null;
      continue;
    }
    entry.state = 'running';
    entry.startedAt = nowIso(deps);
    // The mode rules travel once, in the payload `rules` field (`entryPayload`).
    entry.prompt = built.prompt;
    return entry;
  }
}

/**
 * @param {Record<string, any>} batch
 * @param {Record<string, any>} entry
 * @param {string} token Verified secret of the current epoch.
 * @returns {Record<string, any>}
 */
function entryPayload(batch, entry, token) {
  return {
    entryId: entry.id,
    attempt: entry.attempt,
    todoId: entry.todoId,
    targetId: entry.targetId,
    mode: entry.mode,
    title: entry.title,
    // The capability is injected into the response only; the store never holds it.
    prompt: String(entry.prompt || '').split(TOKEN_PLACEHOLDER).join(token),
    rules: buildEntryRules(entry.mode),
    position: batch.entries.indexOf(entry) + 1,
    total: batch.entries.length,
  };
}

/**
 * Apply a reported outcome to an open entry.
 *
 * @param {Record<string, any>} batch
 * @param {Record<string, any>} entry
 * @param {string} outcome
 * @param {string} summary
 * @param {BatchDeps} deps
 * @returns {Promise<{ kind: 'resolved' | 'pending_confirm' | 'failed', settled?: boolean }>}
 */
async function applyEntryOutcome(batch, entry, outcome, summary, deps) {
  const finish = async (/** @type {any} */ state, reason = '') => {
    entry.state = state;
    entry.reason = reason;
    entry.summary = summary;
    entry.finishedAt = nowIso(deps);
    // A failed entry must not leave the advisory marker behind: a retry would
    // otherwise be skipped as busy and batch create refused workspace-wide.
    if (state === 'failed') await clearRunningMarker(batch.dataDir, batch.workspaceFolder, entry.targetId);
  };
  if (outcome === 'failed') {
    await finish('failed', 'agent_failed');
    return { kind: 'failed' };
  }
  const confirmation = await readEntryConfirmation(batch.dataDir, batch.workspaceFolder, entry);
  if (!confirmation.confirmed) {
    entry.pendingConfirms += 1;
    if (entry.pendingConfirms >= MAX_PENDING_CONFIRMS) {
      await finish('failed', 'unconfirmed');
      return { kind: 'failed' };
    }
    return { kind: 'pending_confirm' };
  }
  if (entry.mode === 'verify' && outcome === 'no_code' && !confirmation.noCode) {
    // A no_code claim needs the recorded no-code review, not a plain confirm.
    await finish('failed', 'no_code_not_recorded');
    return { kind: 'failed' };
  }
  const claimsNoCode = outcome === 'no_code' || confirmation.noCode;
  if (entry.mode === 'smart-merge' && claimsNoCode && !preparedResultIsEmpty(batch.dataDir, entry, confirmation.todo)) {
    await finish('failed', 'no_code_with_changes');
    return { kind: 'failed' };
  }
  await finish(entry.mode === 'verify' ? 'verified' : 'merged');
  return { kind: 'resolved' };
}

/**
 * Cancelling batch: nothing queued survives; close once the current entry ended.
 *
 * @param {Record<string, any>} batch
 * @param {BatchDeps} deps
 */
function settleCancelling(batch, deps) {
  for (const entry of batch.entries) {
    if (entry.state === 'queued') {
      entry.state = 'cancelled';
      entry.reason = 'batch_cancelled';
      entry.finishedAt = nowIso(deps);
    }
  }
  finalizeIfDone(batch, deps);
}

/**
 * Token + epoch validation shared by `next` and the legacy report fence.
 *
 * @param {Record<string, any>} batch
 * @param {unknown} epoch
 * @param {unknown} token
 * @returns {{ ok: boolean, status?: number, code?: string }}
 */
function validateCapability(batch, epoch, token) {
  const claimedEpoch = Number(epoch);
  const expectedHash = batch.epochTokens?.[claimedEpoch];
  if (!Number.isInteger(claimedEpoch) || !secretMatches(readString(token), expectedHash)) {
    return { ok: false, status: 401, code: 'invalid_token' };
  }
  if (claimedEpoch !== batch.epoch) return { ok: false, status: 409, code: 'stale_epoch' };
  return { ok: true };
}

/**
 * `POST /api/integrate-batch/next`: the agent reports the finished entry (when
 * `entryId` is given) and asks for the next one.
 *
 * `workspaceFolder` (set by the MCP twin) scopes the lookup to the caller's
 * workspace: a batch of another workspace reads as not found.
 *
 * @param {{ dataDir: string, body: Record<string, unknown>, workspaceFolder?: string, deps?: BatchDeps }} input
 * @returns {Promise<{ status: number, body: Record<string, any> }>}
 */
export function handleBatchNext(input) {
  // Dispatching awaits git work between load and save, so calls for one batch
  // are serialized; otherwise two concurrent `next` calls could both hand out
  // the same queued entry.
  return serializeBatchCall(input.dataDir, input.body?.batchId, () => handleBatchNextSerialized(input));
}

/**
 * Run `fn` after every earlier call for the same batch settled. Resume and
 * abandon await the todo store between load and save, so they share the queue.
 *
 * @template T
 * @param {unknown} dataDir
 * @param {unknown} batchId
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function serializeBatchCall(dataDir, batchId, fn) {
  const key = `${readString(dataDir)}\0${readString(batchId)}`;
  const previous = batchNextQueue.get(key) || Promise.resolve();
  const run = previous.then(fn);
  const tail = run.catch(() => {});
  batchNextQueue.set(key, tail);
  tail.then(() => { if (batchNextQueue.get(key) === tail) batchNextQueue.delete(key); });
  return run;
}

/** Per-batch tail of the call queue. */
const batchNextQueue = new Map();

async function handleBatchNextSerialized(input) {
  const { dataDir, deps } = input;
  const body = input.body || {};
  const batch = loadBatch(dataDir, body.batchId);
  if (!batch) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (readString(input.workspaceFolder) && canonicalWorkspace(input.workspaceFolder) !== canonicalWorkspace(batch.workspaceFolder)) {
    return { status: 404, body: { ok: false, error: 'not_found' } };
  }
  const capability = validateCapability(batch, body.epoch, body.token);
  if (!capability.ok) return { status: /** @type {number} */ (capability.status), body: { ok: false, error: capability.code } };
  const token = readString(body.token);
  if (BATCH_TERMINAL_STATUSES.includes(batch.status)) {
    return { status: 200, body: { ok: true, action: 'stop', reason: batch.status, batch: toBatchView(batch) } };
  }
  const entryId = readString(body.entryId);
  let reportedKind = '';
  let reportedEntry = null;
  if (entryId) {
    const entry = batch.entries.find((/** @type {any} */ row) => row.id === entryId);
    if (!entry) return { status: 409, body: { ok: false, error: 'unknown_entry' } };
    if (Number(body.attempt) !== entry.attempt) return { status: 409, body: { ok: false, error: 'stale_attempt' } };
    if (ENTRY_TERMINAL_STATES.includes(entry.state)) {
      return { status: 200, body: { ok: true, action: 'resolved', entry: toEntryView(entry), batch: toBatchView(batch) } };
    }
    if (!ENTRY_OPEN_STATES.includes(entry.state)) return { status: 409, body: { ok: false, error: 'entry_not_running' } };
    const outcome = readString(body.outcome).toLowerCase();
    if (!REPORT_OUTCOMES.includes(outcome)) return { status: 400, body: { ok: false, error: 'invalid_outcome' } };
    if (batch.status === 'paused') return { status: 409, body: { ok: false, error: 'batch_paused' } };
    const applied = await applyEntryOutcome(batch, entry, outcome, readString(body.summary).slice(0, 200), deps);
    reportedKind = applied.kind;
    reportedEntry = entry;
  }
  batch.heartbeatAt = nowIso(deps);
  if (batch.status === 'stalled') batch.status = 'running';
  if (reportedKind === 'pending_confirm') {
    saveBatch(dataDir, batch, deps);
    return {
      status: 200,
      body: { ok: true, action: 'pending_confirm', retry: true, entry: toEntryView(reportedEntry), batch: toBatchView(batch) },
    };
  }
  if (reportedKind === 'failed' && !(await settleFailedEntry(batch, reportedEntry, deps))) {
    saveBatch(dataDir, batch, deps);
    return { status: 200, body: { ok: true, action: 'stop', reason: 'paused', batch: toBatchView(batch) } };
  }
  if (batch.status === 'cancelling') {
    settleCancelling(batch, deps);
    saveBatch(dataDir, batch, deps);
    return { status: 200, body: { ok: true, action: 'stop', reason: 'cancelled', batch: toBatchView(batch) } };
  }
  if (batch.status === 'paused') {
    saveBatch(dataDir, batch, deps);
    return { status: 200, body: { ok: true, action: 'stop', reason: 'paused', batch: toBatchView(batch) } };
  }
  const entry = await dispatchNext(batch, deps);
  saveBatch(dataDir, batch, deps);
  if (entry) {
    return { status: 200, body: { ok: true, action: 'entry', entry: entryPayload(batch, entry, token), batch: toBatchView(batch) } };
  }
  const reason = batch.status === 'running' ? 'completed' : batch.status;
  return { status: 200, body: { ok: true, action: 'stop', reason, batch: toBatchView(batch) } };
}

// ---------------------------------------------------------------------------
// Legacy report fencing
// ---------------------------------------------------------------------------

/**
 * Validate a legacy `smart-merge-report-from-agent` call against batches.
 * A todo that is not part of an open batch entry (and names no batch) passes
 * through unchanged; one that is must carry matching `{ batchId, entryId, attempt, epoch, token }`.
 *
 * @param {{ dataDir: string, workspaceFolder: string, todoId: string, body?: Record<string, unknown> }} input
 * @returns {Promise<{ ok: boolean, batchId?: string, entryId?: string }>}
 */
export async function checkBatchLegacyReport(input) {
  const todoId = readString(input.todoId);
  let targetId = todoId;
  try {
    targetId = resolveIntegrationTargetFromItems(input.dataDir, todoId, (await listTodos(input.dataDir, input.workspaceFolder)).items)?.targetId || todoId;
  } catch {
    targetId = todoId;
  }
  // Validate against the current epoch after the asynchronous todo read:
  // resume or abandon may have revoked the old capability while it waited.
  const doc = readIntegrateBatchStore(input.dataDir);
  const folder = canonicalWorkspace(input.workspaceFolder);
  const body = input.body || {};
  const matches = (/** @type {any} */ row) => row.todoId === todoId || row.targetId === todoId || row.targetId === targetId;
  const batches = Object.values(/** @type {Record<string, any>} */ (doc.batches)).filter((batch) => canonicalWorkspace(batch.workspaceFolder) === folder);
  // A report that names a batch is judged against that batch whatever its
  // status: a stale agent of an abandoned / cancelled / completed batch changes
  // nothing.
  for (const batch of batches) {
    if (readString(body.batchId) !== batch.id || !batch.entries.some(matches)) continue;
    const entry = batch.entries.find((/** @type {any} */ row) => matches(row) && !ENTRY_TERMINAL_STATES.includes(row.state));
    const valid = Boolean(entry)
      && BATCH_ACTIVE_STATUSES.includes(batch.status)
      && readString(body.entryId) === entry.id
      && Number(body.attempt) === entry.attempt
      && ENTRY_OPEN_STATES.includes(entry.state)
      && validateCapability(batch, body.epoch, body.token).ok;
    return valid ? { ok: true, batchId: batch.id, entryId: entry.id } : { ok: false };
  }
  for (const batch of batches) {
    if (!BATCH_ACTIVE_STATUSES.includes(batch.status)) continue;
    const entry = batch.entries.find((/** @type {any} */ row) => !ENTRY_TERMINAL_STATES.includes(row.state) && matches(row));
    if (!entry) continue;
    const valid = readString(body.batchId) === batch.id
      && readString(body.entryId) === entry.id
      && Number(body.attempt) === entry.attempt
      && ENTRY_OPEN_STATES.includes(entry.state)
      && validateCapability(batch, body.epoch, body.token).ok;
    return valid ? { ok: true, batchId: batch.id, entryId: entry.id } : { ok: false };
  }
  return { ok: true };
}

/**
 * Record an accepted legacy report: heartbeat, and `merged` moves a smart-merge
 * entry to `awaiting_confirmation`. The report never advances the batch.
 *
 * @param {{ dataDir: string, batchId: string, entryId: string, outcome: string, deps?: BatchDeps }} input
 */
export function recordBatchLegacyReport(input) {
  const batch = loadBatch(input.dataDir, input.batchId);
  if (!batch) return;
  const entry = batch.entries.find((/** @type {any} */ row) => row.id === input.entryId);
  batch.heartbeatAt = nowIso(input.deps);
  if (entry && entry.state === 'running' && readString(input.outcome).toLowerCase() === 'merged') {
    entry.state = 'awaiting_confirmation';
  }
  saveBatch(input.dataDir, batch, input.deps);
}

// ---------------------------------------------------------------------------
// Liveness, recovery, cancel
// ---------------------------------------------------------------------------

/**
 * Positive idle evidence only: `known && !busy`. Everything else is unknown.
 *
 * @param {Record<string, any>} batch
 * @param {BatchDeps} [deps]
 * @returns {{ idle: boolean, busy: boolean, known: boolean, reason: string }}
 */
export function probeBatchLiveness(batch, deps) {
  const probe = typeof deps?.probeChatRunLiveness === 'function' ? deps.probeChatRunLiveness : probeChatRunLiveness;
  if (!batch.chatId) return { idle: false, busy: false, known: false, reason: 'chat_missing' };
  try {
    const result = probe({ chatId: batch.chatId, runId: batch.runId || '' });
    const known = result?.known === true;
    const busy = known && result.busy === true;
    return { idle: known && !busy, busy, known, reason: readString(result?.reason) || (known ? (busy ? 'busy' : 'idle') : 'unknown') };
  } catch {
    return { idle: false, busy: false, known: false, reason: 'probe_failed' };
  }
}

/**
 * Judge a running batch stalled only with a stale heartbeat AND idle evidence.
 *
 * @param {Record<string, any>} batch
 * @param {BatchDeps} [deps]
 * @returns {boolean} true when the record changed
 */
function refreshStalled(batch, deps) {
  if (batch.status !== 'running') return false;
  const nowMs = typeof deps?.now === 'function' ? deps.now() : Date.now();
  const staleMs = Number.isFinite(deps?.staleMs) ? deps.staleMs : BATCH_STALE_HEARTBEAT_MS;
  if (!(nowMs - Date.parse(batch.heartbeatAt || '') > staleMs)) return false;
  if (!probeBatchLiveness(batch, deps).idle) return false;
  batch.status = 'stalled';
  return true;
}

/**
 * Read a batch (refreshing liveness) for the UI.
 *
 * @param {{ dataDir: string, batchId: string, deps?: BatchDeps }} input
 * @returns {Record<string, any> | null}
 */
export function readIntegrateBatch(input) {
  const batch = loadBatch(input.dataDir, input.batchId);
  if (!batch) return null;
  if (refreshStalled(batch, input.deps)) saveBatch(input.dataDir, batch, input.deps);
  const active = BATCH_ACTIVE_STATUSES.includes(batch.status);
  const liveness = active ? probeBatchLiveness(batch, input.deps) : null;
  return toBatchView(batch, active ? {
    liveness: { idle: liveness?.idle, busy: liveness?.busy, known: liveness?.known, reason: liveness?.reason },
    lockHeld: true,
  } : { lockHeld: false });
}

/**
 * @param {{ dataDir: string, workspaceFolder?: string, deps?: BatchDeps }} input
 * @returns {Record<string, any>[]} newest first
 */
export function listIntegrateBatches(input) {
  const doc = readIntegrateBatchStore(input.dataDir);
  const folder = readString(input.workspaceFolder) ? canonicalWorkspace(input.workspaceFolder) : '';
  return Object.values(/** @type {Record<string, any>} */ (doc.batches))
    .filter((batch) => !folder || canonicalWorkspace(batch.workspaceFolder) === folder)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 20)
    .map((batch) => readIntegrateBatch({ dataDir: input.dataDir, batchId: batch.id, deps: input.deps }))
    .filter(Boolean);
}

/**
 * Startup pass: re-judge active batches. A restart makes liveness unknown, so
 * nothing is released here; only positive idle evidence moves a batch to stalled.
 *
 * @param {{ dataDir: string, deps?: BatchDeps }} input
 * @returns {number} batches that changed
 */
export function recoverIntegrateBatchesOnStartup(input) {
  let changed = 0;
  const doc = readIntegrateBatchStore(input.dataDir);
  for (const batch of Object.values(/** @type {Record<string, any>} */ (doc.batches))) {
    if (!BATCH_ACTIVE_STATUSES.includes(batch.status)) continue;
    if (refreshStalled(batch, input.deps)) {
      saveBatch(input.dataDir, batch, input.deps);
      changed += 1;
    }
  }
  return changed;
}

/**
 * Cancel: queued entries end `cancelled`; a running entry keeps the lock until
 * it reports or the user abandons. Nothing kills a run.
 *
 * @param {{ dataDir: string, batchId: string, deps?: BatchDeps }} input
 * @returns {Promise<{ ok: boolean, reason?: string, view?: Record<string, any> }>}
 */
export function cancelIntegrateBatch(input) {
  return serializeBatchCall(input.dataDir, input.batchId, () => cancelIntegrateBatchSerialized(input));
}

/** @param {{ dataDir: string, batchId: string, deps?: BatchDeps }} input */
function cancelIntegrateBatchSerialized(input) {
  const batch = loadBatch(input.dataDir, input.batchId);
  if (!batch) return { ok: false, reason: 'not_found' };
  if (BATCH_TERMINAL_STATUSES.includes(batch.status)) return { ok: false, reason: 'not_active' };
  batch.status = 'cancelling';
  settleCancelling(batch, input.deps);
  saveBatch(input.dataDir, batch, input.deps);
  return { ok: true, view: toBatchView(batch) };
}

/**
 * Record a forced takeover (no positive idle evidence) on the batch and on the
 * entry it affects, so the summary can flag it.
 *
 * @param {Record<string, any>} batch
 * @param {string} action
 * @param {{ reason: string }} liveness
 * @param {BatchDeps} [deps]
 */
function recordLivenessOverride(batch, action, liveness, deps) {
  batch.overrides = [...(batch.overrides || []), { at: nowIso(deps), action, liveness: liveness.reason }];
  const open = currentEntry(batch);
  if (open) open.override = true;
}

/**
 * Re-read the open entry after a takeover: already confirmed -> done, otherwise
 * back to the queue with its marker cleared.
 *
 * @param {Record<string, any>} batch
 * @param {BatchDeps} [deps]
 */
async function reconcileOpenEntry(batch, deps, { dryRun = false } = {}) {
  const entry = currentEntry(batch);
  if (!entry) return;
  if (!dryRun) await clearRunningMarker(batch.dataDir, batch.workspaceFolder, entry.targetId);
  const confirmation = await readEntryConfirmation(batch.dataDir, batch.workspaceFolder, entry);
  if (confirmation.confirmed) {
    entry.finishedAt = nowIso(deps);
    // Same classification as a live report: a no-code proof on a smart-merge
    // entry whose prepared result still has changes is not a merge.
    if (entry.mode === 'smart-merge' && confirmation.noCode && !preparedResultIsEmpty(batch.dataDir, entry, confirmation.todo)) {
      entry.state = 'failed';
      entry.reason = 'no_code_with_changes';
      await blockSequentialSiblings(batch, entry, deps);
      return;
    }
    entry.state = entry.mode === 'verify' ? 'verified' : 'merged';
    entry.reason = 'confirmed_on_recovery';
    return;
  }
  entry.state = 'queued';
  entry.reason = '';
  entry.prompt = '';
  entry.pendingConfirms = 0;
}

/**
 * Rotate the capability: the old agent's next call answers 409 `stale_epoch`.
 *
 * @param {Record<string, any>} batch
 * @returns {string} the new secret
 */
function rotateEpoch(batch) {
  const secret = randomBytes(24).toString('base64url');
  batch.epoch += 1;
  batch.epochTokens = { ...(batch.epochTokens || {}), [batch.epoch]: hashSecret(secret) };
  return secret;
}

/**
 * Resume a paused / stalled (or force-taken-over running) batch with a fresh
 * epoch and a new wrapper prompt; the route opens the new chat.
 *
 * `openChat` runs after every validation and before the epoch rotates, so a
 * chat that cannot be created leaves the batch exactly as it was.
 *
 * @param {{ dataDir: string, batchId: string, entryAction?: 'retry' | 'skip', forceLiveness?: boolean, openChat?: () => ({ chat?: { id: string }, error?: Record<string, any> }), deps?: BatchDeps }} input
 * @returns {Promise<{ ok: boolean, reason?: string, detail?: Record<string, any>, response?: Record<string, any>, view?: Record<string, any>, secret?: string, prompt?: string, chat?: Record<string, any> | null }>}
 */
export function resumeIntegrateBatch(input) {
  return serializeBatchCall(input.dataDir, input.batchId, () => resumeIntegrateBatchSerialized(input));
}

/** @param {any} input */
async function resumeIntegrateBatchSerialized(input) {
  const { dataDir, deps } = input;
  const batch = loadBatch(dataDir, input.batchId);
  if (!batch) return { ok: false, reason: 'not_found' };
  if (!['running', 'paused', 'stalled', 'cancelling'].includes(batch.status)) return { ok: false, reason: 'not_resumable' };
  // Takeover needs positive idle evidence or an explicit override.
  const liveness = probeBatchLiveness(batch, deps);
  if (!liveness.idle && input.forceLiveness !== true) {
    return { ok: false, reason: liveness.busy ? 'agent_busy' : 'liveness_unknown', detail: liveness };
  }
  const entryAction = input.entryAction === 'skip' ? 'skip' : 'retry';
  const wasCancelling = batch.status === 'cancelling';
  const wasPaused = batch.status === 'paused' || (wasCancelling && Boolean(batch.pausedEntryId));
  // Every resume (paused, stalled or forced running takeover) needs a safe
  // boundary; a paused batch is additionally compared with the failed entry's
  // dispatch snapshot.
  const pausedEntry = wasPaused ? batch.entries.find((/** @type {any} */ row) => row.id === batch.pausedEntryId) || null : null;
  const inspect = typeof deps?.inspectBoundary === 'function' ? deps.inspectBoundary : inspectWorkspaceBoundary;
  const evaluated = evaluateBoundary({
    snapshot: pausedEntry?.snapshot || null,
    current: inspect({ workspaceFolder: batch.workspaceFolder }),
    driftIgnored: !pausedEntry?.snapshot,
  });
  if (!evaluated.safe) {
    return { ok: false, reason: 'boundary_unsafe', detail: { reasons: evaluated.reasons, paths: evaluated.paths } };
  }
  // Project the outcome on a copy (no side effects) so a chat is only created
  // when an agent will actually have work left after reconcile / sibling skip.
  const projected = structuredClone(batch);
  await reconcileOpenEntry(projected, deps, { dryRun: true });
  if (wasPaused) {
    const failedProjection = projected.entries.find((/** @type {any} */ row) => row.id === projected.pausedEntryId) || null;
    if (failedProjection?.state === 'failed') {
      if (entryAction === 'retry') failedProjection.state = 'queued';
      else await blockSequentialSiblings(projected, failedProjection, deps);
    }
  }
  const needsAgent = !wasCancelling && projected.entries.some((/** @type {any} */ row) => row.state === 'queued' || ENTRY_OPEN_STATES.includes(row.state));
  const linkTodoIds = needsAgent
    ? [...new Set(projected.entries
      .filter((/** @type {any} */ row) => row.state === 'queued' || ENTRY_OPEN_STATES.includes(row.state))
      .flatMap((/** @type {any} */ row) => [row.todoId, row.targetId]).filter(Boolean))]
    : [];
  let chat = null;
  if (typeof input.openChat === 'function' && needsAgent) {
    let opened;
    try {
      opened = input.openChat();
    } catch (error) {
      return { ok: false, reason: 'chat_unavailable', detail: { message: error instanceof Error ? error.message : String(error) } };
    }
    if (opened?.error) return { ok: false, reason: 'chat_unavailable', response: opened.error };
    chat = opened?.chat || null;
  }
  if (!liveness.idle) recordLivenessOverride(batch, 'resume', liveness, deps);
  const secret = rotateEpoch(batch);
  await reconcileOpenEntry(batch, deps);
  if (wasPaused) {
    const failed = batch.entries.find((/** @type {any} */ row) => row.id === batch.pausedEntryId) || null;
    if (failed && failed.state === 'failed') {
      if (entryAction === 'retry') {
        await clearRunningMarker(batch.dataDir, batch.workspaceFolder, failed.targetId);
        failed.state = 'queued';
        failed.reason = '';
        failed.prompt = '';
        failed.pendingConfirms = 0;
        failed.finishedAt = '';
      } else {
        await blockSequentialSiblings(batch, failed, deps);
      }
    }
  }
  batch.status = wasCancelling ? 'cancelling' : 'running';
  batch.pausedReason = '';
  batch.pausedPaths = [];
  batch.pausedEntryId = '';
  batch.chatId = '';
  batch.runId = '';
  batch.heartbeatAt = nowIso(deps);
  if (wasCancelling) settleCancelling(batch, deps);
  finalizeIfDone(batch, deps);
  const terminal = BATCH_TERMINAL_STATUSES.includes(batch.status);
  if (chat && !terminal) batch.chatId = readString(chat.id);
  saveBatch(dataDir, batch, deps);
  if (chat && !terminal) {
    bindIntegrationLockChat({ dataDir, workspaceFolder: batch.workspaceFolder, batchId: batch.id, chatId: batch.chatId });
  }
  return {
    ok: true,
    view: toBatchView(batch),
    secret,
    prompt: terminal ? '' : buildBatchWrapperPrompt(batch, secret),
    chat: terminal ? null : chat,
    todoIds: terminal ? [] : linkTodoIds,
  };
}

/**
 * Abandon: terminal. Clears the running marker, ends queued entries, keeps every
 * worktree and releases the lock.
 *
 * @param {{ dataDir: string, batchId: string, forceLiveness?: boolean, deps?: BatchDeps }} input
 * @returns {Promise<{ ok: boolean, reason?: string, detail?: Record<string, any>, view?: Record<string, any> }>}
 */
export function abandonIntegrateBatch(input) {
  return serializeBatchCall(input.dataDir, input.batchId, () => abandonIntegrateBatchSerialized(input));
}

/** @param {any} input */
async function abandonIntegrateBatchSerialized(input) {
  const { dataDir, deps } = input;
  const batch = loadBatch(dataDir, input.batchId);
  if (!batch) return { ok: false, reason: 'not_found' };
  if (BATCH_TERMINAL_STATUSES.includes(batch.status)) return { ok: false, reason: 'not_active' };
  const probe = probeBatchLiveness(batch, deps);
  if (!probe.idle && input.forceLiveness !== true && currentEntry(batch)) {
    return { ok: false, reason: probe.busy ? 'agent_busy' : 'liveness_unknown', detail: probe };
  }
  if (!probe.idle && currentEntry(batch)) recordLivenessOverride(batch, 'abandon', probe, deps);
  rotateEpoch(batch);
  await reconcileOpenEntry(batch, deps);
  for (const entry of batch.entries) {
    if (entry.state === 'queued') {
      entry.state = 'cancelled';
      entry.reason = 'batch_abandoned';
      entry.finishedAt = nowIso(deps);
    }
  }
  batch.status = 'abandoned';
  batch.finishedAt = nowIso(deps);
  releaseBatchIntegrationLock({ dataDir, workspaceFolder: batch.workspaceFolder, batchId: batch.id });
  saveBatch(dataDir, batch, deps);
  return { ok: true, view: toBatchView(batch) };
}
