/**
 * Audited, fail-closed wrapper around the operator native tool policy. Every
 * native decision of an isolated chat (operator run or unknown identity) writes
 * one `operator_audit` row; a failed audit write denies the call, a Read
 * included. Allowed builtin MCP calls are NOT audited here: the catalog gate
 * decides them again and writes their row, so each call leaves exactly one.
 */

import './operator-run-chat.js'; // side effect: registers the sync chat-row reader for the identity index
import { appendOperatorAudit } from './operator-audit.js';
import { resolveOperatorNativeToolDecision } from './operator-native-tool-policy.js';
import { getRegisteredOperatorRunId, getOperatorRunIdentity } from './operator-run-chat-registry.js';
import { OPERATOR_DENIED_MESSAGE } from './operator-tool-policy.js';

/**
 * @param {{ chatId?: unknown, toolName?: unknown, args?: unknown, workspaceRoot?: unknown, server?: unknown,
 *   auditOptions?: Record<string, any>, audit?: boolean }} input
 * @returns {{ deny: boolean, reason: string }}
 */
export function gateOperatorNativeToolCall(input = {}) {
  const unknown = getOperatorRunIdentity(input.chatId) === 'unknown';
  const decision = unknown
    ? { deny: true, reason: `${OPERATOR_DENIED_MESSAGE} (identity unknown)` }
    : resolveOperatorNativeToolDecision(input);
  if (!decision.deny && /** @type {any} */ (decision).catalog === true) return { deny: false, reason: '' };
  // `audit: false` re-evaluates a call whose row an earlier hook already wrote (claude PreToolUse then canUseTool).
  if (input.audit === false) return { deny: decision.deny, reason: decision.reason };
  const args = input.args && typeof input.args === 'object' ? /** @type {Record<string, any>} */ (input.args) : {};
  try {
    appendOperatorAudit({
      runId: getRegisteredOperatorRunId(input.chatId),
      tool: String(input.toolName || '').slice(0, 200),
      action: String(args.action || ''),
      outcome: decision.deny ? 'denied' : 'allowed',
      reason: `native:${decision.deny ? 'deny' : 'allow'}`,
      args,
    }, input.auditOptions || {});
  } catch {
    return { deny: true, reason: 'Operator audit is unavailable; the call was refused.' };
  }
  return { deny: decision.deny, reason: decision.reason };
}

/**
 * Audit row for a rejected external MCP server (listing or call); the call is
 * refused either way, so a failed write only goes unrecorded.
 *
 * @param {{ chatId?: unknown, serverId?: unknown, toolName?: unknown, auditOptions?: Record<string, any> }} input
 */
export function auditOperatorExternalMcpReject(input = {}) {
  try {
    appendOperatorAudit({
      runId: getRegisteredOperatorRunId(input.chatId),
      tool: String(input.toolName || 'tools/list').slice(0, 200),
      action: '',
      outcome: 'denied',
      reason: 'external_mcp_server',
      args: { server: String(input.serverId || '') },
    }, input.auditOptions || {});
  } catch {
    // The request is refused regardless.
  }
}
