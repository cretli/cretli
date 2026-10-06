/**
 * Model pick proposals, pick→start linking, and execution counters.
 */

import { decodeModelValue } from './model-catalog.js';
import { normalizeDelegationWorkspaceKey } from './delegation-workspace-guard.js';
import { MODEL_PICK_ROLES } from './model-role-profiles.js';
import {
  MODEL_PICK_MAX_CANDIDATES,
  MODEL_PICK_MAX_SLOTS,
  MODEL_PICK_POLICY_VERSION,
} from './model-pick-policy.js';
import {
  createModelPickRecord,
  getModelPickRecord,
  loadModelPickRecords,
  normalizeSlotKey,
  purgeStaleModelPickRecords,
  releaseModelPickSlotsForDelegation,
  reserveModelPickSlot,
} from './persist/model-pick-decisions-persist.js';

export {
  MODEL_PICK_POLICY_VERSION,
  getModelPickRecord,
  loadModelPickRecords,
  purgeStaleModelPickRecords,
  releaseModelPickSlotsForDelegation,
  reserveModelPickSlot,
};

/**
 * Known explicit human/operator executor choices. Anything else supplied as
 * `manual_source` is not trusted and never produces `origin=manual`.
 */
export const MODEL_PICK_MANUAL_SOURCES = Object.freeze([
  'manual',
  'user',
  'operator',
  'ui',
  'settings-ui',
  'todo-assignee',
]);

/**
 * @param {unknown} value
 * @returns {string} normalized allow-listed source, or ''
 */
export function normalizeManualPickSource(value) {
  const raw = String(value || '').trim().toLowerCase();
  return MODEL_PICK_MANUAL_SOURCES.includes(raw) ? raw : '';
}

/**
 * @param {unknown} assignment
 * @param {unknown} executionMode
 * @param {unknown} [explicitRole]
 * @returns {'plan' | 'implement' | 'review' | 'fix' | ''}
 */
export function resolveDelegationPickRole(assignment, executionMode, explicitRole) {
  const wanted = String(explicitRole || '').trim().toLowerCase();
  if (MODEL_PICK_ROLES.includes(/** @type {import('./model-role-profiles.js').ModelPickRole} */ (wanted))) {
    return /** @type {'plan' | 'implement' | 'review' | 'fix'} */ (wanted);
  }
  const mode = String(executionMode || '').trim().toLowerCase();
  const assign = String(assignment || '').trim().toLowerCase();
  if (assign === 'fix') return 'fix';
  if (assign === 'review' && mode === 'plan') return 'plan';
  if (assign === 'review') return 'review';
  if (assign === 'implement') return 'implement';
  return '';
}

/**
 * @param {string} harness
 * @param {string} model
 * @returns {string}
 */
export function modelPickCandidateId(harness, model) {
  const h = String(harness || '').trim().toLowerCase();
  const m = String(model || '').trim();
  if (!h || !m) return '';
  return `${h}/${m}`;
}

/**
 * @param {string} modelA
 * @param {string} modelB
 * @returns {boolean}
 */
function modelsMatch(modelA, modelB) {
  const left = String(modelA || '').trim();
  const right = String(modelB || '').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const decodedLeft = decodeModelValue(left);
  const decodedRight = decodeModelValue(right);
  const baseLeft = String(decodedLeft.modelId || left).trim().toLowerCase();
  const baseRight = String(decodedRight.modelId || right).trim().toLowerCase();
  return baseLeft === baseRight;
}

/**
 * @param {object} pickResult
 * @param {number} max
 * @returns {object[]}
 */
function boundedCandidatesFromPick(pickResult, max) {
  /** @type {object[]} */
  const out = [];
  const seen = new Set();
  const push = (row, selectionSlot, originDetailHint) => {
    const harness = String(row?.harness || '').trim().toLowerCase();
    const model = String(row?.model || '').trim();
    if (!harness || !model) return;
    const candidateId = modelPickCandidateId(harness, model);
    if (seen.has(candidateId)) return;
    seen.add(candidateId);
    out.push({
      selectionSlot,
      candidateId,
      harness,
      model,
      originDetailHint: String(originDetailHint || '').trim(),
    });
  };
  const picks = Array.isArray(pickResult?.picks) ? pickResult.picks : [];
  // Only explicit picks own a selection slot. Audit-only candidates get
  // `selectionSlot: null`, so they can never be matched into a start.
  picks.slice(0, MODEL_PICK_MAX_SLOTS).forEach((row, index) => push(row, index, index === 0 ? 'selected' : 'alternate'));
  const candidates = Array.isArray(pickResult?.candidates) ? pickResult.candidates : [];
  for (const row of candidates) {
    if (out.length >= max) break;
    push(row, null, '');
  }
  return out.slice(0, max);
}

