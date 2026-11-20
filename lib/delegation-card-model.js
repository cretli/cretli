/**
 * Pure view-model for a delegation history card.
 */

import { isActiveDelegationStatus, isServerRestartInterrupt, isTerminalDelegationStatus } from './delegation-status.js';
import { countDelegationAttempts, listDelegationAttempts } from './delegation-attempt.js';
import { normalizePlanPaceSnapshot } from './model-pick-plan-window.js';
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
 * @param {Record<string, any>} value
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
 * Bounded copy of the weekly pace snapshot; `null` when absent or malformed.
 * The level is clamped to -1..1 and the cost factor to 0.5..2, so a
 * legacy/tampered record never renders an out-of-range pace. Keeps every
 * measurement field (measurement time, measured/estimated basis, slack) and a
 * known window whose reading is unusable (null `utilization` + a reason).
 *
 * @param {unknown} value
 * @returns {{
 *   level: number, costFactor: number, observedAt: string,
 *   windows: {
 *     type: string, limitId: string, resetsAt: string,
 *     utilization: number | null, measuredUtilization: number | null,
 *     estimatedPp: number, elapsedPct: number | null, slackPct: number | null,
 *     eligible: boolean, reason: string, readingObservedAt: string,
 *   }[],
 * } | null}
 */
function normalizePlanPace(value) {
  return normalizePlanPaceSnapshot(value);
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
 *   selection: { origin: string, detail: string, startContext: string, startContextSource: string, continuationOf: string, uiActionProof: boolean, fallbackFailureClass: string, exclusion: { failureClass: string, scope: string, reason: string, expiresAt: string } | null },
 *   planHeadroom: { level: number, hardFreePercent: number, windows: { type: string, utilization: number, resetsAt: string }[] } | null,
 *   planPace: { level: number, costFactor: number, observedAt: string, windows: { type: string, limitId: string, resetsAt: string, utilization: number | null, measuredUtilization: number | null, estimatedPp: number, elapsedPct: number | null, slackPct: number | null, eligible: boolean, reason: string, readingObservedAt: string }[] } | null,
 *   sessionResume: { status: string, reasonCode: string, reason: string, round: number } | null,
 *   reviewerPolicy: { subject: string, session: string, selection: string, membership: string, revision: string, reuse: { status: string, reasonCode: string, reason: string, sourceDelegationId: string } | null } | null,
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
  return {
    canCancel,
    canRetry,
    canAck,
    canAccept,
    isAccepted,
    attemptId,
    userRating,
    showUnverified,
    showUncertain,
    interruptCode: String(data?.interruptCode || ''),
    attemptNumber: countDelegationAttempts(data),
    sourceKind: String(data?.sourceKind || 'plan'),
    // Optional model_pick justification; empty on legacy records.
    pickReason: String(data?.pickReason || '').trim(),
    // Why this executor: picker / continuation / manual source, the start
    // context, a fallback's failure class and any active exclusion with its
    // scope and expiry (server-owned; never prose).
    selection: {
      origin: String(data?.pickOrigin || '').trim() || 'unknown',
      detail: String(data?.pickOriginDetail || '').trim(),
      startContext: String(data?.startContext || '').trim() || 'legacy_ad_hoc',
      startContextSource: String(data?.startContextSource || '').trim(),
      continuationOf: String(data?.continuationOf || '').trim(),
      uiActionProof: data?.uiActionProof === true,
      pickFallbackFrom: String(data?.pickFallbackFrom || '').trim(),
      fallbackFailureClass: String(data?.fallbackFailureClass || '').trim(),
      exclusion: data?.executorExclusion && typeof data.executorExclusion === 'object'
        ? {
          failureClass: String(data.executorExclusion.failureClass || ''),
          scope: String(data.executorExclusion.scope || ''),
          reason: String(data.executorExclusion.reason || ''),
          expiresAt: String(data.executorExclusion.expiresAt || ''),
        }
        : null,
    },
    // Plan-window headroom snapshot at start; independent of pickReason.
    planHeadroom: normalizePlanHeadroom(data?.planHeadroomSnapshot),
    // Weekly pace snapshot at start; null on records created before the field.
    planPace: normalizePlanPace(data?.planPaceSnapshot),
    // Resumed round or recorded fallback of an explicit session resume.
    sessionResume: data?.sessionResume && data.sessionResume.requested === true
      ? {
        status: ['resumed', 'fresh'].includes(String(data.sessionResume.status || '')) ? String(data.sessionResume.status) : 'fallback',
        reasonCode: String(data.sessionResume.reasonCode || '').trim(),
        reason: String(data.sessionResume.reason || '').trim(),
        round: Math.max(1, Math.floor(Number(data.sessionResume.round)) || 1),
      }
      : null,
    // Reviewer policy in force at start and why a session was (not) reused.
    reviewerPolicy: data?.reviewerPolicy && typeof data.reviewerPolicy === 'object'
      ? {
        subject: String(data.reviewerPolicy.subject || '').trim(),
        session: String(data.reviewerPolicy.session || '').trim(),
        selection: String(data.reviewerPolicy.selection || '').trim(),
        membership: String(data.reviewerPolicy.membership || '').trim(),
        revision: String(data.reviewerPolicy.revision || '').trim(),
        reuse: data.reviewerPolicy.reuse && typeof data.reviewerPolicy.reuse === 'object'
          ? {
            status: String(data.reviewerPolicy.reuse.status || '').trim(),
            reasonCode: String(data.reviewerPolicy.reuse.reasonCode || '').trim(),
            reason: String(data.reviewerPolicy.reuse.reason || '').trim(),
            sourceDelegationId: String(data.reviewerPolicy.reuse.sourceDelegationId || '').trim(),
          }
          : null,
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
