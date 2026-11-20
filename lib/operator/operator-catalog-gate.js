/**
 * Catalog gate for operator run chats (stage 2b). Runs as the FIRST branch of
 * the builtin tool gate, before the Plan-mode open tools, the read-only
 * shortcut and the Scout branch, and writes exactly one `operator_audit` row
 * per decision. An audit write that throws denies the call (fail-closed). A
 * chat whose identity cannot be confirmed (`unknown`) is denied outright.
 */

import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from '../mcp/builtin/errors.js';
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
