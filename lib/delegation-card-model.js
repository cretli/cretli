/**
 * Pure view-model for a delegation history card.
 */

import { isActiveDelegationStatus, isServerRestartInterrupt, isTerminalDelegationStatus } from './delegation-status.js';
import { countDelegationAttempts, listDelegationAttempts } from './delegation-attempt.js';
import {
  DELEGATION_RATING_MAX_SCORE,
  DELEGATION_RATING_MIN_SCORE,
  DELEGATION_RATING_TAGS,
} from './delegation-rating-constants.js';

function delegationRatingCardSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  const score = source.score;
  if (!Number.isInteger(score)
    || Number(score) < DELEGATION_RATING_MIN_SCORE
    || Number(score) > DELEGATION_RATING_MAX_SCORE) return null;
  const ts = String(source.ts || '');
  if (!Number.isFinite(Date.parse(ts))) return null;
  const tags = Array.isArray(source.tags)
    ? source.tags.map((tag) => String(tag ?? '').trim().toLowerCase())
      .filter((tag) => DELEGATION_RATING_TAGS.includes(tag))
    : [];
  return { score: Number(score), tags, note: String(source.note ?? '').trim(), ts };
}

/**
 * Bounded copy of the plan-headroom snapshot; `null` when absent or malformed.
 *
 * @param {unknown} value
 * @returns {{ level: number, hardFreePercent: number, windows: { type: string, utilization: number, resetsAt: string }[] } | null}
 */
function normalizePlanHeadroom(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.windows)) return null;
  const windows = value.windows.slice(0, 6)
    .filter((w) => w && typeof w === 'object' && Number.isFinite(Number(w.utilization)))
    .map((w) => ({
      type: String(w.type || '').slice(0, 40),
      utilization: Number(w.utilization),
      resetsAt: String(w.resetsAt || '').slice(0, 40),
    }));
  if (!windows.length) return null;
  return {
    level: Number.isFinite(Number(value.level)) ? Math.min(3, Math.max(0, Math.round(Number(value.level)))) : 1,
    hardFreePercent: Number.isFinite(Number(value.hardFreePercent)) ? Number(value.hardFreePercent) : 5,
    windows,
  };
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown> | null}
 */
function parseHistoryPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return /** @type {Record<string, unknown>} */ (payload);
  }
  if (typeof payload !== 'string' || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} data
 * @returns {'pending' | 'delivered' | 'uncertain'}
 */
function resolveDeliveryState(data) {
  const explicit = String(data?.delivery || data?.uncertain || '').trim();
  if (explicit === 'uncertain' || String(data?.status || '') === 'interrupted') return 'uncertain';
  const history = String(data?.historyDeliveredAt || '').trim();
  const report = String(data?.reportDeliveredAt || '').trim();
  if (history && report) return 'delivered';
  if (history || report) return 'delivered';
  return 'pending';
}

/**
 * @param {Record<string, unknown>} data
 * @returns {{
 *   canCancel: boolean,
 *   canRetry: boolean,
 *   canAck: boolean,
 *   canAccept: boolean,
 *   isAccepted: boolean,
 *   attemptId: string,
 *   userRating: { score: number, tags: string[], note: string, ts: string } | null,
 *   showUnverified: boolean,
 *   showUncertain: boolean,
 *   attemptNumber: number,
 *   sourceKind: string,
 *   pickReason: string,
 *   planHeadroom: { level: number, hardFreePercent: number, windows: { type: string, utilization: number, resetsAt: string }[] } | null,
 *   sessionResume: { status: string, reasonCode: string, reason: string, round: number } | null,
 *   allowChildDelegations: boolean,
 *   durationMs: number,
 *   deliveryState: 'pending' | 'delivered' | 'uncertain',
 *   historyDelivered: boolean,
 *   reportDelivered: boolean,
 *   attemptHistory: object[],
 *   actions: string[],
 * }}
 */
