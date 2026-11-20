/**
 * Builtin Cretli MCP tools for the optional, paid cache keep-alive.
 *
 * Off by default: no plan exists until `keepalive_config` creates one.
 * A ping is a real provider request into the resumed reviewer session, so every
 * tool that can cause one is a mutating tool (blocked in Plan/Ask mode) and the
 * result always carries the stop reason and the remaining budget. The tools
 * never create a report, verdict or TODO change.
 */

import { requireClientMethod } from './client-scope.js';
import { resolveCretliToolContext } from './tool-context.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

const DELEGATION_PROP = {
  delegation_id: {
    type: 'string',
    description: 'Finished (completed) review delegation whose reviewer session is kept warm. Must be a job of the calling chat.',
  },
};

/**
 * @param {Record<string, any>} args
 * @param {Record<string, any>} session
 * @returns {{ controllerChatId: string, delegationId: string }}
 */
function readTarget(args, session) {
  const controllerChatId = String(resolveCretliToolContext(session)?.chatId || session?.chatId || '').trim();
  if (!controllerChatId) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'A calling chat is required');
  }
  return { controllerChatId, delegationId: String(args?.delegation_id ?? '').trim() };
}

/**
 * @param {Record<string, any>} result
 * @param {string} label
 * @returns {Record<string, any>}
 */
function render(result, label) {
  // A stop or deferral that carries the plan is information (stop reason and
  // remaining budget), not a tool failure; refusals without a plan are errors.
  if (result?.ok === false && !result.plan) {
    const reason = String(result.reason || result.code || 'failed');
    const code = result.code === 'not_found'
      ? MCP_BUILTIN_ERROR_CODES.NOT_FOUND
      : MCP_BUILTIN_ERROR_CODES.CONFLICT;
    throw new CretliMcpToolError(code, `${label}: ${result.code || 'failed'} (${reason})`);
  }
  return mcpToolResult(JSON.stringify(result, null, 2), result);
}

export const KEEP_ALIVE_MCP_TOOLS = Object.freeze([
  {
    name: 'keepalive_status',
    readOnly: true,
    description: 'Read the paid cache keep-alive state: default mode (off), benchmark gate, and per plan the mode, stop reason, pings done, remaining ping count and budget (unknown when any ping cost is unmeasured), next attempt, last deferral and the per-ping audit. Local read only: it issues no model request.',
    inputSchema: { type: 'object', properties: { ...DELEGATION_PROP } },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'keepAlive');
      const target = readTarget(args, session);
      const result = await client.keepAlive({ action: 'status', ...target });
      return render(result, 'keepalive_status');
    },
  },
  {
    name: 'keepalive_config',
    readOnly: false,
    description: 'Create (or turn off) a bounded keep-alive plan for a finished review delegation. mode off|manual|auto; default off. Pings are PAID provider requests in the same resumed session (a warm ping still reads the whole cached prefix). Caps: max_pings, min_interval_ms, max_duration_ms, budget_usd. mode=auto additionally needs resume support, a known TTL policy, a priced model, expect_next_round_until and a passing benchmark gate; otherwise it is refused with the reason. Configuring never sends a ping.',
    inputSchema: {
      type: 'object',
      properties: {
        ...DELEGATION_PROP,
        mode: { type: 'string', description: 'off (default), manual or auto.' },
        max_pings: { type: 'number' },
        min_interval_ms: { type: 'number' },
        max_duration_ms: { type: 'number' },
        budget_usd: { type: 'number', description: 'Hard USD cap; defaults to and is capped at 5 USD.' },
        expect_next_round_until: { type: 'string', description: 'ISO time of the latest expected next round; required for auto.' },
        idempotency_key: { type: 'string' },
      },
      required: ['delegation_id'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'keepAlive');
      const target = readTarget(args, session);
      if (!target.delegationId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const result = await client.keepAlive({
        action: 'configure',
        ...target,
        mode: String(args?.mode ?? 'off'),
        idempotencyKey: String(args?.idempotency_key ?? ''),
        limits: {
          maxPings: args?.max_pings,
          minIntervalMs: args?.min_interval_ms,
          maxDurationMs: args?.max_duration_ms,
          budgetUsd: args?.budget_usd,
          expectNextRoundUntil: args?.expect_next_round_until,
        },
      });
      return render(result, 'keepalive_config');
    },
  },
  {
    name: 'keepalive_ping',
    readOnly: false,
    description: 'Send ONE paid keep-alive request now into the resumed reviewer session of an active plan. Honours every stop and deferral (busy session, a recent user command, minimum interval, budget, ping limit, deadline, provider limit, reset). The result is `requested` only when the session accepted a real request; mailbox delivery is never success. Effectiveness and cost are settled later from provider usage (see keepalive_status). The reply is not a review report or verdict.',
    inputSchema: {
      type: 'object',
      properties: { ...DELEGATION_PROP, idempotency_key: { type: 'string', description: 'Replaying the same key never pays twice.' } },
      required: ['delegation_id'],
    },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'keepAlive');
      const target = readTarget(args, session);
      if (!target.delegationId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const result = await client.keepAlive({
        action: 'ping',
        ...target,
        idempotencyKey: String(args?.idempotency_key ?? ''),
      });
      return render(result, 'keepalive_ping');
    },
  },
  {
    name: 'keepalive_stop',
    readOnly: false,
    description: 'Stop a keep-alive plan (reason user_stopped). A stopped plan never pings again; the audit and spent budget stay readable via keepalive_status.',
    inputSchema: { type: 'object', properties: { ...DELEGATION_PROP }, required: ['delegation_id'] },
    async handler(args, { client, session }) {
      requireClientMethod(client, 'keepAlive');
      const target = readTarget(args, session);
      if (!target.delegationId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required');
      }
      const result = await client.keepAlive({ action: 'stop', ...target });
      return render(result, 'keepalive_stop');
    },
  },
]);
