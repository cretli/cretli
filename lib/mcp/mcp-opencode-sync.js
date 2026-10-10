/**
 * Apply Cretli-managed MCP entries on an OpenCode instance without touching
 * user-owned MCP servers. Isolation is the OpenCode runtime (per Cretli
 * session), not a unique MCP name on a shared instance.
 */

import { createHash } from 'crypto';
import { markMcpConfigApplied, prepareHarnessMcp } from './mcp-session.js';
import { lookupMcpExecutionContext } from './mcp-execution-registry.js';
import { CONTEXT_RESTART_REASON, recordContextRestart } from '../usage/context-restarts.js';

const MANAGED_BRIDGE_NAME = 'cretli_bridge';

/**
 * The bridge token is minted per prompt, so a naive content hash would differ on
 * every turn. The guard compares the semantic bridge config instead: MCP
 * revision, effective mode (the tool set is mode-dependent), the live MCP
 * execution incarnation (a rotation revokes the old token), bridge command,
 * args and stable env. A periodic refresh keeps the held token from expiring.
 */
export const OPENCODE_BRIDGE_REFRESH_MS = 6 * 60 * 60 * 1000;

/** @type {WeakMap<object, Map<string, { fingerprint: string, revision: number, mode: string, at: number }>>} */
const appliedBridgeConfig = new WeakMap();

/**
 * @param {unknown} context
 * @returns {string}
 */
function effectiveOpenCodeMode(context) {
  let read;
  try {
    read = typeof context?.getMode === 'function' ? context.getMode() : context?.mode;
  } catch {
    read = context?.mode;
  }
  return String(read || '').trim().toLowerCase();
}

/**
 * @param {ReturnType<typeof prepareHarnessMcp>} prep
 * @param {object} context
 * @returns {string}
 */
function openCodeBridgeFingerprint(prep, context) {
  const bridge = prep?.bridge;
  const incarnation = lookupMcpExecutionContext({
    sessionId: context?.sessionId,
    chatId: context?.chatId,
  })?.incarnation || '';
  return createHash('sha256')
    .update(JSON.stringify({
      revision: Number(prep?.revision) || 0,
      mode: effectiveOpenCodeMode(context),
      incarnation,
      command: String(bridge?.command || ''),
      args: Array.isArray(bridge?.args) ? bridge.args : [],
      // The minted token is intentionally excluded: it rotates on every mint
      // while still pointing at the same bridge and incarnation.
      url: String(bridge?.env?.CRETLI_URL || ''),
      insecureTls: String(bridge?.env?.CRETLI_INSECURE_TLS || ''),
    }))
    .digest('hex');
}

/**
 * @param {{ revision: number, mode: string }} previous
 * @param {number} revision
 * @param {string} mode
 * @returns {string}
 */
function openCodeRestartReason(previous, revision, mode) {
  if (previous.revision !== revision) return CONTEXT_RESTART_REASON.MCP_REVISION;
  if (previous.mode !== mode) return CONTEXT_RESTART_REASON.MODE_CHANGE;
  return CONTEXT_RESTART_REASON.MCP_CONTENT_CHANGE;
}

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isCretliManagedOpenCodeMcpName(name) {
  return String(name || '') === MANAGED_BRIDGE_NAME;
}

/**
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
function unwrap(result) {
  if (!result || typeof result !== 'object') return {};
  if ('data' in result && result.data && typeof result.data === 'object') {
    return /** @type {Record<string, unknown>} */ (result.data);
  }
  return /** @type {Record<string, unknown>} */ (result);
}

/**
 * @param {unknown} result
 * @returns {string}
 */
function resultError(result) {
  if (!result || typeof result !== 'object') return '';
  const row = /** @type {Record<string, unknown>} */ (result);
  if (typeof row.error === 'string' && row.error.trim()) return row.error.trim();
  if (row.error && typeof row.error === 'object' && typeof row.error.message === 'string') {
    return row.error.message.trim();
  }
  if (row.ok === false) return 'OpenCode MCP request failed';
  const data = unwrap(result);
  if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();
  return '';
}