export function buildDelegationCardModel(data) {
  const status = String(data?.status || '').trim();
  const acknowledgedAt = String(data?.acknowledgedAt || '').trim();
  const acknowledgedAttemptId = String(data?.acknowledgedAttemptId || '').trim();
  const attemptId = String(data?.attemptId || '').trim();
  const ackMatchesAttempt = !acknowledgedAttemptId || !attemptId || acknowledgedAttemptId === attemptId;
  const canCancel = isActiveDelegationStatus(status) && status !== 'cancelling';
  // Interrupted jobs may only be continued once, and only for a genuine
  // server restart. Other codes and legacy rows without a code are stop-only.
  const interruptedRetryable = isServerRestartInterrupt({ status, interruptCode: data?.interruptCode })
    && !String(data?.interruptContinuedAt || '').trim();
  const canRetry = isTerminalDelegationStatus(status)
    && (status !== 'interrupted' || interruptedRetryable);
  const canAck = !acknowledgedAt && (
    status === 'completed' || status === 'failed' || status === 'interrupted'
  );
  // Human acceptance (contract §7): a completed review attempt that no human
  // accepted yet. An agent ack with the `accepted` reason is a channel signal,
  // not the UI action §7.1 requires, so it must not remove the button — only the
  // matching human acceptance does. The attempt id is mandatory: acceptance is
  // bound to the attempt the card shows.
  const humanAcceptance = String(data?.acknowledgedReason || '').trim() === 'accepted'
    && String(data?.acknowledgedActor || '').trim() === 'human'
    && ackMatchesAttempt;
  const canAccept = String(data?.assignment || '').trim() === 'review'
    && status === 'completed'
    && !!attemptId
    && !humanAcceptance;
  const isAccepted = humanAcceptance;
  const userRating = delegationRatingCardSnapshot(data?.userRating);
  // Terminal jobs only, and only until the persisted user rating exists — the
  // star controls are read-only afterwards (ratings are immutable).
  const canRate = isTerminalDelegationStatus(status) && !userRating;
  const showUnverified = data?.unverified !== false
    && status === 'completed'
    && (!acknowledgedAt || !ackMatchesAttempt);
  const deliveryState = resolveDeliveryState(data);
  const showUncertain = deliveryState === 'uncertain';
  const startedAt = Date.parse(String(data?.startedAt || data?.createdAt || ''));
  const finishedAt = Date.parse(String(data?.finishedAt || ''));
  const end = Number.isFinite(finishedAt) ? finishedAt : Date.now();
  const durationMs = Number.isFinite(startedAt) ? Math.max(0, end - startedAt) : 0;
  const actions = [];
  if (canCancel) actions.push('cancel');
  if (canAck) actions.push('ack');
  if (canAccept) actions.push('accept');
  if (canRetry) actions.push('retry');
  if (canRate) actions.push('rate');
  return {
    canCancel,
    canRetry,
    canAck,
    canAccept,
    isAccepted,
    attemptId,
    canRate,
    userRating,
    showUnverified,
    showUncertain,
    interruptCode: String(data?.interruptCode || ''),
    attemptNumber: countDelegationAttempts(data),
    sourceKind: String(data?.sourceKind || 'plan'),
    // Optional model_pick justification; empty on legacy records.
    pickReason: String(data?.pickReason || '').trim(),
    // Plan-window headroom snapshot at start; independent of pickReason.
    planHeadroom: normalizePlanHeadroom(data?.planHeadroomSnapshot),
    // Resumed round or recorded fallback of an explicit session resume.
    sessionResume: data?.sessionResume && data.sessionResume.requested === true
      ? {
        status: String(data.sessionResume.status || '') === 'resumed' ? 'resumed' : 'fallback',
        reasonCode: String(data.sessionResume.reasonCode || '').trim(),
        reason: String(data.sessionResume.reason || '').trim(),
        round: Math.max(1, Math.floor(Number(data.sessionResume.round)) || 1),
      }
      : null,
    // Explicit permission for the child to start nested delegations.
    allowChildDelegations: data?.allowChildDelegations === true,
    durationMs,
    deliveryState,
    historyDelivered: Boolean(String(data?.historyDeliveredAt || '').trim()),
    reportDelivered: Boolean(String(data?.reportDeliveredAt || '').trim()),
    attemptHistory: listDelegationAttempts(data),
    actions,
  };
}

/**
 * Replay history cards the way a reconnecting client applies seq-ordered events.
 *
 * @param {Array<{ seq?: number, rec?: { payload?: unknown } } | Record<string, unknown>>} events
 * @returns {Map<string, ReturnType<typeof buildDelegationCardModel> & { id: string, status: string, payload: Record<string, unknown>, seq: number }>}
 */
export function projectDelegationCardsFromHistory(events) {
  /** @type {Map<string, ReturnType<typeof buildDelegationCardModel> & { id: string, status: string, payload: Record<string, unknown>, seq: number }>} */
  const cards = new Map();
  const rows = Array.isArray(events) ? events : [];
  for (const row of rows) {
    const rec = row && typeof row === 'object' && 'rec' in row
      ? /** @type {{ rec?: { payload?: unknown }, seq?: number }} */ (row)
      : { rec: { payload: row }, seq: 0 };
    const payload = parseHistoryPayload(rec.rec?.payload) || parseHistoryPayload(row);
    const id = String(payload?.id || '').trim();
    if (!id) continue;
    const seq = Number(rec.seq) || 0;
    const previous = cards.get(id);
    if (previous && previous.seq > 0 && seq > 0 && seq <= previous.seq) continue;
    const model = buildDelegationCardModel(payload);
    cards.set(id, {
      ...model,
      id,
      status: String(payload?.status || ''),
      payload,
      seq,
    });
  }
  return cards;
}
