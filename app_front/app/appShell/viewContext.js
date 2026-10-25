/**
 * Per-tab ViewContext (navigation plan stage 2).
 *
 * Holds which workspace/folder this browsing context is looking at, plus the
 * explicit chat/TODO scope taken from the URL, and resolves the opaque route
 * keys to runtime paths BEFORE any panel fetches data. View switches write
 * here only — the global default workspace in settings stays a separate,
 * operator-owned choice, so two tabs can show different workspaces at once.
 */

import { parseSpaRoute, buildSpaRoute } from '../../../lib/spa-routes.js';
import { normalizePath } from './workspaceHelpers.js';

export const VIEW_CONTEXT_STATUS = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  /** Explicit target kept while offline/missing data; never silently re-pointed. */
  MISSING_TARGET: 'missing-target',
  /** The URL resource belongs to a different workspace than the explicit ws/folder. */
  CONFLICT: 'conflict',
};

const EMPTY_CONTEXT = Object.freeze({ workspaceKey: '', folderKey: '' });

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} raw
 * @returns {{ workspaceKey: string, folderKey: string }}
 */
export function normalizeViewContext(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    workspaceKey: trimmed(source.workspaceKey),
    folderKey: trimmed(source.folderKey),
  };
}

/**
 * Route → local view context. `locationInfo` is { pathname, search } shaped
 * like everything parseSpaRoute accepts; non-shell paths return null so the
 * caller keeps whatever context it already has.
 *
 * @param {{ pathname?: string, search?: string }} locationInfo
 * @returns {{ route: object, context: {workspaceKey: string, folderKey: string}, scope: {type: string, id: string}} | null}
 */
export function viewContextFromLocation(locationInfo) {
  const route = parseSpaRoute(locationInfo || {});
  if (!route || route.notFound || !route.panel) return null;
  const context = normalizeViewContext(route.context);
  const scope = { type: '', id: '' };
  if (route.scope === 'chat' && route.resource?.type === 'chat') {
    scope.type = 'chat';
    scope.id = route.resource.id;
  } else if (route.scope === 'todo' && route.resource?.type === 'todo') {
    scope.type = 'todo';
    scope.id = route.resource.id;
  }
  return { route, context, scope };
}

/**
 * @param {{ workspaceKey?: string, folderKey?: string }} context
 * @returns {boolean}
 */
