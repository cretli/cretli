/**
 * Pure helpers for the bulk "integrate with agent" selection mode.
 *
 * No DOM: the panel and the unit tests feed the todo list payload (and the set of
 * collapsed ids) directly. The server's read-only `batchEligibility.mode` field is
 * the single source of truth for selectability; the client never re-derives it.
 * See docs/todo-integration-contract.md (Bulk integrate).
 */
import { flattenTodoTree, isBatchSelectableItem } from './todoTreeView.js';

/** Batch record statuses while the queue still owns the workspace lock. */
export const BATCH_ACTIVE_STATUSES = Object.freeze(['running', 'paused', 'stalled', 'cancelling']);
/** Batch record statuses after the queue ended. */
export const BATCH_TERMINAL_STATUSES = Object.freeze(['completed', 'cancelled', 'abandoned']);
/** Per-entry states the server reports on every batch record. */
export const BATCH_ENTRY_STATES = Object.freeze([
  'queued',
  'running',
  'awaiting_confirmation',
  'merged',
  'verified',
  'failed',
  'skipped',
  'cancelled',
]);

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isActiveBatchStatus(status) {
  return BATCH_ACTIVE_STATUSES.includes(String(status || '').trim());
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminalBatchStatus(status) {
  return BATCH_TERMINAL_STATUSES.includes(String(status || '').trim());
}

/** Re-exported so selection code and tests share one definition. */
export { isBatchSelectableItem };

/**
 * Eligible, currently visible rows in visible list order.
 *
 * Visible means: already filtered by the caller and not hidden behind a collapsed
 * ancestor. Hidden eligible rows are intentionally not part of the select-all set,
 * so "select all eligible" always matches what the operator can see.
 *
 * @param {{ items?: object[] | null, collapsedIds?: Iterable<string> | null }} [input]
 * @returns {{ rows: object[], eligibleIds: string[], eligibleSet: Set<string> }}
 */
export function buildBatchSelection(input = {}) {
  const rows = flattenTodoTree(input.items, input.collapsedIds);
  const visibleRows = rows.map((row) => row.item).filter((item) => item?.id);
  const eligibleIds = visibleRows
    .filter((item) => isBatchSelectableItem(item))
    .map((item) => String(item.id));
  return { rows: visibleRows, eligibleIds, eligibleSet: new Set(eligibleIds) };
}

/**
 * Order the selected ids by the visible list order (never by click order), which
 * is the order the server receives and preserves.
 *
 * @param {Iterable<string> | Set<string> | null | undefined} selectedIds
 * @param {string[] | null | undefined} eligibleIds
 * @returns {string[]}
 */
export function buildBatchRequestIds(selectedIds, eligibleIds) {
  const selected = selectedIds instanceof Set
    ? selectedIds
    : new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const eligible = Array.isArray(eligibleIds) ? eligibleIds : [];
  return eligible
    .map((id) => String(id))
    .filter((id) => selected.has(id));
}

/**
 * Drop ids that are no longer eligible (filter change, collapse, new list payload)
 * so a hidden row can never be sent.
 *
 * @param {Iterable<string> | Set<string> | null | undefined} selectedIds
 * @param {string[] | null | undefined} eligibleIds
 * @returns {Set<string>}
 */
export function pruneBatchSelection(selectedIds, eligibleIds) {
  const eligible = new Set((Array.isArray(eligibleIds) ? eligibleIds : []).map((id) => String(id)));
  const selected = selectedIds instanceof Set
    ? selectedIds
    : new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const next = new Set();
  for (const id of selected) {
    const key = String(id);
    if (eligible.has(key)) next.add(key);
  }
  return next;
}

/**
 * The entry covering a todo row (the selected todo, or its integration target).
 *
 * @param {object | null | undefined} batch
 * @param {unknown} todoId
 * @returns {object | null}
 */
export function findBatchEntryForTodo(batch, todoId) {
  const id = String(todoId || '').trim();
  const entries = Array.isArray(batch?.entries) ? batch.entries : [];
  if (!id) return null;
  return entries.find((entry) => String(entry?.todoId || '') === id)
    || entries.find((entry) => String(entry?.targetId || '') === id)
    || null;
}

/**
 * Split a server reason such as `aliased:<targetId>` or `blocked_by:<entryId>`
 * into a stable kind and its payload, so the UI can pick a localized template.
 *
 * @param {unknown} reason
 * @returns {{ kind: string, target: string }}
 */
export function parseBatchReason(reason) {
  const raw = String(reason || '').trim();
  if (!raw) return { kind: '', target: '' };
  const separator = raw.indexOf(':');
  if (separator < 0) return { kind: raw, target: '' };
  return { kind: raw.slice(0, separator), target: raw.slice(separator + 1) };
}

/**
 * Entry-state counts for the banner; `counts` is keyed by state.
 *
 * @param {object | null | undefined} batch
 * @returns {{ total: number, counts: Record<string, number> }}
 */
export function summarizeBatchEntries(batch) {
  const counts = {};
  for (const entry of Array.isArray(batch?.entries) ? batch.entries : []) {
    const state = String(entry?.state || '');
    if (!state) continue;
    counts[state] = (counts[state] || 0) + 1;
  }
  const total = (Array.isArray(batch?.entries) ? batch.entries : []).length;
  return { total, counts };
}

/**
 * Pick the batch a panel should track from the list payload. An active batch
 * always wins over a tracked terminal one (another device may have started a new
 * batch while this panel still shows the finished one); a still-active tracked
 * batch is kept over other active ones. `batches` is newest first.
 *
 * @param {object[] | null | undefined} batches
 * @param {object | null | undefined} tracked
 * @returns {object | null}
 */
export function resolveBatchToTrack(batches, tracked) {
  const list = Array.isArray(batches) ? batches : [];
  const trackedId = String(tracked?.id || '').trim();
  const match = trackedId
    ? list.find((batch) => String(batch?.id || '') === trackedId) || null
    : null;
  if (match && isActiveBatchStatus(match.status)) return match;
  const active = list.find((batch) => isActiveBatchStatus(batch?.status)) || null;
  return active || match;
}

/**
 * Which banner controls apply to a batch. The server allows cancel / abandon on
 * any non-terminal batch; resume is offered for paused / stalled batches and,
 * as an explicitly confirmed forced recovery, for a running batch whose liveness
 * is unknown (for example a record left `running` by a server restart).
 *
 * @param {object | null | undefined} batch
 * @returns {{
 *   canCancel: boolean, cancelDisabled: boolean, canResume: boolean,
 *   needsForce: boolean, livenessUnknown: boolean, canAbandon: boolean, canDismiss: boolean,
 * }}
 */
export function resolveBatchControls(batch) {
  const status = String(batch?.status || '').trim();
  const active = isActiveBatchStatus(status);
  const liveness = batch?.liveness && typeof batch.liveness === 'object' ? batch.liveness : null;
  const livenessUnknown = active && !!liveness && liveness.known === false;
  const paused = status === 'paused' || status === 'stalled';
  return {
    canCancel: active,
    cancelDisabled: status === 'cancelling',
    canResume: paused || (livenessUnknown && (status === 'running' || status === 'cancelling')),
    needsForce: !!liveness && liveness.idle === false,
    livenessUnknown,
    canAbandon: active,
    canDismiss: isTerminalBatchStatus(status),
  };
}

/**
 * Capture the scope a mutation was started in (workspace folder plus a counter
 * that is bumped on every workspace switch).
 *
 * @param {string} folder
 * @param {number} generation
 * @returns {{ folder: string, generation: number }}
 */
export function captureBatchScope(folder, generation) {
  return { folder: String(folder || ''), generation: Number(generation) || 0 };
}

/**
 * Whether a response may still be applied: same generation and the captured
 * folder still is the current workspace.
 *
 * @param {{ folder: string, generation: number } | null | undefined} captured
 * @param {number} currentGeneration
 * @param {(folder: string) => boolean} matchesCurrentFolder
 * @returns {boolean}
 */
export function isBatchScopeCurrent(captured, currentGeneration, matchesCurrentFolder) {
  if (!captured) return false;
  if (captured.generation !== currentGeneration) return false;
  return typeof matchesCurrentFolder === 'function' ? matchesCurrentFolder(captured.folder) === true : true;
}

/**
 * Monotonic request gate: only the response of the newest request is applied.
 *
 * @returns {{ next: () => number, isLatest: (token: number) => boolean }}
 */
export function createLatestRequestGate() {
  let latest = 0;
  return {
    next: () => {
      latest += 1;
      return latest;
    },
    isLatest: (token) => token === latest,
  };
}

/**
 * Pending flag owned by a single request: a late response of a request that
 * was reset (workspace switch) must not clear the guard of a newer request.
 *
 * @returns {{ begin: () => number, release: (token: number) => boolean, reset: () => void, isPending: () => boolean }}
 */
export function createOwnedPendingGuard() {
  let owner = 0;
  let counter = 0;
  return {
    begin: () => {
      counter += 1;
      owner = counter;
      return owner;
    },
    release: (token) => {
      if (owner === 0 || token !== owner) return false;
      owner = 0;
      return true;
    },
    reset: () => {
      owner = 0;
    },
    isPending: () => owner !== 0,
  };
}

/** Entry states the server re-dispatches on resume (mirrors `lib/integrate-batch.js`). */
const RESUME_WORK_STATES = Object.freeze(['queued', 'running', 'awaiting_confirmation']);

/**
 * Whether a resume needs an agent (harness / model). The server opens a chat only
 * when the resumed queue has work left: a cancelling batch only closes the queue,
 * and a batch with nothing queued / open (and no failed entry to retry) opens no
 * chat. When the outcome is uncertain the picker is still offered.
 *
 * @param {{ status?: string, entries?: Array<{ id?: string, state?: string }>, pausedEntryId?: string } | null | undefined} batch
 * @param {{ harness: string, model: string } | null | undefined} known
 * @param {'retry' | 'skip'} [entryAction]
 * @returns {{ needsPicker: boolean, agent: { harness: string, model: string } | null }}
 */
export function resolveResumeAgentNeed(batch, known, entryAction = 'retry') {
  if (batch?.status === 'cancelling') return { needsPicker: false, agent: known || null };
  if (known) return { needsPicker: false, agent: known };
  const entries = Array.isArray(batch?.entries) ? batch.entries : null;
  if (entries && !willResumeOpenChat(batch, entries, entryAction)) {
    return { needsPicker: false, agent: null };
  }
  return { needsPicker: true, agent: null };
}

/**
 * @param {{ status?: string, pausedEntryId?: string }} batch
 * @param {Array<{ id?: string, state?: string }>} entries
 * @param {'retry' | 'skip'} entryAction
 * @returns {boolean}
 */
function willResumeOpenChat(batch, entries, entryAction) {
  if (entries.some((entry) => RESUME_WORK_STATES.includes(String(entry?.state || '')))) return true;
  // A paused batch re-queues its failed entry on retry; skip may unblock siblings, so stay conservative.
  const failedPaused = batch?.status === 'paused'
    && entries.some((entry) => entry?.id === batch.pausedEntryId && entry?.state === 'failed');
  return failedPaused && entryAction === 'retry';
}

/**
 * Whether the "clear lock" control is offered. A lock owned by the batch the
 * panel tracks is released through cancel / abandon instead, so only a stranded
 * single-flow lock (or a lock whose batch is no longer active) is clearable.
 *
 * @param {{ owner?: string, batchId?: string } | null | undefined} lock
 * @param {{ id?: string, status?: string } | null | undefined} activeBatch
 * @returns {boolean}
 */
export function canClearIntegrationLock(lock, activeBatch) {
  if (!lock || typeof lock !== 'object') return false;
  if (lock.owner !== 'batch') return true;
  const ownsTracked = !!activeBatch && isActiveBatchStatus(String(activeBatch.status || ''))
    && (!lock.batchId || lock.batchId === activeBatch.id);
  return !ownsTracked;
}

/**
 * Localized label for a server reason. Handles a single reason (`aliased:<id>`),
 * the comma separated pause / boundary lists (`unmerged_paths,workspace_drift`)
 * and the `boundary_unsafe:<a,b>` / `inspection_failed:<why>` prefixes. Lookup
 * order per token: scope specific key, shared `todo.batchPause_<kind>`, then a
 * generic template. The raw token always survives in the generic template, so an
 * unknown reason is never lost; callers render the result with `textContent`.
 *
 * @param {unknown} reason
 * @param {(key: string, params?: Record<string, string>) => string} translate
 * @param {'entry' | 'skip' | 'pause'} [scope]
 * @returns {string}
 */
export function localizeBatchReason(reason, translate, scope = 'entry') {
  const raw = String(reason || '').trim();
  if (!raw) return '';
  const genericKey = scope === 'skip' ? 'todo.batchSkip_generic' : 'todo.batchEntryReason';
  const lookup = (key) => {
    const text = translate(key);
    return text && text !== key ? text : '';
  };
  const describe = (token) => {
    const { kind, target } = parseBatchReason(token);
    if (!kind) return '';
    const scoped = scope === 'skip' ? `todo.batchSkip_${kind}` : `todo.batchReason_${kind}`;
    let text = lookup(scoped) || lookup(`todo.batchPause_${kind}`);
    if (!text) return translate(genericKey, { reason: token });
    if (kind === 'boundary_unsafe' && target) {
      return `${text}: ${target.split(',').map((part) => describe(part.trim())).filter(Boolean).join(', ')}`;
    }
    if (target) text = `${text} (${target.length > 24 ? target.slice(0, 8) : target})`;
    return text;
  };
  if (raw.startsWith('boundary_unsafe:')) return describe(raw);
  return raw.split(',').map((token) => describe(token.trim())).filter(Boolean).join(', ');
}

/**
 * Failure body -> user text. A localized per-reason key wins; then a server
 * message; then `error` when it already is a sentence (the 503 `sdk.noApiKey`
 * answer puts its localized text there); then the fallback key.
 *
 * @param {{ error?: string, message?: string, detail?: { reasons?: string[] } } | null | undefined} result
 * @param {(key: string, params?: Record<string, string>) => string} translate
 * @param {string} [fallbackKey]
 * @returns {string}
 */
export function describeBatchFailure(result, translate, fallbackKey = 'todo.batchFailed') {
  const error = String(result?.error || '').trim();
  let text = '';
  if (error && /^[a-z0-9_]+$/.test(error)) {
    const key = `todo.batchError_${error}`;
    const found = translate(key);
    if (found && found !== key) text = found;
  }
  if (!text) text = String(result?.message || '').trim();
  if (!text && error && !/^[a-z0-9_]+$/.test(error)) text = error;
  if (!text) text = translate(fallbackKey);
  const reasons = Array.isArray(result?.detail?.reasons) ? result.detail.reasons : [];
  const localized = reasons
    .map((reason) => localizeBatchReason(reason, translate, 'pause'))
    .filter(Boolean);
  return localized.length ? `${text} (${localized.join(', ')})` : text;
}
