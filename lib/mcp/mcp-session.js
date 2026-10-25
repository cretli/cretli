/**
 * Session MCP context and harness injection (native vs managed bridge).
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { loadMcpDocument } from '../persist/mcp-persist.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { getChatByCursorSessionId } from '../persist/chats-persist.js';
import { BUILTIN_CRETILI_SERVER_ID, resolveMcpServersForContext, toMcpRuntimeName } from './mcp-config.js';
import { isExternalMcpToolName, readEffectiveMcpToolName } from './mcp-policy.js';
import {
  decodeMcpToolName,
  findServerByRuntimeName,
  hasMcpServerIdentity,
  MCP_CRETILI_BRIDGE_RUNTIME,
} from './mcp-tool-names.js';
import { getMcpSecrets, resolveSecretMap } from './mcp-secrets.js';
import { mintMcpIntegrationToken } from './mcp-integration-token.js';
import { getHarnessMcpAdapter } from './adapters/index.js';
import { resolveTodoHomeFromSettings } from '../todo-home.js';
import { upsertMcpStatus } from './mcp-status.js';
import {
  lookupMcpExecutionContext,
  rememberMcpExecutionContext,
  normalizeMcpExecutionMode,
} from './mcp-execution-registry.js';
import { readEnforcedSdkMode } from '../sdk/sdk-mode.ts';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class McpAuthorizationError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'McpAuthorizationError';
    this.code = 'MCP_AUTHZ';
  }
}

/**
 * @returns {string}
 */
