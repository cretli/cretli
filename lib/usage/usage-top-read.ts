/**
 * I/O wrapper for the top-consumers read model, shared by the HTTP route and
 * the MCP tools so both return identical numbers.
 */

import { readUsageEvents } from '../persist/usage-persist.js';
import { loadDelegations } from '../persist/delegations-persist.js';
import { peekChatsAsync } from '../persist/chats-persist.js';
import { filterUsageEvents } from './usage-insights.ts';
import { describeUsageWindow, filterEventsByWindow, resolveUsageWindow } from './usage-window.ts';
import { buildUsageTop, explainUsage } from './usage-top.ts';
import { attributeLimitBurn } from './usage-limit-burn.ts';
import { buildUsageAdvice } from './usage-advice.ts';

/**
 * @param {Record<string, any>} query
 * @param {{ dataDir?: string, now?: number, loadDelegationRows?: Function, loadChatRows?: Function }} [ctx]
 * @returns {{ ok: false, error: string } | { ok: true, window: Record<string, any>, events: Record<string, any>[], delegations: Record<string, any>[], tz: string }}
 */
function readWindowEvents(query, ctx) {
  const window = resolveUsageWindow({ range: '7d', ...query, now: ctx.now });
  if (!window.ok) return { ok: false, error: window.error };
  const rawEvents = readUsageEvents({ from: window.readFrom, to: window.readTo, dataDir: ctx.dataDir });
  const filters = {
    role: String(query.role || '').trim().toLowerCase(),
    harness: String(query.harness || '').trim().toLowerCase(),
    workspaceFile: String(query.workspaceFile || '').trim(),
    chatId: String(query.chatId || '').trim(),
    scope: String(query.scope || '').trim().toLowerCase() === 'consolidated' ? 'consolidated' : 'own',
  };
  const events = filterUsageEvents(filterEventsByWindow(rawEvents, window), filters);
  let delegations = [];
  try {
    delegations = (ctx.loadDelegationRows || loadDelegations)();
  } catch {
    delegations = [];
  }
  return { ok: true, window, events, delegations, tz: window.tz };
}

/**
 * @param {Record<string, any>} ctx
 * @returns {Promise<Map<string, string>>}
 */
async function chatTitleMap(ctx) {
  try {
    // Titles only: the read-only peek avoids cloning every chat row.
    const rows = await (ctx.loadChatRows || peekChatsAsync)();
    return new Map((Array.isArray(rows) ? rows : []).map((c): [string, string] => [String(c.id), String(c.title || '')]).filter(([, title]) => title));
  } catch {
    return new Map();
  }
}

/**
 * @param {Record<string, any>} query `groupBy`, `metric`, `limit`, window + filter fields
 * @param {Record<string, any>} [ctx]
 * @returns {Promise<Record<string, any>>}
 */
export async function loadUsageTop(query: Record<string, any> = {}, ctx: object = {}) {
  const read = readWindowEvents(query, ctx);
  if (!read.ok) return read;
  const limit = Number.parseInt(String(query.limit ?? ''), 10);
  const groupBy = String(query.groupBy || 'chat').trim();
  const top = buildUsageTop({
    events: read.events,
    delegations: read.delegations,
    groupBy,
    metric: String(query.metric || 'fresh').trim(),
    limit: Number.isFinite(limit) ? limit : undefined,
    tz: read.tz,
    labels: groupBy === 'chat' ? await chatTitleMap(ctx) : undefined,
  });
  return { ok: true, window: describeUsageWindow(read.window), ...top };
}

/**
 * @param {Record<string, any>} query `subjectType`, `subjectId`, `limit`, window + filter fields
 * @param {Record<string, any>} [ctx]
 * @returns {Promise<Record<string, any>>}
 */
export async function loadUsageExplain(query: Record<string, any> = {}, ctx: Record<string, any> = {}) {
  const read = readWindowEvents(query, ctx);
  if (!read.ok) return read;
  const limit = Number.parseInt(String(query.limit ?? ''), 10);
  const explained = explainUsage({
    events: read.events,
    delegations: read.delegations,
    subject: { type: String(query.subjectType || 'chat').trim(), id: String(query.subjectId || '').trim() },
    limit: Number.isFinite(limit) ? limit : undefined,
    tz: read.tz,
  });
  if (explained.subject.type === 'chat') {
    (explained.subject as Record<string, any>).label = (await chatTitleMap(ctx)).get(explained.subject.id) || null;
  }
  return { ok: true, window: describeUsageWindow(read.window), ...explained };
}

/**
 * @param {Record<string, any>} query window + filter fields, optional `lookbackHours`, `limit`
 * @param {Record<string, any>} [ctx]
 * @returns {Promise<Record<string, any>>}
 */
export async function loadUsageLimitBurn(query: Record<string, any> = {}, ctx: object = {}) {
  const read = readWindowEvents(query, ctx);
  if (!read.ok) return read;
  const hours = Number(query.lookbackHours);
  const limit = Number.parseInt(String(query.limit ?? ''), 10);
  const burn = attributeLimitBurn({
    events: read.events,
    lookbackMs: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 72) * 3_600_000 : undefined,
    top: Number.isFinite(limit) ? limit : undefined,
    labels: await chatTitleMap(ctx),
  });
  return { ok: true, window: describeUsageWindow(read.window), ...burn };
}

/**
 * Optimization findings over the window, each with its evidence.
 *
 * @param {Record<string, any>} query window + filter fields
 * @param {Record<string, any>} [ctx]
 * @returns {Promise<Record<string, any>>}
 */
export async function loadUsageAdvice(query: Record<string, any> = {}, ctx: Record<string, any> = {}) {
  const read = readWindowEvents(query, ctx);
  if (!read.ok) return read;
  const top = (groupBy, labels?) => buildUsageTop({ events: read.events, delegations: read.delegations, groupBy, limit: 200, tz: read.tz, labels });
  const labels = await chatTitleMap(ctx);
  const findings = buildUsageAdvice({
    models: top('model'),
    leaves: top('leaf'),
    chats: top('chat', labels),
    burn: attributeLimitBurn({ events: read.events, labels }),
    resume: top('resume'),
  });
  return { ok: true, window: describeUsageWindow(read.window), findings };
}
