/**
 * Compact branch/worktree indicator in the chat header.
 *
 * It reads the active chat, asks the Git route for that chat's authorized
 * scope and shows a clickable chip that opens the existing Git panel. A late
 * answer for a previous chat is dropped through a request sequence, so
 * switching chats quickly never paints stale data.
 */

import * as api from './core/api/index.js';
import { t } from './i18n/index.js';
import { buildGitScopeKey, isGitScopeLocked, setGitScope } from './features/git/gitScope.js';
import {
  deriveGitContextBadge,
  resolveChatGitScope,
  shouldShowGitContextBadge,
} from './features/git/gitContextView.js';

let requestSeq = 0;
/** Last scope key we attempted, so frequent sidebar renders do not refetch. */
let lastAttemptKey = '';
/** @type {{ scope: object | null }} */
let lastState = { scope: null };
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
  const el = document.getElementById('header-git-badge');
  if (!el) return;
  const chat = deps.getActiveChat();
  const scope = resolveChatGitScope(chat, deps.getActiveWorkspaceFolder());
  const key = buildGitScopeKey(scope);
  // The sidebar render hook fires very often; only a scope change (or an
  // explicit force from a workspace/language event) refetches.
  if (!options.force && key === lastAttemptKey) return;
  lastAttemptKey = key;
  // Follow the active chat, or a forced workspace change. An explicit task scope
  // pinned from a TODO card is not overwritten while no chat is active.
  if (scope.chatId || options.force) {
    setGitScope(scope, { lock: false });
  } else if (isGitScopeLocked()) {
    return;
  }
  const seq = ++requestSeq;
  let info = null;
  try {
    info = await api.getGitInfo(scope);
  } catch {
    if (seq === requestSeq) hideBadge();
    return;
  }
  if (seq !== requestSeq) return;
  if (!info?.ok || (scope.chatId && !shouldShowGitContextBadge(info))) {
    hideBadge();
    return;
  }
  if (!scope.chatId) {
    const branch = String(info.worktree?.branch || info.branch || '').trim();
    if (!branch) {
      hideBadge();
      return;
    }
    const label = t('git.contextGlobal');
    lastState = { scope };
    el.hidden = false;
    el.textContent = branch;
    el.title = `${label}: ${branch}`;
    el.dataset.kind = 'workspace';
    el.setAttribute('aria-label', `${label}: ${branch}`);
    return;
  }
  const badge = deriveGitContextBadge(info, t);
  lastState = { scope };
  el.hidden = false;
  el.textContent = badge.branch ? `${badge.label} · ${badge.branch}` : badge.label;
  el.title = badge.title;
  el.dataset.kind = badge.kind;
  el.setAttribute('aria-label', badge.title);
}
