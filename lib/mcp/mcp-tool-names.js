/**
 * Stable OpenRouter / bridge tool names: mcp__<runtime>__<tool>
 */

import { toMcpRuntimeName } from './mcp-config.js';

const PREFIX = 'mcp__';

/**
 * @param {string} serverId
 * @param {string} toolName
 * @returns {string}
 */
export function encodeMcpToolName(serverId, toolName) {
  const runtime = toMcpRuntimeName(serverId);
  const tool = String(toolName || '').trim() || 'tool';
  return `${PREFIX}${runtime}__${tool}`;
}

/**
 * @param {unknown} encoded
 * @returns {{ runtimeName: string, toolName: string } | null}
 */
export function decodeMcpToolName(encoded) {
  const name = String(encoded || '').trim();
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  return {
    runtimeName: rest.slice(0, sep),
    toolName: rest.slice(sep + 2),
  };
}

/**
 * @param {object[]} servers
 * @param {string} runtimeName
 * @returns {object | null}
 */
export function findServerByRuntimeName(servers, runtimeName) {
  const wanted = String(runtimeName || '').trim();
  if (!wanted) return null;
  return servers.find((server) => toMcpRuntimeName(server.id) === wanted) || null;
}
