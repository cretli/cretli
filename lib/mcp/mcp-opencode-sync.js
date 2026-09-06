/**
 * Apply Cretli-managed MCP entries on an OpenCode instance without touching
 * user-owned MCP servers. Isolation is the OpenCode runtime (per Cretli
 * session), not a unique MCP name on a shared instance.
 */

import { markMcpConfigApplied, prepareHarnessMcp } from './mcp-session.js';

const MANAGED_BRIDGE_NAME = 'cretli_bridge';

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
 * }} input
 */
export async function syncOpenCodeManagedMcp(input) {
  const client = input.client;
  const directory = String(input.workspaceFolder || '').trim();
  const prep = prepareHarnessMcp(input.context);
  if (!client?.mcp?.add) {
    return { ok: false, unsupported: true, reason: 'OpenCode client.mcp.add is unavailable' };
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
  markMcpConfigApplied(input.context, prep.servers, prep.revision);
  return { ok: true, revision: prep.revision };
}
