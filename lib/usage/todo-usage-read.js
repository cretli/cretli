/**
 * Read side of the TODO usage read model.
 *
 * This is the only place in `lib/usage/` that touches persistence for TODO
 * statistics. It reads three existing stores and nothing else:
 *   - the TODO document of the workspace (`loadTodosData`),
 *   - the delegation rows of the workspace (`listDelegationsForWorkspace`),
 *   - the append-only usage ledger (`readUsageEvents`).
 * It never writes usage and never re-prices an event.
 *
 * A failure to read the ledger is surfaced as `USAGE_UNAVAILABLE` so the HTTP
 * layer can answer 503 instead of reporting a fake zero.
 */

import { listDelegationsForWorkspace } from '../persist/delegations-persist.js';
import { loadTodosData } from '../persist/todos-persist.js';
import { readUsageDiagnostics, readUsageEvents } from '../persist/usage-persist.js';
import { filterEventsByWindow } from './usage-window.js';
import {
  buildTodoUsageModel,
  buildTodoUsageStats,
  buildWorkspaceTodoUsage,
  resolveTodoUsageQuery,
} from './todo-usage.js';

/**
 * @param {string} message
 * @returns {Error}
 */
export function todoUsageUnavailableError(message) {
  const error = new Error(message);
  error.code = 'USAGE_UNAVAILABLE';
  return error;
}

/**
 * Reads the three inputs of the TODO usage read model for one workspace.
 *
 * The ledger is read by UTC day files for the window and then filtered to the
 * exact `[from, to)` instants, so a zone-local window never leaks a
 * neighbouring day's events.
 *
 * @param {{ dataDir?: string, cwd: string, window: { from?: string, to?: string } }} input
 * @returns {{ items: object[], delegations: object[], events: object[] }}
 */
export function readTodoUsageContext(input = {}) {
  const cwd = String(input.cwd || '').trim();
  const dataDir = input.dataDir;
  const items = loadTodosData(dataDir, cwd).items;
  const delegations = cwd ? listDelegationsForWorkspace(cwd, { dataDir }) : [];
  let events = [];
  let diagnostics = { corrupt: null, missing: null, retainedOut: null };
  try {
    events = readUsageEvents({
      dataDir,
      from: input.window?.from,
      to: input.window?.to,
    });
    const ledger = readUsageDiagnostics({ dataDir, from: input.window?.from, to: input.window?.to });
    diagnostics = { corrupt: ledger.corrupt, missing: null, retainedOut: ledger.retainedOut };
  } catch (error) {
    throw todoUsageUnavailableError(
      `Usage ledger is unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return { items, delegations, events: filterEventsByWindow(events, input.window), diagnostics };
}

/**
 * Statistics of a single TODO.
 *
 * @param {{ dataDir?: string, cwd: string, todoId: string, query?: object, now?: number }} input
 * @returns {{ ok: true, todoId: string, window: object, todo: object, usage: object } | { ok: false, error: string, code: string }}
 */
export function loadTodoUsage(input = {}) {
  const query = resolveTodoUsageQuery(input.query || {}, { now: input.now });
  if (!query.ok) return { ok: false, error: query.error, code: query.code };
  const context = readTodoUsageContext({
    dataDir: input.dataDir,
    cwd: input.cwd,
    window: query.window,
  });
  const stats = buildTodoUsageStats(
    buildTodoUsageModel(context),
    context.items,
    input.todoId,
    {
      scope: query.scope,
      model: query.model,
      accountingScope: query.accountingScope,
      diagnostics: context.diagnostics || null,
    }
  );
  if (!stats) {
    const error = new Error('Todo not found');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const item = context.items.find((row) => String(row?.id || '') === String(input.todoId)) || null;
  return {
    ok: true,
    todoId: String(input.todoId),
    window: query.window,
    todo: item
      ? {
        id: String(item.id),
        title: String(item.title || '').trim(),
        status: String(item.status || '').trim(),
        parentId: String(item.parentId || '').trim(),
      }
      : null,
    usage: stats,
  };
}

/**
 * Workspace-wide TODO usage view.
 *
 * @param {{ dataDir?: string, cwd: string, query?: object, now?: number }} input
 * @returns {{ ok: true, window: object, report: object } | { ok: false, error: string, code: string }}
 */
export function loadWorkspaceTodoUsage(input = {}) {
  const query = resolveTodoUsageQuery(input.query || {}, { now: input.now });
  if (!query.ok) return { ok: false, error: query.error, code: query.code };
  const context = readTodoUsageContext({
    dataDir: input.dataDir,
    cwd: input.cwd,
    window: query.window,
  });
  const report = buildWorkspaceTodoUsage({
    ...context,
    window: query.window,
    limit: query.limit,
    cursor: query.cursor,
    offset: query.offset,
    scope: query.scope,
    include: query.include,
    status: query.status,
    root: query.root,
    model: query.model,
    accountingScope: query.accountingScope,
    diagnostics: context.diagnostics,
    cwd: input.cwd,
  });
  return { ok: true, window: query.window, report };
}
