/**
 * Strict create-time harness identity guard for `POST /api/chats`.
 *
 * This is the API boundary that stops an unknown or not-yet-loaded local
 * harness id from silently being normalized to the SDK transport. The global
 * {@link normalizeAgentTransport} fallback is deliberately left untouched: it
 * is shared by WebSocket dispatch, `isHarnessEnabled`, persistence, and forks,
 * where changing it would alter existing built-in/empty behavior.
 *
 * Decision table for the raw `req.body.agentTransport` value on the normal
 * (non-`forAgentRun`) create path:
 *
 *   - missing, `null`, `''`, or only whitespace  -> `sdk` (unchanged)
 *   - `cursor` in any case, with surrounding spaces -> `sdk` (explicit legacy alias)
 *   - one of the eight built-in transports (case-insensitive) -> that canonical id
 *   - a valid local plugin id that is currently discovered, explicitly enabled,
 *     chat-capable, host-compatible, and whose module exports
 *     `handleChatWebSocket` + `disposeSession`
 *     -> accept with the exact local id (the plugin is loaded and verified here,
 *     before the chat is saved)
 *   - a local candidate that is unknown/disabled/not chat-capable -> reject 400
 *   - a local candidate whose import or exports fail -> reject 503
 *   - any other non-empty value -> reject 400 `unknown_harness`
 *
 * A rejected id never reaches `addChat` and never falls through to
 * `normalizeAgentTransport`. The global fallback in `lib/agent-transport.js` is
 * deliberately left untouched. Loading/verifying is delegated to
 * {@link loadLocalChatHarness}; this module never imports plugin code directly.
 */

import { parseKnownAgentTransport } from '../agent-transport.js';
import { loadSettings } from '../persist/settings.js';
import {
  LOCAL_HARNESS_LOAD_CODES,
  LOCAL_HARNESS_LOAD_STATUS,
  loadLocalChatHarness,
} from './local-harness-runtime.js';

/** Canonical transport returned for a blank or `cursor` input. */
export const CREATE_HARNESS_DEFAULT = 'sdk';

/** Legacy create-time alias for the SDK transport. */
export const CREATE_HARNESS_CURSOR_ALIAS = 'cursor';

/** Rejection codes emitted by the guard. */
export const CREATE_HARNESS_REJECTION_CODES = Object.freeze({
  unknown: LOCAL_HARNESS_LOAD_CODES.unknown,
  disabled: LOCAL_HARNESS_LOAD_CODES.disabled,
  capability: LOCAL_HARNESS_LOAD_CODES.capability,
  exportMissing: LOCAL_HARNESS_LOAD_CODES.exportMissing,
  loadFailed: LOCAL_HARNESS_LOAD_CODES.loadFailed,
  incompatible: LOCAL_HARNESS_LOAD_CODES.incompatible,
  // Kept for callers/tests written against the pre-runtime iteration.
  unavailable: 'plugin_unavailable',
});

/**
 * @typedef {{ ok: true, harness: string, source: 'blank' | 'cursor' | 'builtin' }} CreateHarnessAccepted
 * @typedef {{ ok: true, harness: string, source: 'local', label: string, manifest: object, module: object }} CreateHarnessLocalAccepted
 * @typedef {{ ok: false, status: number, code: string, error: string }} CreateHarnessRejected
 * @typedef {CreateHarnessAccepted | CreateHarnessLocalAccepted | CreateHarnessRejected} CreateHarnessClassification
 */

/**
 * A successful import can fail with an operator-facing message that embeds an
 * absolute path, a `file://` URL, or importer internals. That detail is useful
 * server-side but must never reach a client. The create boundary therefore maps
 * any such failure to this stable, generic text while preserving the existing
 * `code` and HTTP status.
 *
 * @param {string} id
 * @returns {string}
 */
function genericHarnessLoadFailure(id) {
  return `Harness "${id}" could not be loaded`;
}

/**
 * Whether one loader error can carry filesystem/importer detail that must not be
 * forwarded to a client. `plugin_load_failed` is the import failure path and is
 * always redacted. Other codes emit a controlled message, but a `file:` URL or a
 * filesystem-looking path (POSIX, Windows drive-letter, or UNC) is still refused
 * defensively. The `unknown` code is exempt from path sniffing because its
 * message only echoes the pattern-checked client id.
 *
 * @param {string} code
 * @param {unknown} rawError
 * @returns {boolean}
 */
