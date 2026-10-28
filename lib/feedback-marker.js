/** Pure feedback marker and provenance checks shared by server and browser code. */

export const FEEDBACK_ROOT_MARKER = '<!-- cretli-feedback-root:v1 -->';

export function normalizeFeedbackOrigin(value) {
  if (!value || typeof value !== 'object' || !['report', 'extracted'].includes(value.kind)) return null;
  const rootId = String(value.rootId || '').trim();
  const reportId = String(value.reportId || '').trim();
  return rootId && reportId ? { kind: value.kind, rootId, reportId } : null;
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
      if (sourceOrigin) origin = { kind: 'extracted', rootId: sourceOrigin.rootId, reportId: sourceOrigin.reportId };
    }
    seen.delete(item.id);
    if (origin) item.feedbackOrigin = origin;
    return origin;
  };
  for (const item of items) resolve(item);
  return items;
}

/** Whether a todo is the feedback root or sits anywhere below it. */
export function isUnderFeedbackRoot(items, todo) {
  const byId = new Map(items.map((row) => [row.id, row]));
  let cur = todo?.id ? byId.get(todo.id) : undefined;
  for (let depth = 0; cur && depth < 64; depth += 1) {
    if (!cur.parentId && String(cur.body || '').startsWith(FEEDBACK_ROOT_MARKER)) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

/** Feedback reports and roots extracted from them require approval on themselves. */
export function isFeedbackDerivedTodo(items, todo) {
  if (!todo) return false;
  if (normalizeFeedbackOrigin(todo.feedbackOrigin)) return true;
  if (isUnderFeedbackRoot(items, todo)) return true;
  const byId = new Map(items.map((row) => [row.id, row]));
  const seen = new Set();
  let current = todo;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (normalizeFeedbackOrigin(current.feedbackOrigin)) return true;
    const source = byId.get(current.sourceTodoId);
    if (source && (normalizeFeedbackOrigin(source.feedbackOrigin) || isUnderFeedbackRoot(items, source))) return true;
    current = byId.get(current.parentId);
  }
  return false;
}
