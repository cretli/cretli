/**
 * `conditionCheck` settings block in `data/config.json`. Unlike usage-limit
 * resume the feature is on by default: a check only exists because somebody
 * scheduled it. `enabled: false` suppresses both execution and notifications.
 */

import { loadSettings } from './persist/settings.js';

export const CONDITION_CHECK_DEFAULTS = Object.freeze({
  enabled: true,
  maxPerTick: 2,
  harness: '',
  model: '',
});

const MAX_PER_TICK_BOUNDS = [1, 5];
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@=+-]{0,119}$/;

/** Field descriptors for the generic wake-up settings UI. */
export const CONDITION_CHECK_SETTINGS_SCHEMA = Object.freeze({
  enabled: Object.freeze({ type: 'boolean', default: CONDITION_CHECK_DEFAULTS.enabled }),
  maxPerTick: Object.freeze({
    type: 'integer', min: MAX_PER_TICK_BOUNDS[0], max: MAX_PER_TICK_BOUNDS[1], default: CONDITION_CHECK_DEFAULTS.maxPerTick,
  }),
  harness: Object.freeze({ type: 'string', default: CONDITION_CHECK_DEFAULTS.harness }),
  model: Object.freeze({ type: 'string', default: CONDITION_CHECK_DEFAULTS.model }),
});

const ident = (value) => {
  const text = String(value ?? '').trim();
  return IDENT_RE.test(text) ? text : '';
};

/**
 * @param {unknown} raw
 * @returns {typeof CONDITION_CHECK_DEFAULTS}
 */
export function normalizeConditionCheckSettings(raw) {
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const perTick = Math.round(Number(cfg.maxPerTick));
  return {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : CONDITION_CHECK_DEFAULTS.enabled,
    maxPerTick: Number.isFinite(perTick)
      ? Math.min(MAX_PER_TICK_BOUNDS[1], Math.max(MAX_PER_TICK_BOUNDS[0], perTick))
      : CONDITION_CHECK_DEFAULTS.maxPerTick,
    harness: ident(cfg.harness),
    model: ident(cfg.model),
  };
}

/**
 * @param {Record<string, any>|null} [settings] pre-loaded `config.json` (tests/callers)
 * @returns {typeof CONDITION_CHECK_DEFAULTS}
 */
export function readConditionCheckSettings(settings = null) {
  let source = settings;
  if (!source) {
    try { source = loadSettings(); } catch { source = {}; }
  }
  return normalizeConditionCheckSettings(source?.conditionCheck);
}

/**
 * Validates a settings PATCH: unknown keys are dropped, values are clamped by
 * the shared normalizer and omitted keys keep their stored value.
 *
 * @param {unknown} stored current `conditionCheck` block
 * @param {unknown} patch request body
 * @returns {{ ok: true, value: Record<string, any> }|{ ok: false, error: string }}
 */
export function applyConditionCheckPatch(stored, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Invalid settings patch' };
  return { ok: true, value: normalizeConditionCheckSettings({ ...normalizeConditionCheckSettings(stored), ...patch }) };
}
