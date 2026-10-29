import './cr-decision-stack.js';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { whenViewContextScopedAccessAllowed } from '../../app/appShell/viewContextBridge.js';
import { todoWorkspaceQuery } from '../todo/todoWorkspaceScope.js';
import { attachIntegrationRoots } from './decisionLogic.js';

let revision = -1;
let loading = false;
let refreshQueued = false;

export async function refreshDecisionsPanel() {
  if (loading) { refreshQueued = true; return; }
  loading = true;
  try {
    await whenViewContextScopedAccessAllowed();
    const query = todoWorkspaceQuery();
    const response = await cretliApiFetch(`/api/decisions${query}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    revision = Math.max(revision, Number(data.revision) || 0);
    let cards = Array.isArray(data.items) ? data.items : [];
    if (cards.some((card) => card.kind === 'integration')) {
      const separator = query ? '&' : '?';
      const todosResponse = await cretliApiFetch(`/api/todos${query}${separator}slim=1`, { cache: 'no-store' });
      if (todosResponse.ok) {
        const todos = await todosResponse.json();
        cards = attachIntegrationRoots(cards, todos.items);
      }
    }
    const stack = /** @type {import('./cr-decision-stack.js').CrDecisionStack | null} */ (document.querySelector('cr-decision-stack'));
    stack?.setCards(cards);
    const badge = document.getElementById('header-decisions-badge');
    if (badge) { badge.textContent = String(cards.length); badge.hidden = cards.length === 0; }
  } catch {
    const stack = /** @type {import('./cr-decision-stack.js').CrDecisionStack | null} */ (document.querySelector('cr-decision-stack'));
    if (stack) stack.notice = t('decisions.loadError');
  } finally {
    loading = false;
    if (refreshQueued) { refreshQueued = false; void refreshDecisionsPanel(); }
  }
}

export function initDecisionsPanel() {
  document.querySelector('cr-decision-stack')?.addEventListener('cr-decisions-refresh', refreshDecisionsPanel);
  window.addEventListener('cr-decisions-changed', (event) => {
    if (Number((/** @type {CustomEvent} */ (event)).detail?.revision) > revision) void refreshDecisionsPanel();
  });
  window.addEventListener('focus', () => void refreshDecisionsPanel());
  window.addEventListener('cretli-view-context-changed', () => void refreshDecisionsPanel());
  void refreshDecisionsPanel();
}
