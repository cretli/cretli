/**
 * Session cost meter for Live voice. Prices come from the shared ledger table.
 * Session warn/cap stay here; the ledger is written separately.
 */

import { createUsageEvent, emptyUsageTokens } from '../../../lib/usage/usage-event.js';
import { formatUsd, priceUsage } from '../../../lib/usage/usage-rates.js';
import { fromGeminiLiveUsage, fromOpenAiRealtimeUsage } from '../../../lib/usage/usage-normalize.js';

export { formatUsd };
export const DEFAULT_WARN_USD = 2;
export const DEFAULT_CAP_USD = 5;

/**
 * @param {object} target
 * @param {object} delta
 * @returns {void}
 */
function addCounts(target, delta) {
  for (const key of Object.keys(target)) {
    target[key] += Number(delta?.[key]) > 0 ? Number(delta[key]) : 0;
  }
}

/**
 * @param {{
 *   model?: string,
 *   provider?: string,
 *   warnUsd?: number,
 *   capUsd?: number,
 *   onChange?: (state: { totalUsd: number, tokens: object }) => void,
 *   onWarn?: (totalUsd: number) => void,
 *   onCap?: (totalUsd: number) => void,
 *   onUsageDelta?: (delta: object) => void,
 * }} [options]
 */
export function createVoiceCostTracker(options = {}) {
  const model = String(options.model || '');
  const provider =
    options.provider ||
    (model.toLowerCase().includes('gemini') ? 'google' : 'openai');
  const warnUsd = Number.isFinite(options.warnUsd) ? Number(options.warnUsd) : DEFAULT_WARN_USD;
  const capUsd = Number.isFinite(options.capUsd) ? Number(options.capUsd) : DEFAULT_CAP_USD;
  const tokens = emptyUsageTokens();
  let totalUsd = 0;
  let warned = false;
  let capped = false;

  function recompute() {
    const priced = priceUsage(
      createUsageEvent({
        provider,
        feature: 'voice-live',
        model,
        tokens,
      })
    );
    totalUsd = Number.isFinite(priced.usd) ? priced.usd : 0;
  }

  function afterChange(delta) {
    recompute();
    if (typeof options.onChange === 'function') {
      options.onChange({ totalUsd, tokens: { ...tokens } });
    }
    if (typeof options.onUsageDelta === 'function' && delta) {
      options.onUsageDelta(delta);
    }
    if (!capped && totalUsd >= capUsd) {
      capped = true;
      if (typeof options.onCap === 'function') options.onCap(totalUsd);
      return;
    }
    if (!warned && totalUsd >= warnUsd) {
      warned = true;
      if (typeof options.onWarn === 'function') options.onWarn(totalUsd);
    }
  }

  return {
    /**
     * @param {object} usage
     * @returns {void}
     */
    addUsage(usage) {
      if (!usage || typeof usage !== 'object') return;
      const delta = fromOpenAiRealtimeUsage(usage);
      const hasQty = Object.values(delta).some((count) => Number(count) > 0);
      if (!hasQty) return;
      addCounts(tokens, delta);
      afterChange(delta);
    },

    /**
     * @param {object} usage
     * @returns {void}
     */
    addGeminiUsage(usage) {
      if (!usage || typeof usage !== 'object') return;
      const delta = fromGeminiLiveUsage(usage, tokens);
      const hasQty = Object.values(delta).some((count) => Number(count) > 0);
      if (!hasQty) return;
      addCounts(tokens, delta);
      afterChange(delta);
    },

    getTotalUsd() {
      return totalUsd;
    },

    getTokens() {
      return { ...tokens };
    },

    isCapped() {
      return capped;
    },

    reset() {
      for (const key of Object.keys(tokens)) tokens[key] = 0;
      totalUsd = 0;
      warned = false;
      capped = false;
    },
  };
}