/**
 * @param {{
 *   client: { mcp?: { status?: Function, add?: Function, connect?: Function, disconnect?: Function } },
 *   workspaceFolder: string,
 *   context: object,
 *   force?: boolean,
 * }} input
 */
export async function syncOpenCodeManagedMcp(input) {
  const client = input.client;
  const directory = String(input.workspaceFolder || '').trim();
  const prep = prepareHarnessMcp(input.context);
  if (!client?.mcp?.add) {
    return { ok: false, unsupported: true, reason: 'OpenCode client.mcp.add is unavailable' };
  }
  const revision = Number(prep.revision) || 0;
  const mode = effectiveOpenCodeMode(input.context);
  const fingerprint = prep.bridge ? openCodeBridgeFingerprint(prep, input.context) : '';
  if (!input.force && prep.bridge && fingerprint) {
    const applied = appliedBridgeConfig.get(client)?.get(directory);
    const freshEnough = applied && Date.now() - applied.at < OPENCODE_BRIDGE_REFRESH_MS;
    if (applied && applied.fingerprint === fingerprint && freshEnough) {
      // The bridge is already registered with the same semantic config: skip the
      // add/connect round-trip so OpenCode keeps its tool prefix (and cache).
      markMcpConfigApplied(input.context, prep.servers, prep.revision);
      return { ok: true, revision: prep.revision, skipped: true };
    }
  }
  let currentNames = [];
  if (typeof client.mcp.status === 'function') {
    try {
      const status = unwrap(await client.mcp.status({ query: { directory } }));
      currentNames = Object.keys(status);
    } catch {
      currentNames = [];
    }
  }
  for (const name of currentNames) {
    if (!isCretliManagedOpenCodeMcpName(name)) continue;
    if (prep.bridge && name === MANAGED_BRIDGE_NAME) continue;
    if (typeof client.mcp.disconnect === 'function') {
      try {
        await client.mcp.disconnect({ path: { name }, query: { directory } });
      } catch {
        // ignore missing entries
      }
    }
  }
  if (!prep.bridge) {
    markMcpConfigApplied(input.context, prep.servers, prep.revision);
    return { ok: true, revision: prep.revision };
  }
  const added = await client.mcp.add({
    query: { directory },
    body: {
      name: MANAGED_BRIDGE_NAME,
      config: {
        type: 'local',
        command: [prep.bridge.command, ...prep.bridge.args],
        environment: prep.bridge.env,
        enabled: true,
      },
    },
  });
  const addError = resultError(added);
  if (addError) {
    return { ok: false, revision: prep.revision, error: addError };
  }
  if (typeof client.mcp.connect === 'function') {
    try {
      const connected = await client.mcp.connect({
        path: { name: MANAGED_BRIDGE_NAME },
        query: { directory },
      });
      const connectError = resultError(connected);
      if (connectError) {
        return { ok: false, revision: prep.revision, error: connectError };
      }
    } catch (err) {
      return { ok: false, revision: prep.revision, error: String(err?.message || err) };
    }
  }
  const previousApplied = appliedBridgeConfig.get(client)?.get(directory) || null;
  let perClient = appliedBridgeConfig.get(client);
  if (!perClient) {
    perClient = new Map();
    appliedBridgeConfig.set(client, perClient);
  }
  perClient.set(directory, { fingerprint, revision, mode, at: Date.now() });
  if (previousApplied && previousApplied.fingerprint !== fingerprint) {
    recordContextRestart({
      chatId: input.context?.chatId,
      harness: 'opencode',
      reason: openCodeRestartReason(previousApplied, revision, mode),
    });
  }
  markMcpConfigApplied(input.context, prep.servers, prep.revision);
  return { ok: true, revision: prep.revision };
}
