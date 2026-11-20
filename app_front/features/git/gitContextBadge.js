/**
 * Compact chat/task Git context chip in the sidebar branch row.
 *
 * It reads the active chat, asks the Git route for that chat's authorized
 * scope and shows a clickable chip that opens the existing Git panel. A late
 * answer for a previous chat is dropped through a request sequence, so
 * switching chats quickly never paints stale data.
 */

import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { probeStart, probeEnd } from '../../lib/perfProbe.js';
import { buildGitScopeKey, getGitScope, isGitScopeLocked, setGitScope } from './gitScope.js';
import { gitScopeFromViewContext } from '../../app/appShell/viewContext.js';
import { syncWorkspaceBarVisibility } from '../../app/appShell/workspaceBranchBadge.js';
import {
  getViewContextState,
  isViewContextScopedAccessAllowed,
} from '../../app/appShell/viewContextBridge.js';
import {
  deriveGitContextBadge,
  resolveChatGitScope,
  shouldShowGitContextBadge,
  shouldShowSidebarGitBadge,
} from './gitContextView.js';

let requestSeq = 0;
/** Last scope key we attempted, so frequent sidebar renders do not refetch. */
let lastAttemptKey = '';
/** How long a scope's Git info may be repainted without asking the server again. */
const INFO_CACHE_TTL_MS = 15000;
/** @type {Map<string, { info: object, at: number }>} */
const infoCache = new Map();
/** @type {{ scope: object | null, info: object | null }} */
let lastState = { scope: null, info: null };
let deps = {
  getActiveChat: () => null,
  getActiveWorkspaceFolder: () => '',
};

/**
 * @param {{
 *   getActiveChat?: () => object | null,
 *   getActiveWorkspaceFolder?: () => string,
 * }} [options]
 * @returns {{ refresh: () => Promise<void> }}
 */
export function initGitContextBadge(options = {}) {
  if (typeof options.getActiveChat === 'function') deps.getActiveChat = options.getActiveChat;
  if (typeof options.getActiveWorkspaceFolder === 'function') {
    deps.getActiveWorkspaceFolder = options.getActiveWorkspaceFolder;
  }
  const el = document.getElementById('header-git-badge');
  if (el && el.dataset.bound !== '1') {
    el.dataset.bound = '1';
    el.addEventListener('click', onBadgeClick);
  }
  window.addEventListener('cretli-active-workspace-changed', () => {
    void refreshGitContextBadge({ force: true });
  });
  // Any Git mutation seen by the Git panel makes cached chip data stale.
  window.addEventListener('cretli-git-changed', () => infoCache.clear());
  window.addEventListener('cr-lang-changed', () => {
    void refreshGitContextBadge({ force: true });
  });
  return { refresh: refreshGitContextBadge };
}

function hideBadge() {
  const el = document.getElementById('header-git-badge');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
  el.removeAttribute('title');
  delete el.dataset.kind;
  lastState = { scope: null };
  syncWorkspaceBarVisibility();
}

/**
 * Last painted execution-badge state (chat/worktree scope), so the workspace
 * branch chip can hide itself when it would duplicate the same branch of the
 * same repository. Read-only snapshot; null when nothing is shown.
 *
 * @returns {{ scope: object | null, info: object | null }}
 */
export function getGitContextBadgeSnapshot() {
  if (!lastState.scope) return { scope: null, info: null };
  return { scope: lastState.scope, info: lastState.info || null };
}

function onBadgeClick() {
  if (!lastState.scope) return;
  setGitScope(lastState.scope, { lock: false });
  window.dispatchEvent(new CustomEvent('cretli-git-open', { detail: { scope: lastState.scope } }));
}