export function resolveCretliLoopbackUrl() {
  const configured = String(process.env.CRETLI_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const port = String(process.env.PORT || process.env.CRETLI_PORT || '3011').trim() || '3011';
  const useHttps = String(process.env.USE_HTTPS || '1') !== '0';
  return `${useHttps ? 'https' : 'http'}://127.0.0.1:${port}`;
}

/**
 * @param {{ chat?: Record<string, any>, room?: Record<string, any>, harness?: unknown, mode?: unknown, getMode?: () => unknown }} input
 */
export function buildMcpRuntimeContext(input) {
  const chat = input.chat && typeof input.chat === 'object' ? /** @type {any} */ (input.chat) : {};
  const room = input.room && typeof input.room === 'object' ? /** @type {any} */ (input.room) : {};
  const harness = normalizeAgentTransport(input.harness || chat.agentTransport || room.transport);
  const getMode = typeof input.getMode === 'function'
    ? () => normalizeMcpExecutionMode(input.getMode())
    : () => normalizeMcpExecutionMode(readEnforcedSdkMode(room, room.sdkMode || chat.sdkMode));
  const mode = getMode() || 'agent';
  return {
    sessionId: String(room.sessionKey || chat.cursorSessionId || chat.id || '').trim(),
    chatId: String(chat.id || room.chatId || '').trim(),
    workspaceId: String(chat.workspaceId || '').trim(),
    workspaceFile: String(chat.workspaceFile || '').trim(),
    workspaceFolder: resolveMcpTodoFolder(chat, room),
    harness,
    mode,
    getMode,
    revision: loadMcpDocument().revision,
    attemptId: String(room.delegationAttemptId || '').trim(),
    // Built per run from the live room, so in-process harnesses (no bridge
    // token) prove their round here; bridge harnesses use token claims instead.
    ...(room.delegationAttemptId || room.delegationId
      ? { callProvenance: { attemptId: String(room.delegationAttemptId || '').trim(), delegationId: String(room.delegationId || '').trim() } }
      : {}),
    runId: String(room.currentRun?.id || '').trim(),
    delegationId: String(room.delegationId || '').trim(),
  };
}

/**
 * Resolve the live session for an integration token. Client-supplied mode,
 * workspace, and harness on the tool-call request are ignored.
 *
 * @param {Record<string, any>} tokenClaims
 */
export function resolveAuthorizedMcpContext(tokenClaims) {
  const sessionId = String(tokenClaims?.sessionId || '').trim();
  const chatId = String(tokenClaims?.chatId || '').trim();
  if (!sessionId && !chatId) {
    throw new McpAuthorizationError('MCP token is not bound to a session');
  }
  const live = lookupMcpExecutionContext({ sessionId, chatId });
  if (!live) {
    throw new McpAuthorizationError('MCP session is unknown or no longer active');
  }
  const tokenInc = String(tokenClaims?.incarnation || tokenClaims?.inc || '').trim();
  if (!tokenInc || tokenInc !== live.incarnation) {
    throw new McpAuthorizationError('MCP integration token was revoked');
  }
  if (sessionId && live.sessionId && sessionId !== live.sessionId) {
    throw new McpAuthorizationError('MCP token session does not match');
  }
  if (chatId && live.chatId && chatId !== live.chatId) {
    throw new McpAuthorizationError('MCP token chat does not match');
  }
  if (tokenClaims?.harness) {
    const tokenHarness = normalizeAgentTransport(tokenClaims.harness);
    if (live.harness && tokenHarness && tokenHarness !== live.harness) {
      throw new McpAuthorizationError('MCP token harness does not match');
    }
  }
  const mode = live.getMode();
  if (!mode) {
    throw new McpAuthorizationError('MCP session mode could not be determined');
  }
  // Per-call provenance comes only from the signed token claims, never from
  // the mutable live snapshot (which a chat rebind overwrites).
  const claimAttempt = String(tokenClaims?.attemptId || '').trim();
  const claimDelegation = String(tokenClaims?.delegationId || '').trim();
  const callProvenance = claimAttempt || claimDelegation
    ? { attemptId: claimAttempt, delegationId: claimDelegation }
    : undefined;
  return {
    ...(callProvenance ? { callProvenance } : {}),
    sessionId: live.sessionId,
    chatId: live.chatId,
    workspaceId: live.workspaceId,
    workspaceFile: live.workspaceFile,
    workspaceFolder: live.workspaceFolder,
    harness: live.harness,
    mode,
    getMode: live.getMode,
    revision: loadMcpDocument().revision,
    configurationRevision: loadMcpDocument().revision,
    attemptId: String(live.attemptId || '').trim(),
    runId: String(live.runId || '').trim(),
    delegationId: String(live.delegationId || '').trim(),
  };
}

/**
 * @param {Record<string, any>} context
 * @returns {Record<string, any>[]}
 */
export function listResolvedMcpServers(context) {
  const document = loadMcpDocument();
  return resolveMcpServersForContext(context, document.servers).map((server) => ({
    ...server,
    runtimeName: toMcpRuntimeName(server.id),
  }));
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function readGuardEventToolName(event) {
  if (!event || typeof event !== 'object') return '';
  return String(/** @type {Record<string, unknown>} */ (event).name || '').trim().toLowerCase();
}

/**
 * @param {unknown} event
 * @returns {Record<string, unknown>}
 */
function readGuardEventArgs(event) {
  if (!event || typeof event !== 'object') return {};
  const args = /** @type {Record<string, unknown>} */ (event).args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  return /** @type {Record<string, unknown>} */ (args);
}

/**
 * Resolve the MCP server row for Plan/Scout guards from the live session config.
 * Callers pass the returned object as `mcpServer` / `server` identity.
 *
 * @param {{
 *   room?: Record<string, any>,
 *   chat?: Record<string, any>,
 *   harness?: unknown,
 *   event?: unknown,
 *   toolName?: unknown,
 *   args?: unknown,
 *   mcpServer?: unknown,
 * }} input
 * @returns {Record<string, any> | undefined}
 */
export function resolvePlanGuardMcpServerIdentity(input = {}) {
  if (hasMcpServerIdentity(input.mcpServer)) {
    return /** @type {any} */ (input.mcpServer);
  }
  const room = input.room && typeof input.room === 'object' ? /** @type {any} */ (input.room) : {};
  const chatRow = input.chat && typeof input.chat === 'object'
    ? input.chat
    : getChatByCursorSessionId(String(room.sessionKey || '').trim()) || undefined;
  const eventToolName = input.event
    ? readGuardEventToolName(input.event)
    : String(input.toolName || '').trim().toLowerCase();
  const eventArgs = input.event
    ? readGuardEventArgs(input.event)
    : (input.args && typeof input.args === 'object' && !Array.isArray(input.args)
      ? /** @type {Record<string, unknown>} */ (input.args)
      : {});
  const effectiveName = readEffectiveMcpToolName(eventToolName, eventArgs);
  if (!isExternalMcpToolName(effectiveName)) return undefined;
  const decoded = decodeMcpToolName(effectiveName);
  if (!decoded) return undefined;
  const ctx = buildMcpRuntimeContext({
    room,
    chat: chatRow,
    harness: input.harness || /** @type {any} */ (chatRow)?.agentTransport || room.transport,
  });
  const servers = listResolvedMcpServers(ctx);
  const server = findServerByRuntimeName(servers, decoded.runtimeName)
    ?? (decoded.runtimeName === MCP_CRETILI_BRIDGE_RUNTIME
      ? servers.find((row) => row.id === BUILTIN_CRETILI_SERVER_ID) || null
      : null);
  return server || undefined;
}

/**
 * Native stdio/http map for SDKs that spawn MCP themselves.
 * Builtin Cretli is never spawned natively — it only exists on the managed bridge.
 *
 * @param {Record<string, any>[]} servers
 * @returns {Record<string, Record<string, any>>}
 */
export function buildNativeMcpServerMap(servers) {
  /** @type {Record<string, Record<string, any>>} */
  const map = {};
  for (const server of servers) {
    if (server.kind === 'builtin-cretli') continue;
    const name = toMcpRuntimeName(server.id);
    if (server.transport === 'http') {
      map[name] = {
        type: 'http',
        url: String(server.connection.url || ''),
        headers: resolveSecretMap(server.connection.headers || {}, getMcpSecrets(server.id)),
      };
      continue;
    }
    map[name] = {
      type: 'stdio',
      command: String(server.connection.command || ''),
      args: Array.isArray(server.connection.args) ? server.connection.args : [],
      env: resolveSecretMap(server.connection.env || {}, getMcpSecrets(server.id)),
      cwd: String(server.connection.cwd || '').trim() || undefined,
    };
  }
  return map;
}

/**
 * @param {ReturnType<typeof buildMcpRuntimeContext>} context
 * @param {{ scope?: 'session' | 'builtin' }} [options]
 */
export function buildManagedBridgeStdio(context, options = {}) {
  const live = rememberMcpExecutionContext(context, { getMode: context.getMode });
  const token = mintMcpIntegrationToken({
    ...context,
    scope: options.scope || 'session',
    // Immutable identity of the round this bridge is spawned for.
    attemptId: String(context.attemptId || '').trim(),
    delegationId: String(context.delegationId || '').trim(),
    incarnation: live?.incarnation || '',
  });
  return {
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'scripts/cretli-mcp.js'), '--bridge'],
    env: {
      CRETLI_URL: resolveCretliLoopbackUrl(),
      CRETLI_MCP_TOKEN: token,
      CRETLI_INSECURE_TLS: '1',
    },
  };
}

