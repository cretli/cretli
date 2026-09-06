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
  invalidateServerConnections,
  listTools,
  testMcpServer,
} from './mcp-runtime.js';
import { getMcpToolCatalog, listMcpStatuses, rememberMcpToolCatalog } from './mcp-status.js';
import { createInProcessMcpClient } from './mcp-inprocess-client.js';
import { resolveMcpPlanToolDecision } from './mcp-policy.js';
import { revokeMcpExecutionContext } from './mcp-execution-registry.js';

/**
 * @param {object} server
 * @returns {object}
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
  };
}

/**
 * @param {unknown} expectedRevision
 */
function requireExpectedRevision(expectedRevision) {
  if (!Number.isInteger(expectedRevision)) {
    const err = new Error('expectedRevision is required');
    err.code = 'VALIDATION';
    throw err;
  }
  return expectedRevision;
}

/**
 * @param {object} input
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
    err.code = 'VALIDATION';
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
 * @param {object} patch
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
      err.code = 'NOT_FOUND';
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
      err.code = 'VALIDATION';
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
      err.code = 'NOT_FOUND';
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
 * @param {object} context
 */
export function resolveContextServers(context) {
  const document = loadMcpDocument();
  return resolveMcpServersForContext(context, document.servers).map((server) => ({
    ...server,
    runtimeName: toMcpRuntimeName(server.id),
  }));
}

/**
 * @param {object} context
 * @param {string} serverId
 */
export async function listContextTools(context, serverId) {
  const server = resolveContextServers(context).find((row) => row.id === serverId);
  if (!server) {
    const err = new Error('MCP server not active in this context');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return listTools(withBuiltinClient(context), server);
}

/**
 * Re-resolve the server and Plan policy immediately before execution.
 *
 * @param {object} context
 * @param {string} serverId
 * @param {string} toolName
 * @param {unknown} args
 * @param {AbortSignal} [signal]
 */
export async function callContextTool(context, serverId, toolName, args, signal) {
  const server = resolveContextServers(context).find((row) => row.id === serverId);
  if (!server) {
    return { ok: false, output: '', error: 'MCP server not active in this context' };
  }
  const decision = resolveMcpPlanToolDecision({
    mode: context?.mode,
    toolName,
    server,
  });
  if (decision.deny) {
    return { ok: false, denied: true, output: decision.reason, error: decision.reason };
  }
  return callTool(withBuiltinClient(context), server, toolName, args, signal);
}

/**
 * @param {object} context
 * @param {string} serverId
 */
export async function testServer(context, serverId) {
  const document = loadMcpDocument();
  const server = normalizeMcpServers(document.servers).find((row) => row.id === serverId);
  if (!server) {
    const err = new Error('MCP server not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const result = await testMcpServer(withBuiltinClient(context), server);
  if (result.ok) rememberMcpToolCatalog(server.id, result.tools, { diagnostic: true });
  return result;
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
  await disposeContext(context, resolveContextServers(context));
}

/**
 * @param {object} context
 */
function withBuiltinClient(context) {
  if (context?.builtinClient) return context;
  return { ...context, builtinClient: createInProcessMcpClient(context) };
}

/**
 * @param {Record<string, Record<string, string>>} secrets
 * @param {string} serverId
 * @param {object} input
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
