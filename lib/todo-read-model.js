/**
 * Bounded read models behind the MCP `todo_list`, `todo_show` tools (docs/todo-scalable-architecture.md, phase 1 slice 2).
 *
 * Every function reads through the todo repository: a filtered window, a point
 * read with its neighbours, or the tree closure of the candidate rows. None of
 * them loads the whole document per call; the repository index is built once per
 * committed revision. Rows are enriched (`enrich`) only after they were selected,
 * so enrichment cost follows the page, not the workspace.
 */

import { getTodoRepository } from './persist/todo-repository.js';
import { findApprovedPlanAncestor, readTodoExecutionState } from './todo-tree.js';

/**
 * @typedef {{ dataDir: string, workspaceFolder: string, enrich?: (rows: Record<string, any>[]) => Promise<Record<string, any>[]> | Record<string, any>[], policy?: Record<string, any> | null }} ReadDeps
 */

/**
 * @param {ReadDeps} deps
 * @param {Record<string, any>[]} rows
 * @returns {Promise<Record<string, any>[]>}
 */
async function enrichRows(deps, rows) {
  if (!deps.enrich) return rows.map((row) => ({ ...row }));
  return /** @type {Record<string, any>[]} */ (await deps.enrich(rows.map((row) => ({ ...row }))));
}

/**
 * Execution states for `rows` (enriched, ids of `wantedIds`), computed over just
 * the plan-gate closure of those rows. Only a stored-`ready` row under a watcher
 * policy can differ from its stored status, so nothing is loaded otherwise.
 *
 * @param {ReadDeps} deps
 * @param {Record<string, any>[]} rows enriched rows to judge
 * @returns {Promise<Map<string, string>>}
 */
async function executionStates(deps, rows) {
  const repo = getTodoRepository(deps.dataDir);
  const ids = rows.filter((row) => row.status === 'ready').map((row) => row.id);
  /** @type {Map<string, string>} */
  const states = new Map(rows.map((row) => [row.id, String(row.status || 'idea')]));
  if (!ids.length || !deps.policy || typeof deps.policy !== 'object') return states;
  const closure = await enrichRows(deps, await repo.gateClosure(deps.workspaceFolder, ids));
  const byId = new Map(closure.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.status !== 'ready') continue;
    states.set(row.id, readTodoExecutionState(closure, byId.get(row.id) || row, deps.policy));
  }
  return states;
}

/**
 * One window of the filtered list in document order plus the exact filtered total.
 *
 * @param {ReadDeps} deps
 * @param {{ status?: string, review?: { subject?: string, state?: string }, integration?: string, text?: string }} filter
 * @param {{ offset: number, limit: number }} window
 * @returns {Promise<{ entries: { item: Record<string, any>, isContainer: boolean, executionState: string }[], total: number }>}
 */
export async function readTodoListModel(deps, filter, window) {
  const repo = getTodoRepository(deps.dataDir);
  const page = await repo.listWindow(deps.workspaceFolder, filter, window);
  const enriched = await enrichRows(deps, page.entries.map((entry) => entry.raw));
  const states = await executionStates(deps, enriched);
  return {
    total: page.total,
    entries: page.entries.map((entry, i) => ({
      item: { ...enriched[i], integrationSummary: entry.integrationSummary },
      isContainer: entry.isContainer,
      executionState: states.get(enriched[i].id) || String(enriched[i].status || 'idea'),
    })),
  };
}

/**
 * Resolve a full id or a unique (case-insensitive) prefix of >= 8 chars.
 *
 * @param {ReadDeps} deps
 * @param {unknown} rawId
 * @returns {Promise<{ ok: true, item: Record<string, any> } | { ok: false, code: string, matches?: Record<string, any>[] }>}
 */
export async function resolveTodoModel(deps, rawId) {
  const requested = String(rawId || '').trim();
  if (!requested) return { ok: false, code: 'NOT_FOUND' };
  const repo = getTodoRepository(deps.dataDir);
  const { item, matches } = await repo.resolveItem(deps.workspaceFolder, requested, { ignoreCase: true });
  if (item) return { ok: true, item: (await enrichRows(deps, [item]))[0] };
  if (matches.length > 1) return { ok: false, code: 'VALIDATION_ERROR', matches: await enrichRows(deps, matches) };
  return { ok: false, code: 'NOT_FOUND' };
}

/**
 * Everything `todo_show` needs for one todo: the item, its direct children (all
 * of them, for the review aggregate; the requested page carries execution
 * states), follow-ups, the approved-plan ancestor and the execution state.
 *
 * @param {ReadDeps} deps
 * @param {unknown} rawId
 * @param {{ offset: number, limit: number }} childrenWindow
 */
export async function readTodoShowModel(deps, rawId, childrenWindow) {
  const resolution = await resolveTodoModel(deps, rawId);
  if (!resolution.ok) return resolution;
  const repo = getTodoRepository(deps.dataDir);
  const item = resolution.item;
  const neighbours = /** @type {NonNullable<Awaited<ReturnType<typeof repo.readNeighbours>>>} */ (
    await repo.readNeighbours(deps.workspaceFolder, String(item.id))
  );
  const enrichedChildren = await enrichRows(deps, neighbours.children.map((child) => child.raw));
  const children = neighbours.children.map((child, i) => ({
    item: { ...enrichedChildren[i], integrationSummary: child.integrationSummary },
    isContainer: child.isContainer,
  }));
  const pageStart = Math.max(0, childrenWindow.offset);
  const pageChildren = children.slice(pageStart, pageStart + Math.max(0, childrenWindow.limit));
  const [readRaw] = await enrichRows(deps, [neighbours.self.raw]);
  const readItem = { ...readRaw, integrationSummary: neighbours.self.integrationSummary };
  // The gate closure of the item also covers its ancestors and source chains,
  // which is all `findApprovedPlanAncestor` reads.
  const closure = await enrichRows(deps, await repo.gateClosure(deps.workspaceFolder, [String(item.id)]));
  const approvedAncestor = findApprovedPlanAncestor(closure, item);
  const states = await executionStates(deps, [item, ...pageChildren.map((child) => child.item)]);
  return {
    ok: /** @type {const} */ (true),
    item,
    readItem,
    children,
    childrenPage: pageChildren.map((child) => ({ ...child, executionState: states.get(/** @type {any} */ (child.item).id) || String(/** @type {any} */ (child.item).status || 'idea') })),
    followUps: neighbours.followUps.map((row) => ({ id: row.raw.id, title: row.raw.title })),
    approvedAncestor,
    executionState: states.get(item.id) || String(item.status || 'idea'),
  };
}
