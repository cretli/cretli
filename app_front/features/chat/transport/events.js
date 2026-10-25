/**
 * Dispatch transport-originated application events.
 *
 * These events intentionally stay on the existing window channel. The socket
 * remains the only transport; this module only translates selected frames.
 */

export function dispatchTodoChangedEvent(msg) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
  const todoId = typeof msg?.todoId === 'string' ? msg.todoId.trim() : '';
  if (!todoId) return false;
  const workspaceFolder = typeof msg.workspaceFolder === 'string' ? msg.workspaceFolder.trim() : '';
  const reason = typeof msg.reason === 'string' ? msg.reason.trim() : '';
  window.dispatchEvent(new CustomEvent('cretli:todo-changed', {
    detail: { workspaceFolder, todoId, reason },
  }));
  return true;
}

/** Notify the Todo panel that a reconnect may have skipped a frame. */
export function dispatchTodoReconnectEvent() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
  window.dispatchEvent(new CustomEvent('cretli:todo-changed', {
    detail: { workspaceFolder: '', todoId: '', reason: 'reconnect' },
  }));
  return true;
}

