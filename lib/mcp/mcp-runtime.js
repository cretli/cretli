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
import { currentOwnerGeneration } from './mcp-owner-registry.js';
import { registerChildProcess, unregisterChildProcess } from '../child-process-registry.js';
import {
  SCOUT_READ_ONLY_MESSAGE,
  isScoutReadOnlySession,
} from '../workspace-scout-read-only.js';

function liveMcpMode(context) {
  if (typeof context?.getMode === 'function') {
    return normalizeMcpExecutionMode(context.getMode());
  }
  return normalizeMcpExecutionMode(context?.mode);
}

/**
 * @param {McpRuntimeContext} context
 * @param {Record<string, any>} server
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
 *   builtinClient?: Record<string, any>,
 * }} McpRuntimeContext
 */

/**
 * @typedef {{
 *   client: Client,
 *   serverId: string,
 *   transport: Record<string, any> | null,
 *   contextKey: string,
 *   sessionId: string,
 *   lastUsedAt?: number,
 *   createdAt?: number,
 *   activeCalls?: number,
 *   harness?: string,
 *   ownerGeneration?: number,
 * }} LiveClientEntry
 */

/** @type {Map<string, LiveClientEntry>} */
const liveClients = new Map();

function idleTtlMs() {
  const raw = Number(process.env.CRETLI_MCP_IDLE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
}

/**
 * Close pooled connections unused for longer than the idle TTL. Sessions that
 * end without an explicit dispose would otherwise keep their stdio child alive
 * for the life of the server.
 *
 * @param {number} [now]
 * @param {number} [ttlMs]
 * @returns {Promise<number>} evicted connections
 */
export async function sweepIdleConnections(now = Date.now(), ttlMs = idleTtlMs()) {
  const stale = [...liveClients.entries()]
    .filter(([, entry]) => now - (entry.lastUsedAt || 0) >= ttlMs)
    .map(([key]) => key);
  for (const key of stale) await disposeConnection(key);
  return stale.length;
}

/** @type {ReturnType<typeof setInterval> | null} */
let idleSweepTimer = null;

function startIdleSweep() {
  if (idleSweepTimer) return;
  idleSweepTimer = setInterval(() => {
    void sweepIdleConnections().catch(() => {});
  }, Math.max(1000, Math.min(60000, idleTtlMs())));
  idleSweepTimer.unref?.();
}

/**
 * Close every pooled or connecting MCP connection (server shutdown).
 *
 * @returns {Promise<number>}
 */
export async function disposeAllConnections() {
  if (idleSweepTimer) {
    clearInterval(idleSweepTimer);
    idleSweepTimer = null;
  }
  const keys = new Set([...liveClients.keys(), ...connectingOwners.keys()]);
  for (const key of keys) await disposeConnection(key);
  connecting.clear();
  return keys.size;
}

/** @type {Map<string, Promise<LiveClientEntry>>} */
const connecting = new Map();

/**
 * Owners of in-flight pooled connects. A teardown that races a connect cannot
 * see the client in `liveClients` yet, so it flags the attempt here and the
 * connect closes itself instead of registering a client nobody owns.
 *
 * @type {Map<string, { sessionId: string, contextKey: string, serverId: string, cancelled: boolean }>}
 */
const connectingOwners = new Map();

/**
 * @param {Record<string, any>} server
 * @returns {Record<string, string>}
 */
function resolvedEnv(server) {
  return resolveSecretMap(server.connection?.env || {}, getMcpSecrets(server.id));
}

/**
 * @param {Record<string, any>} server
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
 * @param {Record<string, any>} server
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
 * @param {Record<string, any>} server
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
 * @param {Record<string, any>} server
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
 * PID of a stdio transport child, keyed by the transport object. The SDK clears
 * its own `_process` reference on `close()`, so the PID is captured at connect
 * time and released when the transport is torn down.
 *
 * @type {WeakMap<Record<string, any>, number>}
 */
const transportChildPids = new WeakMap();

/**
 * @param {Record<string, any>} transport
 */
async function closeTransport(transport) {
  if (!transport) return;
  try {
    if (typeof transport.close === 'function') await transport.close();
  } catch {
    // ignore
  }
  const child = transportChildPids.get(transport)
    || transport.pid
    || transport._process?.pid
    || transport.process?.pid;
  if (child) {
    try {
      process.kill(child, 'SIGKILL');
    } catch {
      // ignore
    }
    unregisterChildProcess(child);
  }
}

const MCP_PAGING_KEYS = Object.freeze([
  'pickId',
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
 * @param {Record<string, any>} result
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
 * @param {Record<string, any>} server
 * @param {{ pooled?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<LiveClientEntry>}
 */
async function connectExternal(context, server, options = {}) {
  const pooled = options.pooled !== false;
  const key = mcpConnectionKey(context, server);
  if (pooled) {
    const existing = liveClients.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const pending = connecting.get(key);
    if (pending) return pending;
  }
  const owner = {
    sessionId: String(context?.sessionId || ''),
    contextKey: isolationKey(context),
    serverId: String(server?.id || ''),
    cancelled: false,
  };
  if (pooled) connectingOwners.set(key, owner);
  const start = (async () => {
    markStatus(context, server, {
      connectionState: 'connecting',
      configState: 'pending',
      source: pooled ? 'session' : 'diagnostic',
    });
    const client = new Client({ name: 'cretli', version: '0.4.0' });
    /** @type {Record<string, any> | null} */
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
        client.connect(/** @type {any} */ (transport)),
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
    if (pooled && owner.cancelled) {
      await client.close().catch(() => {});
      await closeTransport(transport);
      markStatus(context, server, { connectionState: 'disconnected', error: '', source: 'session' });
      throw new Error('MCP connection closed during connect');
    }
    const entry = {
      client,
      serverId: server.id,
      transport,
      contextKey: isolationKey(context),
      sessionId: String(context?.sessionId || ''),
      harness: String(context?.harness || ''),
      ownerGeneration: currentOwnerGeneration(context?.sessionId),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      activeCalls: 0,
    };
    const childPid = transport?.pid || transport?._process?.pid || transport?.process?.pid || 0;
    if (Number.isInteger(childPid) && childPid > 0) {
      transportChildPids.set(transport, childPid);
      registerChildProcess({
        pid: childPid,
        type: 'mcp-stdio',
        label: `mcp:${server.id}`,
      });
    }
    client.onclose = () => {
      if (pooled && liveClients.get(key) === entry) {
        liveClients.delete(key);
        markStatus(context, server, {
          connectionState: 'disconnected',
          error: '',
        });
      }
    };
    if (pooled) {
      liveClients.set(key, entry);
      startIdleSweep();
    }
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
      if (connecting.get(key) === start) connecting.delete(key);
      if (connectingOwners.get(key) === owner) connectingOwners.delete(key);
    }
  }
  return start;
}

/**
 * @param {McpRuntimeContext} context
 * @param {Record<string, any>} server
 * @returns {Promise<Record<string, any>[]>}
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
  /** @type {Record<string, any>[]} */
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
 * @param {Record<string, any>} server
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
    /** @type {Record<string, any>[]} */
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
 * @param {Record<string, any>} server
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
  // A Scout chat never reaches an external MCP server: those tools are opaque
  // to the host, so their read-only guarantee cannot be verified. Builtin tools
  // are handled below by the catalog, which allows reads and the scan submit.
  if (initial.server.kind !== 'builtin-cretli' && isScoutReadOnlySession(context)) {
    return {
      ok: false,
      denied: true,
      output: SCOUT_READ_ONLY_MESSAGE,
      error: SCOUT_READ_ONLY_MESSAGE,
    };
  }
  if (initial.server.kind === 'builtin-cretli') {
    const handlers = createCretliMcpToolHandlers(context?.builtinClient || {}, context);
    const handler = handlers[toolName];
    if (!handler) return { ok: false, output: '', error: `Unknown tool: ${toolName}` };
    const result = await handler(args && typeof args === 'object' ? /** @type {any} */ (args) : {}, { signal });
    const output = formatMcpToolResult(result);
    return { ok: result?.isError !== true, output, raw: result };
  }
  const connected = await connectExternal(context, initial.server, { signal });
  const { client } = connected;
  const again = authorizeMcpToolCall(context, initial.server, toolName);
  if (!again.ok) {
    return { ok: false, denied: again.denied === true, output: again.output, error: again.error };
  }
  const controller = new AbortController();
  connected.activeCalls = (connected.activeCalls || 0) + 1;
  const endCall = () => {
    connected.activeCalls = Math.max(0, (connected.activeCalls || 0) - 1);
    connected.lastUsedAt = Date.now();
  };
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const result = await client.callTool(
      { name: String(toolName), arguments: /** @type {Record<string, unknown>} */ (args && typeof args === 'object' ? /** @type {any} */ (args) : {}) },
      undefined,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    endCall();
    if (signal) signal.removeEventListener('abort', onAbort);
    const output = formatMcpToolResult(result);
    return { ok: result?.isError !== true, output, raw: result };
  } catch (err) {
    clearTimeout(timer);
    endCall();
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
  const owner = connectingOwners.get(key);
  if (owner) owner.cancelled = true;
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
  for (const [key, owner] of [...connectingOwners.entries()]) {
    if (owner.serverId === id) await disposeConnection(key);
  }
}

/**
 * Exact isolation match — never a workspace path prefix.
 *
 * @param {McpRuntimeContext} context
 * @param {Record<string, any>[]} servers
 */
export async function disposeContext(context, servers) {
  const wanted = isolationKey(context);
  const ids = new Set((servers || []).map((server) => server.id));
  for (const [key, entry] of [...liveClients.entries()]) {
    if (entry.contextKey !== wanted) continue;
    if (ids.size > 0 && !ids.has(entry.serverId)) continue;
    await disposeConnection(key);
  }
  for (const [key, owner] of [...connectingOwners.entries()]) {
    if (owner.contextKey !== wanted) continue;
    if (ids.size > 0 && !ids.has(owner.serverId)) continue;
    await disposeConnection(key);
  }
}

/**
 * Close every pooled connection of one chat session. Room teardown only knows
 * the session key and its cwd, not the workspace file/id the connection was
 * keyed with, so an exact isolation match would never find the stdio child
 * and it would outlive the room.
 *
 * @param {string} sessionId
 * @returns {Promise<number>} closed or cancelled connections
 */
export async function disposeSessionConnections(sessionId) {
  const wanted = String(sessionId || '').trim();
  if (!wanted) return 0;
  const keys = new Set();
  for (const [key, entry] of liveClients.entries()) {
    if (entry.sessionId === wanted) keys.add(key);
  }
  for (const [key, owner] of connectingOwners.entries()) {
    if (owner.sessionId === wanted && !owner.cancelled) keys.add(key);
  }
  for (const key of keys) await disposeConnection(key);
  return keys.size;
}

/**
 * Read-only pool view for the resource observer: no secrets, no client handles.
 *
 * @returns {{ sessionId: string, harness: string, serverId: string, ownerGeneration: number, createdAt: number, lastUsedAt: number, activeCalls: number, pid: number }[]}
 */
export function snapshotPoolEntries() {
  return [...liveClients.values()].map((entry) => ({
    sessionId: entry.sessionId,
    harness: entry.harness || '',
    serverId: entry.serverId,
    ownerGeneration: entry.ownerGeneration || 0,
    createdAt: entry.createdAt || 0,
    lastUsedAt: entry.lastUsedAt || 0,
    activeCalls: entry.activeCalls || 0,
    pid: transportChildPids.get(entry.transport) || 0,
  }));
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
  await disposeAllConnections();
}

export { toMcpRuntimeName };
