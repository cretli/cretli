/**
 * Pure text builder for the delegation card's weekly pace line.
 *
 * Kept out of `sdk-rich-view.js` (which has browser-only imports) so the line
 * can be unit-tested in Node. Every user-facing string goes through the passed
 * `t`, so the module never embeds a language.
 */

/** i18n keys for the closed set of neutrality reasons the picker emits. */
const PACE_REASON_KEYS = Object.freeze({
  stale: 'chat.delegationPlanPaceReason.stale',
  expired: 'chat.delegationPlanPaceReason.expired',
  scope_mismatch: 'chat.delegationPlanPaceReason.scope_mismatch',
  reading_unknown: 'chat.delegationPlanPaceReason.reading_unknown',
  reading_old: 'chat.delegationPlanPaceReason.reading_old',
  invalid_window: 'chat.delegationPlanPaceReason.invalid_window',
});

/**
 * Falls back when a dictionary has no entry (the real `t` returns the key).
 *
 * @param {(key: string, vars?: Record<string, string>) => string} t
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function translate(t, key, fallback) {
  const value = t(key);
  return typeof value === 'string' && value !== key ? value : fallback;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function percentText(value) {
  return value == null ? '?' : `${value}%`;
}

/**
 * Compact `summary` (the visible line) plus a `detail` string for its `title`
 * tooltip. `summary` carries level, cost factor and a per-window one-liner;
 * `detail` adds the measurement fields of every window: reading time
 * (`readingObservedAt`), measured/estimated basis (`measuredUtilization` /
 * `estimatedPp`), elapsed percent, slack (`slackPct`) and the neutrality
 * `reason` of an ineligible window.
 *
 * @param {{
 *   level?: unknown, costFactor?: unknown, observedAt?: unknown,
 *   windows?: Array<{
 *     type?: unknown, utilization?: unknown, measuredUtilization?: unknown,
 *     estimatedPp?: unknown, elapsedPct?: unknown, slackPct?: unknown,
 *     eligible?: unknown, reason?: unknown, readingObservedAt?: unknown,
 *   }>,
 * } | null | undefined} planPace
 * @param {(key: string, vars?: Record<string, string>) => string} t
 * @returns {{ summary: string, detail: string }}
 */
export function buildPlanPaceLine(planPace, t) {
  const windows = Array.isArray(planPace?.windows) ? planPace.windows : [];
  if (!planPace || windows.length === 0) return { summary: '', detail: '' };
  const level = Number(planPace.level);
  const levelLabel = translate(
    t,
    `chat.delegationPlanPaceLevel.${Number.isFinite(level) ? level : 0}`,
    String(planPace.level ?? 0),
  );
  const costFactor = Number(planPace.costFactor);
  const costText = Number.isFinite(costFactor)
    ? translate(t, 'chat.delegationPlanPaceCost', `cost x${costFactor}`).replace('{factor}', String(costFactor))
    : '';
  const header = `${t('chat.delegationPlanPace')}: ${levelLabel}${costText ? ` (${costText})` : ''}`;
  const summaryRows = [];
  const detailRows = [];
  for (const window of windows) {
    const type = String(window?.type || '?');
    const reason = String(window?.reason || '').trim();
    const reasonKey = PACE_REASON_KEYS[reason];
    const reasonText = reasonKey ? translate(t, reasonKey, reason) : reason;
    if (window?.eligible !== true || window?.utilization == null) {
      const neutral = reasonText || translate(t, 'chat.delegationPlanPaceUnreliable', 'unreliable reading');
      summaryRows.push(`${type} ${neutral}`);
      detailRows.push(`${type}: ${neutral}`);
      continue;
    }
    summaryRows.push(`${type} ${percentText(window.utilization)}`);
    const parts = [percentText(window.utilization)];
    if (window.measuredUtilization != null) {
      parts.push(translate(t, 'chat.delegationPlanPaceMeasured', 'measured {value}%')
        .replace('{value}', String(window.measuredUtilization)));
    }
    if (Number(window.estimatedPp) > 0) {
      parts.push(translate(t, 'chat.delegationPlanPaceEstimated', 'est. +{value} pp')
        .replace('{value}', String(window.estimatedPp)));
    }
    if (window.elapsedPct != null) {
      parts.push(translate(t, 'chat.delegationPlanPaceElapsed', 'elapsed {value}%')
        .replace('{value}', String(window.elapsedPct)));
    }
    if (window.slackPct != null) {
      parts.push(translate(t, 'chat.delegationPlanPaceSlack', 'slack {value} pp')
        .replace('{value}', String(window.slackPct)));
    }
    if (window.readingObservedAt) {
      parts.push(translate(t, 'chat.delegationPlanPaceReadingAt', 'reading {value}')
        .replace('{value}', String(window.readingObservedAt)));
    }
    detailRows.push(`${type}: ${parts.join(' · ')}`);
  }
  const snapshotAt = planPace.observedAt
    ? translate(t, 'chat.delegationPlanPaceSnapshotAt', 'snapshot {value}').replace('{value}', String(planPace.observedAt))
    : '';
  const detail = [header, ...detailRows, snapshotAt].filter(Boolean).join(' · ');
  return { summary: `${header} (${summaryRows.join(', ')})`, detail };
}
