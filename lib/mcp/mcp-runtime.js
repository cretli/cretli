/**
 * MCP client connections, tool catalog, calls, cancel, timeout, dispose.
 * Isolation key: session/workspace + server + effective connection fingerprint.
 */

import { createHash } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getMcpSecrets, resolveSecretMap } from './mcp-secrets.js';
import { resolveMcpPlanToolDecision } from './mcp-policy.js';
import { createCretliMcpToolHandlers, CRETILI_MCP_TOOL_DEFS } from './mcp-builtin-tools.js';
import {
  getMcpToolCatalogByKey,
  rememberMcpToolCatalog,
  sanitizeMcpError,
  upsertMcpStatus,
  markMcpServerStatusesStale,
} from './mcp-status.js';
import { toMcpRuntimeName, resolveMcpServersForContext } from './mcp-config.js';
import { loadMcpDocument } from '../persist/mcp-persist.js';
import { normalizeMcpExecutionMode } from './mcp-execution-registry.js';

function liveMcpMode(context) {
  if (typeof context?.getMode === 'function') {
    return normalizeMcpExecutionMode(context.getMode());
  }
  return normalizeMcpExecutionMode(context?.mode);
}

/**
 * @param {McpRuntimeContext} context
 * @param {object} server
 * @param {string} toolName
 */
function authorizeMcpToolCall(context, server, toolName) {
  const liveServer = resolveMcpServersForContext(context, loadMcpDocument().servers)
    .find((row) => row.id === server?.id);
  if (!liveServer) {
    return { ok: false, denied: false, output: '', error: 'MCP server not active in this context' };
  }
  if (!liveServer.enabled) {
    return { ok: false, denied: false, output: '', error: 'MCP integration is disabled' };
  }
  const mode = liveMcpMode(context);
  if (!mode) {
    return {
      ok: false,
      denied: true,
      output: 'MCP tool call blocked because the live session mode is unavailable.',
      error: 'MCP tool call blocked because the live session mode is unavailable.',
    };
  }
  const decision = resolveMcpPlanToolDecision({
    mode,
    toolName,
    server: liveServer,
  });
  if (decision.deny) {
    return { ok: false, denied: true, output: decision.reason, error: decision.reason };
  }
  return { ok: true, server: liveServer };
}

