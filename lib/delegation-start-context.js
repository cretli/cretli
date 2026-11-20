/**
 * Server-owned provenance for delegation starts
 * (`docs/model-pick-decisions.md`, "Automatic start context").
 *
 * Three pieces, none of them settable from a request body:
 * - the controller's start context (`automatic` | `human_ad_hoc` |
 *   `legacy_ad_hoc`), persisted when the server launches an orchestrator and
 *   otherwise derived from durable server evidence;
 * - single-use, expiring UI action records minted only for an authenticated
 *   human browser session, bound to chat/workspace/role/executor/task;
 * - validation of a continuation of an earlier completed assignment.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { delegationController } from './delegation-control.js';
import { decodeModelValue } from './model-catalog.js';
import { isDelegationSlotOccupied } from './delegation-status.js';
import { normalizeDelegationWorkspaceKey } from './delegation-workspace-guard.js';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { resolveDataPath } from './runtime-paths.js';

export const DELEGATION_START_CONTEXTS = Object.freeze({
  automatic: 'automatic',
  humanAdHoc: 'human_ad_hoc',
  legacyAdHoc: 'legacy_ad_hoc',
});

/** Lifetime of a minted UI action: one click, not a standing grant. */
export const DELEGATION_UI_ACTION_TTL_MS = 2 * 60 * 1000;
const MAX_STORED_ACTIONS = 200;

/**
 * @param {string} [dataDir]
 * @returns {string}
 */
function storeFile(dataDir) {
  const override = String(dataDir || '').trim();
  return override ? path.join(override, 'delegation-start-context.json') : resolveDataPath('delegation-start-context.json');
}

/**
 * @param {string} [dataDir]
 * @returns {{ contexts: Record<string, Record<string, any>>, actions: Record<string, Record<string, any>> }}
 */
function readStore(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(dataDir), 'utf8'));
    return {
      contexts: parsed?.contexts && typeof parsed.contexts === 'object' ? parsed.contexts : {},
      actions: parsed?.actions && typeof parsed.actions === 'object' ? parsed.actions : {},
    };
  } catch {
    return { contexts: {}, actions: {} };
  }
}

/**
 * @param {{ contexts: Record<string, any>, actions: Record<string, any> }} store
 * @param {string} [dataDir]
 * @param {number} now
 * @returns {void}
 */
