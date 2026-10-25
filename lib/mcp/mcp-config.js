/**
 * Normalize MCP server definitions and resolve which ones apply to a context.
 */

import { randomUUID } from 'crypto';
import { VALID_TRANSPORTS, isValidAgentTransport, normalizeAgentTransport } from '../agent-transport.js';
import { collectWorkspaceIdentityKeys, mcpScopeMatchesWorkspace, normalizeWorkspaceKey } from './mcp-workspace.js';

export const BUILTIN_CRETILI_SERVER_ID = 'builtin-cretli';
export const MCP_KINDS = Object.freeze(['external', 'builtin-cretli']);
export const MCP_TRANSPORTS = Object.freeze(['stdio', 'http']);

/**
 * @param {unknown} id
 * @returns {string}
 */
export function toMcpRuntimeName(id) {
  const compact = String(id || '').replace(/-/g, '').toLowerCase();
  return `cretli_${compact.slice(0, 12) || 'server'}`;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeHarnessList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!isValidAgentTransport(item)) continue;
    const harness = normalizeAgentTransport(item);
    if (seen.has(harness)) continue;
    seen.add(harness);
    out.push(harness);
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {'all' | string[]}
 */
function normalizeScope(raw) {
  if (raw === 'all' || raw == null || raw === '') return 'all';
  if (!Array.isArray(raw)) return 'all';
  const ids = [...new Set(raw.map((item) => normalizeWorkspaceKey(item)).filter(Boolean))];
  return ids;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function normalizeStringMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim()) continue;
    if (typeof value === 'string') {
      out[key] = value;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && ('secret' in value || 'clear' in value)) {
      out[key] = {
        secret: typeof value.secret === 'string' ? value.secret : key,
        clear: value.clear === true,
      };
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @param {string} transport
 * @returns {Record<string, unknown>}
 */
function normalizeConnection(raw, transport) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  if (transport === 'http') {
    return {
      url: String(source.url || '').trim(),
      headers: normalizeStringMap(source.headers),
    };
  }
  const args = Array.isArray(source.args)
    ? source.args.map((part) => String(part ?? '')).filter((part) => part.length > 0)
    : [];
  return {
    command: String(source.command || '').trim(),
    args,
    cwd: String(source.cwd || '').trim(),
    env: normalizeStringMap(source.env),
  };
}

/**
 * @param {unknown} raw
 * @returns {{ allowInPlan: string[] }}
 */
function normalizeToolPolicy(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  const allowInPlan = Array.isArray(source.allowInPlan)
    ? [...new Set(source.allowInPlan.map((name) => String(name || '').trim()).filter(Boolean))]
    : [];
  return { allowInPlan };
}

/**
 * @param {unknown} raw
 * @returns {Record<string, any> | null}
 */
export function normalizeMcpServer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(/** @type {any} */ (raw).id || '').trim() || randomUUID();
  let kind = MCP_KINDS.includes(/** @type {any} */ (raw).kind) ? /** @type {any} */ (raw).kind : 'external';
  if (kind === 'builtin-cretli' && id !== BUILTIN_CRETILI_SERVER_ID) {
    kind = 'external';
  }
  const transport = MCP_TRANSPORTS.includes(/** @type {any} */ (raw).transport) ? /** @type {any} */ (raw).transport : 'stdio';
  const now = new Date().toISOString();
  return {
    id,
    name: String(/** @type {any} */ (raw).name || '').trim() || 'MCP server',
    kind,
    enabled: /** @type {any} */ (raw).enabled !== false,
    scope: normalizeScope(/** @type {any} */ (raw).scope),
    harnesses: normalizeHarnessList(/** @type {any} */ (raw).harnesses),
    transport,
    connection: normalizeConnection(/** @type {any} */ (raw).connection, transport),
    toolPolicy: normalizeToolPolicy(/** @type {any} */ (raw).toolPolicy),
    createdAt: String(/** @type {any} */ (raw).createdAt || now),
    updatedAt: String(/** @type {any} */ (raw).updatedAt || now),
  };
}

/**
 * @param {unknown[]} servers
 * @returns {Record<string, any>[]}
 */
export function normalizeMcpServers(servers) {
  if (!Array.isArray(servers)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of servers) {
    const server = normalizeMcpServer(raw);
    if (!server || seen.has(server.id)) continue;
    seen.add(server.id);
    out.push(server);
  }
  return out;
}

/**
 * @param {Record<string, any>} server
 * @returns {string | null}
 */
export function validateMcpServerConnection(server) {
  if (!server?.enabled) return null;
  if (server.kind === 'builtin-cretli') return null;
  if (server.transport === 'http') {
    const url = String(server.connection?.url || '').trim();
    if (!url) return 'HTTP MCP servers require a URL';
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'HTTP MCP URL must use http or https';
      }
    } catch {
      return 'HTTP MCP URL is invalid';
    }
    return null;
  }
  if (!String(server.connection?.command || '').trim()) {
    return 'stdio MCP servers require a command';
  }
  return null;
}

/**
 * @returns {Record<string, any> | null}
 */
export function createBuiltinCretliServer() {
  return normalizeMcpServer({
    id: BUILTIN_CRETILI_SERVER_ID,
    name: 'Cretli',
    kind: 'builtin-cretli',
    enabled: true,
    scope: 'all',
    harnesses: [...VALID_TRANSPORTS],
    transport: 'stdio',
  });
}

/**
 * @param {Record<string, any>[]} servers
 * @returns {Record<string, any>[]}
 */
export function withBuiltinCretliServer(servers) {
  const normalized = normalizeMcpServers(servers);
  if (normalized.some((server) => server.kind === 'builtin-cretli')) return normalized;
  const builtin = createBuiltinCretliServer();
  return builtin ? [builtin, ...normalized] : normalized;
}

/**
 * @param {{
 *   workspaceId?: unknown,
 *   workspaceFile?: unknown,
 *   workspaceFolder?: unknown,
 *   harness?: unknown,
 * }} context
 * @param {Record<string, any>[]} servers
 * @returns {Record<string, any>[]}
 */
export function resolveMcpServersForContext(context, servers) {
  const harness = normalizeAgentTransport(context?.harness);
  const identity = collectWorkspaceIdentityKeys(context);
  return withBuiltinCretliServer(servers).filter((server) => {
    if (server.kind === 'builtin-cretli') {
      if (!server.enabled) return false;
      return mcpScopeMatchesWorkspace(server.scope, identity);
    }
    if (!server.enabled) return false;
    if (!server.harnesses.includes(harness)) return false;
    return mcpScopeMatchesWorkspace(server.scope, identity);
  });
}

export const MCP_HARNESS_IDS = VALID_TRANSPORTS;
