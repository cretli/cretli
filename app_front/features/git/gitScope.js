/**
 * Active Git panel scope (which chat or task the panel is looking at).
 *
 * The panel is a singleton, so switching chats/workspaces while a request is in
 * flight must not paint an older answer over a newer context. This module keeps
 * a monotonically increasing revision next to the scope; request handlers
 * capture the revision and drop their response when it changed.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function readId(value) {
  return String(value ?? '').trim();
}

/**
 * @param {{ chatId?: unknown, todoId?: unknown, workspaceFolder?: unknown } | null | undefined} scope
 * @returns {{ chatId: string, todoId: string, workspaceFolder: string }}
 */
export function normalizeGitScope(scope) {
  return {
    chatId: readId(scope?.chatId),
    todoId: readId(scope?.todoId),
    workspaceFolder: readId(scope?.workspaceFolder),
  };
}

/**
 * Stable identity of a scope, used to skip redundant refreshes and to compare
 * "same context" after an async answer.
 *
 * @param {object | null | undefined} scope
 * @returns {string}
 */
export function buildGitScopeKey(scope) {
  const normalized = normalizeGitScope(scope);
  return `${normalized.chatId}\u0000${normalized.todoId}\u0000${normalized.workspaceFolder}`;
}

/** @type {{ chatId: string, todoId: string, workspaceFolder: string }} */
let activeScope = normalizeGitScope(null);
let revision = 0;
/**
 * A pinned task scope (set by an explicit task-chip click) survives the frequent
 * sidebar/badge refreshes until the active chat/workspace changes.
 */
let scopeLocked = false;
/** @type {Set<(scope: object, revision: number) => void>} */
const listeners = new Set();

/**
 * @returns {{ chatId: string, todoId: string, workspaceFolder: string }}
 */
export function getGitScope() {
  return { ...activeScope };
}

/**
 * @returns {boolean}
 */
export function isGitScopeLocked() {
  return scopeLocked;
}

/**
 * @returns {number}
 */
export function getGitScopeRevision() {
  return revision;
}

/**
 * Replace the active scope. Returns the new revision, or the current one when
 * the scope did not change (a redundant notification then causes no refetch).
 *
 * @param {object | null | undefined} scope
 * @param {{ lock?: boolean }} [options] `lock: true` pins a task scope.
 * @returns {number}
 */
export function setGitScope(scope, options = {}) {
  const next = normalizeGitScope(scope);
  if (options.lock === true) scopeLocked = true;
  else if (options.lock === false) scopeLocked = false;
  if (buildGitScopeKey(next) === buildGitScopeKey(activeScope)) return revision;
  activeScope = next;
  revision += 1;
  for (const listener of listeners) {
    try {
      listener({ ...activeScope }, revision);
    } catch {
      // A subscriber must never break the scope switch.
    }
  }
  return revision;
}

/**
 * True when a response captured at `requestRevision` is still current.
 *
 * @param {number} requestRevision
 * @returns {boolean}
 */
export function isCurrentGitRevision(requestRevision) {
  return requestRevision === revision;
}

/**
 * @param {(scope: object, revision: number) => void} listener
 * @returns {() => void}
 */
export function subscribeGitScope(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reset module state (tests only).
 */
export function resetGitScopeForTests() {
  activeScope = normalizeGitScope(null);
  revision = 0;
  scopeLocked = false;
  listeners.clear();
}
