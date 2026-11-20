import {
  hasExplicitWorkspace,
  scopedAccessAllowedFor,
  viewContextQueryParams,
  viewContextRuntimeParams,
} from './viewContext.js';

/**
 * Shared ViewContext handle.
 *
 * The store instance is created inside `createWorkspaceContext` (App wiring);
 * feature modules must not import that factory (it would build a second
 * store). They read/observe the per-tab view context through this one-line
 * registry instead, which keeps the dependency direction acyclic:
 * workspaceContext → bridge ← consumers.
 */

/** @type {any} */
let store = null;

/**
 * @param {object | null} createdStore store returned by createViewContextStore, or null to clear (tests)
 */
export function setSharedViewContextStore(createdStore) {
  store = createdStore || null;
}

/** @returns {object | null} */
export function getSharedViewContextStore() {
  return store;
}

/** @returns {object | null} snapshot of the current per-tab view context */
export function getViewContextState() {
  return store ? store.getState() : null;
}

/**
 * True while an explicit `ws`/`folder` link owns the header context. Boot
 * caches (chat cold-start snapshot) must not stamp over it: the URL wins.
 *
 * @returns {boolean}
 */
export function hasExplicitViewContextTarget() {
  const state = getViewContextState();
  return Boolean(state?.target && (state.target.workspaceKey || state.target.folderKey));
}

/**
 * False while an explicit link target is still resolving or could not be honored.
 * Panels must not issue scoped API/WS calls against the global cwd in that window.
 *
 * @returns {boolean}
 */
export function isViewContextScopedAccessAllowed() {
  return scopedAccessAllowedFor(getViewContextState());
}

/**
 * Park a scoped boot pass for this tab. Resolves immediately (in a microtask)
 * when scoped access is already allowed, otherwise with the first applied
 * snapshot that allows it — so an explicit `ws`/`folder` link slower than the
 * bounded boot wait still loads its lists and panel exactly once when it
 * finally resolves, and never with a fallback to another workspace.
 *
 * No store (embed/tests) resolves immediately.
 *
 * @returns {Promise<object | null>}
 */
export function whenViewContextScopedAccessAllowed() {
  if (!store || typeof store.whenScopedAccessAllowed !== 'function') {
    return Promise.resolve(store ? store.getState() : null);
  }
  return Promise.resolve(store.whenScopedAccessAllowed());
}

/**
 * Report that a URL resource (chat/TODO) belongs to a different workspace
 * than the link's explicit `ws/folder`. Sets the conflict status, emits
 * `cretli-view-context-conflict` and returns the validation result; it never
 * changes the global settings context.
 *
 * @param {'chat'|'todo'} kind
 * @param {object | null | undefined} row
 * @returns {{ ok: true } | { ok: false, kind: string, detail: string }}
 */
export function reportViewContextResourceConflict(kind, row) {
  if (!store) return { ok: true };
  const result = store.reportResourceConflict(kind, row);
  if (!result.ok && typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('cretli-view-context-conflict', {
      detail: { kind: result.kind, detail: result.detail, state: store.getState() },
    }));
  }
  return result;
}

/**
 * The operator opened a resource on purpose (sidebar row, chat list,
 * notification, voice): the deep link no longer owns the tab, so later
 * ownership checks must not block that choice. Route restores never call this.
 */
export function releaseViewContextRouteTarget() {
  if (store && typeof store.clearRouteTarget === 'function') store.clearRouteTarget();
}

/**
 * Await the boot view-context resolution before any panel fetches scoped data
 * (navigation plan: resolve workspace/folder first, then chat/TODO/Git scope,
 * then data). No store (embed/tests) resolves immediately.
 *
 * @returns {Promise<object | null>}
 */
export function whenViewContextReady() {
  if (!store || typeof store.whenReady !== 'function') return Promise.resolve(null);
  return store.whenReady();
}

/**
 * True while a per-tab context was named explicitly (a `ws`/`folder` link or an
 * operator workspace switch). Such a tab must never be answered from the
 * server's shared settings cwd, so its clients declare the scope on the wire.
 *
 * @returns {boolean}
 */
export function hasExplicitViewContextWorkspace() {
  const state = getViewContextState();
  return Boolean(state && hasExplicitWorkspace(state.context));
}

/**
 * Runtime workspace paths for adapters that cannot send opaque route keys (PTY WS).
 *
 * @returns {{ workspaceFile: string, workspaceFolder: string }}
 */
export function getViewContextRuntimeScope() {
  const state = getViewContextState();
  const fromStore = viewContextRuntimeParams(state || {});
  if (fromStore.workspaceFile || fromStore.workspaceFolder) {
    return {
      workspaceFile: fromStore.workspaceFile,
      workspaceFolder: fromStore.workspaceFolder,
    };
  }
  if (typeof document === 'undefined') {
    return { workspaceFile: '', workspaceFolder: '' };
  }
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFile: String(trigger?.dataset?.workspaceFile || '').trim(),
    workspaceFolder: String(trigger?.dataset?.workspaceFolder || '').trim(),
  };
}

/**
 * Append durable ws/folder keys to a relative API path when the tab owns them.
 *
 * @param {string} basePath
 * @returns {string}
 */
export function withViewContextQuery(basePath) {
  const state = getViewContextState();
  const context = state?.context || {};
  if (!hasExplicitWorkspace(context)) return basePath;
  const qIndex = basePath.indexOf('?');
  const pathOnly = qIndex === -1 ? basePath : basePath.slice(0, qIndex);
  const merged = new URLSearchParams(qIndex === -1 ? '' : basePath.slice(qIndex + 1));
  for (const [key, value] of Object.entries(viewContextQueryParams(context))) {
    if (!merged.has(key)) merged.set(key, value);
  }
  const query = merged.toString();
  if (!query) return basePath;
  return `${pathOnly}?${query}`;
}
