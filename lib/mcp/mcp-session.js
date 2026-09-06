/**
 * Session MCP context and harness injection (native vs managed bridge).
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { loadMcpDocument } from '../persist/mcp-persist.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { resolveMcpServersForContext, toMcpRuntimeName } from './mcp-config.js';
import { getMcpSecrets, resolveSecretMap } from './mcp-secrets.js';
import { mintMcpIntegrationToken } from './mcp-integration-token.js';
import { getHarnessMcpAdapter } from './adapters/index.js';
import { upsertMcpStatus } from './mcp-status.js';
import {
  lookupMcpExecutionContext,
  rememberMcpExecutionContext,
  normalizeMcpExecutionMode,
} from './mcp-execution-registry.js';
import { readEnforcedSdkMode } from '../sdk/sdk-mode.js';

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
 * @param {{ chat?: object, room?: object, harness?: unknown, mode?: unknown, getMode?: () => unknown }} input
 */
export function buildMcpRuntimeContext(input) {
  const chat = input.chat && typeof input.chat === 'object' ? input.chat : {};
  const room = input.room && typeof input.room === 'object' ? input.room : {};
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
    workspaceFolder: String(chat.workspaceFolder || room.cwd || '').trim(),
    harness,
    mode,
    getMode,
    revision: loadMcpDocument().revision,
  };
}

/**
 * Resolve the live session for an integration token. Client-supplied mode,
 * workspace, and harness on the tool-call request are ignored.
 *
 * @param {object} tokenClaims
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
  return {
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
  };
}

/**
 * @param {ReturnType<typeof buildMcpRuntimeContext>} context
 */
export function listResolvedMcpServers(context) {
  const document = loadMcpDocument();
  return resolveMcpServersForContext(context, document.servers).map((server) => ({
    ...server,
    runtimeName: toMcpRuntimeName(server.id),
  }));
}

/**
 * Native stdio/http map for SDKs that spawn MCP themselves.
 * Builtin Cretli is never spawned natively — it only exists on the managed bridge.
 *
 * @param {object[]} servers
 * @returns {Record<string, object>}
 */
export function buildNativeMcpServerMap(servers) {
  /** @type {Record<string, object>} */
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
  /** @type {Record<string, object>} */
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
 * @param {object[]} servers
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
