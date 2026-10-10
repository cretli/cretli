/**
 * Native OpenCode compaction configuration.
 *
 * OpenCode already compacts conversations and prunes old tool output on its
 * own. Cretli must not rewrite harness history; the lever here is tuning those
 * native knobs and letting OpenCode do the work:
 *
 * - `prune` erases oversized/old tool output deterministically (no LLM call),
 *   which is the cheapest way to recover context.
 * - `auto` toggles automatic compaction.
 * - `reserved` is the token budget kept free for the compaction request. When
 *   omitted, OpenCode computes its own default
 *   (`min(20_000, maxOutputTokens(model))`), so a missing value stays
 *   default-safe instead of hardcoding a buffer.
 *
 * Precedence: explicit env override, then the `opencodeCompaction` setting,
 * then the shipped defaults. Only `auto` and `prune` are always written; a
 * configured `reserved` is merged in on top.
 */

import { loadSettings } from '../persist/settings.js';

/** Shipped defaults mirror OpenCode's own config defaults. */
export const OPENCODE_COMPACTION_DEFAULTS = Object.freeze({
  auto: true,
  prune: true,
});

export const OPENCODE_COMPACTION_ENV = Object.freeze({
  auto: 'CRETLI_OPENCODE_COMPACTION_AUTO',
  prune: 'CRETLI_OPENCODE_COMPACTION_PRUNE',
  reserved: 'CRETLI_OPENCODE_COMPACTION_RESERVED',
});

/**
 * Parse a boolean-ish value. Returns `null` when the value is absent or not
 * recognizable, so the caller can fall through to the next source.
 *
 * @param {unknown} value
 * @returns {boolean | null}
 */
function parseBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return null;
}

/**
 * Parse a non-negative integer (compaction reserved tokens). Returns `null`
 * when absent or invalid.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseReserved(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Resolve the native OpenCode compaction config.
 *
 * @param {object | null} [settings] - loadSettings() result; loaded when omitted
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ auto: boolean, prune: boolean, reserved?: number }}
 */
export function resolveOpenCodeCompactionConfig(settings = null, env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const settingsSource = settings || loadSettings();
  const raw = settingsSource?.opencodeCompaction;
  const configured = raw && typeof raw === 'object' ? raw : {};

  const envAuto = parseBoolean(source[OPENCODE_COMPACTION_ENV.auto]);
  const auto = envAuto ?? parseBoolean(configured.auto) ?? OPENCODE_COMPACTION_DEFAULTS.auto;

  const envPrune = parseBoolean(source[OPENCODE_COMPACTION_ENV.prune]);
  const prune = envPrune ?? parseBoolean(configured.prune) ?? OPENCODE_COMPACTION_DEFAULTS.prune;

  const envReserved = parseReserved(source[OPENCODE_COMPACTION_ENV.reserved]);
  const reserved = envReserved ?? parseReserved(configured.reserved);

  /** @type {{ auto: boolean, prune: boolean, reserved?: number }} */
  const resolved = { auto, prune };
  if (reserved !== null) resolved.reserved = reserved;
  return resolved;
}

/**
 * Build the OpenCode server config Cretli passes to the instance. Always
 * includes the compaction block; the provider block is merged when supplied.
 *
 * @param {{
 *   settings?: object | null,
 *   env?: Record<string, string | undefined>,
 *   provider?: Record<string, unknown> | null,
 * }} [input]
 * @returns {{ compaction: { auto: boolean, prune: boolean, reserved?: number }, provider?: Record<string, unknown> }}
 */
export function buildOpenCodeServerConfig(input = {}) {
  /** @type {{ compaction: ReturnType<typeof resolveOpenCodeCompactionConfig>, provider?: Record<string, unknown> }} */
  const config = {
    compaction: resolveOpenCodeCompactionConfig(input.settings ?? null, input.env ?? process.env),
  };
  if (input.provider && typeof input.provider === 'object' && Object.keys(input.provider).length > 0) {
    config.provider = input.provider;
  }
  return config;
}

/**
 * Trigger OpenCode's own session compaction/summarization for one session.
 * This is the native POST /session/:id/summarize endpoint, exposed so a caller
 * can compact deliberately (for example when the provider cache is already
 * cold) instead of Cretli rewriting any history itself.
 *
 * @param {{ session?: { summarize?: Function } } | null | undefined} client - OpenCode SDK client
 * @param {{ sessionID: string, providerID: string, modelID: string, directory?: string }} input
 * @returns {Promise<unknown>}
 */
export async function summarizeOpenCodeSession(client, input) {
  const sessionId = String(input?.sessionID || '').trim();
  if (!sessionId) throw new Error('OpenCode session id is required');
  if (!client?.session?.summarize) throw new Error('OpenCode client does not support summarize');
  const providerID = String(input?.providerID || '').trim();
  const modelID = String(input?.modelID || '').trim();
  if (!providerID || !modelID) throw new Error('OpenCode summarize requires providerID and modelID');
  const query = input?.directory ? { directory: input.directory } : undefined;
  return client.session.summarize({
    path: { id: sessionId },
    body: { providerID, modelID },
    ...(query ? { query } : {}),
  });
}