/**
 * Prepare MCP injection for a harness turn. Does not interrupt an in-flight reply.
 *
 * @param {ReturnType<typeof buildMcpRuntimeContext>} context
 */
export function prepareHarnessMcp(context) {
  rememberMcpExecutionContext(context, { getMode: context.getMode });
  const adapter = getHarnessMcpAdapter(context.harness);
  const servers = listResolvedMcpServers(context);
  const revision = Number(context.revision) || 0;
  if (!adapter) {
    for (const server of servers) {
      upsertMcpStatus({
        serverId: server.id,
        harness: context.harness,
        sessionId: context.sessionId,
        workspaceKey: context.workspaceId || context.workspaceFolder || context.workspaceFile,
        configState: 'unsupported',
        connectionState: 'unknown',
        desiredRevision: revision,
        error: `Harness ${context.harness} has no MCP adapter`,
      });
    }
    return {
      adapter: null,
      servers,
      revision,
      mcpServers: {},
      bridge: null,
      unsupported: true,
      unsupportedReason: `Harness ${context.harness} has no MCP adapter`,
    };
  }
  const usesBridge = adapter.callControl === 'bridge';
  const native = adapter.callControl === 'native' ? buildNativeMcpServerMap(servers) : {};
  const bridge = usesBridge && servers.length > 0
    ? buildManagedBridgeStdio(context)
    : null;
  /** @type {Record<string, Record<string, any>>} */
  const mcpServers = usesBridge ? {} : { ...native };
  if (bridge) {
    mcpServers.cretli_bridge = {
      type: 'stdio',
      command: bridge.command,
      args: bridge.args,
      env: bridge.env,
    };
  }
  for (const server of servers) {
    upsertMcpStatus({
      serverId: server.id,
      harness: context.harness,
      sessionId: context.sessionId,
      workspaceKey: context.workspaceId || context.workspaceFolder || context.workspaceFile,
      configState: adapter.unsupportedFeature ? 'unsupported' : 'pending',
      connectionState: 'unknown',
      desiredRevision: revision,
      error: adapter.unsupportedFeature || '',
    });
  }
  return {
    adapter,
    servers,
    revision,
    mcpServers,
    bridge,
    unsupported: Boolean(adapter.unsupportedFeature),
    unsupportedReason: adapter.unsupportedFeature || '',
  };
}

/**
 * Mark applied revision only after the harness accepted the config.
 *
 * @param {ReturnType<typeof buildMcpRuntimeContext>} context
 * @param {Record<string, any>[]} servers
 * @param {number} revision
 */
export function markMcpConfigApplied(context, servers, revision) {
  for (const server of servers) {
    upsertMcpStatus({
      serverId: server.id,
      harness: context.harness,
      sessionId: context.sessionId,
      workspaceKey: context.workspaceId || context.workspaceFolder || context.workspaceFile,
      configState: 'applied',
      appliedRevision: revision,
      desiredRevision: revision,
      error: '',
    });
  }
}

/**
 * Folder the MCP `todo_*` tools key their list by: the workspace's todo home
 * (same resolver as the REST routes), not the chat's own folder. Falls back to
 * the chat/room folder when the workspace cannot be resolved uniquely.
 *
 * @param {Record<string, any>} chat
 * @param {Record<string, any>} room
 * @returns {string}
 */
function resolveMcpTodoFolder(chat, room) {
  const raw = String(chat.workspaceFolder || room.cwd || '').trim();
  try {
    const resolved = resolveTodoHomeFromSettings({
      workspaceId: chat.workspaceId,
      workspaceFile: chat.workspaceFile,
      workspaceFolder: raw,
    });
    if (resolved.ok) return resolved.homeFolder;
  } catch {
    // Settings unreadable: keep the chat folder.
  }
  return raw;
}
