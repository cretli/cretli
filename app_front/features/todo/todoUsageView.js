/**
 * Pure view model for the TODO usage statistics (editor tab + workspace view).
 *
 * It consumes `GET /api/todos/usage` and `GET /api/todos/:id/usage`
 * (docs/usage-telemetry.md §6b) and never imports DOM or server code, so it
 * runs in the bundler and under `node:test`.
 *
 * The one rule that shapes everything here: a missing measurement is `null`
 * and is rendered as "no data", never as `0`. A measured zero is a real number.
 */

import { formatCompactNumber, formatInteger, formatUsd, sumTokens } from '../usage/usageCharts.js';

/** Window presets offered by the filter bar (all are named backend ranges). */
export const TODO_USAGE_RANGES = Object.freeze(['24h', '7d', '30d', 'month']);
export const TODO_USAGE_DEFAULT_RANGE = '30d';
/** TODO statuses the status filter offers. */
export const TODO_USAGE_STATUSES = Object.freeze(['idea', 'ready', 'doing', 'done', 'deferred']);
/** Rows requested per page of the workspace view (backend max is 200). */
export const TODO_USAGE_PAGE_SIZE = 50;

/** Rendered when a value was not measured. */
export const TODO_USAGE_NO_DATA = '—';

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * Normalizes the filter state to values the backend accepts.
 *
 * @param {{ range?: string, status?: string[], model?: string, onlyWithUsage?: boolean }} [filters]
 * @returns {{ range: string, status: string[], model: string, onlyWithUsage: boolean }}
 */
export function normalizeTodoUsageFilters(filters = {}) {
  const range = TODO_USAGE_RANGES.includes(text(filters.range)) ? text(filters.range) : TODO_USAGE_DEFAULT_RANGE;
  const status = (Array.isArray(filters.status) ? filters.status : [])
    .map((value) => text(value))
    .filter((value, index, list) => TODO_USAGE_STATUSES.includes(value) && list.indexOf(value) === index);
  return {
    range,
    status,
    model: text(filters.model),
    onlyWithUsage: filters.onlyWithUsage === true,
  };
}

/**
 * Query string (no leading `?`) for either endpoint. `cursor` only belongs to
 * the workspace list; the single-TODO endpoint ignores `status`/`include`.
 *
 * @param {{ range?: string, status?: string[], model?: string, onlyWithUsage?: boolean }} filters
 * @param {{ workspace?: boolean, cursor?: string, limit?: number }} [options]
 * @returns {string}
 */
export function buildTodoUsageQuery(filters, options = {}) {
  const f = normalizeTodoUsageFilters(filters);
  const params = new URLSearchParams();
  params.set('range', f.range);
  if (f.model) params.set('model', f.model);
  if (options.workspace) {
    if (f.status.length > 0) params.set('status', f.status.join(','));
    if (f.onlyWithUsage) params.set('include', 'usage');
    params.set('limit', String(options.limit || TODO_USAGE_PAGE_SIZE));
    if (options.cursor) params.set('cursor', options.cursor);
  }
  return params.toString();
}

/**
 * @param {number|null} usd
 * @param {number|null} estimatedUsd
 * @param {string} lang
 * @returns {{ text: string, missing: boolean, estimated: boolean }}
 */
export function formatTodoUsageCost(usd, estimatedUsd, lang = 'en') {
  const measured = finiteOrNull(usd);
  if (measured != null) return { text: formatUsd(measured), missing: false, estimated: false };
  const estimate = finiteOrNull(estimatedUsd);
  // An estimate is shown as such; it never pretends to be a measurement.
  if (estimate != null) return { text: `~${formatUsd(estimate)}`, missing: false, estimated: true };
  return { text: TODO_USAGE_NO_DATA, missing: true, estimated: false };
}

/**
 * @param {number|null|undefined} tokens
 * @param {string} lang
 * @returns {{ text: string, missing: boolean }}
 */
export function formatTodoUsageTokens(tokens, lang = 'en') {
  const value = finiteOrNull(tokens);
  if (value == null) return { text: TODO_USAGE_NO_DATA, missing: true };
  return { text: formatCompactNumber(value, lang), missing: false };
}

/**
 * @param {number|null|undefined} count
 * @param {string} lang
 * @returns {{ text: string, missing: boolean }}
 */
export function formatTodoUsageCount(count, lang = 'en') {
  const value = finiteOrNull(count);
  if (value == null) return { text: TODO_USAGE_NO_DATA, missing: true };
  return { text: formatInteger(value, lang), missing: false };
}

