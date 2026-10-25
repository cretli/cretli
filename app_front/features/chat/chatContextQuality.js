import {
  resolveOccupancyFreshness,
  resolveUsageContract,
  resolveWindowSemantics,
} from '../../../lib/usage/usage-contract.js';

/**
 * Measurement-quality view of a context snapshot. It reads the existing usage
 * contract (window semantics, granularity, occupancy freshness) and never
 * invents a number: it only labels the one the meter already holds and says
 * whether that number may be shown as a percentage or used automatically.
 *
 * @typedef {'reported' | 'estimated' | 'unknown'} ContextQuality
 * @typedef {'current_prompt' | 'transcript_estimate' | 'unknown'} ContextScope
 * @typedef {'provider' | 'catalog' | 'manual' | 'unknown'} ContextLimitSource
 */

/**
 * @param {Record<string, any>|null|undefined} chat
 * @param {number|null|undefined} windowTokens resolved window
 * @returns {{ type: 'context_window' | 'unknown', source: ContextLimitSource }}
 */
export function describeContextLimit(chat, windowTokens) {
  if (!Number.isFinite(windowTokens) || windowTokens == null || windowTokens <= 0) {
    return { type: 'unknown', source: 'unknown' };
  }
  const transport = String(chat?.agentTransport || '').trim();
  // A server-stamped source (usageMeta.occupancy.limitSource) wins when its
  // window is the one in use.
  const serverSource = String(chat?._contextServerLimitSource || '');
  if (Number(chat?._contextServerLimitTokens) === windowTokens
    && ['provider', 'catalog', 'manual'].includes(serverSource)) {
    return { type: 'context_window', source: /** @type {ContextLimitSource} */ (serverSource) };
  }
  const provider = (transport === 'claude' || transport === 'codex')
    && Number(chat?._contextMeasuredWindowTokens) === windowTokens;
  return { type: 'context_window', source: provider ? 'provider' : 'catalog' };
}

/**
 * @param {{
 *   transport?: string,
 *   fillProvenance?: string,
 *   isEstimated?: boolean,
 *   inputTokens?: number|null,
 *   fillPercent?: number|null,
 *   contextWindowTokens?: number|null,
 *   updatedAt?: number|null,
 *   contextMeterEpoch?: number|null,
 *   measurementEpoch?: number|null,
 *   limitSource?: ContextLimitSource,
 * }} snapshot
 * @param {{ now?: number }} [options]
 * @returns {{
 *   quality: ContextQuality,
 *   scope: ContextScope,
 *   granularity: string|null,
 *   semantics: 'disjoint'|'inclusive'|'unknown',
 *   limitType: 'context_window'|'unknown',
 *   limitSource: ContextLimitSource,
 *   ageMs: number|null,
 *   stale: boolean,
 *   percentReliable: boolean,
 *   autoEligible: boolean,
 *   reasons: string[],
 * }}
 */
