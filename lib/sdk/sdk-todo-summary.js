/**
 * Preview text for updateTodos tiles. Prefer the tool result over incomplete args.
 */

/**
 * @param {unknown} value
 * @returns {unknown[] | undefined}
 */
function readTodosArray(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = /** @type {Record<string, unknown>} */ (value);
  return Array.isArray(row.todos) ? row.todos : undefined;
}

/**
 * Result list wins, including `todos: []`. Missing list falls back to args.
 *
 * @param {unknown} event
 * @returns {unknown[] | undefined}
 */
function pickTodoItemsFromToolEvent(event) {
  const ev = event && typeof event === 'object' && !Array.isArray(event)
    ? /** @type {Record<string, unknown>} */ (event)
    : {};
  const result = ev.result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const row = /** @type {Record<string, unknown>} */ (result);
    const fromValue = readTodosArray(row.value);
    if (fromValue !== undefined) return fromValue;
    const fromResult = readTodosArray(row);
    if (fromResult !== undefined) return fromResult;
  }
  return readTodosArray(ev.args);
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function extractTodoSummaryFromToolEvent(event) {
  const todos = pickTodoItemsFromToolEvent(event);
  if (!Array.isArray(todos) || todos.length === 0) return '';
  const lines = todos.slice(0, 12).map((item) => {
    if (!item || typeof item !== 'object') return '';
    const row = /** @type {Record<string, unknown>} */ (item);
    const status = typeof row.status === 'string' ? row.status : '?';
    const content = typeof row.content === 'string' ? row.content : '';
    return `[${status}] ${content}`;
  });
  return lines.filter(Boolean).join('\n');
}
