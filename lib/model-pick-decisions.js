/**
 * Model pick proposals, pick→start linking, and execution counters.
 */

import { decodeModelValue } from './model-catalog.js';
import { normalizeDelegationWorkspaceKey } from './delegation-workspace-guard.js';
import { MODEL_PICK_ROLES } from './model-role-profiles.js';
import fs from 'node:fs';
import { writeJsonAtomic } from './persist/atomic-write.js';
import { resolveDataPath } from './runtime-paths.js';
import {
  MODEL_PICK_MAX_CANDIDATES,
  MODEL_PICK_MAX_SLOTS,
  MODEL_PICK_POLICY_VERSION,
  composeModelPickPolicyVersion,
} from './model-pick-policy.js';
import { buildModelPickEligibilityCohort } from './model-role-profiles.js';
import { MODEL_PICK_SHADOW_CONFIG_DEFAULTS } from './model-pick-policy.js';
import {
  createModelPickRecord,
  getModelPickRecord,
  loadModelPickRecords,
  normalizeSlotKey,
  purgeStaleModelPickRecords,
  releaseModelPickSlotsForDelegation,
  reserveModelPickSlot,
  withModelPickFileLock,
} from './persist/model-pick-decisions-persist.js';
import { buildShadowAgreementReport, evaluateShadowWindow } from './model-pick-shadow-gates.js';

