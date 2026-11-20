/**
 * Wake-up kind `usage_limit_resume`: vocabulary, record builder and the
 * detection/cancellation helpers used by the chat and delegation hooks.
 *
 * Record only, never a resume: a later scheduler decides when and whether to
 * act. A pause stores no provider message body and no prompt text, and no
 * `dueAt` (the scheduler derives it from the current settings).
 */

import { createHash } from 'node:crypto';
import { decodeModelValue } from './model-catalog.js';
import {
  armWakeup,
  cancelWakeupsWhere,
  newestWakeupForSubject,
} from './persist/wakeups-persist.js';
import { readUsageLimitResumeSettings } from './usage-limit-resume-settings.js';

export const USAGE_LIMIT_RESUME_KIND = 'usage_limit_resume';
export const PAUSE_SUBJECT_TYPES = Object.freeze(['chat', 'delegation']);
export const PAUSE_STATES = Object.freeze(['armed', 'resuming', 'resumed', 'cancelled', 'expired', 'blocked']);
/** A resumed pause chains onto the next one only inside this gap. */
export const CHAIN_GAP_MS = 6 * 60 * 60 * 1000;

const baseModelId = (model) => decodeModelValue(String(model || '').trim()).modelId.toLowerCase();
const str = (value) => String(value ?? '').trim();

/**
 * @param {Record<string, any>} input
 * @returns {Record<string, any>} the pause envelope (`state: 'armed'`)
 */
export function buildPauseRecord(input = {}) {
  const subjectType = str(input.subjectType);
  const subjectId = str(input.subjectId);
  const harness = str(input.harness).toLowerCase();
  const model = str(input.model);
  const resetAt = str(input.resetAt);
  const digest = createHash('sha256')
    .update([subjectType, subjectId, harness, baseModelId(model), resetAt].join('|'))
    .digest('hex');
  return {
    id: `pause:${digest}`,
    kind: USAGE_LIMIT_RESUME_KIND,
    subjectType,
    subjectId,
    parentChatId: str(input.parentChatId),
    leafId: str(input.leafId),
    subjectAttemptId: str(input.subjectAttemptId),
    subjectModel: str(input.subjectModel),
    harness,
    model,
    resetAt,
    resetSource: str(input.resetSource),
    code: str(input.code),
    pausedAt: str(input.pausedAt),
    state: 'armed',
    reason: '',
    attempts: 0,
    pendingAttempt: 0,
    resumeRequestId: '',
    lastResumeAt: '',
    chain: Number.isInteger(input.chain) && input.chain >= 0 ? input.chain : 0,
  };
}

/**
 * @param {{ previousRecord?: Record<string, any>|null, pausedAt?: string }} input
 * @returns {number} `previous.chain + 1` inside the gap after a resume, else 0
 */
export function nextChain({ previousRecord, pausedAt } = {}) {
  if (!previousRecord || previousRecord.state !== 'resumed') return 0;
  const gap = Date.parse(pausedAt) - Date.parse(previousRecord.lastResumeAt);
  if (!Number.isFinite(gap) || gap < 0 || gap > CHAIN_GAP_MS) return 0;
  return (Number.isInteger(previousRecord.chain) ? previousRecord.chain : 0) + 1;
}

/**
 * @param {any} raw
 * @returns {Record<string, any>|null} a normalized pause record, or null for anything else
 */
export function normalizePauseRecord(raw) {
  try {
    if (!raw || typeof raw !== 'object' || raw.kind !== USAGE_LIMIT_RESUME_KIND) return null;
    if (!PAUSE_SUBJECT_TYPES.includes(raw.subjectType) || !str(raw.subjectId) || !str(raw.id)) return null;
    const state = PAUSE_STATES.includes(raw.state) ? raw.state : null;
    if (!state) return null;
    const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    return {
      id: str(raw.id),
      kind: USAGE_LIMIT_RESUME_KIND,
      subjectType: raw.subjectType,
      subjectId: str(raw.subjectId),
      parentChatId: str(raw.parentChatId),
      leafId: str(raw.leafId),
      subjectAttemptId: str(raw.subjectAttemptId),
      subjectModel: str(raw.subjectModel),
      harness: str(raw.harness).toLowerCase(),
      model: str(raw.model),
      resetAt: str(raw.resetAt),
      resetSource: str(raw.resetSource),
      code: str(raw.code),
      pausedAt: str(raw.pausedAt),
      state,
      reason: str(raw.reason),
      attempts: count(raw.attempts),
      pendingAttempt: count(raw.pendingAttempt),
      resumeRequestId: str(raw.resumeRequestId),
      lastResumeAt: str(raw.lastResumeAt),
      chain: count(raw.chain),
      updatedAt: str(raw.updatedAt),
    };
  } catch {
    return null;
  }
}

/**
 * Chats the server drives (delegation child, Scout, watcher/TODO execution)
 * are resumed by their own layer; a pause there would double-resume.
 *
 * @param {Record<string, any>} chat
 * @param {{ dataDir?: string, resolveContext?: Function }} deps
 * @returns {boolean}
 */