function connectTimeoutMs() {
  const raw = Number(process.env.CRETLI_MCP_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}
const CALL_TIMEOUT_MS = 60000;

/**
 * @typedef {{
 *   sessionId?: string,
 *   chatId?: string,
 *   workspaceId?: string,
 *   workspaceFile?: string,
 *   workspaceFolder?: string,
 *   harness?: string,
 *   mode?: string,
 *   revision?: number,
 *   builtinClient?: object,
 * }} McpRuntimeContext
 */

/**
 * @typedef {{
 *   client: Client,
 *   serverId: string,
 *   transport: object | null,
 *   contextKey: string,
 * }} LiveClientEntry
 */

/** @type {Map<string, LiveClientEntry>} */
const liveClients = new Map();

/** @type {Map<string, Promise<LiveClientEntry>>} */
const connecting = new Map();

/**
 * @param {object} server
 * @returns {Record<string, string>}
 */
function resolvedEnv(server) {
  return resolveSecretMap(server.connection?.env || {}, getMcpSecrets(server.id));
}

/**
 * @param {object} server
 * @returns {Record<string, string>}
 */
function resolvedHeaders(server) {
  return resolveSecretMap(server.connection?.headers || {}, getMcpSecrets(server.id));
}

/**
 * @param {McpRuntimeContext} context
 * @returns {string}
 */
function isolationKey(context) {
  return [
    String(context?.sessionId || ''),
    String(context?.workspaceId || ''),
    String(context?.workspaceFolder || ''),
    String(context?.workspaceFile || ''),
  ].join('\0');
}

/**
 * @param {object} server
 * @returns {string}
 */
export function mcpServerFingerprint(server) {
  const payload = JSON.stringify({
    transport: server?.transport || '',
    url: server?.connection?.url || '',
    command: server?.connection?.command || '',
    args: server?.connection?.args || [],
    cwd: server?.connection?.cwd || '',
    env: resolvedEnv(server),
    headers: resolvedHeaders(server),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * @param {McpRuntimeContext} context
 * @param {object} server
 * @returns {string}
 */
export function mcpConnectionKey(context, server) {
  return [
    isolationKey(context),
    String(server?.id || ''),
    mcpServerFingerprint(server),
  ].join('\0');
}

/**
 * @param {McpRuntimeContext} context
 * @param {object} server
 */
function markStatus(context, server, patch) {
  upsertMcpStatus({
    serverId: server.id,
    harness: String(context?.harness || ''),
    sessionId: String(context?.sessionId || ''),
    workspaceKey: String(context?.workspaceId || context?.workspaceFolder || context?.workspaceFile || ''),
    desiredRevision: Number(context?.revision) || 0,
    source: patch.source || 'session',
    ...patch,
  });
}

/**
 * @param {object} transport
 */
async function closeTransport(transport) {
  if (!transport) return;
  try {
    if (typeof transport.close === 'function') await transport.close();
  } catch {
    // ignore
  }
  const child = transport.pid
    || transport._process?.pid
    || transport.process?.pid;
  if (child) {
    try {
      process.kill(child, 'SIGKILL');
    } catch {
      // ignore
    }
  }
}

const MCP_PAGING_KEYS = Object.freeze([
  'next_cursor',
  'next_from_seq',
  'next_before_seq',
  'next_offset',
  'truncated',
]);

/**
 * @param {unknown} structured
 * @param {string} text
 * @returns {string}
 */
function formatStructuredPaging(structured, text) {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return '';
  const body = String(text || '');
  const lines = [];
  for (const key of MCP_PAGING_KEYS) {
    const value = /** @type {Record<string, unknown>} */ (structured)[key];
    if (value == null || value === '' || value === false) continue;
    const line = `${key}: ${value}`;
    if (body.includes(`${key}:`)) continue;
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * @param {object} result
 * @returns {string}
 */
export function formatMcpToolResult(result) {
  if (!result || typeof result !== 'object') return '';
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else parts.push(JSON.stringify(part));
  }
  let text = parts.join('\n');
  const paging = formatStructuredPaging(result.structuredContent, text);
  if (paging) text = text ? `${text}\n${paging}` : paging;
  if (text) return text;
  if (typeof result.structuredContent !== 'undefined') {
    try {
      return JSON.stringify(result.structuredContent);
    } catch {
      // fall through
    }
  }
  if (result.isError) return 'MCP tool error';
  return JSON.stringify(result);
}

/**
 * @param {McpRuntimeContext} context
 * @param {object} server
 * @param {{ pooled?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<LiveClientEntry>}
 */
async function connectExternal(context, server, options = {}) {
  const pooled = options.pooled !== false;
  const key = mcpConnectionKey(context, server);
  if (pooled) {
    const existing = liveClients.get(key);
    if (existing) return existing;
    const pending = connecting.get(key);
    if (pending) return pending;
  }
  const start = (async () => {
    markStatus(context, server, {
      connectionState: 'connecting',
      configState: 'pending',
      source: pooled ? 'session' : 'diagnostic',
    });
    const client = new Client({ name: 'cretli', version: '0.4.0' });
    /** @type {object | null} */
    let transport = null;
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    if (options.signal) {
      if (options.signal.aborted) abort.abort();
      else options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => abort.abort(), connectTimeoutMs());
    try {
      if (server.transport === 'http') {
        const headers = resolvedHeaders(server);
        transport = new StreamableHTTPClientTransport(new URL(String(server.connection.url)), {
          requestInit: { headers, signal: abort.signal },
        });
      } else {
        const env = { ...getDefaultEnvironment(), ...resolvedEnv(server) };
        transport = new StdioClientTransport({
          command: String(server.connection.command),
          args: Array.isArray(server.connection.args) ? server.connection.args : [],
          cwd: String(server.connection.cwd || '').trim() || undefined,
          env,
          stderr: 'pipe',
        });
      }
      abort.signal.addEventListener('abort', () => {
        void closeTransport(transport);
      }, { once: true });
      if (abort.signal.aborted) {
        throw new Error('MCP connection timed out');
      }
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => {
          const fail = () => reject(new Error('MCP connection timed out'));
          if (abort.signal.aborted) fail();
          else abort.signal.addEventListener('abort', fail, { once: true });
        }),
      ]);
      if (abort.signal.aborted) {
        await client.close().catch(() => {});
        throw new Error('MCP connection timed out');
      }
    } catch (err) {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);
      markStatus(context, server, {
        connectionState: 'error',
        configState: 'error',
        error: sanitizeMcpError(err?.message || err),
        source: pooled ? 'session' : 'diagnostic',
      });
      try {
        await client.close();
      } catch {
        // ignore
      }
      await closeTransport(transport);
      throw err;
    }
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onCallerAbort);
    const entry = {
      client,
      serverId: server.id,
      transport,
      contextKey: isolationKey(context),
    };
    client.onclose = () => {
      if (pooled && liveClients.get(key) === entry) {
        liveClients.delete(key);
        markStatus(context, server, {
          connectionState: 'disconnected',
          error: '',
        });
      }
    };
    if (pooled) liveClients.set(key, entry);
    markStatus(context, server, {
      connectionState: pooled ? 'connected' : 'tested',
      configState: pooled ? 'applied' : 'pending',
      appliedRevision: pooled ? (Number(context?.revision) || 0) : undefined,
      error: '',
      source: pooled ? 'session' : 'diagnostic',
    });
    return entry;
  })();
  if (pooled) {
    connecting.set(key, start);
    try {
      return await start;
    } finally {
      connecting.delete(key);
    }
  }
  return start;
}