function isSensitiveHarnessLoadError(code, rawError) {
  if (code === CREATE_HARNESS_REJECTION_CODES.loadFailed) return true;
  if (typeof rawError !== 'string') return false;
  if (rawError.includes('file:')) return true;
  if (code === CREATE_HARNESS_REJECTION_CODES.unknown) return false;
  // Windows absolute paths: `C:\dir`, `C:/dir`, and `\\server\share`. The
  // leading boundary avoids matching the scheme of a URL such as `https://`.
  if (/(^|[\s("'`])[A-Za-z]:[\\/]/.test(rawError)) return true;
  if (/(^|[\s("'`])\\\\[^\s)"'`]+/.test(rawError)) return true;
  return /(^|[\s("'`])\/(?:[^\s)"'`]+\/)+[^\s)"'`]*/.test(rawError);
}

/**
 * Strip filesystem paths and token-like material from a loader error before it
 * reaches a server log line. The raw error is never sent to a client; this only
 * keeps the server-side diagnostic while honouring "do not log secret material".
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeHarnessLoadErrorForLog(value) {
  if (typeof value !== 'string' || !value) return '';
  let text = value.replace(/\s+/g, ' ').trim().slice(0, 300);
  text = text.replace(/file:\/\/[^\s)"'`]+/gi, '<path>');
  text = text.replace(
    /(^|[\s("'`])[A-Za-z]:[\\/][^\s)"'`]*/g,
    (_match, prefix) => `${prefix}<path>`,
  );
  text = text.replace(
    /(^|[\s("'`])\\\\[^\s)"'`]*/g,
    (_match, prefix) => `${prefix}<path>`,
  );
  text = text.replace(/(^|[\s("'`])\/[^\s)"'`]*/g, (_match, prefix) => `${prefix}<path>`);
  text = text.replace(
    /\b(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})\b/g,
    '[redacted]',
  );
  return text;
}

/**
 * Classify the raw create-time `agentTransport` value.
 *
 * Dependencies are injectable so the decision table can be unit tested without
 * a plugin root, filesystem, or settings store:
 *
 * @param {unknown} raw
 * @param {{
 *   loadLocalChatHarness?: (id: string, options?: object) => Promise<object>,
 *   loadSettings?: () => object,
 *   settings?: object | null,
 *   env?: NodeJS.ProcessEnv | Record<string, unknown>,
 *   hostVersion?: unknown,
 *   importer?: (specifier: string) => Promise<unknown>,
 *   semver?: object | null,
 *   reservedIds?: readonly string[],
 * }} [deps]
 * @returns {Promise<CreateHarnessClassification>}
 */
export async function classifyCreateHarness(raw, deps = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: true, harness: CREATE_HARNESS_DEFAULT, source: 'blank' };
  }

  const token = raw.trim().toLowerCase();
  if (token === CREATE_HARNESS_CURSOR_ALIAS) {
    return { ok: true, harness: CREATE_HARNESS_DEFAULT, source: 'cursor' };
  }

  const builtin = parseKnownAgentTransport(token);
  if (builtin) {
    return { ok: true, harness: builtin, source: 'builtin' };
  }

  const readSettings = typeof deps.loadSettings === 'function' ? deps.loadSettings : loadSettings;
  const settings = deps.settings !== undefined ? deps.settings : readSettings();
  const loader = typeof deps.loadLocalChatHarness === 'function'
    ? deps.loadLocalChatHarness
    : loadLocalChatHarness;

  let loaded;
  try {
    loaded = await loader(token, {
      settings,
      env: deps.env,
      ...(deps.hostVersion !== undefined ? { hostVersion: deps.hostVersion } : {}),
      ...(typeof deps.importer === 'function' ? { importer: deps.importer } : {}),
      ...(Object.prototype.hasOwnProperty.call(deps, 'semver') ? { semver: deps.semver } : {}),
      ...(Array.isArray(deps.reservedIds) ? { reservedIds: deps.reservedIds } : {}),
    });
  } catch {
    // A broken loader can never turn an unknown id into a create path.
    loaded = null;
  }

  if (!loaded || loaded.ok !== true) {
    const code = loaded?.code || CREATE_HARNESS_REJECTION_CODES.unknown;
    const status = LOCAL_HARNESS_LOAD_STATUS[code] || 400;
    const rawError = typeof loaded?.error === 'string' ? loaded.error : '';
    if (isSensitiveHarnessLoadError(code, rawError)) {
      // Raw detail stays server-side only; the log line is path/token sanitized.
      console.warn('[api/chats] local harness create rejected', {
        id: token,
        code,
        detail: sanitizeHarnessLoadErrorForLog(rawError),
      });
      return { ok: false, status, code, error: genericHarnessLoadFailure(token) };
    }
    return {
      ok: false,
      status,
      code,
      error: rawError || `Unknown harness "${raw.trim()}"`,
    };
  }

  return {
    ok: true,
    harness: token,
    source: 'local',
    label: loaded.manifest?.label || token,
    manifest: loaded.manifest,
    module: loaded.module,
  };
}