/**
 * Compact duration: "850 ms", "42 s", "5 min 3 s", "2 h 10 min".
 *
 * @param {number|null|undefined} ms
 * @returns {{ text: string, missing: boolean }}
 */
export function formatTodoUsageDuration(ms) {
  const value = finiteOrNull(ms);
  if (value == null || value < 0) return { text: TODO_USAGE_NO_DATA, missing: true };
  if (value < 1000) return { text: `${Math.round(value)} ms`, missing: false };
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return { text: `${seconds} s`, missing: false };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return { text: rest ? `${minutes} min ${rest} s` : `${minutes} min`, missing: false };
  }
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return { text: restMin ? `${hours} h ${restMin} min` : `${hours} h`, missing: false };
}

/**
 * One aggregate (`own`, `consolidated` or the workspace roll-up) as display
 * values. Every numeric field stays `null` when the backend sent `null`.
 *
 * @param {object|null|undefined} aggregate
 * @returns {object|null}
 */
export function normalizeTodoUsageAggregate(aggregate) {
  if (!aggregate || typeof aggregate !== 'object') return null;
  const coverage = aggregate.coverage && typeof aggregate.coverage === 'object' ? aggregate.coverage : {};
  const contractual = coverage.contractual && typeof coverage.contractual === 'object' ? coverage.contractual : {};
  const ledger = coverage.ledger && typeof coverage.ledger === 'object' ? coverage.ledger : {};
  return {
    attempts: finiteOrNull(aggregate.attempts),
    delegations: finiteOrNull(aggregate.delegations),
    events: finiteOrNull(aggregate.events),
    usd: finiteOrNull(aggregate.usd),
    estimatedUsd: finiteOrNull(aggregate.estimatedUsd),
    reportedUsd: finiteOrNull(aggregate.reportedUsd),
    billedTokens: finiteOrNull(aggregate.billedTokens),
    attemptsDurationMs: finiteOrNull(aggregate.attemptsDurationMs),
    elapsedMs: finiteOrNull(aggregate.elapsedMs),
    coverage: {
      state: text(coverage.state) || 'no_data',
      costCoverage: text(coverage.costCoverage) || 'none',
      unpricedEvents: finiteOrNull(coverage.unpricedEvents) ?? 0,
      subscriptionEvents: finiteOrNull(coverage.subscriptionEvents) ?? 0,
      estimatedEvents: finiteOrNull(coverage.estimatedEvents) ?? 0,
      corrupt: finiteOrNull(ledger.corrupt),
      retainedOut: finiteOrNull(ledger.retainedOut),
      missing: finiteOrNull(contractual.missing ?? ledger.missing),
      complete: contractual.complete === true,
      notes: Array.isArray(coverage.notes) ? coverage.notes.map(text).filter(Boolean) : [],
    },
    modelRoles: normalizeModelRoleRows(aggregate.byModelRole),
  };
}

/**
 * Rows of the model x role table. The ledger roll-up reports `totalUsd: 0` for
 * a group with no priced event, so a priced count is derived to keep "no cost
 * data" apart from a measured zero.
 *
 * @param {Record<string, object>|null|undefined} byModelRole
 * @returns {Array<{ key: string, model: string, role: string, events: number|null, usd: number|null, estimatedUsd: number|null, tokens: number|null, unpricedEvents: number }>}
 */
export function normalizeModelRoleRows(byModelRole) {
  if (!byModelRole || typeof byModelRole !== 'object') return [];
  const rows = [];
  for (const [key, row] of Object.entries(byModelRole)) {
    if (!row || typeof row !== 'object') continue;
    const events = finiteOrNull(row.eventsByScope?.own);
    const unpriced = finiteOrNull(row.unpricedEvents) ?? 0;
    const total = finiteOrNull(row.totalUsd);
    const estimated = finiteOrNull(row.estimatedUsd);
    const estimatedOnly = total === 0 && estimated != null && estimated > 0;
    // At least one event carried a cost and it was not only an estimate.
    const hasMeasured = events != null && events > unpriced && !estimatedOnly;
    const tokenSum = sumTokens(row.tokensByScope?.own || row.tokens);
    rows.push({
      key,
      model: text(row.model) || 'unknown',
      role: text(row.role) || 'unknown',
      events,
      usd: hasMeasured ? total : null,
      estimatedUsd: estimated != null && estimated > 0 ? estimated : null,
      tokens: events != null && events > 0 ? tokenSum : null,
      unpricedEvents: unpriced,
    });
  }
  return rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || a.model.localeCompare(b.model) || a.role.localeCompare(b.role));
}

/**
 * @param {object} payload `GET /api/todos/usage` body
 * @returns {object}
 */
