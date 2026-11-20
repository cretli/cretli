/**
 * Public MCP service used by HTTP routes, harness adapters, and builtin tools.
 */

import { loadMcpDocument, mutateMcpConfiguration } from '../persist/mcp-persist.js';
import {
  normalizeMcpServer,
  normalizeMcpServers,
  resolveMcpServersForContext,
  toMcpRuntimeName,
  validateMcpServerConnection,
} from './mcp-config.js';
import {
  applySecretPatchToMap,
  deleteSecretsFromMap,
  listMcpSecretKeys,
} from './mcp-secrets.js';
import {
  callTool,
  disposeContext,
  disposeSessionConnections,
  invalidateServerConnections,
  listTools,
  testMcpServer,
} from './mcp-runtime.js';
import { createHash } from 'node:crypto';
import {
  clearMcpToolCatalogsForServer,
  getMcpToolCatalog,
  listMcpStatuses,
  rememberMcpToolCatalog,
} from './mcp-status.js';
import { getMcpSecretOAuthState } from './mcp-oauth.js';
import { listMcpOAuthPresets } from './mcp-oauth-presets.js';
import { appendMcpAccess } from './mcp-access-log.js';
import { createInProcessMcpClient } from './mcp-inprocess-client.js';
import { resolveMcpPlanToolDecision } from './mcp-policy.js';
import { auditOperatorExternalMcpReject } from '../operator/operator-native-gate.js';
import { isOperatorIsolatedChatId } from '../operator/operator-run-chat-registry.js';
import { BUILTIN_CRETILI_SERVER_ID } from './mcp-config.js';
import { revokeMcpExecutionContext } from './mcp-execution-registry.js';

/**
 * @param {Record<string, any>} server
 * @returns {Record<string, any>}
 */
export function publicMcpServer(server) {
  const secretKeys = listMcpSecretKeys(server.id);
  return {
    id: server.id,
    name: server.name,
    kind: server.kind,
    enabled: server.enabled,
    scope: server.scope,
    harnesses: server.harnesses,
    transport: server.transport,
    connection: redactConnection(server.connection, secretKeys),
    toolPolicy: server.toolPolicy,
    ...(server.oauth ? { oauth: { ...server.oauth, ...getMcpSecretOAuthState(server) } } : {}),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    runtimeName: toMcpRuntimeName(server.id),
    secretKeys,
  };
}

/**
 * @param {Record<string, unknown>} connection
 * @param {string[]} secretKeys
 */
function redactConnection(connection, secretKeys) {
  const redacted = { ...connection };
  const mask = (bag) => {
    if (!bag || typeof bag !== 'object') return {};
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(bag)) {
      if (value && typeof value === 'object' && value.secret) {
        out[key] = { set: secretKeys.includes(value.secret) || secretKeys.includes(key) };
        continue;
      }
      if (secretKeys.includes(key)) {
        out[key] = { set: true };
        continue;
      }
      out[key] = value;
    }
    return out;
  };
  if (redacted.env) redacted.env = mask(redacted.env);
  if (redacted.headers) redacted.headers = mask(redacted.headers);
  return redacted;
}

export function listMcpServers() {
  const document = loadMcpDocument();
  return {
    revision: document.revision,
    servers: normalizeMcpServers(document.servers).map(publicMcpServer),
    oauthPresets: listMcpOAuthPresets(),
  };
}

/**
 * @param {unknown} expectedRevision
 * @returns {number}
 */
function requireExpectedRevision(expectedRevision) {
  if (!Number.isInteger(expectedRevision)) {
    const err = new Error('expectedRevision is required');
    /** @type {any} */ (err).code = 'VALIDATION';
    throw err;
  }
  return /** @type {number} */ (expectedRevision);
}

/**
 * @param {Record<string, any>} input
 * @param {number} expectedRevision
 */
