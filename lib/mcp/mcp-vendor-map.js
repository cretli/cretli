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
  /** @type {Record<string, object>} */
  const out = {};
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    if (spec.type === 'http' || spec.url) {
      out[name] = { type: 'http', url: spec.url, headers: spec.headers || {} };
      continue;
    }
    if (!spec.command) continue;
    // The CLI rejects an entry without an explicit `type` ("no valid transport
    // type") and then starts with no MCP servers at all.
    out[name] = {
      type: 'stdio',
      command: spec.command,
      args: spec.args || [],
      env: spec.env || {},
    };
  }
  return out;
}

/**
 * Claude Agent SDK `McpServerConfig`. The Cretli bridge is `alwaysLoad` so
 * protocol tools such as `delegation_reply` are in the first prompt. Deferred
 * tool search does not see them until a server is connected, and a search for
 * the short name then returns no match.
 *
 * @param {Record<string, object>} mcpServers
 * @returns {Record<string, object>}
 */
export function toClaudeMcpServers(mcpServers) {
  /** @type {Record<string, object>} */
  const out = {};
  for (const [name, spec] of Object.entries(mcpServers || {})) {
    const alwaysLoad = name === 'cretli_bridge';
    if (spec.type === 'http' || spec.url) {
      out[name] = {
        type: 'http',
        url: spec.url,
        headers: spec.headers || {},
        ...(alwaysLoad ? { alwaysLoad: true } : {}),
      };
      continue;
    }
    if (!spec.command) continue;
    out[name] = {
      type: 'stdio',
      command: spec.command,
      args: spec.args || [],
      env: spec.env || {},
      ...(alwaysLoad ? { alwaysLoad: true } : {}),
    };
  }
  return out;
}
