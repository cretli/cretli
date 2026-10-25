/**
 * Builtin Cretli MCP tools behind Settings → Usage: the overview numbers, plan
 * limits, telemetry/alert/budget settings and usage-limit auto-resume. They let
 * a chat read and fill in the same data the tab shows; billing rows (accounts,
 * readings, transactions, subscriptions) stay in the `billing_*` tools.
 *
 * None of them calls a model. The update/cancel tools are mutating and need
 * Agent mode; all of them are refused to delegation children.
 */

import { requireClientMethod } from './client-scope.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

/**
 * @param {Record<string, any>} client
 * @param {string} op
 * @param {Record<string, any>} [args]
 * @returns {Promise<Record<string, any>>}
 */
async function callUsageControl(client, op, args = {}) {
  requireClientMethod(client, 'usageControl');
  const result = await client.usageControl({ op, ...args });
  if (result?.ok === false) {
    const code = result.code === 'not_found' ? MCP_BUILTIN_ERROR_CODES.NOT_FOUND : MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR;
    throw new CretliMcpToolError(code, String(result.error || 'Invalid usage request'));
  }
  return result;
}

/**
 * @param {Record<string, any>} result
 * @returns {Record<string, any>}
 */
function jsonResult(result) {
  return mcpToolResult(JSON.stringify(result, null, 2), result);
}

/**
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
function summaryQuery(args) {
  /** @type {Record<string, any>} */
  const query = {};
  const map = {
    range: 'range',
    from: 'from',
    to: 'to',
    tz: 'tz',
    role: 'role',
    harness: 'harness',
    origin: 'origin',
    scope: 'scope',
    subject: 'subject',
    workspace_file: 'workspaceFile',
    chat_id: 'chatId',
  };
  for (const [from, to] of Object.entries(map)) {
    const value = args?.[from];
    if (value != null && String(value).trim()) query[to] = String(value).trim();
  }
  if (!query.range && !query.from && !query.to) query.range = '7d';
  return query;
}

const USAGE_SETTINGS_PATCH_DESCRIPTION = 'Partial usage settings, same keys as Settings → Usage → Settings: '
  + '{ retentionDays, alerts: { planLimit, lockout, budget (booleans), planLimitThresholdPercent, dailyBudgetUsd, monthlyBudgetUsd (null clears) }, '
  + 'resumeAdvice: { enabled, minContextTokens } }. Omitted keys keep their value; values are clamped by the server.';
const LIMIT_RESUME_PATCH_DESCRIPTION = 'Partial auto-resume-after-limit settings: '
  + '{ enabled, allowPremium, resumeDelegations, marginMs, jitterMs, maxChain, maxPerTick, catchUpMs }. '
  + 'Unknown keys are dropped; numbers are clamped.';

export const USAGE_CONTROL_MCP_TOOLS = Object.freeze([
  {
    name: 'usage_summary',
    readOnly: true,
    description: 'Usage totals for a window, the numbers on Settings → Usage → Overview: tokens by bucket, measured and estimated USD, runs, per-harness/model sums, zone-local days, today/7d/month KPIs and data coverage. Same filters as the tab. Read-only; no model call.',
    inputSchema: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'today | 24h | 7d (default) | 30d | month | month7d. Ignored when from/to is given.' },
        from: { type: 'string', description: 'ISO 8601 instant or YYYY-MM-DD (inclusive).' },
        to: { type: 'string', description: 'ISO 8601 instant (exclusive) or YYYY-MM-DD (inclusive day).' },
        tz: { type: 'string', description: 'IANA zone for day grouping (default UTC).' },
        role: { type: 'string', description: 'plan, implement, review, fix or chat.' },
        harness: { type: 'string' },
        origin: { type: 'string', enum: ['auto', 'manual', 'unknown'] },
        scope: { type: 'string', enum: ['own', 'consolidated'], description: 'own (default) = this instance; consolidated adds child/cycle usage.' },
        subject: { type: 'string', enum: ['chat', 'delegation', 'internal'] },
        workspace_file: { type: 'string', description: 'Only usage of this workspace (file or folder path).' },
        chat_id: { type: 'string', description: 'Only usage of this chat.' },
      },
    },
    async handler(args, { client }) {
      return jsonResult(await callUsageControl(client, 'summary', summaryQuery(args)));
    },
  },
  {
    name: 'usage_plan_limits',
    readOnly: true,
    description: 'Latest plan-limit readings per harness (window, utilization, reset time, forecast), active usage-limit lockouts and the Codex credit state, as shown on Settings → Usage → Limits. A live Codex read waits at most 3 s (then codex.reason = "pending"). Read-only; no model call.',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, { client }) {
      return jsonResult(await callUsageControl(client, 'plan_limits'));
    },
  },
  {
    name: 'usage_settings',
    readOnly: true,
    description: 'Read the Settings → Usage configuration: telemetry retention, plan/lockout/budget alerts, daily and monthly USD budgets, cheaper-resume advice, the auto-resume-after-limit settings, the usage data size on disk, and the pending auto-resume records (with ids for usage_resume_stop). Read-only.',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, { client }) {
      return jsonResult(await callUsageControl(client, 'settings_show'));
    },
  },
  {
    name: 'usage_settings_set',
    readOnly: false,
    description: 'Change Settings → Usage configuration from chat: retention, alerts, USD budgets, resume advice (`usage`) and/or auto-resume after a usage limit (`limit_resume`). Pass only the keys to change. Returns the stored result (same shape as usage_settings). Does not prune data and never calls a model.',
    inputSchema: {
      type: 'object',
      properties: {
        usage: { type: 'object', description: USAGE_SETTINGS_PATCH_DESCRIPTION },
        limit_resume: { type: 'object', description: LIMIT_RESUME_PATCH_DESCRIPTION },
      },
    },
    async handler(args, { client }) {
      return jsonResult(await callUsageControl(client, 'settings_update', {
        ...(args?.usage != null ? { usage: args.usage } : {}),
        ...(args?.limit_resume != null ? { limitResume: args.limit_resume } : {}),
      }));
    },
  },
  {
    name: 'usage_resume_stop',
    readOnly: false,
    description: 'Cancel one pending auto-resume after a usage-limit reset (id from usage_settings pendingResumes). The paused chat or delegation is not resumed automatically afterwards.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Auto-resume record id.' } },
      required: ['id'],
    },
    async handler(args, { client }) {
      return jsonResult(await callUsageControl(client, 'limit_resume_cancel', { id: args?.id }));
    },
  },
]);