export async function createMcpServer(input, expectedRevision) {
  const revision = requireExpectedRevision(expectedRevision);
  const server = normalizeMcpServer({
    ...input,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const error = validateMcpServerConnection(server);
  if (error) {
    const err = new Error(error);
    /** @type {any} */ (err).code = 'VALIDATION';
    throw err;
  }
  const next = await mutateMcpConfiguration(revision, (state) => {
    const servers = [...normalizeMcpServers(state.servers), server];
    const secrets = collectInputSecrets(state.secrets, server.id, input);
    return { servers, secrets };
  });
  await invalidateServerConnections(server.id);
  return { revision: next.revision, server: publicMcpServer(server) };
}

/**
 * @param {string} id
 * @param {Record<string, any>} patch
 * @param {number} expectedRevision
 */
export async function updateMcpServer(id, patch, expectedRevision) {
  const revision = requireExpectedRevision(expectedRevision);
  let merged = null;
  const next = await mutateMcpConfiguration(revision, (state) => {
    const servers = normalizeMcpServers(state.servers);
    const index = servers.findIndex((row) => row.id === id);
    if (index < 0) {
      const err = new Error('MCP server not found');
      /** @type {any} */ (err).code = 'NOT_FOUND';
      throw err;
    }
    merged = normalizeMcpServer({
      ...servers[index],
      ...patch,
      id,
      createdAt: servers[index].createdAt,
      updatedAt: new Date().toISOString(),
      connection: patch.connection
        ? { ...servers[index].connection, ...patch.connection }
        : servers[index].connection,
    });
    const error = validateMcpServerConnection(merged);
    if (error) {
      const err = new Error(error);
      /** @type {any} */ (err).code = 'VALIDATION';
      throw err;
    }
    servers[index] = merged;
    const secrets = collectInputSecrets(state.secrets, id, patch);
    return { servers, secrets };
  });
  await invalidateServerConnections(id);
  return { revision: next.revision, server: publicMcpServer(merged) };
}

/**
 * Copies a server under a new id, including its stored secrets. OAuth tokens
 * are not copied (they belong to one login session). The copy starts disabled
 * so two identical servers never expose the same tools by accident.
 *
 * @param {string} id
 * @param {number} expectedRevision
 * @param {{ name?: string }} [options]
 */
export async function duplicateMcpServer(id, expectedRevision, options = {}) {
  const revision = requireExpectedRevision(expectedRevision);
  let copy = null;
  const next = await mutateMcpConfiguration(revision, (state) => {
    const servers = normalizeMcpServers(state.servers);
    const source = servers.find((row) => row.id === id);
    if (!source) {
      const err = new Error('MCP server not found');
      /** @type {any} */ (err).code = 'NOT_FOUND';
      throw err;
    }
    if (source.kind === 'builtin-cretli') {
      const err = new Error('The built-in Cretli server cannot be duplicated');
      /** @type {any} */ (err).code = 'VALIDATION';
      throw err;
    }
    const taken = new Set(servers.map((row) => row.name));
    const requested = String(options.name || '').trim();
    let name = requested || `${source.name} (copy)`;
    for (let n = 2; taken.has(name); n += 1) name = `${requested || `${source.name} (copy)`} ${n}`;
    const now = new Date().toISOString();
    copy = normalizeMcpServer({
      ...structuredClone(source),
      id: undefined,
      name,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    });
    /** @type {Record<string, string>} */
    const secretPatch = {};
    for (const [key, value] of Object.entries(state.secrets?.[source.id] || {})) {
      if (!key.startsWith('oauth_') && typeof value === 'string' && value) secretPatch[key] = value;
    }
    return {
      servers: [...servers, copy],
      secrets: applySecretPatchToMap(state.secrets, copy.id, secretPatch),
    };
  });
  return { revision: next.revision, server: publicMcpServer(copy) };
}

/**
 * @param {string} id
 * @param {number} expectedRevision
 */
export async function deleteMcpServer(id, expectedRevision) {
  const revision = requireExpectedRevision(expectedRevision);
  await mutateMcpConfiguration(revision, (state) => {
    const servers = normalizeMcpServers(state.servers);
    const exists = servers.some((row) => row.id === id);
    if (!exists) {
      const err = new Error('MCP server not found');
      /** @type {any} */ (err).code = 'NOT_FOUND';
      throw err;
    }
    return {
      servers: servers.filter((row) => row.id !== id),
      secrets: deleteSecretsFromMap(state.secrets, id),
    };
  });
  await invalidateServerConnections(id);
  const document = loadMcpDocument();
  return { revision: document.revision };
}

/**
 * @param {Record<string, any>} context
 * @returns {Record<string, any>[]}
 */
export function resolveContextServers(context) {
  const document = loadMcpDocument();
  return resolveMcpServersForContext(context, document.servers).map((server) => ({
    ...server,
    runtimeName: toMcpRuntimeName(server.id),
  }));
}

/**
 * @param {Record<string, any>} context
 * @param {string} serverId
 */
export async function listContextTools(context, serverId) {
  const server = resolveContextServers(context).find((row) => row.id === serverId);
  if (!server) {
    if (serverId !== BUILTIN_CRETILI_SERVER_ID && isOperatorIsolatedChatId(context?.chatId)) {
      auditOperatorExternalMcpReject({ chatId: context?.chatId, serverId });
    }
    const err = new Error('MCP server not active in this context');
    /** @type {any} */ (err).code = 'NOT_FOUND';
    throw err;
  }
  return listTools(withBuiltinClient(context), server);
}

/**
 * Re-resolve the server and Plan policy immediately before execution.
 *
 * @param {Record<string, any>} context
 * @param {string} serverId
 * @param {string} toolName
 * @param {unknown} args
 * @param {AbortSignal} [signal]
 */
export async function callContextTool(context, serverId, toolName, args, signal) {
  const server = resolveContextServers(context).find((row) => row.id === serverId);
  /** @param {Record<string, any>} extra */
  const record = (extra) => {
    // The built-in Cretli server is internal; the log covers external servers.
    if (serverId === BUILTIN_CRETILI_SERVER_ID) return;
    appendMcpAccess({
      serverId,
      serverName: server?.name,
      tool: toolName,
      chatId: context?.chatId,
      harness: context?.harness,
      mode: context?.mode,
      ...extra,
    });
  };
  if (!server) {
    if (serverId !== BUILTIN_CRETILI_SERVER_ID && isOperatorIsolatedChatId(context?.chatId)) {
      auditOperatorExternalMcpReject({ chatId: context?.chatId, serverId, toolName });
    }
    record({ outcome: 'unavailable', reason: 'server not active in this context' });
    return { ok: false, output: '', error: 'MCP server not active in this context' };
  }
  const decision = resolveMcpPlanToolDecision({
    mode: context?.mode,
    toolName,
    server,
  });
  if (decision.deny) {
    record({ outcome: 'denied', reason: decision.reason });
    return { ok: false, denied: true, output: decision.reason, error: decision.reason };
  }
  const startedAt = Date.now();
  try {
    const result = await callTool(withBuiltinClient(context), server, toolName, args, signal);
    record({ outcome: result?.ok === false ? 'error' : 'ok', durationMs: Date.now() - startedAt, reason: result?.ok === false ? result.error : undefined });
    return result;
  } catch (err) {
    record({ outcome: 'error', durationMs: Date.now() - startedAt, reason: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * @param {Record<string, any>} context
 * @param {string} serverId
 */
export async function testServer(context, serverId) {
  const document = loadMcpDocument();
  const server = normalizeMcpServers(document.servers).find((row) => row.id === serverId);
  if (!server) {
    const err = new Error('MCP server not found');
    /** @type {any} */ (err).code = 'NOT_FOUND';
    throw err;
  }
  const result = await testMcpServer(withBuiltinClient(context), server);
  if (result.ok) rememberMcpToolCatalog(server.id, result.tools, { diagnostic: true });
  return result;
}

/**
 * Key-sorted JSON, so schemas that differ only in key order hash alike.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Fingerprint of a tool list: names and input schemas, independent of order.
 *
 * @param {Record<string, any>[]} tools
 * @returns {string}
 */
export function mcpToolsFingerprint(tools) {
  const rows = (Array.isArray(tools) ? tools : [])
    .map((tool) => ({ name: String(tool?.name || ''), inputSchema: tool?.inputSchema || {} }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash('sha256').update(stableJson(rows)).digest('hex').slice(0, 16);
}

/**
 * Forget the cached tool lists of one server (all sessions), close its pooled
 * connections and fetch the list again. Config, revision and secrets are not
 * touched: the next `listTools` of any chat reconnects and sees the fresh list.
 *
 * @param {Record<string, any>} context
 * @param {string} serverId
 * @returns {Promise<{ ok: boolean, serverId: string, name: string, tools: number, changed: boolean, error: string }>}
 */
export async function refreshMcpServerTools(context, serverId) {
  const document = loadMcpDocument();
  const server = normalizeMcpServers(document.servers).find((row) => row.id === serverId);
  if (!server) {
    const err = new Error('MCP server not found');
    /** @type {any} */ (err).code = 'NOT_FOUND';
    throw err;
  }
  const previous = clearMcpToolCatalogsForServer(server.id).map(mcpToolsFingerprint);
  await invalidateServerConnections(server.id);
  const result = await testMcpServer(withBuiltinClient(context), server);
  const fresh = result.ok ? mcpToolsFingerprint(result.tools) : '';
  return {
    ok: result.ok === true,
    serverId: server.id,
    name: server.name,
    tools: result.ok ? result.tools.length : 0,
    // Nothing cached before: no chat has seen a list yet, so the fresh one is new to it.
    changed: result.ok === true && (previous.length === 0 || previous.some((print) => print !== fresh)),
    error: result.ok ? '' : String(result.error || ''),
  };
}

/**
 * Refresh enabled external servers visible to a chat: one by id / name /
 * runtime name, or all of them without a reference.
 *
 * @param {Record<string, any>} context
 * @param {string} [reference]
 */
export async function refreshContextMcpTools(context, reference = '') {
  const wanted = String(reference || '').trim().toLowerCase();
  const candidates = resolveContextServers(context).filter((row) => row.kind !== 'builtin-cretli');
  const servers = wanted
    ? candidates.filter((row) => [row.id, row.name, row.runtimeName].some((key) => String(key || '').toLowerCase() === wanted))
    : candidates;
  if (wanted && servers.length === 0) {
    const err = new Error(`MCP server "${reference}" is not an enabled external integration in this context`);
    /** @type {any} */ (err).code = 'NOT_FOUND';
    throw err;
  }
  const results = [];
  for (const server of servers) results.push(await refreshMcpServerTools(context, server.id));
  return results;
}

export function getServerTools(serverId) {
  return getMcpToolCatalog(serverId);
}

export function getContextStatus(context) {
  return listMcpStatuses({
    harness: context?.harness,
    sessionId: context?.sessionId,
    workspaceKey: context?.workspaceId || context?.workspaceFolder || context?.workspaceFile,
  });
}

export async function disposeMcpContext(context) {
  revokeMcpExecutionContext(context);
  // A session owns its connections outright: close them all, including servers
  // that no longer resolve for this (partial) context.
  if (String(context?.sessionId || '').trim()) {
    await disposeSessionConnections(context.sessionId);
    return;
  }
  await disposeContext(context, resolveContextServers(context));
}

/**
 * @param {Record<string, any>} context
 */
function withBuiltinClient(context) {
  if (context?.builtinClient) return context;
  return { ...context, builtinClient: createInProcessMcpClient(context) };
}

/**
 * @param {Record<string, Record<string, string>>} secrets
 * @param {string} serverId
 * @param {Record<string, any>} input
 */
function collectInputSecrets(secrets, serverId, input) {
  /** @type {Record<string, string | null>} */
  const patch = {};
  collectSecrets(input?.connection?.env, patch);
  collectSecrets(input?.connection?.headers, patch);
  if (input?.secrets && typeof input.secrets === 'object') {
    for (const [key, value] of Object.entries(input.secrets)) {
      if (value === null) patch[key] = null;
      else if (typeof value === 'string' && value) patch[key] = value;
    }
  }
  return applySecretPatchToMap(secrets, serverId, patch);
}

/**
 * @param {unknown} bag
 * @param {Record<string, string | null>} patch
 */
function collectSecrets(bag, patch) {
  if (!bag || typeof bag !== 'object') return;
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === 'string' && value) {
      continue;
    }
    if (value && typeof value === 'object') {
      if (value.clear === true) {
        patch[typeof value.secret === 'string' ? value.secret : key] = null;
        continue;
      }
      if (typeof value.value === 'string' && value.value) {
        patch[typeof value.secret === 'string' ? value.secret : key] = value.value;
      }
    }
  }
}
