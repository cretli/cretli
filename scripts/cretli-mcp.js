#!/usr/bin/env node
/**
 * Cretli MCP server (stdio transport, newline-delimited JSON-RPC 2.0).
 *
 * Configuration (environment):
 *   CRETLI_URL              Base URL (default https://127.0.0.1:3011)
 *   CRETLI_CLI_PASSWORD     Login password (falls back to CRETLI_PASSWORD)
 *   CRETLI_MCP_TOKEN        Session bridge token (with --bridge)
 *   CRETLI_MCP_WORKSPACE    Required for standalone stdio workspace tools
 *   CRETLI_MCP_MODE         plan | ask (writes blocked) or agent
 *   CRETLI_INSECURE_TLS     Set to 0 to enforce TLS verification
 *   CRETLI_MCP_DEFER_TOOLS  Set to 1 to mark non-core tools as deferred
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { mcpTextResult } from '../lib/mcp/builtin/result.js';
import { listenMcpStdio, writeMcpStdioMessage } from '../lib/mcp/mcp-stdio-framing.js';
import { markDeferredMcpTools } from '../lib/mcp/mcp-deferred-tools.js';
import { createBridgeCatalogLoader } from '../lib/mcp/mcp-bridge-catalog.js';

const SERVER_INFO = { name: 'cretli', version: '0.1.0' };
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

/**
 * Map a `/api/mcp/bridge/call` response to an MCP tool result. The server alone
 * decides whether `output` is compressed (`res.compressed === true`); the
 * bridge reads no env and does not sniff the text.
 *
 * @param {Record<string, any>} res
 */
export function mapBridgeToolResult(res) {
  if (res?.compressed === true && typeof res.output === 'string') {
    return mcpTextResult(res.output, res.ok === false);
  }
  if (res?.content) return res;
  if (res?.raw?.content) return res.raw;
  return mcpTextResult(res?.output || res?.error || '', res?.ok === false);
}

function sessionFromEnv() {
  return {
    chatId: String(process.env.CRETLI_MCP_CHAT_ID || '').trim(),
    workspaceFolder: String(process.env.CRETLI_MCP_WORKSPACE || '').trim(),
    workspaceFile: String(process.env.CRETLI_MCP_WORKSPACE_FILE || '').trim(),
    harness: String(process.env.CRETLI_MCP_HARNESS || '').trim(),
    mode: String(process.env.CRETLI_MCP_MODE || '').trim(),
  };
}

/**
 * Handle a single JSON-RPC message. Returns a response object, or null for
 * notifications (which must not produce output).
 *
 * @param {CretliApiClient} client
 * @param {object & { deferTools?: boolean }} [session]
 */
