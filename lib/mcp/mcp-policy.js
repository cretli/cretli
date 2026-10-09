/**
 * Plan-mode and enablement policy for MCP tool calls.
 * Mode and permissions come from the session context, never from model args.
 */

import { listBuiltinMcpMutatingToolNames, listBuiltinMcpReadToolNames } from './builtin/catalog.js';
import {
  hasMcpServerIdentity,
  isCretliBuiltinServerIdentity,
  resolveCretliBuiltinToolName,
} from './mcp-tool-names.js';
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
 * Read-only job-protocol builtin tools that stay callable in Plan mode even
 * though they are not annotated read-only. Scout exposes `list` (read) and
 * `submit` (the scan's own channel); the handler in `builtin/catalog.js` still
 * denies `accept`/`reject` in Plan.
 */
export const BUILTIN_PLAN_PROTOCOL_TOOLS = new Set(['scout_findings']);

/**
 * @param {object} server
 * @param {string} toolName
 * @returns {boolean}
 */
export function isMcpToolAllowedInPlan(server, toolName) {
  const name = String(toolName || '').trim();
  if (!name || !server) return false;
  if (isCretliBuiltinServerIdentity(server)) {
    // Identity decides ownership here; the name only selects the catalog entry.
    const base = resolveCretliBuiltinToolName(name, server);
    return getBuiltinMcpReadTools().includes(base) || BUILTIN_PLAN_PROTOCOL_TOOLS.has(base);
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
  if (isCretliBuiltinServerIdentity(input?.server)) return true;
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
 * A legacy alias must classify exactly like its canonical name: the dispatch in
 * `builtin/catalog.js` accepts both, so a gate that only knows the canonical
 * list would reject a read alias before its handler ever runs. Resolution is
 * limited to names the builtin catalog owns, otherwise a foreign server that
 * reuses a builtin basename (`mcp__github__todo_list`) would pass for read.
 *
 * `identity` is the real server from the call context. When it is present it is
 * authoritative: a foreign server's read basename is never a builtin read even
 * if the encoded name carries a `cretli` token (an external server id slugs to
 * `cretli_<slug>`), and a builtin server keeps owning its harness-mangled names.
 *
 * @param {unknown} toolName
 * @param {import('./mcp-tool-names.js').McpServerIdentity} [identity]
 * @returns {boolean}
 */
export function isReadOnlyBuiltinMcpToolName(toolName, identity) {
  const name = String(toolName || '').trim();
  if (!name) return false;
  if (hasMcpServerIdentity(identity) && !isCretliBuiltinServerIdentity(identity)) return false;
  const readTools = getBuiltinMcpReadTools();
  if (readTools.includes(name)) return true;
  // Resolves `mcp__<cretli runtime>__<tool>` shapes to the basename and maps a
  // legacy id to the name currently listed in CRETILI_MCP_TOOL_DEFS.
  const builtin = resolveCretliBuiltinToolName(name, identity);
  return builtin !== null && readTools.includes(builtin);
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
