/**
 * Plan-mode and enablement policy for MCP tool calls.
 * Mode and permissions come from the session context, never from model args.
 */

import { listBuiltinMcpMutatingToolNames, listBuiltinMcpReadToolNames } from './builtin/catalog.js';
import { isAskSdkMode, isReadOnlySdkMode } from '../sdk/sdk-mode.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import {
  ASK_GUARD_USER_MESSAGE,
  PLAN_GUARD_USER_MESSAGE,
  REVIEW_GUARD_USER_MESSAGE,
} from '../sdk/sdk-plan-guard.js';

// Resolved on first use. catalog.js imports delegation tools, which import this
// module while BUILTIN_TOOLS is still in the temporal dead zone.
let builtinMcpReadTools;
let builtinMcpMutatingTools;

/**
 * @returns {readonly string[]}
 */
export function getBuiltinMcpReadTools() {
  if (!builtinMcpReadTools) builtinMcpReadTools = Object.freeze(listBuiltinMcpReadToolNames());
  return builtinMcpReadTools;
}

/**
 * @returns {readonly string[]}
 */
export function getBuiltinMcpMutatingTools() {
  if (!builtinMcpMutatingTools) {
    builtinMcpMutatingTools = Object.freeze(listBuiltinMcpMutatingToolNames());
  }
  return builtinMcpMutatingTools;
}

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
    return getBuiltinMcpReadTools().includes(name);
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
  if (!isReadOnlySdkMode(mode) && !isReviewReadOnlyAssignment(input?.assignment)) return false;
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
  if (!isReadOnlySdkMode(options.mode) && !isReviewReadOnlyAssignment(options.assignment)) return idle;
  if (!isMcpPlanCallDenied(options)) return idle;
  return {
    deny: true,
    reason: isReviewReadOnlyAssignment(options.assignment)
      ? REVIEW_GUARD_USER_MESSAGE
      : isAskSdkMode(options.mode)
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

/**
 * Cursor SDK (Grok) often calls MCP through a generic `mcp` wrapper.
 * Review must classify the inner tool, not the wrapper name.
 *
 * @param {unknown} toolName
 * @param {unknown} [args]
 * @returns {string}
 */
export function readEffectiveMcpToolName(toolName, args) {
  const name = String(toolName || '').trim();
  if (name.toLowerCase() !== 'mcp') return name;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return name;
  const record = /** @type {Record<string, unknown>} */ (args);
  const inner = record.toolName ?? record.name;
  const innerName = String(inner || '').trim();
  if (!innerName) return name;
  return innerName;
}

/**
 * Builtin Cretli read tools stay allowed in review/plan. Unknown MCP names
 * are mutating until an allowInPlan list says otherwise.
 *
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isReadOnlyBuiltinMcpToolName(toolName) {
  const name = String(toolName || '').trim();
  if (!name) return false;
  const base = basenameMcpTool(name);
  const readTools = getBuiltinMcpReadTools();
  if (readTools.includes(name) || readTools.includes(base)) return true;
  const dotted = name.split(/[./]/);
  const lastDotted = dotted[dotted.length - 1] || '';
  if (readTools.includes(lastDotted)) return true;
  const underscored = name.split('__');
  const lastUnderscored = underscored[underscored.length - 1] || '';
  return readTools.includes(lastUnderscored);
}

/**
 * Job protocol tools the review child must call without aborting the run.
 *
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isReviewProtocolMcpToolName(toolName) {
  const name = String(toolName || '').trim().toLowerCase();
  if (!name) return false;
  const base = basenameMcpTool(name).toLowerCase();
  if (base === 'delegation_reply') return true;
  const lastUnderscored = name.split('__').pop() || '';
  return lastUnderscored === 'delegation_reply';
}