export function createMcpHandler(client, session = {}) {
  // The local tool catalog (hundreds of modules) is only needed in standalone
  // mode. The --bridge proxy never loads it, so it starts fast and does not
  // crash when the working tree is mid-edit while the server runs older code.
  /** @type {Promise<typeof import('../lib/mcp/mcp-builtin-tools.js')> | null} */
  let builtinModule = null;
  /** @type {Promise<Record<string, Function>> | null} */
  let handlersPromise = null;
  const loadBuiltin = () => {
    builtinModule ||= import('../lib/mcp/mcp-builtin-tools.js');
    return builtinModule;
  };
  const getHandlers = () => {
    handlersPromise ||= loadBuiltin().then((mod) => mod.createCretliMcpToolHandlers(client, session));
    return handlersPromise;
  };

  /** @param {string} requestId */
  const errorResponse = (requestId, code, message) => ({
    jsonrpc: '2.0',
    id: requestId,
    error: { code, message },
  });

  /** @type {Promise<object[]> | null} */
  let prefetchedTools = null;

  return async function handleMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
    if (typeof message.method !== 'string') return null;
    if (message.method === 'notifications/initialized' && typeof client.listBridgeTools === 'function') {
      // Fetch the catalog as soon as the handshake ends: the request tells the
      // server this harness is connected, so it can release a held first prompt.
      prefetchedTools = client.listBridgeTools();
      prefetchedTools.catch(() => {});
    }
    if (message.method.startsWith('notifications/')) return null;

    try {
      if (message.method === 'initialize') {
        const requested = String(message.params?.protocolVersion || '');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: SERVER_INFO,
          },
        };
      }
      if (message.method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }
      if (message.method === 'tools/list') {
        const prefetched = prefetchedTools;
        prefetchedTools = null;
        const tools = typeof client.listBridgeTools === 'function'
          ? await (prefetched ? prefetched.catch(() => client.listBridgeTools()) : client.listBridgeTools())
          : (await loadBuiltin()).listCretliMcpToolDefs();
        const deferTools = session.deferTools === true
          || String(process.env.CRETLI_MCP_DEFER_TOOLS || '').trim() === '1';
        return { jsonrpc: '2.0', id, result: { tools: deferTools ? markDeferredMcpTools(tools) : tools } };
      }
      if (message.method === 'tools/call') {
        const name = String(message.params?.name || '');
        if (typeof client.callBridgeTool === 'function') {
          const result = await client.callBridgeTool(name, message.params?.arguments || {});
          return { jsonrpc: '2.0', id, result };
        }
        const handler = (await getHandlers())[name];
        if (!handler) {
          return errorResponse(id, -32602, `Unknown tool: ${name}`);
        }
        const result = await handler(message.params?.arguments || {});
        return { jsonrpc: '2.0', id, result };
      }
      return errorResponse(id, -32601, `Method not found: ${message.method}`);
    } catch (err) {
      if (id === null) return null;
      if (message.method === 'tools/list') {
        return errorResponse(id, -32603, `MCP catalog unavailable: ${String(err?.message || err)}`);
      }
      return {
        jsonrpc: '2.0',
        id,
        result: mcpTextResult(String(err?.message || err), true),
      };
    }
  };
}

async function main() {
  const token = String(process.env.CRETLI_MCP_TOKEN || '').trim();
  const isBridge = process.argv.includes('--bridge') || Boolean(token);
  const client = new CretliApiClient({
    baseUrl: process.env.CRETLI_URL,
    password: process.env.CRETLI_CLI_PASSWORD || process.env.CRETLI_PASSWORD || '',
    bearerToken: token,
  });
  if (!token && !client.password) {
    process.stderr.write('cretli-mcp: set CRETLI_MCP_TOKEN or CRETLI_CLI_PASSWORD (or CRETLI_PASSWORD)\n');
    process.exit(1);
  }
  const catalogLoader = isBridge && token ? createBridgeCatalogLoader(
    () => client.getMcpBridgeTools(),
    () => writeResponse({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
  ) : null;
  if (catalogLoader) {
    client.listBridgeTools = () => catalogLoader.load();
    client.callBridgeTool = async (name, args) => {
      const result = mapBridgeToolResult(await client.callMcpBridgeTool(name, args));
      // After mcp_refresh the server holds fresh lists: re-list in the background so
      // the harness gets notifications/tools/list_changed (it re-reads tools/list).
      if (/(^|__)mcp_refresh$/.test(name)) catalogLoader.refresh().catch(() => {});
      return result;
    };
  }
  const handleMessage = createMcpHandler(client, sessionFromEnv());
  const pending = new Set();
  const newline = String(process.env.CRETLI_MCP_NEWLINE || '1') !== '0';
  const writeResponse = (response) => {
    if (!response) return;
    if (newline) process.stdout.write(`${JSON.stringify(response)}\n`);
    else writeMcpStdioMessage(process.stdout, response);
  };
  listenMcpStdio(process.stdin, (message) => {
    const inFlight = handleMessage(message)
      .then((response) => writeResponse(response))
      .catch((err) => {
        writeResponse({
          jsonrpc: '2.0',
          id: message?.id ?? null,
          error: { code: -32603, message: String(err?.message || err) },
        });
      });
    pending.add(inFlight);
    inFlight.finally(() => pending.delete(inFlight));
  });
  process.stdin.on('end', () => {
    catalogLoader?.dispose();
    Promise.allSettled([...pending]).finally(() => process.exit(0));
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`cretli-mcp: ${String(err?.message || err)}\n`);
    process.exit(1);
  });
}
