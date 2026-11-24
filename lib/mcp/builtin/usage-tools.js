/**
 * Builtin Cretli MCP usage tools: read-only views over the usage ledger that
 * answer "what burned the tokens and limits". They never call a model.
 *
 * Rankings default to `fresh` tokens (input without cache + cache write +
 * output), because cache reads are ~95-99% of the raw total and hide real cost.
 */

import { loadUsageAdvice, loadUsageCoverage, loadUsageExplain, loadUsageLimitBurn, loadUsageTop } from '../../usage/usage-top-read.ts';
import {
  USAGE_EXPLAIN_SUBJECTS,
  USAGE_TOP_GROUPS,
  USAGE_TOP_METRICS,
} from '../../usage/usage-top.ts';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

const WINDOW_PROPERTIES = {
  range: { type: 'string', description: 'Named window: today | 24h | 7d (default) | 30d | month. Ignored when from/to is given.' },
  from: { type: 'string', description: 'ISO 8601 instant or YYYY-MM-DD (inclusive).' },
  to: { type: 'string', description: 'ISO 8601 instant (exclusive) or YYYY-MM-DD (inclusive day).' },
  harness: { type: 'string', description: 'Only this harness (sdk, claude, codex, deepseek, ...).' },
  role: { type: 'string', description: 'Only this role (chat, plan, implement, review, fix, orchestrator; matches the stored role).' },
  limit: { type: 'number', description: 'Max rows (default 20, max 200).' },
};

/**
 * @param {Record<string, any>} args
 * @returns {Record<string, any>}
 */
function windowQuery(args) {
  return {
    range: args?.range,
    from: args?.from,
    to: args?.to,
    harness: args?.harness,
    role: args?.role,
    limit: args?.limit,
  };
}

/**
 * @param {Record<string, any>} result
 * @returns {Record<string, any>}
 */
function unwrap(result) {
  if (result?.ok === false) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, String(result.error || 'Invalid usage query'));
  }
  return result;
}

export const USAGE_MCP_TOOLS = Object.freeze([
  {
    name: 'usage_top',
    readOnly: true,
    description: 'Rank token consumers from the usage ledger along one axis (chat, delegation, leaf, model, harness, role, cycle, day). Each row has fresh tokens (input without cache + cache write + output), cache-read volume, cache share, output, USD, limit hits, attempts and fresh-per-attempt. Use it to find what burned tokens and where limits are hit. Read-only; no model call.',
    inputSchema: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: [...USAGE_TOP_GROUPS], description: 'Axis to group by (default chat); outcome = lifecycle outcome of the delegation attempt (recovered, completed, cancelled, restart, requeued, abandoned).' },
        metric: { type: 'string', enum: [...USAGE_TOP_METRICS], description: 'Sort metric (default fresh).' },
        ...WINDOW_PROPERTIES,
      },
    },
    async handler(args) {
      const result = unwrap(await loadUsageTop({ ...windowQuery(args), groupBy: args?.group_by, metric: args?.metric }));
      return mcpToolResult(JSON.stringify(result, null, 2), result);
    },
  },
  {
    name: 'usage_explain',
    readOnly: true,
    description: 'Drill into one chat, delegation, todo leaf or watcher cycle: totals plus breakdown by role, model and day, the most expensive runs and the single most expensive measurements. Use after usage_top to see which run or turn caused a spike. Read-only; no model call.',
    inputSchema: {
      type: 'object',
      properties: {
        subject_type: { type: 'string', enum: [...USAGE_EXPLAIN_SUBJECTS], description: 'What the id refers to (default chat).' },
        subject_id: { type: 'string', description: 'Chat id, delegation id, leaf (todo) id or cycle id.' },
        ...WINDOW_PROPERTIES,
      },
      required: ['subject_id'],
    },
    async handler(args) {
      if (!String(args?.subject_id ?? '').trim()) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'subject_id is required');
      }
      const result = unwrap(await loadUsageExplain({ range: '30d', ...windowQuery(args), subjectType: args?.subject_type, subjectId: args?.subject_id }));
      return mcpToolResult(JSON.stringify(result, null, 2), result);
    },
  },
  {
    name: 'usage_limit_burn',
    readOnly: true,
    description: 'For each usage-limit hit in the window (retry bursts collapsed), list which chats consumed the same harness fresh tokens in the look-back before it, plus the chats blamed most often overall. Use it to learn where plan limits are burned. Read-only; no model call.',
    inputSchema: {
      type: 'object',
      properties: {
        lookback_hours: { type: 'number', description: 'Look-back before each hit in hours (default 5, max 72).' },
        ...WINDOW_PROPERTIES,
      },
    },
    async handler(args) {
      const result = unwrap(await loadUsageLimitBurn({ range: '30d', ...windowQuery(args), lookbackHours: args?.lookback_hours }));
      return mcpToolResult(JSON.stringify(result, null, 2), result);
    },
  },
  {
    name: 'usage_coverage',
    readOnly: true,
    description: 'Usage capture coverage per harness x role (plan, implement, review, fix, orchestrator): terminal attempts, attempts with a run event, no-output and pending (24 h grace) attempts, eligible, measured, coverage ratio, missing reasons and a quality flag (ok, low_coverage, insufficient_sample, no_traffic, unsupported), byOutcome (lifecycle outcome counts per attempt) and a hostVerify block (host review-verify wall/step/queue time; no tokens). Target 0.8 with at least 20 eligible attempts. Read-only.',
    inputSchema: { type: 'object', properties: { range: WINDOW_PROPERTIES.range, from: WINDOW_PROPERTIES.from, to: WINDOW_PROPERTIES.to, harness: WINDOW_PROPERTIES.harness } },
    async handler(args) {
      const result = unwrap(await loadUsageCoverage({ range: '30d', ...windowQuery(args) }));
      return mcpToolResult(JSON.stringify(result, null, 2), result);
    },
  },
  {
    name: 'usage_advice',
    readOnly: true,
    description: 'Rule-based optimization findings from the usage ledger: models that never hit a cache, harnesses where resumed sessions cost more than new ones, leaves that cost a lot per attempt, chats with oversized context, and chats repeatedly present before limit hits. Each finding has evidence numbers and a suggestion. Read-only; no model call.',
    inputSchema: { type: 'object', properties: { range: WINDOW_PROPERTIES.range, from: WINDOW_PROPERTIES.from, to: WINDOW_PROPERTIES.to, harness: WINDOW_PROPERTIES.harness } },
    async handler(args) {
      const result = unwrap(await loadUsageAdvice({ range: '7d', ...windowQuery(args) }));
      return mcpToolResult(JSON.stringify(result, null, 2), result);
    },
  },
]);
