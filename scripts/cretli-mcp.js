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
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CretliApiClient } from '../lib/remote-api-client.js';
import {
  CRETILI_MCP_TOOL_DEFS,
  createCretliMcpToolHandlers,
  mcpTextResult,
} from '../lib/mcp/mcp-builtin-tools.js';
import { listenMcpStdio, writeMcpStdioMessage } from '../lib/mcp/mcp-stdio-framing.js';

const SERVER_INFO = { name: 'cretli', version: '0.1.0' };
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

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
 * @param {object} [session]
 */
export function createMcpHandler(client, session = {}) {
  const handlers = createCretliMcpToolHandlers(client, session);

  /** @param {string} requestId */
  const errorResponse = (requestId, code, message) => ({
    jsonrpc: '2.0',
    id: requestId,
    error: { code, message },
  });

  return async function handleMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
    if (typeof message.method !== 'string') return null;
    if (message.method.startsWith('notifications/')) return null;

    try {
      if (message.method === 'initialize') {
        const requested = String(message.params?.protocolVersion || '');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested || DEFAULT_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        };
      }
      if (message.method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }
      if (message.method === 'tools/list') {
        const tools = typeof client.listBridgeTools === 'function'
          ? await client.listBridgeTools()
          : CRETILI_MCP_TOOL_DEFS;
        return { jsonrpc: '2.0', id, result: { tools } };
      }
      if (message.method === 'tools/call') {
        const name = String(message.params?.name || '');
        if (typeof client.callBridgeTool === 'function') {
          const result = await client.callBridgeTool(name, message.params?.arguments || {});
          return { jsonrpc: '2.0', id, result };
        }
        const handler = handlers[name];
        if (!handler) {
          return errorResponse(id, -32602, `Unknown tool: ${name}`);
        }
        const result = await handler(message.params?.arguments || {});
        return { jsonrpc: '2.0', id, result };
      }
      return errorResponse(id, -32601, `Method not found: ${message.method}`);
    } catch (err) {
      if (id === null) return null;
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
  if (isBridge && token) {
    client.listBridgeTools = async () => {
      const res = await client.getMcpBridgeTools();
      return Array.isArray(res?.tools) ? res.tools : [];
    };
    client.callBridgeTool = async (name, args) => {
      const res = await client.callMcpBridgeTool(name, args);
      if (res?.content) return res;
      if (res?.raw?.content) return res.raw;
      return mcpTextResult(res?.output || res?.error || '', res?.ok === false);
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
