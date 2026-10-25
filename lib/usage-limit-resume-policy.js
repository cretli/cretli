/**
 * Pure policy for the `usage_limit_resume` wake-up kind: due instant,
 * candidate selection and the resume decision table. No I/O and no clock read;
 * `now` is always injected and the jitter is derived from the record id, so two
 * ticks (and the tests) always agree.
 */

import { createHash } from 'node:crypto';
import { PREMIUM_COST_TIER } from './model-pick-cost-policy.js';

/** Closed list of reasons `decideResumeAction` can return. */
export const RESUME_DECISION_REASONS = Object.freeze([
  'disabled',
  'unconfirmed_reset',
  'before_due',
  'subject_moved',
  'chain_exhausted',
  'premium_model',
  'limit_active',
  'catch_up_window_missed',
  'parent_busy',
  'session_not_resumable',
  'delegations_disabled',
  'due',
]);

const TRUSTED_RESET_SOURCES = new Set(['provider', 'provider-message']);

const parseMs = (value) => Date.parse(String(value ?? '').trim());

/**
 * Deterministic jitter in `[0, jitterMs)` from the record id.
 *
 * @param {string} id
 * @param {number} jitterMs
 * @returns {number}
 */
export function resolvePauseJitterMs(id, jitterMs) {
  const span = Math.floor(Number(jitterMs));
  if (!Number.isFinite(span) || span <= 0) return 0;
  const digest = createHash('sha256').update(String(id || '')).digest();
  return digest.readUInt32BE(0) % span;
}

/**
 * `resetAt + marginMs + jitter`, in epoch ms; `NaN` when `resetAt` is unusable.
 *
 * @param {{ id?: string, resetAt?: string }} record
 * @param {{ marginMs?: number, jitterMs?: number }} settings
 * @returns {number}
 */
export function resolvePauseDueAt(record, settings) {
  const resetMs = parseMs(record?.resetAt);
  if (!Number.isFinite(resetMs)) return Number.NaN;
  return resetMs + Math.max(0, Number(settings?.marginMs) || 0)
    + resolvePauseJitterMs(record?.id, settings?.jitterMs);
}

/**
 * Due `armed` records ordered by `dueAt`, then `pausedAt`, then `id`.
 *
 * @param {{ records?: Record<string, any>[], now?: number, settings?: Record<string, any>, limit?: number }} input
 *   `limit` is optional; without it every due record is returned.
 * @returns {Array<{ record: Record<string, any>, dueAt: number }>}
 */
export function selectResumeCandidates({ records, now, settings, limit } = {}) {
  const due = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.state !== 'armed') continue;
    const dueAt = resolvePauseDueAt(record, settings);
    if (!Number.isFinite(dueAt) || dueAt > now) continue;
    due.push({ record, dueAt });
  }
  due.sort((a, b) => a.dueAt - b.dueAt
    || (parseMs(a.record.pausedAt) || 0) - (parseMs(b.record.pausedAt) || 0)
    || String(a.record.id).localeCompare(String(b.record.id)));
  const cap = Number.isInteger(limit) && limit > 0 ? limit : due.length;
  return due.slice(0, cap);
}

/**
 * First matching row of the decision table wins.
 *
 * @param {{
 *   record: Record<string, any>,
 *   now: number,
 *   dueAt: number,
 *   settings: Record<string, any>,
 *   lockout?: { resetAt?: string }|null,
 *   costTier?: number,
 *   parentBusy?: boolean,
 *   sessionResumable?: boolean,
 *   subjectMoved?: boolean,
 *   subjectMissing?: boolean,
 * }} input
 * @returns {{ action: 'resume'|'defer'|'expire'|'block'|'skip'|'cancel', reason: string, deferUntil?: number }}
 */
export function decideResumeAction(input) {
  const { record, now, dueAt, settings } = input;
  const out = (action, reason, extra = {}) => ({ action, reason, ...extra });
  if (!settings?.enabled) return out('skip', 'disabled');
  if (!TRUSTED_RESET_SOURCES.has(String(record?.resetSource || ''))) return out('block', 'unconfirmed_reset');
  if (!(now >= dueAt)) return out('defer', 'before_due');
  if (input.subjectMissing) return out('block', 'session_not_resumable');
  if (input.subjectMoved) return out('cancel', 'subject_moved');
  if ((Number(record.chain) || 0) >= settings.maxChain) return out('block', 'chain_exhausted');
  // An unknown/empty model id is priced as premium: an account-wide lockout row
  // has `model: ''`, so the run's own `subjectModel` is the only price signal.
  const tier = Number.isFinite(input.costTier) ? input.costTier : PREMIUM_COST_TIER;
  if (tier >= PREMIUM_COST_TIER && !settings.allowPremium) return out('block', 'premium_model');
  const lockoutMs = parseMs(input.lockout?.resetAt);
  const catchUpEnd = dueAt + settings.catchUpMs;
  if (Number.isFinite(lockoutMs) && lockoutMs > now) {
    const deferUntil = lockoutMs + Math.max(0, settings.marginMs)
      + resolvePauseJitterMs(record.id, settings.jitterMs);
    if (deferUntil > catchUpEnd) return out('expire', 'catch_up_window_missed');
    return out('defer', 'limit_active', { deferUntil });
  }
  if (now > catchUpEnd) return out('expire', 'catch_up_window_missed');
  if (input.parentBusy) return out('defer', 'parent_busy');
  if (input.sessionResumable === false) return out('block', 'session_not_resumable');
  if (record.subjectType === 'delegation' && settings.resumeDelegations === false) {
    return out('skip', 'delegations_disabled');
  }
  return out('resume', 'due');
}
