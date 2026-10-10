/**
 * Native DeepSeek Harness (DSH) compaction policy for Cretli's SDK profile.
 *
 * DSH ships `dsh-compaction-basic`, which the base profile mounts with no
 * explicit config: it compacts at 80% of the routed model's context window.
 * Cretli declares a 1_000_000-token window for every DeepSeek model, so
 * automatic compaction only fires near 800k tokens — very late, and long after
 * the conversation has become expensive.
 *
 * Cretli must not rewrite harness history. Instead it lowers the native
 * threshold through the generated cordis patch
 * (`dsh-runtime.cordis.patch.yml`), starting compaction earlier so DSH itself
 * keeps the conversation bounded. The value stays configurable.
 *
 * Precedence: env override, then the `deepseekCompaction` setting, then the
 * shipped default. An invalid value falls back to the default rather than
 * rejecting the harness at load time.
 */

import { loadSettings } from '../persist/settings.js';

/**
 * Shipped default lowers the trigger from DSH's 0.8 to 0.5 of the declared
 * window (about 500k tokens) while keeping a 0.16 verbatim tail. `retainRatio`
 * must stay below `thresholdRatio`.
 */
export const DEEPSEEK_COMPACTION_DEFAULTS = Object.freeze({
  thresholdRatio: 0.5,
  retainRatio: 0.16,
});

export const DEEPSEEK_COMPACTION_ENV = Object.freeze({
  thresholdRatio: 'CRETLI_DEEPSEEK_COMPACTION_THRESHOLD_RATIO',
  retainRatio: 'CRETLI_DEEPSEEK_COMPACTION_RETAIN_RATIO',
});

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ minExclusive?: number, max?: number }} [bounds]
 * @returns {number}
 */
function parseRatio(value, fallback, bounds = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (Number.isFinite(bounds.minExclusive) && parsed <= Number(bounds.minExclusive)) return fallback;
  if (Number.isFinite(bounds.max) && parsed > Number(bounds.max)) return fallback;
  return parsed;
}

/**
 * Resolve the DSH compaction policy patch values.
 *
 * @param {object | null} [settings] - loadSettings() result; loaded when omitted
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ thresholdRatio: number, retainRatio: number }}
 */
export function resolveDeepSeekCompactionConfig(settings = null, env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const settingsSource = settings || loadSettings();
  const configured = settingsSource?.deepseekCompaction;
  const fromSettings = configured && typeof configured === 'object' ? configured : {};

  const thresholdRatio = parseRatio(
    source[DEEPSEEK_COMPACTION_ENV.thresholdRatio] ?? fromSettings.thresholdRatio,
    DEEPSEEK_COMPACTION_DEFAULTS.thresholdRatio,
    { minExclusive: 0, max: 1 },
  );
  let retainRatio = parseRatio(
    source[DEEPSEEK_COMPACTION_ENV.retainRatio] ?? fromSettings.retainRatio,
    DEEPSEEK_COMPACTION_DEFAULTS.retainRatio,
    { minExclusive: 0, max: 1 },
  );
  // DSH rejects a retainRatio that is not strictly below the threshold; clamp
  // rather than fail the boot.
  if (retainRatio >= thresholdRatio) retainRatio = DEEPSEEK_COMPACTION_DEFAULTS.retainRatio;
  if (retainRatio >= thresholdRatio) retainRatio = thresholdRatio / 2;
  return { thresholdRatio, retainRatio };
}