/**
 * @param {McpRuntimeContext} context
 * @param {object} server
 * @returns {Promise<object[]>}
 */
export async function listTools(context, server) {
  if (server.kind === 'builtin-cretli') {
    const tools = CRETILI_MCP_TOOL_DEFS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
    rememberMcpToolCatalog(server.id, tools, { catalogKey: mcpConnectionKey(context, server) });
    markStatus(context, server, {
      connectionState: 'connected',
      configState: 'applied',
      appliedRevision: Number(context?.revision) || 0,
      tools,
      toolsFetchedAt: new Date().toISOString(),
    });
    return tools;
  }
  const catalogKey = mcpConnectionKey(context, server);
  const cached = getMcpToolCatalogByKey(catalogKey);
  if (cached.tools.length > 0) return cached.tools;
  const { client } = await connectExternal(context, server);
  /** @type {object[]} */
  const tools = [];
  let cursor = '';
  do {
    const listed = await client.listTools(cursor ? { cursor } : {});
    const page = Array.isArray(listed?.tools) ? listed.tools : [];
    for (const tool of page) {
      tools.push({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema || { type: 'object' },
      });
    }
    cursor = typeof listed?.nextCursor === 'string' ? listed.nextCursor : '';
  } while (cursor);
  rememberMcpToolCatalog(server.id, tools, { catalogKey });
  markStatus(context, server, {
    tools,
    toolsFetchedAt: new Date().toISOString(),
    connectionState: 'connected',
    configState: 'applied',
    appliedRevision: Number(context?.revision) || 0,
  });
  return tools;
}

/**
 * Diagnostic connect + list; never steals a pooled session client.
 *
 * @param {McpRuntimeContext} context
 * @param {object} server
 */
