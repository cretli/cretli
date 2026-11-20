/**
 * Request controller for the TODO usage statistics.
 *
 * Every `load` aborts the request that is still in flight and carries a
 * monotonically increasing sequence number, so a slow response for an old
 * filter (or an old TODO) can never overwrite the state of a newer one.
 * The fetcher is injectable so the stale-response rules are unit-testable.
 */

import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { getTodoWorkspaceFolder } from './todoWorkspaceScope.js';
import { withViewContextQuery } from '../../app/appShell/viewContextBridge.js';
import {
  buildTodoUsageQuery,
  describeUsageFailure,
  normalizeTodoUsage,
  normalizeWorkspaceUsage,
} from './todoUsageView.js';

/**
 * Default fetcher: workspace-scoped GET returning `{ status, body }`.
 *
 * @param {string} path `/api/todos/...` without a query string
 * @param {string} query filter query string (no `?`)
 * @param {AbortSignal} signal
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function fetchTodoUsageJson(path, query, signal) {
  const params = new URLSearchParams(query);
  const folder = getTodoWorkspaceFolder();
  // Scope is always the active workspace; the server never reads another.
  if (folder) params.set('workspaceFolder', folder);
  const url = withViewContextQuery(`${path}?${params.toString()}`);
  const response = await cretliApiFetch(url, { method: 'GET', cache: 'no-store', credentials: 'include', signal });
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

/**
 * @param {{ fetcher?: typeof fetchTodoUsageJson, onChange: (state: object) => void }} options
 * @returns {{ load: Function, loadMore: Function, abort: Function, getState: () => object }}
 */
export function createTodoUsageController(options) {
  const fetcher = options.fetcher || fetchTodoUsageJson;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  let sequence = 0;
  let abortController = null;
  let state = { loading: false, error: null, data: null, loadingMore: false };

  function setState(next) {
    state = { ...state, ...next };
    onChange(state);
  }

  function cancelInFlight() {
    if (abortController) {
      try {
        abortController.abort();
      } catch {
        // already aborted
      }
    }
    abortController = null;
  }

  /**
   * @param {{ todoId?: string, filters: object, append?: boolean }} request
   */
  async function run(request) {
    cancelInFlight();
    sequence += 1;
    const mine = sequence;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortController = controller;
    const workspace = !request.todoId;
    const path = workspace ? '/api/todos/usage' : `/api/todos/${encodeURIComponent(request.todoId)}/usage`;
    const cursor = request.append ? state.data?.nextCursor || '' : '';
    const query = buildTodoUsageQuery(request.filters, { workspace, cursor });
    if (request.append) setState({ loadingMore: true, error: null });
    else setState({ loading: true, loadingMore: false, error: null });
    try {
      const { status, body } = await fetcher(path, query, controller?.signal);
      // A newer request started while this one was in flight: drop silently.
      if (mine !== sequence) return;
      if (!body || body.ok !== true) {
        setState({ loading: false, loadingMore: false, error: describeUsageFailure(body, status) });
        return;
      }
      if (workspace) {
        const next = normalizeWorkspaceUsage(body);
        if (request.append && state.data) {
          // Totals and summary repeat on every page; only the rows accumulate.
          next.todos = [...state.data.todos, ...next.todos];
          next.returned = next.todos.length;
        }
        setState({ loading: false, loadingMore: false, error: null, data: next });
      } else {
        setState({ loading: false, loadingMore: false, error: null, data: normalizeTodoUsage(body) });
      }
    } catch (err) {
      if (mine !== sequence) return;
      if (err && err.name === 'AbortError') return;
      setState({ loading: false, loadingMore: false, error: describeUsageFailure(err?.message || 'network', 0) });
    }
  }

  return {
    load: (request) => run({ ...request, append: false }),
    loadMore: (request) => run({ ...request, append: true }),
    abort() {
      sequence += 1;
      cancelInFlight();
    },
    getState: () => state,
  };
}