/**
 * Persist one model_pick response as a proposal with bounded candidates.
 *
 * @param {{
 *   chatId?: string,
 *   workspaceFolder?: string,
 *   purpose?: string,
 *   role?: string,
 *   pickResult?: object,
 *   now?: number,
 *   file?: string,
 * }} input
 * @returns {{ pickId: string, expiresAt: string, policyVersion: string, record: object }}
 */
export function persistModelPickProposal(input = {}) {
  purgeStaleModelPickRecords({ file: input.file, now: input.now });
  const pickResult = input.pickResult && typeof input.pickResult === 'object' ? input.pickResult : {};
  const bounded = boundedCandidatesFromPick(pickResult, MODEL_PICK_MAX_CANDIDATES);
  // `picks` is the real fanout set from the pick response (slot 0 = primary);
  // candidates beyond that set are alternates, so they must not inflate
  // `picks.length` and turn every alternate into a "fanout".
  const picks = (Array.isArray(pickResult.picks) ? pickResult.picks : [])
    .slice(0, MODEL_PICK_MAX_SLOTS)
    .map((row, index) => ({
      selectionSlot: index,
      candidateId: modelPickCandidateId(row?.harness, row?.model),
      harness: String(row?.harness || '').trim().toLowerCase(),
      model: String(row?.model || '').trim(),
      originDetailHint: index === 0 ? 'selected' : 'alternate',
    }))
    .filter((row) => row.harness && row.model);
  if (picks.length === 0 && bounded.length > 0) {
    // A pick response without an explicit `picks` list still has one primary.
    picks.push({ ...bounded[0], selectionSlot: 0, originDetailHint: 'selected' });
  }
  const record = createModelPickRecord({
    chatId: input.chatId,
    workspaceFolder: input.workspaceFolder,
    purpose: input.purpose,
    role: input.role,
    policyVersion: MODEL_PICK_POLICY_VERSION,
    candidates: bounded,
    picks,
    now: input.now,
    file: input.file,
  });
  return {
    pickId: record.id,
    expiresAt: record.expiresAt,
    policyVersion: record.policyVersion,
    record,
  };
}

/**
 * @param {object} pick
 * @param {string} harness
 * @param {string} model
 * @returns {{ selectionSlot: number, originDetail: string } | null}
 */
export function matchPickExecutor(pick, harness, model) {
  const h = String(harness || '').trim().toLowerCase();
  const m = String(model || '').trim();
  if (!h || !m) return null;
  // Only explicit picks own a slot; audit candidates are never matched.
  const rows = Array.isArray(pick?.picks) ? pick.picks.slice(0, MODEL_PICK_MAX_SLOTS) : [];
  for (const row of rows) {
    if (String(row?.harness || '').trim().toLowerCase() !== h) continue;
    if (!modelsMatch(row?.model, m)) continue;
    const slot = row?.selectionSlot != null && Number.isInteger(Number(row.selectionSlot)) ? Number(row.selectionSlot) : -1;
    if (slot < 0) continue;
    let originDetail = String(row?.originDetailHint || '').trim();
    if (!originDetail) originDetail = slot === 0 ? 'selected' : 'alternate';
    if (/explore|cold[- ]start/i.test(String(row?.reason || ''))) originDetail = 'explore';
    return { selectionSlot: slot, originDetail };
  }
  return null;
}

/**
 * Validate a claimed fallback: it must name a real earlier delegation of the
 * same parent chat (and same leaf when both know one) that ran on a different
 * executor than the new start.
 *
 * @param {{ pickFallbackFrom?: string, fallbackFromRecord?: object | null, parentChatId?: string, leafId?: string, harness?: string, model?: string }} input
 * @returns {boolean}
 */
export function isValidPickFallback(input) {
  const fromId = String(input.pickFallbackFrom || '').trim();
  const prev = input.fallbackFromRecord;
  if (!fromId || !prev || typeof prev !== 'object') return false;
  if (String(prev.id || '').trim() !== fromId) return false;
  const parentChatId = String(input.parentChatId || '').trim();
  if (!parentChatId || String(prev.parentChatId || '').trim() !== parentChatId) return false;
  const leafNow = String(input.leafId || '').trim();
  const leafPrev = String(prev.leafId || '').trim();
  if (!leafNow || !leafPrev || leafNow !== leafPrev) return false;
  const prevHarness = String(prev.executor?.transport || '').trim().toLowerCase();
  const prevModel = String(prev.executor?.model || '').trim();
  const harness = String(input.harness || '').trim().toLowerCase();
  const model = String(input.model || '').trim();
  if (!prevHarness || !harness) return false;
  // Evidence of an executor change: harness differs, or model differs.
  if (prevHarness === harness && modelsMatch(prevModel, model)) return false;
  return true;
}

