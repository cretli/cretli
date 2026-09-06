/**
 * Plan-mode and enablement policy for MCP tool calls.
 * Mode and permissions come from the session context, never from model args.
 */

import { listBuiltinMcpMutatingToolNames, listBuiltinMcpReadToolNames } from './builtin/catalog.js';
import { isAskSdkMode, isReadOnlySdkMode } from '../sdk/sdk-mode.js';
import { ASK_GUARD_USER_MESSAGE, PLAN_GUARD_USER_MESSAGE } from '../sdk/sdk-plan-guard.js';

export const BUILTIN_MCP_READ_TOOLS = Object.freeze(listBuiltinMcpReadToolNames());
export const BUILTIN_MCP_MUTATING_TOOLS = Object.freeze(listBuiltinMcpMutatingToolNames());

/**
 * @param {string} toolName
 * @returns {string}
 */
export function basenameMcpTool(toolName) {
  const name = String(toolName || '').trim();
  const slash = name.lastIndexOf('/');
  const dotted = name.lastIndexOf('.');
  const sep = Math.max(slash, dotted);
  if (sep < 0) return name;
  return name.slice(sep + 1);
}

/**
 * @param {object} server
 * @param {string} toolName
 * @returns {boolean}
 */
export function isMcpToolAllowedInPlan(server, toolName) {
  const name = String(toolName || '').trim();
  if (!name || !server) return false;
  if (server.kind === 'builtin-cretli') {
    return BUILTIN_MCP_READ_TOOLS.includes(name);
  }
  const allow = Array.isArray(server.toolPolicy?.allowInPlan) ? server.toolPolicy.allowInPlan : [];
  return allow.includes(name);
}

/**
 * Unknown external MCP tools stay blocked in Plan unless allowInPlan lists them.
 *
 * @param {{ server?: object, toolName?: unknown, mode?: unknown }} input
 * @returns {boolean}
 */
export function isMcpPlanCallDenied(input) {
  const mode = String(input?.mode || '').trim().toLowerCase();
  if (!isReadOnlySdkMode(mode)) return false;
  const toolName = String(input?.toolName || '').trim();
  if (!toolName) return true;
  if (isMcpToolAllowedInPlan(input?.server, toolName)) return false;
  if (input?.server?.kind === 'builtin-cretli') return true;
  return true;
}

/**
 * Host-side Plan decision for a named MCP tool (before the handler runs).
 *
 * @param {{ transport?: unknown, mode?: unknown, toolName?: unknown, server?: object }} options
 * @returns {{ deny: boolean, reason: string }}
 */
export function resolveMcpPlanToolDecision(options = {}) {
  const idle = { deny: false, reason: '' };
  if (!isReadOnlySdkMode(options.mode)) return idle;
  if (!isMcpPlanCallDenied(options)) return idle;
  return {
    deny: true,
    reason: isAskSdkMode(options.mode)
      ? ASK_GUARD_USER_MESSAGE
      : PLAN_GUARD_USER_MESSAGE,
  };
}

/**
 * Cursor/OpenRouter still use the shared mutating-name helper for non-MCP tools.
 * MCP names must not inherit a read-only basename such as web_search.
 *
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isExternalMcpToolName(toolName) {
  const name = String(toolName || '').trim().toLowerCase();
  if (!name) return false;
  if (name === 'mcp') return true;
  if (name.startsWith('mcp.') || name.startsWith('mcp__') || name.startsWith('mcp/')) return true;
  return name.startsWith('cretli_');
}
