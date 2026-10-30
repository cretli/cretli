/**
 * External Chrome (CDP) endpoint configuration.
 *
 * The endpoint can come from two places: the `CRETLI_BROWSER_CDP_URL` /
 * `CRETLI_BROWSER_CDP_ALLOWLIST` environment (operator pin, wins) or the
 * Settings UI (`browserCdpUrl` / `browserCdpAllowlist` in config.json). Both
 * feed the same `detectBrowserRuntime()` path, so validation and the private
 * address checks are identical whichever source is used.
 */

import { EXTERNAL_CDP_MAX_SESSIONS_DEFAULT, EXTERNAL_CDP_MAX_SESSIONS_LIMIT } from './constants.js';

/** @typedef {'env' | 'settings' | 'none'} BrowserCdpSource */

/** Session modes a caller may request (REST `browserMode`, MCP `browser_open`). */
export const BROWSER_SESSION_MODES = Object.freeze(['builtin', 'external']);
/** Values the Settings default `browserDefaultMode` accepts. */
export const BROWSER_DEFAULT_MODES = Object.freeze(['builtin', 'external', 'auto']);

/**
 * @param {unknown} value
 * @returns {'builtin'|'external'|'auto'|''} the normalized default mode, '' when unusable
 */
export function normalizeBrowserDefaultMode(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BROWSER_DEFAULT_MODES.includes(v) ? /** @type {any} */ (v) : '';
}

/**
 * Clamps the external-profile session cap (`browserCdpMaxSessions`). Anything
 * unusable falls back to the default instead of disabling the external Browser.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeExternalMaxSessions(value) {
  if (value === null || value === undefined || value === '') return EXTERNAL_CDP_MAX_SESSIONS_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return EXTERNAL_CDP_MAX_SESSIONS_DEFAULT;
  return Math.min(EXTERNAL_CDP_MAX_SESSIONS_LIMIT, Math.max(1, Math.floor(n)));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Comma/whitespace separated host names, lowercased and deduplicated.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCdpAllowlist(value) {
  const items = String(typeof value === 'string' ? value : '')
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(items)].join(',');
}

/**
 * Calm pace switch; `browserHumanMode` is the key it was saved under before the
 * rename and is still honoured until the next save rewrites it.
 * @param {Record<string, unknown> | null | undefined} settings
 * @returns {boolean}
 */
export function readCalmPaceModeSetting(settings) {
  return settings?.browserCalmPaceMode === true || settings?.browserHumanMode === true;
}

/**
 * The effective CDP configuration and where it comes from.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, unknown> | null | undefined} settings
 * @returns {{ source: BrowserCdpSource, url: string, allowlist: string, envLocked: boolean,
 *   settingsUrl: string, settingsAllowlist: string, nativeNetwork: boolean, calmPaceMode: boolean,
 *   maxSessions: number, defaultMode: 'builtin'|'external'|'auto', explicitDefaultMode: string, settingsDefaultMode: string,
 *   defaultModeLocked: boolean }}
 */
export function resolveBrowserCdpConfig(env, settings) {
  const envUrl = trimmed(env?.CRETLI_BROWSER_CDP_URL);
  // Chrome fetches policy-approved public requests itself (Settings only).
  const nativeNetwork = settings?.browserCdpNativeNetwork === true;
  const settingsUrl = trimmed(settings?.browserCdpUrl);
  const settingsAllowlist = normalizeCdpAllowlist(settings?.browserCdpAllowlist);
  const maxSessions = normalizeExternalMaxSessions(settings?.browserCdpMaxSessions);
  // Default session mode: the env pin wins, then the Settings value. With
  // neither, an install that already has an endpoint keeps its old behaviour
  // (external); without an endpoint the built-in Chromium is the default.
  const settingsDefaultMode = normalizeBrowserDefaultMode(settings?.browserDefaultMode);
  const envDefaultMode = normalizeBrowserDefaultMode(env?.CRETLI_BROWSER_DEFAULT_MODE);
  const endpointConfigured = Boolean(envUrl || settingsUrl);
  const defaultMode = envDefaultMode || settingsDefaultMode || (endpointConfigured ? 'external' : 'builtin');
  const defaultModeLocked = Boolean(envDefaultMode);
  if (envUrl) {
    return {
      source: 'env',
      url: envUrl,
      allowlist: normalizeCdpAllowlist(env?.CRETLI_BROWSER_CDP_ALLOWLIST),
      envLocked: true,
      settingsUrl,
      settingsAllowlist,
      nativeNetwork,
      calmPaceMode: readCalmPaceModeSetting(settings),
      maxSessions,
      defaultMode,
      explicitDefaultMode: envDefaultMode || settingsDefaultMode,
      settingsDefaultMode,
      defaultModeLocked,
    };
  }
  return {
    source: settingsUrl ? 'settings' : 'none',
    url: settingsUrl,
    allowlist: settingsAllowlist,
    envLocked: false,
    settingsUrl,
    settingsAllowlist,
    nativeNetwork,
    calmPaceMode: readCalmPaceModeSetting(settings),
    maxSessions,
    defaultMode,
    explicitDefaultMode: envDefaultMode || settingsDefaultMode,
    settingsDefaultMode,
    defaultModeLocked,
  };
}

/**
 * The environment `detectBrowserRuntime()` should see: the process env with the
 * Settings endpoint filled in when the env does not pin one.
 *
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, unknown> | null | undefined} settings
 * @returns {Record<string, string | undefined>}
 */
export function buildBrowserRuntimeEnv(env, settings) {
  const config = resolveBrowserCdpConfig(env, settings);
  if (config.source !== 'settings') return env;
  return {
    ...env,
    CRETLI_BROWSER_CDP_URL: config.url,
    CRETLI_BROWSER_CDP_ALLOWLIST: config.allowlist,
  };
}
