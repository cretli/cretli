/**
 * Pre-prompt catalog probe for the managed Cretli MCP bridge.
 *
 * Some harness CLIs spawn their process only when the first prompt is sent, so
 * a Workspace Watcher orchestrator cannot wait for that process' bridge mark
 * before the prompt: the mark can only appear after the process is started.
 * For those harnesses the gate asks the running server for the live bridge
 * catalog instead of waiting for the mark. The probe uses the same
 * `GET /api/mcp/bridge/tools` endpoint and the same integration token as the
 * stdio bridge, so it exercises the real bridge contract (scope, token,
 * vendor mapping target) and marks the chat ready as a side effect.
 *
 * The probe is deliberately side-effect free on failure: a missing endpoint, a
 * rejected token or a timeout resolves `null`, and the gate maps that to
 * `mcp_not_ready` rather than a tool-catalog failure.
 */

import { CretliApiClient } from '../remote-api-client.js';

/** Upper bound for a single preflight request. */
export const MCP_BRIDGE_PREFLIGHT_TIMEOUT_MS = 5000;

/**
 * @param {{ command?: string, args?: unknown[], env?: Record<string, string> } | null | undefined} bridge
 * @param {{
 *   timeoutMs?: number,
 *   createClient?: (options: { baseUrl: string, bearerToken: string, insecureTls: boolean }) =>
 *     ({ getMcpBridgeTools: () => Promise<unknown> } | null | undefined),
 * }} [options]
 * @returns {Promise<{ at: number, toolNames: string[] } | null>}
 */
export async function probeMcpBridgeCatalog(bridge, options = {}) {
  const env = bridge && typeof bridge === 'object' ? (bridge.env || {}) : {};
  const baseUrl = String(env.CRETLI_URL || '').trim();
  const bearerToken = String(env.CRETLI_MCP_TOKEN || '').trim();
  if (!baseUrl || !bearerToken) return null;
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : MCP_BRIDGE_PREFLIGHT_TIMEOUT_MS;
  const createClient = typeof options.createClient === 'function'
    ? options.createClient
    : (clientOptions) => new CretliApiClient(clientOptions);
  let client = null;
  try {
    client = createClient({ baseUrl, bearerToken, insecureTls: true });
  } catch {
    return null;
  }
  if (!client || typeof client.getMcpBridgeTools !== 'function') return null;
  const catalog = await withTimeout(client.getMcpBridgeTools(), timeoutMs);
  if (!catalog || typeof catalog !== 'object') return null;
  const tools = Array.isArray(catalog.tools) ? catalog.tools : [];
  const toolNames = tools
    .map((tool) => String(tool?.name || '').trim())
    .filter(Boolean);
  return { at: Date.now(), toolNames };
}

/**
 * Resolve `null` on timeout or rejection: the gate treats both as "no catalog
 * was listed", never as a missing-tool failure.
 *
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