export {
  MODEL_PICK_POLICY_VERSION,
  composeModelPickPolicyVersion,
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
 *   shadowSegment?: string,
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
  const marker = input.explore !== undefined ? input.explore : null;
  const exploreSegment = String(marker?.segment || pickResult.explore?.segment || '').trim();
  const record = createModelPickRecord({
    chatId: input.chatId,
    workspaceFolder: input.workspaceFolder,
    purpose: input.purpose,
    role: input.role,
    // The explore segment belongs in the version: a policy change (or flipping
    // the real-exploration flag) must start a new cohort, never reuse the one
    // the stage-7 shadow window already measured.
    policyVersion: composeModelPickPolicyVersion(
      buildModelPickEligibilityCohort(),
      exploreSegment,
      String(input.shadowSegment || '').trim(),
    ),
    explore: marker,
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
    // An out-of-band explore pick carries its own detail: the budget guard reads
    // it to keep the experiment out of the denominator that funds the next one.
    // A dry-run marker never rewrites the detail — the selection was ordinary.
    const marker = pick?.explore;
    if (marker?.mode === 'real'
      && String(marker.harness || '').trim().toLowerCase() === h
      && modelsMatch(marker.model, m)) {
      originDetail = MODEL_PICK_EXPLORE_ORIGIN_DETAIL;
    }
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

/**
 * Durable store for shadow comparisons (stage 4). It is a separate file from
 * the pick proposals so the pick record schema (`lib/persist/...`) does not have
 * to grow a field for an observer that changes nothing, and so the agreement
 * window survives independently of the 30-day proposal retention.
 */
export const MODEL_PICK_SHADOW_COMPARISONS_FILE = resolveDataPath('model-pick-shadow-comparisons.json');

/** Version of the persisted shadow comparison document. */
export const MODEL_PICK_SHADOW_COMPARISONS_SCHEMA_VERSION = 1;

/** Bounded recent-row history; the per-role counters are unbounded. */
export const MODEL_PICK_SHADOW_MAX_ENTRIES = 500;

/** @type {Map<string, object>} */
const shadowMemory = new Map();

/**
 * @param {unknown} parsed
 * @returns {object}
 */
function normalizeShadowDocument(parsed) {
  const doc = parsed && typeof parsed === 'object' ? parsed : {};
  const byRole = {};
  const roles = doc.byRole && typeof doc.byRole === 'object' ? doc.byRole : {};
  for (const [role, raw] of Object.entries(roles)) {
    if (!raw || typeof raw !== 'object') continue;
    byRole[String(role)] = {
      n: Math.max(0, Math.round(Number(raw.n) || 0)),
      agree: Math.max(0, Math.round(Number(raw.agree) || 0)),
      firstAt: String(raw.firstAt || '').trim(),
      lastAt: String(raw.lastAt || '').trim(),
    };
  }
  const entries = Array.isArray(doc.entries)
    ? doc.entries.slice(0, MODEL_PICK_SHADOW_MAX_ENTRIES)
    : [];
  return {
    schemaVersion: MODEL_PICK_SHADOW_COMPARISONS_SCHEMA_VERSION,
    // The scoring/normalization segment the counters belong to. A new
    // normalization (e.g. the stage-7 measurement input) starts a new segment so
    // the agreement window is never improved by changing the population.
    segment: String(doc.segment || '').trim(),
    segmentStartedAt: String(doc.segmentStartedAt || '').trim(),
    updatedAt: String(doc.updatedAt || '').trim(),
    byRole,
    entries,
  };
}

/**
 * @param {{ file?: string, reload?: boolean }} [options]
 * @returns {object}
 */
function readShadowDocument(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_SHADOW_COMPARISONS_FILE;
  if (options.reload !== true && shadowMemory.has(file)) return shadowMemory.get(file);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  const doc = normalizeShadowDocument(parsed);
  shadowMemory.set(file, doc);
  return doc;
}

/**
 * @param {string} file
 * @param {object} doc
 */
function writeShadowDocument(file, doc) {
  shadowMemory.set(file, doc);
  try {
    writeJsonAtomic(file, doc);
  } catch (err) {
    // A read-only data dir must not fail a pick; the in-memory window survives.
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[model-pick-shadow] persist failed:', message);
  }
}

/**
 * Read the shadow agreement window and build the per-role report.
 *
 * @param {{ file?: string, now?: number, reviewPassRateInfluencesScore?: boolean, config?: object, reviewAgreementFloor?: number, segment?: string }} [options]
 * @returns {{ schemaVersion: number, segment: string, segment_started_at: string, segment_match: boolean | null, updatedAt: string, byRole: object, entries: object[], report: object, window: object }}
 */
export function loadModelPickShadowComparisons(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_SHADOW_COMPARISONS_FILE;
  const doc = readShadowDocument({ file });
  const report = buildShadowAgreementReport(doc.byRole, {
    reviewAgreementFloor: options.reviewAgreementFloor ?? options.config?.reviewAgreementFloor,
    reviewPassRateInfluencesScore: options.reviewPassRateInfluencesScore,
  });
  // Minimum observation window (the later of 14 days and 200 calls). Reported
  // only: this stage never promotes on it.
  const config = { ...MODEL_PICK_SHADOW_CONFIG_DEFAULTS, ...(options.config || {}) };
  let totalCalls = 0;
  let firstAt = null;
  for (const row of Object.values(doc.byRole)) {
    totalCalls += Number(row.n) || 0;
    const at = String(row.firstAt || '').trim();
    if (at && (firstAt == null || at < firstAt)) firstAt = at;
  }
  const window = evaluateShadowWindow({
    firstAt,
    now: options.now,
    calls: totalCalls,
    minDays: config.minDays,
    minCalls: config.minCalls,
  });
  // A caller that names a segment learns whether the stored counters belong to
  // it. A mismatch means the window must not be read as evidence for the
  // current normalization; it restarts on the next persisted comparison.
  const requestedSegment = typeof options.segment === 'string' ? options.segment.trim() : null;
  const segmentMatch = requestedSegment == null ? null : doc.segment === requestedSegment;
  return {
    ...doc,
    report,
    window,
    segment_started_at: doc.segmentStartedAt,
    segment_match: segmentMatch,
  };
}

/**
 * Append one shadow comparison and refresh the per-role agreement counters.
 * Idempotent per call by design: every pick is one comparison event.
 *
 * @param {{
 *   role?: string,
 *   agreement?: { role?: string, selected?: string|null, shadow_top?: string|null, agree?: boolean },
 *   entry?: object,
 *   reviewPassRateInfluencesScore?: boolean,
 *   segment?: string,
 *   now?: number,
 *   file?: string,
 * }} input
 * @returns {{ stored: boolean, segment: string, report: object, entry: object | null }}
 */
export function persistModelPickShadowComparison(input = {}) {
  const agreement = input.agreement && typeof input.agreement === 'object' ? input.agreement : null;
  if (!agreement) {
    return { stored: false, segment: '', report: buildShadowAgreementReport({}, {}), entry: null };
  }
  const role = String(input.role || agreement.role || '').trim().toLowerCase();
  if (!role) {
    return { stored: false, segment: '', report: buildShadowAgreementReport({}, {}), entry: null };
  }
  const file = typeof input.file === 'string' && input.file ? input.file : MODEL_PICK_SHADOW_COMPARISONS_FILE;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const at = new Date(now).toISOString();
  const agree = agreement.agree === true;
  const requestedSegment = typeof input.segment === 'string' ? input.segment.trim() : '';
  const entry = {
    at,
    role,
    selected: String(agreement.selected || '').trim() || null,
    shadow_top: String(agreement.shadow_top || '').trim() || null,
    agree,
    ...(input.entry && typeof input.entry === 'object' ? input.entry : {}),
  };
  try {
    withModelPickFileLock(file, () => {
      // Read through to disk inside the lock, so a writer in another process is
      // not lost to this process's in-memory copy.
      const doc = readShadowDocument({ file, reload: true });
      // A new scoring/normalization segment restarts the agreement window
      // instead of letting a changed population improve the old numbers.
      if (requestedSegment && doc.segment !== requestedSegment) {
        doc.byRole = {};
        doc.entries = [];
        doc.segment = requestedSegment;
        doc.segmentStartedAt = at;
      }
      const current = doc.byRole[role] || { n: 0, agree: 0, firstAt: '', lastAt: '' };
      doc.byRole[role] = {
        n: current.n + 1,
        agree: current.agree + (agree ? 1 : 0),
        firstAt: current.firstAt || at,
        lastAt: at,
      };
      doc.entries = [entry, ...doc.entries].slice(0, MODEL_PICK_SHADOW_MAX_ENTRIES);
      doc.updatedAt = at;
      writeShadowDocument(file, normalizeShadowDocument(doc));
    });
  } catch (err) {
    // The observer must never break a pick: a busy lock or an unwritable store
    // degrades to "not stored" with a warning.
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[model-pick-shadow] comparison not stored:', message);
    return { stored: false, segment: requestedSegment, report: buildShadowAgreementReport({}, {}), entry };
  }
  const stored = readShadowDocument({ file });
  return {
    stored: true,
    segment: stored.segment,
    entry,
    report: buildShadowAgreementReport(stored.byRole, {
      reviewPassRateInfluencesScore: input.reviewPassRateInfluencesScore,
    }),
  };
}

/**
 * Drop the in-memory copy (and optionally the file) so a test can start clean.
 *
 * @param {{ file?: string, removeFile?: boolean }} [options]
 * @returns {void}
 */
export function resetModelPickShadowComparisons(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : MODEL_PICK_SHADOW_COMPARISONS_FILE;
  shadowMemory.delete(file);
  if (options.removeFile === true) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Best effort: a missing file is already a clean state.
    }
  }
}