/**
 * @param {string} pickRole
 * @param {string} detail
 * @returns {object}
 */
function rejectedLink(pickRole, detail = 'rejected-link') {
  return {
    origin: 'unknown',
    originDetail: 'rejected-link',
    linkStatus: 'rejected-link',
    pickRole,
    selectionSlot: null,
    rejectReason: detail,
  };
}

/**
 * @param {{
 *   pickId?: string,
 *   harness?: string,
 *   model?: string,
 *   role?: string,
 *   assignment?: string,
 *   executionMode?: string,
 *   manualSource?: string,
 *   pickFallbackFrom?: string,
 *   fallbackFromRecord?: object | null,
 *   parentChatId?: string,
 *   workspaceFolder?: string,
 *   leafId?: string,
 *   now?: number,
 *   file?: string,
 * }} input
 * @returns {{
 *   origin: 'auto' | 'manual' | 'unknown',
 *   originDetail: string,
 *   linkStatus: 'linked' | 'rejected-link' | 'legacy' | 'none',
 *   pickRole: string,
 *   selectionSlot: number | string | null,
 *   rejectReason?: string,
 * }}
 */
export function classifyDelegationPickOrigin(input = {}) {
  const pickRole = resolveDelegationPickRole(input.assignment, input.executionMode, input.role);
  const rawManual = String(input.manualSource || '').trim();
  if (rawManual) {
    const manualSource = normalizeManualPickSource(rawManual);
    // Unknown free text is never trusted as a manual choice.
    if (!manualSource) return rejectedLink(pickRole, 'unknown_manual_source');
    return {
      origin: 'manual',
      originDetail: manualSource,
      linkStatus: 'linked',
      pickRole,
      selectionSlot: null,
    };
  }
  const pickId = String(input.pickId || '').trim();
  if (!pickId) {
    return {
      origin: 'unknown',
      originDetail: 'legacy',
      linkStatus: 'legacy',
      pickRole,
      selectionSlot: null,
    };
  }
  const pick = getModelPickRecord(pickId, { file: input.file });
  if (!pick) return rejectedLink(pickRole, 'unknown_pick');
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const expiresMs = Date.parse(pick.expiresAt);
  if (Number.isFinite(expiresMs) && now > expiresMs) return rejectedLink(pickRole, 'expired');
  if (pickRole && pick.role && pick.role !== pickRole) return rejectedLink(pickRole, 'role_mismatch');
  // The pick must belong to the chat (and workspace) that starts the child.
  const parentChatId = String(input.parentChatId || '').trim();
  if (!parentChatId || !pick.chatId || pick.chatId !== parentChatId) return rejectedLink(pickRole, 'chat_mismatch');
  const pickWorkspace = normalizeDelegationWorkspaceKey(pick.workspaceFolder);
  if (pickWorkspace) {
    const startWorkspace = normalizeDelegationWorkspaceKey(input.workspaceFolder);
    if (!startWorkspace || startWorkspace !== pickWorkspace) return rejectedLink(pickRole, 'workspace_mismatch');
  }
  const fallbackFrom = String(input.pickFallbackFrom || '').trim();
  const fallbackOk = fallbackFrom
    ? isValidPickFallback({
      pickFallbackFrom: fallbackFrom,
      fallbackFromRecord: input.fallbackFromRecord,
      parentChatId,
      leafId: input.leafId,
      harness: input.harness,
      model: input.model,
    })
    : false;
  if (fallbackFrom && !fallbackOk) return rejectedLink(pickRole, 'invalid_fallback');
  const matched = matchPickExecutor(pick, input.harness, input.model);
  if (!matched) {
    if (fallbackOk) {
      // Own attempt: a fallback outside the proposed picks reserves a
      // dedicated per-fallback slot instead of aliasing slot 0.
      return {
        origin: 'auto',
        originDetail: 'fallback',
        linkStatus: 'linked',
        pickRole: pickRole || pick.role,
        selectionSlot: `fallback:${fallbackFrom}`,
      };
    }
    return rejectedLink(pickRole, 'executor_not_picked');
  }
  let originDetail = matched.originDetail;
  if (fallbackOk) originDetail = 'fallback';
  else if (matched.selectionSlot > 0 && picksLookLikeFanout(pick)) originDetail = 'fanout';
  return {
    origin: 'auto',
    originDetail,
    linkStatus: 'linked',
    pickRole: pickRole || pick.role,
    selectionSlot: matched.selectionSlot,
  };
}