export function normalizeWorkspaceUsage(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const todos = (Array.isArray(body.todos) ? body.todos : []).map((row) => ({
    todoId: text(row.todoId),
    title: text(row.title),
    status: text(row.status),
    parentId: text(row.parentId),
    own: normalizeTodoUsageAggregate(row.own),
    consolidated: normalizeTodoUsageAggregate(row.consolidated),
    mixed: row.mixed === true,
  }));
  return {
    asOf: text(body.asOf),
    window: body.window && typeof body.window === 'object' ? body.window : null,
    summary: normalizeTodoUsageAggregate(body.workspace),
    todos,
    total: finiteOrNull(body.total) ?? todos.length,
    returned: finiteOrNull(body.returned) ?? todos.length,
    nextCursor: text(body.nextCursor) || null,
    unattributed: {
      events: finiteOrNull(body.unattributed?.events) ?? 0,
      duplicateEvents: finiteOrNull(body.unattributed?.duplicateEvents) ?? 0,
      unscopedEvents: finiteOrNull(body.unattributed?.unscopedEvents) ?? 0,
    },
  };
}

/**
 * @param {object} payload `GET /api/todos/:id/usage` body
 * @returns {object}
 */
export function normalizeTodoUsage(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const usage = body.usage && typeof body.usage === 'object' ? body.usage : {};
  return {
    window: body.window && typeof body.window === 'object' ? body.window : null,
    todo: body.todo && typeof body.todo === 'object' ? body.todo : null,
    own: normalizeTodoUsageAggregate(usage.own),
    consolidated: normalizeTodoUsageAggregate(usage.consolidated),
    descendantCount: finiteOrNull(usage.descendantCount) ?? 0,
    mixed: usage.mixed === true,
  };
}

/**
 * Display state of one aggregate.
 *  - `empty`: nothing was attempted or measured in the window;
 *  - `partial`: numbers exist but the ledger cannot prove them complete
 *    (unpriced events, corrupt/retained-out days, attempts without usage);
 *  - `ready`: measured and complete.
 *
 * @param {object|null} aggregate normalized aggregate
 * @returns {'empty'|'partial'|'ready'}
 */
export function resolveAggregateState(aggregate) {
  if (!aggregate) return 'empty';
  const attempts = aggregate.attempts ?? 0;
  const events = aggregate.events ?? 0;
  if (attempts === 0 && events === 0) return 'empty';
  const c = aggregate.coverage;
  if (events === 0) return 'partial';
  if (
    c.state === 'partial'
    || c.unpricedEvents > 0
    || (c.corrupt ?? 0) > 0
    || (c.retainedOut ?? 0) > 0
    || (c.missing ?? 0) > 0
    || !c.complete
  ) return 'partial';
  return 'ready';
}

/**
 * Overall state of a request lifecycle.
 *
 * @param {{ loading?: boolean, error?: { status?: number, code?: string } | null, aggregates?: Array<object|null> }} input
 * @returns {'loading'|'unavailable'|'error'|'empty'|'partial'|'ready'}
 */
export function resolveUsageViewState(input = {}) {
  if (input.loading) return 'loading';
  const error = input.error;
  if (error) {
    if (error.status === 503 || error.code === 'USAGE_UNAVAILABLE') return 'unavailable';
    return 'error';
  }
  const states = (input.aggregates || []).map((aggregate) => resolveAggregateState(aggregate));
  if (states.length === 0 || states.every((state) => state === 'empty')) return 'empty';
  return states.includes('partial') ? 'partial' : 'ready';
}

/**
 * Distinct models seen in a normalized workspace report, for the model filter.
 * The backend filters by exact model id; the options come from what the last
 * unfiltered response contained.
 *
 * @param {object|null} workspace normalized workspace report
 * @returns {string[]}
 */
export function collectUsageModels(workspace) {
  const models = new Set();
  for (const row of workspace?.summary?.modelRoles || []) {
    if (row.model && row.model !== 'unknown') models.add(row.model);
  }
  return [...models].sort((a, b) => a.localeCompare(b));
}

/**
 * Turns a failed fetch (thrown or `{ ok: false }`) into a stable error object.
 *
 * @param {unknown} failure
 * @param {number} [status]
 * @returns {{ status: number, code: string, message: string }}
 */
export function describeUsageFailure(failure, status = 0) {
  const body = failure && typeof failure === 'object' ? failure : {};
  return {
    status: Number(status) || Number(body.status) || 0,
    code: text(body.code),
    message: text(body.error || body.message) || (typeof failure === 'string' ? failure : ''),
  };
}
