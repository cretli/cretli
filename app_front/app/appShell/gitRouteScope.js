/** Git scope derived from the route, plus the window events that open Git/other panels. */
import { setGitScope } from '../../features/git/gitScope.js';
import { gitScopeFromViewContext } from './viewContext.js';
import { getViewContextState, isViewContextScopedAccessAllowed } from './viewContextBridge.js';
import { getSharedSpaNavigation } from './spaNavigationBridge.js';

/**
 * Deterministic Git scope from the route (stage 2): `/git` without `scope=`
 * shows the view context's workspace and releases any pin; `scope=chat|todo`
 * pins that id with the scope lock. Only route applies move the lock, so a
 * sidebar or active-chat refresh can never overwrite a pinned TODO scope.
 */
export function applyRouteGitScope() {
  // An explicit `ws`/`folder` link that has not resolved yet has no runtime
  // folder: applying its projection would hand the panel an empty scope, which
  // the Git route answers from the server's global cwd (another workspace).
  if (!isViewContextScopedAccessAllowed()) return;
  const state = getViewContextState();
  if (!state?.route || state.route.panel !== 'git') return;
  const projected = gitScopeFromViewContext(state);
  if (!projected) return;
  setGitScope(projected.scope, { lock: projected.lock });
}

/** Registers the shell-level window listeners (view-context, Git open, panel open). */
export function installRouteWindowListeners() {
  window.addEventListener('cretli-view-context-changed', () => applyRouteGitScope());
  window.addEventListener('cretli-git-open', () => {
    void getSharedSpaNavigation()?.navigate({ panel: 'git' }, { explicit: true });
  });
  window.addEventListener('cretli-git-show-worktrees', () => {
    void getSharedSpaNavigation()?.navigate({ panel: 'git', subview: 'worktrees' }, { explicit: true });
  });
  // Lets feature modules switch the visible panel with a full route payload.
  window.addEventListener('cretli-panel-open', (event) => {
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
    const panel = String(detail.panel || '').trim();
    if (!panel) return;
    void getSharedSpaNavigation()?.navigate({
      panel,
      settingsTab: detail.settingsTab,
      subview: detail.subview,
      context: detail.context,
      scope: detail.scope,
      resource: detail.resource,
      query: detail.query,
    }, { explicit: true });
  });
}
