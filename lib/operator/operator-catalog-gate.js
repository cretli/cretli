/**
 * Catalog gate for operator run chats (stage 2b). Runs as the FIRST branch of
 * the builtin tool gate, before the Plan-mode open tools, the read-only
 * shortcut and the Scout branch, and writes exactly one `operator_audit` row
 * per decision. An audit write that throws denies the call (fail-closed). A
 * chat whose identity cannot be confirmed (`unknown`) is denied outright.
 */

import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from '../mcp/builtin/errors.js';
import { wrapUntrusted, OPERATOR_UNTRUSTED_TOOL_NAMES, OPERATOR_TOOL_RESULT_MAX_CHARS } from './operator-briefing.js';
import { OPERATOR_DENIED_MESSAGE, resolveOperatorBuiltinToolDecision } from './operator-tool-policy.js';

const denied = (message, reason) => new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.PLAN_MODE_DENIED, message, { reason });

/**
 * @param {{ name?: string }} tool
 * @param {unknown} args
 * @param {Record<string, any> | null | undefined} client in-process client (host identity + audit writer)
 * @returns {Promise<CretliMcpToolError | null | undefined>} `undefined` = confirmed normal chat (caller continues
 *   with the regular gate); `null` = allowed; an error = denied
 */
export async function resolveOperatorRunGate(tool, args, client) {
  if (!client) return undefined;
  /** @type {'operator' | 'normal' | 'unknown'} */
  let identity;
  try {
    if (typeof client.getOperatorIdentity === 'function') identity = await client.getOperatorIdentity();
    else if (typeof client.isOperatorRunChat === 'function') identity = (await client.isOperatorRunChat()) === true ? 'operator' : 'normal';
    else return undefined;
  } catch {
    identity = 'unknown';
  }
  if (identity === 'normal') return undefined;
  const decision = identity === 'operator'
    ? resolveOperatorBuiltinToolDecision(tool?.name, args)
    : { ...resolveOperatorBuiltinToolDecision(tool?.name, args), allow: false, reason: 'identity_unknown' };
  try {
    if (typeof client.recordOperatorAudit !== 'function') throw new Error('operator audit writer missing');
    await client.recordOperatorAudit({
      tool: decision.tool,
      action: decision.action,
      outcome: decision.allow ? 'allowed' : 'denied',
      reason: decision.reason,
      args,
    });
  } catch {
    return denied('Operator audit is unavailable; the call was refused.', 'operator_audit_failed');
  }
  return decision.allow ? null : denied(OPERATOR_DENIED_MESSAGE, `operator_${decision.reason}`);
}

/**
 * Result path of an allowed builtin call. For an operator run chat the results
 * of tools that carry text written by other agents or users (chat history and
 * search, todos, notes, lessons, findings) are wrapped in the untrusted
 * envelope: escaped, control characters removed, capped. Any other caller, or
 * a tool outside the list, gets the result unchanged. The structured copy of a
 * wrapped result is dropped so the raw text cannot be read around the envelope.
 *
 * @param {{ name?: string }} tool
 * @param {any} result MCP tool result (`{ content: [{ type: 'text', text }], structuredContent? }`)
 * @param {Record<string, any> | null | undefined} client
 * @returns {Promise<any>}
 */
export async function wrapOperatorBuiltinResult(tool, result, client) {
  if (!client || !OPERATOR_UNTRUSTED_TOOL_NAMES.includes(String(tool?.name || '')) || !result || result.isError) return result;
  let operator = false;
  try {
    operator = typeof client.getOperatorIdentity === 'function'
      ? (await client.getOperatorIdentity()) === 'operator'
      : (await client.isOperatorRunChat?.()) === true;
  } catch { operator = false; }
  if (!operator) return result;
  const content = (Array.isArray(result.content) ? result.content : []).map((part) => (part && part.type === 'text'
    ? { ...part, text: wrapUntrusted({ source: `tool:${tool.name}`, text: part.text, maxChars: OPERATOR_TOOL_RESULT_MAX_CHARS }) }
    : { type: 'text', text: wrapUntrusted({ source: `tool:${tool.name}`, text: `[${part?.type || 'non-text'} content omitted]`, maxChars: 100 }) }));
  const { structuredContent, ...rest } = result;
  void structuredContent;
  return { ...rest, content };
}
