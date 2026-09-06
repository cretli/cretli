/**
 * Map Cretli MCP server maps onto vendor SDK shapes.
 */

/**
 * @param {Record<string, object>} mcpServers
 * @returns {Record<string, object>}
 */
export function toCursorMcpServers(mcpServers) {
  /** @type {Record<string, object>} */
  const out = {};
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    if (spec.type === 'http' || spec.url) {
      out[name] = { type: 'http', url: spec.url, headers: spec.headers || {} };
      continue;
    }
    out[name] = {
      command: spec.command,
      args: spec.args || [],
      env: spec.env || {},
      cwd: spec.cwd,
    };
  }
  return out;
}

/**
 * @param {Record<string, object>} mcpServers
 * @returns {Record<string, object>}
 */
export function toCodexMcpServers(mcpServers) {
  /** @type {Record<string, object>} */
  const out = {};
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    if (spec.type === 'http' || spec.url) {
      out[name] = { url: spec.url, http_headers: spec.headers || {} };
      continue;
    }
    out[name] = {
      command: spec.command,
      args: spec.args || [],
      env: spec.env || {},
    };
  }
  return out;
}

/**
 * @param {Record<string, object>} mcpServers
 * @returns {Record<string, object>}
 */
export function toQwenMcpServers(mcpServers) {
  /** @type {Record<string, object>} */
  const out = {};
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    if (spec.type === 'http' || spec.url) {
      out[name] = { httpUrl: spec.url, headers: spec.headers || {} };
      continue;
    }
    out[name] = {
      command: spec.command,
      args: spec.args || [],
      env: spec.env || {},
      cwd: spec.cwd,
    };
  }
  return out;
}

/**
 * @param {Record<string, object>} mcpServers
 * @returns {Record<string, object>}
 */
export function toCodeBuddyMcpServers(mcpServers) {
  return toQwenMcpServers(mcpServers);
}
