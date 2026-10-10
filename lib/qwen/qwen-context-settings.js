/**
 * Native Qwen Code context/compaction settings.
 *
 * Cretli owns the Qwen HOME (`lib/qwen/qwen-cli.js`), so it can write the
 * harness's own `settings.json` instead of rewriting any history. The values
 * below mirror the keys Qwen Code reads:
 *
 * - `context.clearContextOnIdle` clears old tool-result content after idle time
 *   or size pressure (deterministic, no LLM call). Defaults observed in the
 *   bundled CLI: 60 minutes idle, keep the newest 5 results, 500_000 chars.
 * - `context.autoCompactThreshold` is the target fraction of the context window
 *   at which auto-compaction triggers; Qwen's documented default is 0.85.
 * - `model.generationConfig.enableCacheControl` keeps explicit prompt caching
 *   on (Qwen's default is true).
 *
 * Precedence: `CRETLI_QWEN_CONTEXT_SETTINGS` JSON env, then the
 * `qwenContextSettings` setting, then the documented defaults. Existing
 * unrelated keys in settings.json are preserved.
 */

import fs from 'fs';
import path from 'path';
import { loadSettings } from '../persist/settings.js';
import { writeJsonAtomic } from '../persist/atomic-write.js';
import { resolveQwenHomeDir } from './qwen-cli.js';

export const DEFAULT_QWEN_CLEAR_CONTEXT_ON_IDLE = Object.freeze({
  toolResultsThresholdMinutes: 60,
  toolResultsNumToKeep: 5,
  toolResultsTotalCharsThreshold: 500_000,
});

export const DEFAULT_QWEN_AUTO_COMPACT_THRESHOLD = 0.85;
export const DEFAULT_QWEN_ENABLE_CACHE_CONTROL = true;

/** Env var holding a JSON object merged over the settings/defaults. */
export const QWEN_CONTEXT_SETTINGS_ENV = 'CRETLI_QWEN_CONTEXT_SETTINGS';

/** Settings file path for an explicit home dir (default: Cretli's Qwen HOME). */
export function resolveQwenSettingsPath(homeDir = resolveQwenHomeDir()) {
  return path.join(String(homeDir || resolveQwenHomeDir()), '.qwen', 'settings.json');
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function asNumber(value, fallback, bounds = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (Number.isFinite(bounds.min) && parsed < Number(bounds.min)) return fallback;
  if (Number.isFinite(bounds.max) && parsed > Number(bounds.max)) return fallback;
  return parsed;
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function asBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

/**
 * Parse the JSON env override; invalid JSON is ignored so a typo never breaks a
 * chat.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, unknown>}
 */
function readEnvOverride(env) {
  const raw = String(env?.[QWEN_CONTEXT_SETTINGS_ENV] || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return asObject(parsed);
  } catch {
    return {};
  }
}

/**
 * Resolve the effective Qwen context settings (documented defaults, layered
 * with settings and the env JSON override).
 *
 * @param {object | null} [settings] - loadSettings() result; loaded when omitted
 * @param {Record<string, string | undefined>} [env]
 * @returns {{
 *   autoCompactThreshold: number,
 *   clearContextOnIdle: {
 *     toolResultsThresholdMinutes: number,
 *     toolResultsNumToKeep: number,
 *     toolResultsTotalCharsThreshold: number,
 *   },
 *   enableCacheControl: boolean,
 * }}
 */
export function resolveQwenContextSettings(settings = null, env = process.env) {
  const settingsSource = settings || loadSettings();
  const fromSettings = asObject(settingsSource?.qwenContextSettings);
  const fromEnv = readEnvOverride(env && typeof env === 'object' ? env : process.env);
  const source = { ...fromSettings, ...fromEnv };

  const idleSource = {
    ...DEFAULT_QWEN_CLEAR_CONTEXT_ON_IDLE,
    ...asObject(fromSettings.clearContextOnIdle),
    ...asObject(fromEnv.clearContextOnIdle),
  };

  return {
    autoCompactThreshold: asNumber(
      source.autoCompactThreshold,
      DEFAULT_QWEN_AUTO_COMPACT_THRESHOLD,
      { min: 0, max: 1 },
    ),
    clearContextOnIdle: {
      toolResultsThresholdMinutes: asNumber(
        idleSource.toolResultsThresholdMinutes,
        DEFAULT_QWEN_CLEAR_CONTEXT_ON_IDLE.toolResultsThresholdMinutes,
      ),
      toolResultsNumToKeep: asNumber(
        idleSource.toolResultsNumToKeep,
        DEFAULT_QWEN_CLEAR_CONTEXT_ON_IDLE.toolResultsNumToKeep,
        { min: 1 },
      ),
      toolResultsTotalCharsThreshold: asNumber(
        idleSource.toolResultsTotalCharsThreshold,
        DEFAULT_QWEN_CLEAR_CONTEXT_ON_IDLE.toolResultsTotalCharsThreshold,
      ),
    },
    enableCacheControl: asBoolean(source.enableCacheControl, DEFAULT_QWEN_ENABLE_CACHE_CONTROL),
  };
}

/**
 * Merge the resolved Qwen context settings into an existing settings document,
 * preserving every unrelated key.
 *
 * @param {Record<string, unknown>} [existing]
 * @param {ReturnType<typeof resolveQwenContextSettings>} resolved
 * @returns {Record<string, unknown>}
 */
export function buildQwenSettingsDocument(existing = {}, resolved) {
  const base = asObject(existing);
  const context = asObject(base.context);
  const model = asObject(base.model);
  const generationConfig = asObject(model.generationConfig);
  return {
    ...base,
    context: {
      ...context,
      clearContextOnIdle: { ...resolved.clearContextOnIdle },
      autoCompactThreshold: resolved.autoCompactThreshold,
    },
    model: {
      ...model,
      generationConfig: {
        ...generationConfig,
        enableCacheControl: resolved.enableCacheControl,
      },
    },
  };
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readExistingSettings(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return asObject(parsed);
  } catch {
    return {};
  }
}

/**
 * Write the Qwen settings.json with the resolved native context/compaction
 * keys. Idempotent and safe to call before every session.
 *
 * @param {{
 *   settings?: object | null,
 *   env?: Record<string, string | undefined>,
 *   homeDir?: string,
 * }} [options]
 * @returns {{ path: string, document: Record<string, unknown>, resolved: ReturnType<typeof resolveQwenContextSettings>, written: boolean }}
 */
export function writeQwenSettingsFile(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;
  const homeDir = String(options.homeDir || resolveQwenHomeDir());
  const filePath = resolveQwenSettingsPath(homeDir);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readExistingSettings(filePath);
  const resolved = resolveQwenContextSettings(options.settings ?? null, env);
  const document = buildQwenSettingsDocument(existing, resolved);
  // Skip the write when nothing changed so frequent env builds do not churn the
  // settings mtime (the CLI watches this file).
  if (JSON.stringify(document) === JSON.stringify(existing)) {
    return { path: filePath, document, resolved, written: false };
  }
  writeJsonAtomic(filePath, document, 'utf8');
  return { path: filePath, document, resolved, written: true };
}