export async function testMcpServer(context, server) {
  if (server.kind === 'builtin-cretli') {
    const tools = CRETILI_MCP_TOOL_DEFS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
    rememberMcpToolCatalog(server.id, tools, { diagnostic: true });
    markStatus(context, server, {
      connectionState: 'tested',
      configState: 'pending',
      tools,
      toolsFetchedAt: new Date().toISOString(),
      source: 'diagnostic',
    });
    return { ok: true, tools };
  }
  let entry = null;
  try {
    entry = await connectExternal(context, server, { pooled: false });
    /** @type {object[]} */
    const tools = [];
    let cursor = '';
    do {
      const listed = await entry.client.listTools(cursor ? { cursor } : {});
      const page = Array.isArray(listed?.tools) ? listed.tools : [];
      for (const tool of page) {
        tools.push({
          name: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || { type: 'object' },
        });
      }
      cursor = typeof listed?.nextCursor === 'string' ? listed.nextCursor : '';
    } while (cursor);
    rememberMcpToolCatalog(server.id, tools, { diagnostic: true });
    markStatus(context, server, {
      connectionState: 'tested',
      configState: 'pending',
      tools,
      toolsFetchedAt: new Date().toISOString(),
      source: 'diagnostic',
    });
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, error: sanitizeMcpError(err?.message || err), tools: [] };
  } finally {
    if (entry) {
      try {
        await entry.client.close();
      } catch {
        // ignore
      }
      await closeTransport(entry.transport);
    }
  }
}

/**
 * @param {McpRuntimeContext} context
 * @param {object} server
 * @param {string} toolName
 * @param {unknown} args
 * @param {AbortSignal} [signal]
 */
export async function callTool(context, server, toolName, args, signal) {
  const initial = authorizeMcpToolCall(context, server, toolName);
  if (!initial.ok) {
    return { ok: false, denied: initial.denied === true, output: initial.output, error: initial.error };
  }
  if (signal?.aborted) {
    return { ok: false, output: '', error: 'MCP call cancelled' };
  }
  if (initial.server.kind === 'builtin-cretli') {
    const handlers = createCretliMcpToolHandlers(context?.builtinClient || {}, context);
    const handler = handlers[toolName];
    if (!handler) return { ok: false, output: '', error: `Unknown tool: ${toolName}` };
    const result = await handler(args && typeof args === 'object' ? args : {});
    const output = formatMcpToolResult(result);
    return { ok: result?.isError !== true, output, raw: result };
  }
  const { client } = await connectExternal(context, initial.server, { signal });
  const again = authorizeMcpToolCall(context, initial.server, toolName);
  if (!again.ok) {
    return { ok: false, denied: again.denied === true, output: again.output, error: again.error };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const result = await client.callTool(
      { name: String(toolName), arguments: args && typeof args === 'object' ? args : {} },
      undefined,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const output = formatMcpToolResult(result);
    return { ok: result?.isError !== true, output, raw: result };
  } catch (err) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    return { ok: false, output: '', error: sanitizeMcpError(err?.message || err) };
  }
}

/**
 * @param {string} key
 */
export async function disposeConnection(key) {
  const pending = connecting.get(key);
  if (pending) {
    connecting.delete(key);
  }
  const entry = liveClients.get(key);
  if (!entry) return;
  liveClients.delete(key);
  try {
    await entry.client.close();
  } catch {
    // ignore
  }
  await closeTransport(entry.transport);
}

/**
 * @param {string} serverId
 */
export async function invalidateServerConnections(serverId) {
  const id = String(serverId || '').trim();
  if (!id) return;
  markMcpServerStatusesStale(id);
  for (const [key, entry] of [...liveClients.entries()]) {
    if (entry.serverId !== id) continue;
    await disposeConnection(key);
  }
}

/**
 * Exact isolation match — never a workspace path prefix.
 *
 * @param {McpRuntimeContext} context
 * @param {object[]} servers
 */
export async function disposeContext(context, servers) {
  const wanted = isolationKey(context);
  const ids = new Set((servers || []).map((server) => server.id));
  for (const [key, entry] of [...liveClients.entries()]) {
    if (entry.contextKey !== wanted) continue;
    if (ids.size > 0 && !ids.has(entry.serverId)) continue;
    await disposeConnection(key);
  }
}

export function getCachedTools(serverId) {
  return getMcpToolCatalogByKey(String(serverId || ''));
}

export function getStatus(context) {
  return {
    runtimeNamePrefix: 'cretli_',
    sessionId: context?.sessionId || '',
    harness: context?.harness || '',
  };
}

export async function resetMcpRuntimeForTests() {
  for (const key of [...liveClients.keys()]) {
    await disposeConnection(key);
  }
  connecting.clear();
}

export { toMcpRuntimeName };