export function describeContextQuality(snapshot, options = {}) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const transport = String(snap.transport || '').trim();
  const provenance = snap.isEstimated === true ? 'estimated' : snap.fillProvenance;
  /** @type {ContextQuality} */
  const quality = provenance === 'measured' ? 'reported' : provenance === 'estimated' ? 'estimated' : 'unknown';
  const contract = resolveUsageContract(transport);
  const semantics = resolveWindowSemantics(contract);
  const windowKnown = Number.isFinite(snap.contextWindowTokens) && Number(snap.contextWindowTokens) > 0;
  const limitSource = windowKnown ? snap.limitSource || 'catalog' : 'unknown';
  const reasons = [];
  if (quality !== 'reported') reasons.push(`quality_${quality}`);
  if (!windowKnown) reasons.push('limit_unknown');
  if (semantics === 'unknown') reasons.push('window_semantics_unknown');

  const observedAt = Number(snap.updatedAt);
  const hasTime = Number.isFinite(observedAt) && observedAt > 0;
  const freshness = hasTime
    ? resolveOccupancyFreshness({ observedAt, now: options.now, transport: 'live' })
    : null;
  const ageMs = freshness?.ageMs != null ? Math.max(0, freshness.ageMs) : null;
  const stale = freshness != null && !freshness.fresh;
  if (quality === 'reported' && (!hasTime || stale)) reasons.push('stale_or_unknown_time');

  const epochOk = snap.measurementEpoch != null
    && Number(snap.measurementEpoch) === Number(snap.contextMeterEpoch ?? 0);
  if (quality === 'reported' && !epochOk) reasons.push('context_epoch_mismatch');

  // A percentage needs a known window and known semantics; estimates may be
  // shown (labelled) but never count as reliable.
  const percentReliable = quality === 'reported' && windowKnown && semantics !== 'unknown'
    && hasTime && !stale && epochOk;
  const autoEligible = percentReliable && Number(snap.inputTokens) > 0;
  return {
    quality,
    scope: quality === 'reported' ? 'current_prompt' : quality === 'estimated' ? 'transcript_estimate' : 'unknown',
    granularity: quality === 'reported' ? /** @type {any} */ (contract).granularity || null : null,
    semantics,
    limitType: windowKnown ? 'context_window' : 'unknown',
    limitSource,
    ageMs,
    stale,
    percentReliable,
    autoEligible,
    reasons,
  };
}

/**
 * @param {number|null|undefined} ageMs
 * @param {(key: string, params?: object) => string} t
 * @returns {string}
 */
export function formatContextAge(ageMs, t) {
  if (ageMs == null || !Number.isFinite(ageMs)) return t('chat.contextQualityAgeUnknown');
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return t('chat.contextQualityAgeSeconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('chat.contextQualityAgeMinutes', { n: minutes });
  return t('chat.contextQualityAgeHours', { n: Math.floor(minutes / 60) });
}

/**
 * Short advisory suffix naming the quality, or '' for a fresh reported reading.
 * @param {ReturnType<typeof describeContextQuality>|null|undefined} q
 * @param {(key: string, params?: object) => string} t
 * @returns {string}
 */
export function formatContextQualityNote(q, t) {
  if (!q) return '';
  if (q.quality === 'estimated') return t('chat.contextQualityNoteEstimated');
  if (q.quality === 'unknown') return t('chat.contextQualityNoteUnknown');
  if (q.stale) return t('chat.contextQualityNoteStale', { age: formatContextAge(q.ageMs, t) });
  if (q.limitType === 'unknown') return t('chat.contextQualityNoteLimitUnknown');
  return '';
}

/**
 * Text for the quality rows of the details modal. The quality is re-derived
 * from the snapshot at render time so the age and staleness are current.
 *
 * @param {object|null|undefined} snapshot
 * @param {(key: string, params?: object) => string} t
 * @param {{ now?: number }} [options]
 * @returns {{ quality: string, scope: string, granularity: string, age: string, limit: string, auto: string }}
 */
export function describeContextQualityRows(snapshot, t, options = {}) {
  if (!snapshot) {
    const dash = '—';
    return { quality: dash, scope: dash, granularity: dash, age: dash, limit: dash, auto: dash };
  }
  const q = describeContextQuality(snapshot, options);
  const qualityKey = { reported: 'Reported', estimated: 'Estimated', unknown: 'Unknown' }[q.quality];
  const scopeKey = { current_prompt: 'CurrentPrompt', transcript_estimate: 'Estimate', unknown: 'Unknown' }[q.scope];
  const limitKey = { provider: 'Provider', catalog: 'Catalog', manual: 'Manual', unknown: 'Unknown' }[q.limitSource];
  const age = formatContextAge(q.ageMs, t);
  return {
    quality: t(`chat.contextQuality${qualityKey}`),
    scope: t(`chat.contextQualityScope${scopeKey}`),
    granularity: q.granularity || t('chat.contextQualityGranularityUnknown'),
    age: q.stale ? `${age} · ${t('chat.contextQualityStale')}` : age,
    limit: t(`chat.contextQualityLimit${limitKey}`),
    auto: t(q.autoEligible ? 'chat.contextQualityAutoYes' : 'chat.contextQualityAutoNo'),
  };
}