function writeStore(store, dataDir, now) {
  const live = Object.entries(store.actions)
    .filter(([, row]) => !row.consumedAt && Date.parse(row.expiresAt) > now - DELEGATION_UI_ACTION_TTL_MS)
    .slice(-MAX_STORED_ACTIONS);
  writeJsonAtomic(storeFile(dataDir), { contexts: store.contexts, actions: Object.fromEntries(live) });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDelegationStartContext(value) {
  const raw = String(value || '').trim().toLowerCase();
  return Object.values(DELEGATION_START_CONTEXTS).includes(raw) ? raw : '';
}

/**
 * Persist the controller context at the moment the server creates or adopts an
 * orchestrator parent, before any child can start. First write wins for
 * `automatic`; an ad-hoc marker never downgrades an automatic parent.
 *
 * @param {string} chatId
 * @param {string} context
 * @param {{ source?: string, dataDir?: string }} [options]
 * @returns {boolean}
 */
export function persistDelegationStartContext(chatId, context, options = {}) {
  const id = String(chatId || '').trim();
  const normalized = normalizeDelegationStartContext(context);
  if (!id || !normalized) return false;
  const store = readStore(options.dataDir);
  if (store.contexts[id]?.context === DELEGATION_START_CONTEXTS.automatic) return true;
  store.contexts[id] = {
    context: normalized,
    source: String(options.source || '').trim(),
    at: new Date().toISOString(),
  };
  writeStore(store, options.dataDir, Date.now());
  return true;
}

/**
 * Mark a server-launched orchestration parent (TODO execution, Watcher cycle).
 *
 * @param {string} chatId
 * @param {string} source
 * @param {{ dataDir?: string }} [options]
 * @returns {boolean}
 */
export function markDelegationAutomaticController(chatId, source, options = {}) {
  return persistDelegationStartContext(chatId, DELEGATION_START_CONTEXTS.automatic, { ...options, source });
}

/**
 * Durable server evidence that a parent is an orchestrator. A caller-editable
 * `orchestratorChatId` on a todo is deliberately NOT evidence on its own.
 *
 * @param {{
 *   parent?: object | null,
 *   isWatcherCycleChat?: (chatId: string, workspaceFolder: string) => boolean,
 *   isTodoExecutionChat?: (parent: object) => boolean,
 * }} input
 * @returns {string} evidence label, or ''
 */
export function findAutomaticControllerEvidence(input = {}) {
  const parent = /** @type {Record<string, any>} */ (input.parent);
  const chatId = String(parent?.id || '').trim();
  if (!chatId) return '';
  if (String(parent.pickPurpose || '').trim() === 'watcher-orchestrator') return 'watcher_orchestrator_chat';
  const workspaceFolder = String(parent.workspaceFolder || '').trim();
  try {
    if (input.isWatcherCycleChat?.(chatId, workspaceFolder)) return 'watcher_active_cycle';
  } catch { /* evidence lookup is best-effort */ }
  try {
    if (input.isTodoExecutionChat?.(parent)) return 'todo_execution_chat';
  } catch { /* evidence lookup is best-effort */ }
  return '';
}

/**
 * @param {{
 *   parent?: object | null,
 *   dataDir?: string,
 *   isWatcherCycleChat?: Function,
 *   isTodoExecutionChat?: Function,
 *   persist?: boolean,
 * }} input
 * @returns {{ context: string, source: string, derived: boolean }}
 */
export function resolveDelegationStartContext(input = {}) {
  const chatId = String(input.parent?.id || '').trim();
  const stored = chatId ? readStore(input.dataDir).contexts[chatId] : null;
  const storedContext = normalizeDelegationStartContext(stored?.context);
  if (storedContext === DELEGATION_START_CONTEXTS.automatic) {
    return { context: storedContext, source: String(stored.source || 'persisted'), derived: false };
  }
  const evidence = findAutomaticControllerEvidence(input);
  if (evidence) {
    if (input.persist !== false) markDelegationAutomaticController(chatId, evidence, { dataDir: input.dataDir });
    return { context: DELEGATION_START_CONTEXTS.automatic, source: evidence, derived: true };
  }
  if (storedContext) return { context: storedContext, source: String(stored.source || 'persisted'), derived: false };
  // No execution evidence: an old ad-hoc chat keeps its legacy behavior and is
  // shown with unknown provenance. History is never manufactured.
  return { context: DELEGATION_START_CONTEXTS.legacyAdHoc, source: 'no_execution_evidence', derived: true };
}

/**
 * @param {unknown} model
 * @returns {string}
 */
function baseModelId(model) {
  return decodeModelValue(String(model || '').trim()).modelId.toLowerCase();
}

/**
 * @param {unknown} text
 * @returns {string}
 */
export function hashDelegationUiActionTask(text) {
  return createHash('sha256').update(String(text || '').trim()).digest('hex');
}

/**
 * @param {{
 *   parentChatId?: string,
 *   workspaceFolder?: string,
 *   role?: string,
 *   harness?: string,
 *   model?: string,
 *   taskHash?: string,
 *   ttlMs?: number,
 *   now?: number,
 *   dataDir?: string,
 * }} input
 * @returns {{ ok: boolean, id?: string, expiresAt?: string, code?: string, error?: string }}
 */
export function mintDelegationUiAction(input = {}) {
  const parentChatId = String(input.parentChatId || '').trim();
  const harness = String(input.harness || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  if (!parentChatId || !harness || !model) {
    return { ok: false, code: 'validation', error: 'parentChatId, harness and model are required.' };
  }
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const ttl = Math.min(Math.max(Number(input.ttlMs) || DELEGATION_UI_ACTION_TTL_MS, 1000), 10 * 60 * 1000);
  const id = randomUUID();
  const store = readStore(input.dataDir);
  store.actions[id] = {
    parentChatId,
    workspaceKey: normalizeDelegationWorkspaceKey(input.workspaceFolder),
    role: String(input.role || '').trim().toLowerCase(),
    harness,
    model: baseModelId(model),
    taskHash: String(input.taskHash || '').trim(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    consumedAt: '',
  };
  writeStore(store, input.dataDir, now);
  return { ok: true, id, expiresAt: store.actions[id].expiresAt };
}

/**
 * Check an action against the start without consuming it.
 *
 * @param {Record<string, any>} input same bindings as {@link consumeDelegationUiAction}
 * @returns {{ ok: boolean, code?: string, error?: string, action?: Record<string, any> }}
 */
export function inspectDelegationUiAction(input = {}) {
  const id = String(input.id || '').trim();
  const fail = (code, error) => ({ ok: false, code, error });
  if (!id) return fail('ui_action_missing', 'A UI action proof is required.');
  const action = readStore(input.dataDir).actions[id];
  if (!action) return fail('ui_action_unknown', 'Unknown or already used UI action.');
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  if (action.consumedAt) return fail('ui_action_used', 'This UI action was already used.');
  if (Date.parse(action.expiresAt) <= now) return fail('ui_action_expired', 'This UI action expired.');
  if (action.parentChatId !== String(input.parentChatId || '').trim()) {
    return fail('ui_action_foreign', 'This UI action belongs to another chat.');
  }
  if (action.workspaceKey && action.workspaceKey !== normalizeDelegationWorkspaceKey(input.workspaceFolder)) {
    return fail('ui_action_foreign', 'This UI action belongs to another workspace.');
  }
  if (action.role && action.role !== String(input.role || '').trim().toLowerCase()) {
    return fail('ui_action_mismatch', 'This UI action was minted for another role.');
  }
  if (action.harness !== String(input.harness || '').trim().toLowerCase()
    || action.model !== baseModelId(input.model)) {
    return fail('ui_action_mismatch', 'This UI action was minted for another executor.');
  }
  if (action.taskHash && action.taskHash !== String(input.taskHash || '').trim()) {
    return fail('ui_action_mismatch', 'This UI action was minted for another task.');
  }
  return { ok: true, action };
}

/**
 * Atomically consume a UI action. Only the human channel may consume one; the
 * caller passes the actor derived from the authenticated request.
 *
 * @param {{
 *   id?: string,
 *   actor?: string,
 *   parentChatId?: string,
 *   workspaceFolder?: string,
 *   role?: string,
 *   harness?: string,
 *   model?: string,
 *   taskHash?: string,
 *   now?: number,
 *   dataDir?: string,
 * }} input
 * @returns {{ ok: boolean, code?: string, error?: string }}
 */
export function consumeDelegationUiAction(input = {}) {
  if (String(input.actor || '').trim().toLowerCase() !== 'human') {
    return { ok: false, code: 'ui_action_forbidden', error: 'UI actions can only be used from the human UI channel.' };
  }
  const checked = inspectDelegationUiAction(input);
  if (!checked.ok) return checked;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const store = readStore(input.dataDir);
  const id = String(input.id).trim();
  store.actions[id] = { ...store.actions[id], consumedAt: new Date(now).toISOString() };
  writeStore(store, input.dataDir, now);
  return { ok: true };
}

/**
 * Validate an explicit continuation of an earlier completed assignment: same
 * controller and leaf, a real usable prior run of the same role family on the
 * SAME executor, no run currently holding the slot. All current start gates
 * still run afterwards; this is evidence, not an exemption.
 *
 * @param {{
 *   continuationOf?: string,
 *   previous?: object | null,
 *   parentChatId?: string,
 *   leafId?: string,
 *   role?: string,
 *   harness?: string,
 *   model?: string,
 * }} input
 * @returns {{ ok: boolean, code?: string, error?: string }}
 */
export function validateDelegationContinuation(input = {}) {
  const prev = /** @type {Record<string, any>} */ (input.previous);
  const fail = (error) => ({ ok: false, code: 'invalid_continuation', error });
  if (!prev || typeof prev !== 'object' || String(prev.id || '') !== String(input.continuationOf || '').trim()) {
    return fail('continuation_of must name an existing delegation.');
  }
  if (delegationController(prev) !== String(input.parentChatId || '').trim()) {
    return fail('continuation_of belongs to another controller.');
  }
  const leaf = String(input.leafId || '').trim();
  if (!leaf || String(prev.leafId || '').trim() !== leaf) {
    return fail('A continuation must stay within the same leaf.');
  }
  const family = (role) => (role === 'fix' || role === 'implement' ? 'implement' : role);
  const prevRole = String(prev.pickRole || prev.assignment || '').trim().toLowerCase();
  if (family(prevRole) !== family(String(input.role || '').trim().toLowerCase())) {
    return fail('A continuation must keep the role of the earlier assignment.');
  }
  if (String(prev.status || '') !== 'completed' || prev.unusable === true) {
    return fail('Only a completed prior assignment can be continued; use a new pick after a failure.');
  }
  if (isDelegationSlotOccupied(prev)) return fail('The earlier assignment still holds its slot.');
  const sameExecutor = String(prev.executor?.transport || '').trim().toLowerCase()
    === String(input.harness || '').trim().toLowerCase()
    && baseModelId(prev.executor?.model) === baseModelId(input.model);
  if (!sameExecutor) return fail('A continuation must use the same executor as the earlier assignment.');
  return { ok: true };
}
