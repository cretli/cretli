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
 *   canRate: boolean,
 *   userRating: { score: number, tags: string[], note: string, ts: string } | null,
 *   showUnverified: boolean,
 *   showUncertain: boolean,
 *   attemptNumber: number,
 *   sourceKind: string,
 *   pickReason: string,
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
  if (canRetry) actions.push('retry');
  if (canRate) actions.push('rate');
  return {
    canCancel,
    canRetry,
    canAck,
    canRate,
    userRating,
    showUnverified,
    showUncertain,
    interruptCode: String(data?.interruptCode || ''),
    attemptNumber: countDelegationAttempts(data),
    sourceKind: String(data?.sourceKind || 'plan'),
    // Optional model_pick justification; empty on legacy records.
    pickReason: String(data?.pickReason || '').trim(),
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