export function hasExplicitWorkspace(context) {
  const ctx = normalizeViewContext(context);
  return Boolean(ctx.workspaceKey || ctx.folderKey);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameViewContext(a, b) {
  const left = normalizeViewContext(a);
  const right = normalizeViewContext(b);
  return left.workspaceKey === right.workspaceKey && left.folderKey === right.folderKey;
}

/**
 * Whether a snapshot lets panels read or write workspace-scoped data.
 *
 * Without an explicit `ws`/`folder` the tab follows the local/default context,
 * so scoped work is allowed. With one, the link owns the tab until it
 * resolves: pending, missing and conflicting targets must not fetch (the
 * server would answer from its own global cwd) and must not switch panels.
 *
 * @param {{ context?: {workspaceKey?: string, folderKey?: string}, status?: string } | null | undefined} state
 * @returns {boolean}
 */
export function scopedAccessAllowedFor(state) {
  if (!state || !hasExplicitWorkspace(state.context)) return true;
  if (state.status === VIEW_CONTEXT_STATUS.PENDING) return false;
  if (state.status === VIEW_CONTEXT_STATUS.MISSING_TARGET) return false;
  // A URL resource conflict blocks that resource only; workspace lists and Git
  // reads for the resolved ws/folder must stay available.
  return state.status === VIEW_CONTEXT_STATUS.RESOLVED
    || state.status === VIEW_CONTEXT_STATUS.CONFLICT;
}

/**
 * Query params a panel request should carry so the server resolves the scope
 * from opaque keys instead of the shared settings cwd (works on routes that
 * accept ws/folder; runtime-path adapters use viewContextRuntimeParams).
 *
 * @param {{ workspaceKey?: string, folderKey?: string }} context
 * @returns {Record<string, string>}
 */
export function viewContextQueryParams(context) {
  const ctx = normalizeViewContext(context);
  const params = {};
  if (ctx.workspaceKey) params.ws = ctx.workspaceKey;
  if (ctx.folderKey) params.folder = ctx.folderKey;
  return params;
}

/**
 * Explicit runtime scope for the panel adapters (Git/Worktrees, TODO, tasks):
 * only fields the resolved context actually has. `chatId`/`todoId` come from
 * the URL scope, never from an incidental active chat.
 *
 * @param {{ context?: {workspaceKey?: string, folderKey?: string}, scope?: {type?: string, id?: string}, runtime?: {workspaceFile?: string, workspaceFolder?: string} }} state
 * @returns {{ workspaceFile: string, workspaceFolder: string, chatId: string, todoId: string }}
 */
export function viewContextRuntimeParams(state) {
  const source = state && typeof state === 'object' ? state : {};
  const runtime = source.runtime && typeof source.runtime === 'object' ? source.runtime : {};
  const scope = source.scope && typeof source.scope === 'object' ? source.scope : {};
  const out = {
    workspaceFile: trimmed(runtime.workspaceFile),
    workspaceFolder: trimmed(runtime.workspaceFolder),
    chatId: '',
    todoId: '',
  };
  if (scope.type === 'chat') out.chatId = trimmed(scope.id);
  if (scope.type === 'todo') out.todoId = trimmed(scope.id);
  return out;
}

/**
 * Ownership check for URL resources: a chat/TODO row must live in the explicit
 * ws/folder of the link. Without an explicit context there is nothing to
 * conflict with (the local/default context applies). Rows that only pin a
 * workspaceFile can still be matched against the resolved workspace file.
 *
 * @param {'chat'|'todo'} kind
 * @param {object | null | undefined} row persisted resource record
 * @param {{ context?: {workspaceKey?: string, folderKey?: string}, runtime?: {workspaceFile?: string, workspaceFolder?: string} }} state
 * @returns {{ ok: true } | { ok: false, kind: string, detail: string }}
 */
export function validateResourceAgainstContext(kind, row, state) {
  const source = state && typeof state === 'object' ? state : {};
  if (!hasExplicitWorkspace(source.context)) return { ok: true };
  const runtime = source.runtime && typeof source.runtime === 'object' ? source.runtime : {};
  const wantedFile = normalizePath(runtime.workspaceFile);
  const wantedFolder = normalizePath(runtime.workspaceFolder);
  if (!wantedFile && !wantedFolder) return { ok: true };
  const record = row && typeof row === 'object' ? row : null;
  if (!record) {
    return { ok: false, kind: String(kind || 'resource'), detail: 'resource-missing' };
  }
  const rowFile = normalizePath(record.workspaceFile);
  const rowFolder = normalizePath(record.workspaceFolder);
  if (rowFile && wantedFile && rowFile !== wantedFile) {
    return { ok: false, kind: String(kind || 'resource'), detail: 'workspace-mismatch' };
  }
  if (rowFolder && wantedFolder && rowFolder !== wantedFolder) {
    return { ok: false, kind: String(kind || 'resource'), detail: 'folder-mismatch' };
  }
  return { ok: true };
}

/**
 * Deterministic Git scope projection of a view-context state (stage 4 builds
 * restoration on top of this). A route scope pins the matching id with the
 * scope lock; `/git` without one shows the workspace and releases the lock —
 * "history/reset applies the lock deterministically".
 *
 * @param {object} state controller state ({ scope, runtime })
 * @returns {{ scope: {chatId: string, todoId: string, workspaceFolder: string}, lock: boolean, pin: boolean } | null}
 */
export function gitScopeFromViewContext(state) {
  const source = state && typeof state === 'object' ? state : null;
  if (!source) return null;
  const params = viewContextRuntimeParams(source);
  const scope = { chatId: '', todoId: '', workspaceFolder: params.workspaceFolder };
  let lock = false;
  if (params.todoId) {
    scope.todoId = params.todoId;
    lock = true;
  } else if (params.chatId) {
    scope.chatId = params.chatId;
    lock = true;
  }
  return { scope, lock, pin: lock };
}

/**
 * The store factory. It is DOM-free: reading the location, resolving keys to
 * runtime paths, canonicalizing the URL and reacting to an applied revision
 * are all injected dependencies so the generation guard can be unit-tested.
 *
 * @param {{
 *   readLocation: () => { pathname?: string, search?: string } | null,
 *   resolveWorkspace: (context: {workspaceKey: string, folderKey: string}) => Promise<{ workspaceFile?: string, workspaceFolder?: string, error?: string }>,
 *   canonicalize?: (canonicalPath: string) => void,
 *   onApplied?: (state: object) => void,
 *   getDefaultContext?: () => Promise<{ workspaceFile?: string, workspaceFolder?: string } | null>,
 *   readyTimeoutMs?: number,
 *   now?: () => number,
 * }} deps
 */
export function createViewContextStore(deps = {}) {
  const noop = () => {};
  const readLocation = typeof deps.readLocation === 'function' ? deps.readLocation : () => null;
  const resolveWorkspace = typeof deps.resolveWorkspace === 'function'
    ? deps.resolveWorkspace
    : async () => ({ error: 'resolver-unavailable' });
  const canonicalize = typeof deps.canonicalize === 'function' ? deps.canonicalize : noop;
  const onApplied = typeof deps.onApplied === 'function' ? deps.onApplied : noop;
  const getDefaultContext = typeof deps.getDefaultContext === 'function' ? deps.getDefaultContext : async () => null;
  const getContextKeysForRuntime = typeof deps.getContextKeysForRuntime === 'function'
    ? deps.getContextKeysForRuntime
    : null;
  const readyTimeoutMs = Number.isFinite(deps.readyTimeoutMs) && deps.readyTimeoutMs > 0
    ? Number(deps.readyTimeoutMs)
    : 3000;

  /** @type {number} bumped by every route-driven apply; late answers must not paint. */
  let revision = 0;
  let state = {
    revision: 0,
    /** 'route' when a link drove the state, 'default' when local settings did. */
    source: '',
    route: null,
    context: { ...EMPTY_CONTEXT },
    scope: { type: '', id: '' },
    runtime: { workspaceFile: '', workspaceFolder: '' },
    status: VIEW_CONTEXT_STATUS.PENDING,
    conflict: null,
    /** The link the user asked for; preserved while data is missing (offline). */
    target: null,
  };

  /** @type {Set<(state: object) => void>} parked scoped boot passes. */
  const scopedWaiters = new Set();

  /**
   * Hand one applied snapshot to the paint hook, then release the scoped boot
   * passes it made usable. A boot timeout is not a resolution: only a snapshot
   * that really permits scoped work settles them, and every waiter is dropped
   * before it runs, so a late resolve resumes each pass exactly once.
   */
  function emitApplied() {
    const snap = snapshot();
    onApplied(snap);
    if (scopedWaiters.size === 0 || !scopedAccessAllowedFor(snap)) return snap;
    const waiters = [...scopedWaiters];
    scopedWaiters.clear();
    for (const notify of waiters) {
      try {
        notify(snap);
      } catch {
        // A parked pass must never break the apply chain.
      }
    }
    return snap;
  }

  let readyPromise = null;
  let readyResolve = null;
  function ensureReady() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve) => { readyResolve = resolve; });
    // Never let a stalled resolver hang the boot chain. The timeout only
    // releases the WAIT: an explicit target keeps its PENDING status and its
    // link target (slow is not missing), so callers that need usable scope use
    // whenScopedAccessAllowed() instead of treating this settle as one.
    setTimeout(() => settleReady(), readyTimeoutMs);
    return readyPromise;
  }
  function settleReady() {
    if (readyResolve) {
      const resolve = readyResolve;
      readyResolve = null;
      resolve(state);
    }
  }

  function snapshot() {
    return {
      revision: state.revision,
      source: state.source,
      route: state.route,
      context: { ...state.context },
      scope: { ...state.scope },
      runtime: { ...state.runtime },
      status: state.status,
      conflict: state.conflict,
      target: state.target ? { ...state.target } : null,
    };
  }

  /**
   * Resolve the CURRENT location into the local context. Rapid A→B calls are
   * safe: the older revision's answer is dropped (stale responses never paint).
   *
   * @returns {Promise<object>} the settled snapshot for THIS invocation's revision
   */
  async function applyRouteContext() {
    const token = ++revision;
    state = { ...state, revision: token };
    const locationInfo = readLocation();
    const fromLocation = viewContextFromLocation(locationInfo);
    if (!fromLocation) {
      settleReady();
      return snapshot();
    }
    const explicitTarget = hasExplicitWorkspace(fromLocation.context);
    // A tab switch re-applies the same link: when the explicit ws/folder is the
    // one this tab already resolved, keep the runtime and skip the PENDING
    // flash plus the resolver round trip. A conflicted or unresolved state
    // always takes the full path below.
    if (explicitTarget
      && state.status === VIEW_CONTEXT_STATUS.RESOLVED
      && (state.runtime.workspaceFile || state.runtime.workspaceFolder)
      && sameViewContext(state.context, fromLocation.context)) {
      state = {
        ...state,
        source: 'route',
        route: fromLocation.route,
        scope: fromLocation.scope,
        conflict: null,
        target: {
          workspaceKey: fromLocation.context.workspaceKey,
          folderKey: fromLocation.context.folderKey,
          scope: { ...fromLocation.scope },
        },
      };
      emitApplied();
      settleReady();
      return snapshot();
    }
    state = {
      ...state,
      source: 'route',
      route: fromLocation.route,
      context: fromLocation.context,
      scope: fromLocation.scope,
      status: VIEW_CONTEXT_STATUS.PENDING,
      conflict: null,
      runtime: explicitTarget
        ? { workspaceFile: '', workspaceFolder: '' }
        : state.runtime,
      target: {
        workspaceKey: fromLocation.context.workspaceKey,
        folderKey: fromLocation.context.folderKey,
        scope: { ...fromLocation.scope },
      },
    };
    if (explicitTarget) {
      emitApplied();
    }
    if (!hasExplicitWorkspace(fromLocation.context)) {
      // Link without ws/folder: the local/default context applies. The boot
      // settings pass finalizes it with markDefaultReady(); panels must not
      // be gated on the network for this branch, so nothing is emitted here.
      const fallback = await getDefaultContext();
      if (token !== revision) return snapshot();
      if (fallback && (fallback.workspaceFile || fallback.workspaceFolder)) {
        state = {
          ...state,
          runtime: {
            workspaceFile: trimmed(fallback.workspaceFile),
            workspaceFolder: trimmed(fallback.workspaceFolder),
          },
          status: VIEW_CONTEXT_STATUS.RESOLVED,
        };
        emitApplied();
        // A link without context may be canonicalized once resolved: map the
        // runtime default back onto its durable keys so the address replays.
        if (getContextKeysForRuntime) {
          let keys = null;
          try {
            keys = await getContextKeysForRuntime(state.runtime);
          } catch {
            keys = null;
          }
          if (token === revision && keys && (keys.workspaceKey || keys.folderKey)) {
            const canonical = buildSpaRoute({ ...state.route, context: keys });
            const current = `${locationInfo?.pathname || '/'}${locationInfo?.search || ''}`;
            if (canonical && canonical !== current) canonicalize(canonical);
          }
        }
        settleReady();
      }
      return snapshot();
    }
    let resolved = null;
    let failure = '';
    try {
      resolved = await resolveWorkspace(fromLocation.context);
    } catch (err) {
      failure = trimmed(err?.code) || trimmed(err?.message) || 'resolve-failed';
    }
    if (token !== revision) return snapshot();
    const paths = resolved && !resolved.error
      ? {
        workspaceFile: trimmed(resolved.workspaceFile),
        workspaceFolder: trimmed(resolved.workspaceFolder),
      }
      : null;
    if (paths && (paths.workspaceFile || paths.workspaceFolder)) {
      // The resolver may hand back the durable ids it matched; keep them so a
      // link that only pinned `ws` can canonicalize its resolved folder key too.
      const returnedKey = trimmed(resolved.workspaceKey);
      const returnedFolderKey = trimmed(resolved.folderKey);
      state = {
        ...state,
        context: {
          workspaceKey: state.context.workspaceKey || returnedKey,
          folderKey: state.context.folderKey || returnedFolderKey,
        },
        runtime: paths,
        status: VIEW_CONTEXT_STATUS.RESOLVED,
      };
      const canonical = buildSpaRoute({
        ...state.route,
        context: state.context,
        notFound: false,
      });
      const current = `${locationInfo?.pathname || '/'}${locationInfo?.search || ''}`;
      if (canonical && canonical !== current) {
        canonicalize(canonical);
      }
    } else {
      // Missing data preserves the target instead of re-pointing the view.
      state = {
        ...state,
        status: VIEW_CONTEXT_STATUS.MISSING_TARGET,
        conflict: {
          code: trimmed(resolved?.error) || failure || 'missing-data',
          workspaceKey: state.context.workspaceKey,
          folderKey: state.context.folderKey,
        },
      };
    }
    emitApplied();
    settleReady();
    return snapshot();
  }

  /**
   * Record a resource/workspace conflict for the CURRENT context: the explicit
   * scope is reported, never silently replaced. Returns the validation result.
   * Only the pending link target can conflict — after the operator navigates
   * on their own the old URL no longer owns the view.
   *
   * @param {'chat'|'todo'} kind
   * @param {object | null | undefined} row
   * @returns {{ ok: true } | { ok: false, kind: string, detail: string }}
   */
  function reportResourceConflict(kind, row) {
    if (!state.target) return { ok: true };
    const result = validateResourceAgainstContext(kind, row, state);
    if (result.ok) return result;
    state = {
      ...state,
      status: VIEW_CONTEXT_STATUS.CONFLICT,
      conflict: { code: result.detail, kind: result.kind },
    };
    emitApplied();
    return result;
  }

  /**
   * The operator left the deep-linked target with an action of their own
   * (sidebar click, popover switch, chat align). Keep the resolved runtime but
   * stop treating the old link as an ownership contract.
   */
  function clearRouteTarget() {
    if (!state.target) return;
    const token = ++revision;
    state = {
      ...state,
      revision: token,
      target: null,
      conflict: null,
      status: state.runtime.workspaceFile || state.runtime.workspaceFolder
        ? VIEW_CONTEXT_STATUS.RESOLVED
        : state.status,
    };
    emitApplied();
  }

  /**
   * Operator-driven workspace switch: cancel any in-flight route resolver, retire
   * the deep-link target and stamp runtime paths (and durable keys when known).
   *
   * @param {{ workspaceFile?: string, workspaceFolder?: string }} runtime
   * @param {{ workspaceKey?: string, folderKey?: string } | null | undefined} contextKeys
   */
  function applyUserWorkspaceSelection(runtime, contextKeys) {
    const token = ++revision;
    const keys = normalizeViewContext(contextKeys || {});
    state = {
      ...state,
      revision: token,
      source: 'user',
      target: null,
      conflict: null,
      context: keys.workspaceKey || keys.folderKey ? keys : { ...EMPTY_CONTEXT },
      runtime: {
        workspaceFile: trimmed(runtime?.workspaceFile),
        workspaceFolder: trimmed(runtime?.workspaceFolder),
      },
      status: VIEW_CONTEXT_STATUS.RESOLVED,
    };
    emitApplied();
  }

  return {
    getState: snapshot,
    getRevision: () => revision,
    /** @param {number} token */
    isCurrent: (token) => token === revision,
    applyRouteContext,
    reportResourceConflict,
    clearRouteTarget,
    applyUserWorkspaceSelection,
    whenReady: ensureReady,
    /**
     * Park a scoped boot pass until this tab's context really permits it: the
     * snapshot settles it as soon as an explicit `ws`/`folder` link resolves
     * (including a resolve that lands long after `whenReady()` timed out), and
     * a link that never resolves parks it forever rather than falling back to
     * the server's global cwd.
     *
     * @returns {Promise<object>} the first applied snapshot with scoped access
     */
    whenScopedAccessAllowed() {
      if (scopedAccessAllowedFor(state)) return Promise.resolve(snapshot());
      return new Promise((resolve) => { scopedWaiters.add(resolve); });
    },
    /** Set by the boot default pass so a URL without context is never gated on network. */
    markDefaultReady(runtime) {
      if (hasExplicitWorkspace(state.context)) return;
      state = {
        ...state,
        source: state.source || 'default',
        runtime: {
          workspaceFile: trimmed(runtime?.workspaceFile),
          workspaceFolder: trimmed(runtime?.workspaceFolder),
        },
        status: VIEW_CONTEXT_STATUS.RESOLVED,
      };
      settleReady();
    },
  };
}