/**
 * @param {object} pick
 * @returns {boolean}
 */
function picksLookLikeFanout(pick) {
  return Array.isArray(pick?.picks) && pick.picks.length > 1;
}

/**
 * Separate execution counters for persisted pick proposals.
 *
 * `proposals` counts durable pick records (claimed or not); `executed*` count
 * delegation rows by `pickOrigin`; `runs` is every delegation row and always
 * equals `executedAuto + executedManual + executedUnknown`. A proposal without
 * a `delegation_start` therefore raises only `proposals`. When the proposal
 * store cannot be read, `proposals` is `null` rather than a guessed zero.
 *
 * @param {object[]} rows
 * @param {{ file?: string, loadPicks?: Function, cycles?: number }} [options]
 * @returns {{
 *   proposals: number | null,
 *   executedAuto: number,
 *   executedManual: number,
 *   executedUnknown: number,
 *   runs: number,
 *   cycles: number | null,
 *   originDetails: Record<string, number>,
 * }}
 */
export function summarizeModelPickExecutionCounters(rows, options = {}) {
  const delegations = Array.isArray(rows) ? rows : [];
  let executedAuto = 0;
  let executedManual = 0;
  let executedUnknown = 0;
  /** @type {Record<string, number>} */
  const originDetails = {};
  for (const row of delegations) {
    const origin = String(row?.pickOrigin || '').trim().toLowerCase();
    if (origin === 'auto') executedAuto += 1;
    else if (origin === 'manual') executedManual += 1;
    else executedUnknown += 1;
    const detail = String(row?.pickOriginDetail || '').trim().toLowerCase() || 'none';
    originDetails[detail] = (originDetails[detail] || 0) + 1;
  }
  let proposals = null;
  try {
    const loadPicks = typeof options.loadPicks === 'function' ? options.loadPicks : loadModelPickRecords;
    const picks = options.file ? loadPicks({ file: options.file }) : loadPicks();
    proposals = picks && typeof picks === 'object' ? Object.keys(picks).length : 0;
  } catch {
    proposals = null;
  }
  return {
    proposals,
    executedAuto,
    executedManual,
    executedUnknown,
    runs: delegations.length,
    cycles: Number.isFinite(Number(options.cycles)) ? Number(options.cycles) : null,
    originDetails,
  };
}

/**
 * Resolve pick metadata for a new delegation start (does not bypass workflow gates).
 *
 * @param {object} input same as {@link classifyDelegationPickOrigin} plus pickId
 * @returns {{
 *   pickId: string,
 *   pickOrigin: string,
 *   pickOriginDetail: string,
 *   pickLinkStatus: string,
 *   pickRole: string,
 *   selectionSlot: number | string | null,
 * }}
 */
export function resolveDelegationPickLinkFields(input = {}) {
  const classified = classifyDelegationPickOrigin(input);
  return {
    pickId: String(input.pickId || '').trim(),
    pickOrigin: classified.origin,
    pickOriginDetail: classified.originDetail,
    pickLinkStatus: classified.linkStatus,
    pickRole: classified.pickRole,
    selectionSlot: classified.selectionSlot,
  };
}

/**
 * Reserve the slot for an `auto` link. An auto link without a key, delegation
 * id, or valid slot is refused (never silently accepted), so one `pick_id`
 * cannot back unlimited starts.
 *
 * @param {{
 *   pickId?: string,
 *   selectionSlot?: number | string | null,
 *   delegationId?: string,
 *   idempotencyKey?: string,
 *   pickOrigin?: string,
 *   file?: string,
 *   now?: number,
 * }} input
 * @returns {Promise<{ ok: boolean, code?: string, error?: string }>}
 */
export async function finalizeDelegationPickSlotReservation(input = {}) {
  if (String(input.pickOrigin || '').trim().toLowerCase() !== 'auto') {
    return { ok: true };
  }
  const pickId = String(input.pickId || '').trim();
  const delegationId = String(input.delegationId || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '').trim();
  if (!idempotencyKey) {
    return { ok: false, code: 'idempotency_key_required', error: 'idempotency_key is required when starting from a pick_id.' };
  }
  const slotKey = normalizeSlotKey(input.selectionSlot);
  if (!pickId || !delegationId || !slotKey) {
    return { ok: false, code: 'validation', error: 'pick_id slot reservation needs a pick, a delegation, and a selection slot.' };
  }
  const reserved = await reserveModelPickSlot({
    pickId,
    selectionSlot: slotKey,
    delegationId,
    idempotencyKey,
    file: input.file,
    now: input.now,
  });
  if (reserved.ok) return { ok: true };
  return { ok: false, code: reserved.code, error: reserved.error };
}
