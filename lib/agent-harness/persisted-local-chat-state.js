/**
 * Read-only availability state for a persisted chat whose `agentTransport` is a
 * local harness id (anything that is neither blank, a built-in, nor the legacy
 * `cursor` alias).
 *
 * Why this exists: a chat saved while a local plugin was installed must stay
 * visible after that plugin is removed or disabled. The transport id is never
 * rewritten to `sdk` (persistence keeps the exact id), so the client needs a
 * safe, explicit signal that separates "the plugin is missing", "the plugin is
 * turned off", and "the plugin is present but not loaded for this read".
 *
 * Safety contract:
 *  - The classification never imports plugin code and never runs discovery
 *    outside the existing memoized catalog (`listLocalHarnessProviders`), so a
 *    GET request never scans the plugin root or executes a plugin.
 *  - The returned state is exactly `{ code, runnable: false }`. It carries no
 *    absolute path, no manifest `entry`, no filesystem/import error text, and no
 *    stack. `runnable` is always `false` here: only the runtime
 *    (`loadLocalChatHarness` / the WebSocket dispatcher) may decide to run a
 *    plugin.
 *  - A broken plugin root or a failed discovery degrades to
 *    `plugin_unavailable`; it never throws and never hides the chat.
 *  - `enabled` is explicit only. It comes from the memoized catalog row, which
 *    derives it from `settings.enabledLocalHarnesses`; a missing/empty list
 *    means "off", never an implicit enable.
 *
 * Classification order:
 *   - not a local transport                          -> no state (caller skips)
 *   - absent root / discovery failure / missing row  -> `plugin_unavailable`
 *   - discovered but not explicitly enabled          -> `plugin_disabled`
 *   - enabled but no `capabilities.chat`             -> `plugin_capability`
 *   - enabled, chat-capable, host too old            -> `host_incompatible`
 *   - enabled, chat-capable, compatible or deferred  -> `not_loaded`
 *
 * Dependencies are injectable so the classifier can be unit tested without a
 * plugin root, a settings store, or a filesystem.
 */

import { parseKnownAgentTransport } from '../agent-transport.js';
import { loadSettings } from '../persist/settings.js';
import { evaluateHostMinCompatibility } from './harness-plugin-loader.js';
import { listLocalHarnessProviders } from './harness-snapshot-registry.js';
import { readHostVersion } from './local-harness-runtime.js';

/** Stable state codes emitted for a persisted local chat. */
export const PERSISTED_LOCAL_CHAT_STATE_CODES = Object.freeze({
  unavailable: 'plugin_unavailable',
  disabled: 'plugin_disabled',
  capability: 'plugin_capability',
  incompatible: 'host_incompatible',
  notLoaded: 'not_loaded',
});

/**
 * @typedef {{
 *   code: 'plugin_unavailable' | 'plugin_disabled' | 'plugin_capability' | 'host_incompatible' | 'not_loaded',
 *   runnable: false,
 * }} PersistedLocalChatState
 */

/**
 * @param {string} code
 * @returns {PersistedLocalChatState}
 */
function buildState(code) {
  return Object.freeze({ code, runnable: false });
}

/**
 * Whether a raw persisted transport names a local harness candidate. Blank,
 * built-in, and legacy `cursor` values are not local.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isPersistedLocalChatTransport(raw) {
  if (typeof raw !== 'string') return false;
  const token = raw.trim().toLowerCase();
  if (!token || token === 'cursor') return false;
  return parseKnownAgentTransport(token) === '';
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeLocalId(raw) {
  return isPersistedLocalChatTransport(raw) ? raw.trim().toLowerCase() : '';
}

/**
 * Resolve the safe state for every distinct local transport in a list.
 *
 * Non-local transports are ignored. The function never throws: a discovery or
 * compatibility failure degrades to `plugin_unavailable` (discovery) or
 * `not_loaded` (deferred host comparison), matching the runtime's own
 * "never guess" policy.
 *
 * @param {unknown} rawTransports one transport or an array of transports
 * @param {{
 *   settings?: object | null,
 *   env?: NodeJS.ProcessEnv | Record<string, unknown>,
 *   providers?: readonly object[] | null,
 *   listProviders?: (options: { settings?: object | null, env?: unknown }) => Promise<object[]>,
 *   readSettings?: () => object,
 *   hostVersion?: unknown,
 *   evaluateCompat?: (hostMin: unknown, hostVersion: unknown) => Promise<object | null>,
 * }} [options]
 * @returns {Promise<Map<string, PersistedLocalChatState>>} keyed by normalized local id
 */
export async function resolvePersistedLocalChatStates(rawTransports, options = {}) {
  const result = new Map();
  const inputs = Array.isArray(rawTransports) ? rawTransports : [rawTransports];
  const ids = [];
  const seen = new Set();
  for (const raw of inputs) {
    const id = normalizeLocalId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return result;

  let providers = options.providers;
  if (!Array.isArray(providers)) {
    const readSettings = typeof options.readSettings === 'function'
      ? options.readSettings
      : loadSettings;
    const settings = options.settings !== undefined ? options.settings : readSettings();
    const listProviders = typeof options.listProviders === 'function'
      ? options.listProviders
      : listLocalHarnessProviders;
    try {
      providers = await listProviders({ settings, env: options.env });
    } catch {
      // Discovery failure must degrade to unavailable, never throw.
      providers = [];
    }
  }
  if (!Array.isArray(providers)) providers = [];

  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const row of providers) {
    if (!row || typeof row.id !== 'string') continue;
    const id = row.id.trim().toLowerCase();
    if (id && !byId.has(id)) byId.set(id, row);
  }

  const evaluateCompat = typeof options.evaluateCompat === 'function'
    ? options.evaluateCompat
    : evaluateHostMinCompatibility;
  const hostVersion = options.hostVersion !== undefined
    ? options.hostVersion
    : readHostVersion();

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      result.set(id, buildState(PERSISTED_LOCAL_CHAT_STATE_CODES.unavailable));
      continue;
    }
    if (row.enabled !== true) {
      result.set(id, buildState(PERSISTED_LOCAL_CHAT_STATE_CODES.disabled));
      continue;
    }
    if (!row.capabilities || row.capabilities.chat !== true) {
      result.set(id, buildState(PERSISTED_LOCAL_CHAT_STATE_CODES.capability));
      continue;
    }
    let compatibility = null;
    try {
      compatibility = await evaluateCompat(row.hostMin, hostVersion);
    } catch {
      compatibility = null;
    }
    if (compatibility && compatibility.evaluated === true && compatibility.compatible === false) {
      result.set(id, buildState(PERSISTED_LOCAL_CHAT_STATE_CODES.incompatible));
      continue;
    }
    result.set(id, buildState(PERSISTED_LOCAL_CHAT_STATE_CODES.notLoaded));
  }

  return result;
}

/**
 * Resolve the safe state for one persisted transport. Returns `null` for any
 * non-local transport so callers can enrich only local rows.
 *
 * @param {unknown} rawTransport
 * @param {Parameters<typeof resolvePersistedLocalChatStates>[1]} [options]
 * @returns {Promise<PersistedLocalChatState | null>}
 */
export async function resolvePersistedLocalChatState(rawTransport, options = {}) {
  const id = normalizeLocalId(rawTransport);
  if (!id) return null;
  const states = await resolvePersistedLocalChatStates([id], options);
  return states.get(id) || null;
}