function isServerDrivenChat(chat, deps) {
  if (str(chat?.delegationId) || str(chat?.pickPurpose) === 'scout') return true;
  return deps.resolveContext({
    parent: chat,
    dataDir: deps.dataDir,
    persist: false,
    isTodoExecutionChat: (row) => Boolean(str(row?.todoId)),
  })?.context === 'automatic';
}

function armPause(fields, deps) {
  const settings = readUsageLimitResumeSettings(deps.settings || null);
  if (!settings.enabled) return null;
  const limit = deps.getLimit({ harness: fields.harness, model: fields.model, dataDir: deps.dataDir });
  if (!limit?.resetAt) return null;
  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  const pausedAt = new Date(nowMs).toISOString();
  const storeOptions = { dataDir: deps.dataDir, now: nowMs };
  const previousRecord = newestWakeupForSubject(
    USAGE_LIMIT_RESUME_KIND, fields.subjectType, fields.subjectId, storeOptions,
  );
  const record = buildPauseRecord({
    ...fields,
    model: limit.model ?? '',
    resetAt: limit.resetAt,
    resetSource: limit.resetSource,
    code: limit.code,
    pausedAt,
    chain: nextChain({ previousRecord, pausedAt }),
  });
  const armed = armWakeup(record, storeOptions);
  // Only a newly created row is announced; re-detecting a window stays silent.
  if (armed.created && typeof deps.onArmed === 'function') {
    try { deps.onArmed(armed.record); } catch { /* observers never break arming */ }
  }
  return armed.record;
}

/**
 * Arms a pause for a human-driven chat whose run just ended on a provider
 * limit. Best-effort: never throws.
 *
 * @param {{ chat?: Record<string, any>, chatId?: string, harness: string, model?: string, subjectModel?: string }} input
 *   `chatId` is resolved lazily through `deps.findChat`, only when the feature is enabled.
 * @param {{ dataDir?: string, now?: () => number, settings?: Record<string, any>, getLimit: Function, resolveContext: Function, findChat?: (id: string) => Record<string, any>|null|undefined, onArmed?: (record: Record<string, any>) => void }} deps
 * @returns {Record<string, any>|null} the armed (or already existing) record
 */
export function armChatUsageLimitPause(input, deps) {
  try {
    // Cheap gate first: a disabled feature must not touch the chats store.
    if (!readUsageLimitResumeSettings(deps.settings || null).enabled) return null;
    const chat = input?.chat
      || (typeof deps.findChat === 'function' ? deps.findChat(input?.chatId) : null);
    if (!chat?.id || isServerDrivenChat(chat, deps)) return null;
    return armPause({
      subjectType: 'chat',
      subjectId: chat.id,
      subjectAttemptId: '',
      subjectModel: input.subjectModel || input.model,
      harness: input.harness,
      model: input.model,
    }, deps);
  } catch {
    return null;
  }
}

/**
 * Arms a pause for a delegation that failed with a quota error. Best-effort.
 *
 * @param {Record<string, any>} delegation
 * @param {{ dataDir?: string, now?: () => number, settings?: Record<string, any>, getLimit: Function }} deps
 * @returns {Record<string, any>|null}
 */
export function armDelegationUsageLimitPause(delegation, deps) {
  try {
    if (!delegation?.id) return null;
    const harness = str(delegation.executor?.transport);
    if (!harness) return null;
    return armPause({
      subjectType: 'delegation',
      subjectId: delegation.id,
      subjectAttemptId: delegation.attemptId,
      subjectModel: delegation.executor?.model,
      parentChatId: delegation.parentChatId,
      leafId: delegation.leafId,
      harness,
      model: delegation.executor?.model,
    }, deps);
  } catch {
    return null;
  }
}

/**
 * Cancels the armed pauses of one subject (new run, Stop, successful retry).
 * Best-effort: returns 0 on a store error.
 *
 * @param {{ subjectType: string, subjectId: string, reason: string }} input
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {number}
 */
export function cancelSubjectUsageLimitPauses({ subjectType, subjectId, reason }, options = {}) {
  try {
    if (!str(subjectId)) return 0;
    return cancelWakeupsWhere({ kind: USAGE_LIMIT_RESUME_KIND, subjectType, subjectId, reason }, options);
  } catch {
    return 0;
  }
}

/**
 * Cancels armed delegation pauses of a parent when a sibling delegation starts.
 * Scoped to the same workflow leaf; a row or call without a leaf id sweeps the
 * whole parent.
 *
 * @param {{ parentChatId: string, leafId?: string }} input
 * @param {{ dataDir?: string, now?: number }} [options]
 * @returns {number}
 */
export function cancelParentDelegationUsageLimitPauses({ parentChatId, leafId }, options = {}) {
  try {
    if (!str(parentChatId)) return 0;
    return cancelWakeupsWhere({
      kind: USAGE_LIMIT_RESUME_KIND,
      subjectType: 'delegation',
      parentChatId: str(parentChatId),
      leafId: str(leafId),
      reason: 'superseded_by_new_delegation',
    }, options);
  } catch {
    return 0;
  }
}
