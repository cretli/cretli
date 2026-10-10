/**
 * Opt-in Claude Code caching / auto-compaction environment overrides.
 *
 * Cretli cannot rewrite Claude history, and Claude Code already caches prompts
 * automatically. These knobs only tune the CLI's own native behavior and are
 * all OFF by default:
 *
 * - `ENABLE_PROMPT_CACHING_1H` requests the 1-hour prompt-cache TTL.
 * - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` changes the auto-compaction percentage.
 * - `DISABLE_AUTO_COMPACT` turns automatic compaction off.
 *
 * IMPORTANT: these variable names come from third-party issue reports
 * (anthropics/claude-code #48082, #49139), not from official Anthropic
 * documentation, and the 1-hour cache reportedly does not work for every API
 * key. Treat them as unverified, keep them opt-in, and verify by measuring
 * `cache_creation.ephemeral_1h` before relying on them.
 */

import { loadSettings } from '../persist/settings.js';

/** Defaults stay off so an existing Claude setup is unchanged. */
export const CLAUDE_CACHE_SETTINGS_DEFAULTS = Object.freeze({
  promptCaching1h: false,
  autocompactPctOverride: null,
  disableAutoCompact: false,
});

export const CLAUDE_CACHE_ENV = Object.freeze({
  promptCaching1h: 'ENABLE_PROMPT_CACHING_1H',
  autocompactPctOverride: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
  disableAutoCompact: 'DISABLE_AUTO_COMPACT',
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isEnabled(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const raw = String(value).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Normalize the auto-compaction percentage. Claude expects a positive integer
 * percentage; out-of-range input is dropped instead of silently clamping.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function normalizeClaudeAutocompactPct(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) return null;
  return parsed;
}

/**
 * Resolve the opt-in cache settings from config.json.
 *
 * @param {object | null} [settings] - loadSettings() result; loaded when omitted
 * @returns {{ promptCaching1h: boolean, autocompactPctOverride: number | null, disableAutoCompact: boolean }}
 */
export function resolveClaudeCacheSettings(settings = null) {
  const source = settings || loadSettings();
  return {
    promptCaching1h: isEnabled(source?.claudePromptCaching1h),
    autocompactPctOverride: normalizeClaudeAutocompactPct(source?.claudeAutocompactPctOverride),
    disableAutoCompact: isEnabled(source?.claudeDisableAutoCompact),
  };
}

/**
 * Merge the opt-in cache/compaction overrides into a Claude subprocess env.
 * Mutates and returns `env` for convenience. A disabled/normalized-away option
 * is left untouched, so an operator's own process env still passes through.
 *
 * @param {Record<string, string | undefined>} env
 * @param {object | null} [settings]
 * @returns {Record<string, string | undefined>}
 */
export function applyClaudeCacheEnv(env, settings = null) {
  const target = env && typeof env === 'object' ? env : {};
  const resolved = resolveClaudeCacheSettings(settings);
  if (resolved.promptCaching1h) target[CLAUDE_CACHE_ENV.promptCaching1h] = '1';
  if (resolved.autocompactPctOverride !== null) {
    target[CLAUDE_CACHE_ENV.autocompactPctOverride] = String(resolved.autocompactPctOverride);
  }
  if (resolved.disableAutoCompact) target[CLAUDE_CACHE_ENV.disableAutoCompact] = '1';
  return target;
}

/**
 * Build only the overlay map (useful for tests and diagnostics).
 *
 * @param {object | null} [settings]
 * @returns {Record<string, string>}
 */
export function buildClaudeCacheEnvOverlay(settings = null) {
  /** @type {Record<string, string>} */
  const overlay = {};
  applyClaudeCacheEnv(overlay, settings);
  return overlay;
}
