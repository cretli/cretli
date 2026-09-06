/**
 * In-memory MCP config/connection status. Restarts at unknown until confirmed.
 * Diagnostic tests do not mark a chat as connected.
 */

/** @typedef {'applied' | 'pending' | 'unsupported' | 'error' | 'stale'} McpConfigState */
/** @typedef {'unknown' | 'connecting' | 'connected' | 'disconnected' | 'error' | 'tested'} McpConnectionState */

/**
 * @typedef {{
 *   serverId: string,
 *   harness: string,
 *   sessionId: string,
 *   workspaceKey: string,
 *   configState: McpConfigState,
 *   connectionState: McpConnectionState,
 *   desiredRevision: number,
 *   appliedRevision: number,
 *   checkedAt: string,
 *   error: string,
 *   tools: object[],
 *   toolsFetchedAt: string,
 *   source: 'session' | 'diagnostic',
 * }} McpStatusEntry
 */

/** @type {Map<string, McpStatusEntry>} */
const statuses = new Map();

/** @type {Map<string, { tools: object[], fetchedAt: string, catalogKey: string }>} */
const toolCatalogs = new Map();

/**
 * @param {{ serverId?: unknown, harness?: unknown, sessionId?: unknown, workspaceKey?: unknown, source?: unknown }} parts
 * @returns {string}
 */
export function mcpStatusKey(parts) {
  return [
    String(parts.serverId || ''),
    String(parts.harness || ''),
    String(parts.sessionId || ''),
    String(parts.workspaceKey || ''),
    String(parts.source || 'session'),
  ].join('\0');
}

/**
 * @param {Partial<McpStatusEntry> & { serverId: string }} entry
 * @returns {McpStatusEntry}
 */
export function upsertMcpStatus(entry) {
  const source = entry.source === 'diagnostic' ? 'diagnostic' : 'session';
  const key = mcpStatusKey({ ...entry, source });
  const previous = statuses.get(key);
  /** @type {McpStatusEntry} */
  const next = {
    serverId: entry.serverId,
    harness: String(entry.harness || previous?.harness || ''),
    sessionId: String(entry.sessionId || previous?.sessionId || ''),
    workspaceKey: String(entry.workspaceKey || previous?.workspaceKey || ''),
    configState: entry.configState || previous?.configState || 'pending',
    connectionState: entry.connectionState || previous?.connectionState || 'unknown',
    desiredRevision: Number.isFinite(entry.desiredRevision)
      ? Number(entry.desiredRevision)
      : (previous?.desiredRevision || 0),
    appliedRevision: Number.isFinite(entry.appliedRevision)
      ? Number(entry.appliedRevision)
      : (previous?.appliedRevision || 0),
    checkedAt: entry.checkedAt || new Date().toISOString(),
    error: typeof entry.error === 'string' ? sanitizeMcpError(entry.error) : (previous?.error || ''),
    tools: Array.isArray(entry.tools) ? entry.tools : (previous?.tools || []),
    toolsFetchedAt: entry.toolsFetchedAt || previous?.toolsFetchedAt || '',
    source,
  };
  statuses.set(key, next);
  return next;
}

/**
 * @param {string} serverId
 * @param {object[]} tools
 * @param {{ catalogKey?: string, diagnostic?: boolean }} [options]
 */
export function rememberMcpToolCatalog(serverId, tools, options = {}) {
  const id = String(serverId || '').trim();
  if (!id) return;
  const catalog = Array.isArray(tools) ? tools : [];
  const catalogKey = String(options.catalogKey || id);
  toolCatalogs.set(catalogKey, { tools: catalog, fetchedAt: new Date().toISOString(), catalogKey });
  if (!options.diagnostic) {
    toolCatalogs.set(id, { tools: catalog, fetchedAt: new Date().toISOString(), catalogKey });
  }
}

/**
 * @param {string} serverId
 * @returns {{ tools: object[], fetchedAt: string }}
 */
export function getMcpToolCatalog(serverId) {
  return toolCatalogs.get(String(serverId || '').trim()) || { tools: [], fetchedAt: '' };
}

/**
 * @param {string} catalogKey
 */
export function getMcpToolCatalogByKey(catalogKey) {
  return toolCatalogs.get(String(catalogKey || '').trim()) || { tools: [], fetchedAt: '' };
}

/**
 * @param {{ harness?: unknown, sessionId?: unknown, workspaceKey?: unknown, serverId?: unknown }} filter
 * @returns {McpStatusEntry[]}
 */
export function listMcpStatuses(filter = {}) {
  const harness = String(filter.harness || '').trim();
  const sessionId = String(filter.sessionId || '').trim();
  const workspaceKey = String(filter.workspaceKey || '').trim();
  const serverId = String(filter.serverId || '').trim();
  return [...statuses.values()].filter((entry) => {
    if (serverId && entry.serverId !== serverId) return false;
    if (harness && entry.harness !== harness) return false;
    if (sessionId && entry.sessionId !== sessionId) return false;
    if (workspaceKey && entry.workspaceKey !== workspaceKey) return false;
    return true;
  });
}

/**
 * @param {{ serverId?: string, sessionId?: string }} filter
 */
export function clearMcpStatuses(filter = {}) {
  const serverId = String(filter.serverId || '').trim();
  const sessionId = String(filter.sessionId || '').trim();
  for (const [key, entry] of [...statuses.entries()]) {
    if (serverId && entry.serverId !== serverId) continue;
    if (sessionId && entry.sessionId !== sessionId) continue;
    if (!serverId && !sessionId) {
      statuses.delete(key);
      continue;
    }
    statuses.delete(key);
  }
}

/**
 * @param {string} serverId
 */
export function markMcpServerStatusesStale(serverId) {
  const id = String(serverId || '').trim();
  if (!id) return;
  for (const entry of statuses.values()) {
    if (entry.serverId !== id) continue;
    if (entry.source === 'diagnostic') continue;
    entry.configState = 'stale';
    entry.connectionState = 'disconnected';
  }
}

/**
 * @param {unknown} message
 * @returns {string}
 */
export function sanitizeMcpError(message) {
  return String(message || '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/password[=:]\s*\S+/gi, 'password=***')
    .replace(/CRETLI_MCP_TOKEN[=:]\s*\S+/gi, 'CRETLI_MCP_TOKEN=***')
    .replace(/MCP_TOKEN[=:]\s*\S+/gi, 'MCP_TOKEN=***')
    .slice(0, 500);
}

export function resetMcpStatusForTests() {
  statuses.clear();
  toolCatalogs.clear();
}
