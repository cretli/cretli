/** Pure feedback marker and provenance checks shared by server and browser code. */

export const FEEDBACK_ROOT_MARKER = '<!-- cretli-feedback-root:v1 -->';

/** The backlog root that holds MCP reports. */
export function isFeedbackRoot(item) {
  return !!item && !item.parentId && String(item.body || '').startsWith(FEEDBACK_ROOT_MARKER);
}

export function normalizeFeedbackOrigin(value) {
  if (!value || typeof value !== 'object' || !['report', 'extracted'].includes(value.kind)) return null;
  const rootId = String(value.rootId || '').trim();
  const reportId = String(value.reportId || '').trim();
  return reportId ? { kind: value.kind, ...(rootId ? { rootId } : {}), reportId } : null;
}

/** A report is its own category member; its implementation children are not. */
export function isFeedbackReport(item) {
  const origin = normalizeFeedbackOrigin(item?.feedbackOrigin);
  return origin?.kind === 'report' && origin.reportId === item?.id;
}

/** Flatten legacy report containers while keeping their history and report subtrees. */
export function separateFeedbackReports(items) {
  stampFeedbackOrigins(items);
  const rootIds = new Set(items.filter(isFeedbackRoot).map((item) => item.id));
  let nextIndex = Math.max(-1, ...items.filter((item) => !item.parentId)
    .map((item) => Number.isInteger(item.siblingIndex) ? item.siblingIndex : 0)) + 1;
  const reports = items.filter((item) => rootIds.has(item.parentId))
    .sort((a, b) => (a.siblingIndex || 0) - (b.siblingIndex || 0));
  for (const item of reports) {
    delete item.parentId;
    item.siblingIndex = nextIndex++;
  }
  return items;
}

/** Stamp legacy and newly linked todos before a structural write can detach them. */
export function stampFeedbackOrigins(items) {
  const byId = new Map(items.map((row) => [row.id, row]));
  const resolve = (item, seen = new Set()) => {
    if (!item || seen.has(item.id)) return null;
    const saved = normalizeFeedbackOrigin(item.feedbackOrigin);
    if (saved) return saved;
    seen.add(item.id);
    const parent = byId.get(item.parentId);
    let origin = null;
    if (parent && !parent.parentId && String(parent.body || '').startsWith(FEEDBACK_ROOT_MARKER)) {
      origin = { kind: 'report', rootId: parent.id, reportId: item.id };
    } else if (parent) {
      const parentOrigin = resolve(parent, seen);
      if (parentOrigin) origin = { ...parentOrigin };
    }
    if (!origin) {
      const source = byId.get(item.sourceTodoId);
      const sourceOrigin = source ? resolve(source, seen) : null;
      if (sourceOrigin) origin = { ...sourceOrigin, kind: 'extracted' };
    }
    seen.delete(item.id);
    if (origin) item.feedbackOrigin = origin;
    return origin;
  };
  for (const item of items) resolve(item);
  return items;
}

/**
 * id -> row index per items array. The Watcher tick calls these helpers once per todo over the same
 * array, so rebuilding the map on every call was O(n^2) allocation (gigabytes per minute).
 * Callers may push to or replace rows of an array in place, so the entry is rebuilt when the length
 * changed or when the looked-up todo is not the indexed row.
 *
 * @type {WeakMap<object, { length: number, byId: Map<any, any> }>}
 */
const indexByItems = new WeakMap();

/**
 * @param {any[] | Map<any, any>} items an items array, or an id -> row Map already built by the caller
 * @param {any} [todo] the row about to be looked up; a different object under its id forces a rebuild
 * @returns {Map<any, any>}
 */
function todoIndexOf(items, todo = undefined) {
  if (items instanceof Map) return items;
  const list = Array.isArray(items) ? items : [];
  const cached = indexByItems.get(list);
  const fresh = cached && cached.length === list.length
    && (!todo?.id || !cached.byId.has(todo.id) || cached.byId.get(todo.id) === todo);
  if (fresh) return cached.byId;
  const byId = new Map(list.map((row) => [row.id, row]));
  indexByItems.set(list, { length: list.length, byId });
  return byId;
}

/**
 * Whether a todo is the feedback root or sits anywhere below it.
 *
 * @param {any[] | Map<any, any>} items
 * @param {any} todo
 */
export function isUnderFeedbackRoot(items, todo) {
  const byId = todoIndexOf(items, todo);
  let cur = todo?.id ? byId.get(todo.id) : undefined;
  for (let depth = 0; cur && depth < 64; depth += 1) {
    if (!cur.parentId && String(cur.body || '').startsWith(FEEDBACK_ROOT_MARKER)) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

/**
 * Feedback reports and roots extracted from them require approval on themselves.
 *
 * @param {any[] | Map<any, any>} items an items array, or an id -> row Map (no copy is made)
 * @param {any} todo
 */
export function isFeedbackDerivedTodo(items, todo) {
  if (!todo) return false;
  if (normalizeFeedbackOrigin(todo.feedbackOrigin)) return true;
  const byId = todoIndexOf(items, todo);
  if (isUnderFeedbackRoot(byId, todo)) return true;
  const seen = new Set();
  let current = todo;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (normalizeFeedbackOrigin(current.feedbackOrigin)) return true;
    const source = byId.get(current.sourceTodoId);
    if (source && (normalizeFeedbackOrigin(source.feedbackOrigin) || isUnderFeedbackRoot(byId, source))) return true;
    current = byId.get(current.parentId);
  }
  return false;
}