/**
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function refreshGitContextBadge(options = {}) {
  const probe = probeStart('shell.gitContextBadge.refresh');
  try {
    await refreshGitContextBadgeImpl(options);
  } finally {
    probeEnd(probe);
  }
}

async function refreshGitContextBadgeImpl(options = {}) {
  const el = document.getElementById('header-git-badge');
  if (!el) return;
  // An explicit `ws`/`folder` link owns this tab's Git scope. Until it resolves
  // there is no authorized folder to ask about, and the route would answer from
  // the server's global cwd (another workspace's branch), so the chip keeps the
  // pending state and issues no request. The key reset lets the late resolve
  // refresh the badge instead of being swallowed as "already attempted".
  if (!isViewContextScopedAccessAllowed()) {
    lastAttemptKey = '';
    hideBadge();
    return;
  }
  const chat = deps.getActiveChat();
  const scope = resolveChatGitScope(chat, deps.getActiveWorkspaceFolder());
  // A pinned scope (route `scope=chat|todo` or a task chip) survives sidebar
  // and active-chat refreshes: it only releases through a deterministic route
  // apply (open/reset), never because some other row repainted.
  const viewState = getViewContextState();
  const routeGit = viewState?.route?.panel === 'git' ? gitScopeFromViewContext(viewState) : null;
  const routeWorkspaceGit = Boolean(routeGit && !routeGit.lock);
  if (isGitScopeLocked()) {
    const locked = getGitScope();
    if (locked.todoId && scope.todoId !== locked.todoId) return;
    if (locked.chatId && scope.chatId !== locked.chatId) return;
  }
  const effectiveScope = routeWorkspaceGit ? getGitScope() : scope;
  const key = buildGitScopeKey(effectiveScope);
  // The sidebar render hook fires very often; only a scope change (or an
  // explicit force from a workspace/language event) refetches.
  if (!options.force && key === lastAttemptKey) return;
  lastAttemptKey = key;
  // Follow the active chat, or a forced workspace change. An explicit task scope
  // pinned from a TODO card is not overwritten while no chat is active.
  if (routeWorkspaceGit) {
    // `/git` without `scope=` is owned by the route apply — never infer active chat.
  } else if (isGitScopeLocked()) {
    // Same pinned id: fetch badge data only; do not call setGitScope (would unlock).
  } else if (scope.chatId || options.force) {
    setGitScope(scope, { lock: false });
  }
  const seq = ++requestSeq;
  // Switching back to a chat seen moments ago repaints from the last answer
  // instead of a round trip; a forced refresh (workspace/language) always asks.
  const cached = options.force ? null : infoCache.get(key);
  let info = null;
  if (cached && Date.now() - cached.at < INFO_CACHE_TTL_MS) {
    info = cached.info;
  } else {
    try {
      info = await api.getGitInfo(effectiveScope);
    } catch {
      if (seq === requestSeq) hideBadge();
      return;
    }
    if (seq !== requestSeq) return;
    if (info?.ok) {
      if (infoCache.size >= 32) infoCache.delete(infoCache.keys().next().value);
      infoCache.set(key, { info, at: Date.now() });
    }
  }
  if (!info?.ok || (effectiveScope.chatId && !shouldShowGitContextBadge(info))) {
    hideBadge();
    return;
  }
  if (!effectiveScope.chatId) {
    const branch = String(info.worktree?.branch || info.branch || '').trim();
    if (!branch) {
      hideBadge();
      return;
    }
    // The workspace branch chip next to it already shows this branch: keep
    // the state (panel scope, worktree bar snapshot) but paint nothing.
    const label = t('git.contextGlobal');
    lastState = { scope: effectiveScope, info };
    el.hidden = true;
    el.textContent = branch;
    el.title = `${label}: ${branch}`;
    el.dataset.kind = 'workspace';
    el.setAttribute('aria-label', `${label}: ${branch}`);
    syncWorkspaceBarVisibility();
    return;
  }
  const badge = deriveGitContextBadge(info, t);
  lastState = { scope: effectiveScope, info };
  el.hidden = !shouldShowSidebarGitBadge(info, deps.getActiveWorkspaceFolder());
  el.textContent = badge.branch ? `${badge.label} · ${badge.branch}` : badge.label;
  el.title = badge.title;
  el.dataset.kind = badge.kind;
  el.setAttribute('aria-label', badge.title);
  syncWorkspaceBarVisibility();
}
