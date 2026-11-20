import './cr-decision-stack.js';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { whenViewContextScopedAccessAllowed } from '../../app/appShell/viewContextBridge.js';
import { todoWorkspaceQuery } from '../todo/todoWorkspaceScope.js';
import { attachIntegrationRoots } from './decisionLogic.js';

let revision = -1;
let loading = false;
let refreshQueued = false;
/** Card the next render should reveal (set by "Open in the app" from car mode). */
let focusCardId = '';

/** @param {string} cardId */
export function focusDecisionCard(cardId) {
  focusCardId = String(cardId || '');
  applyFocus();
  // A card that never shows up (resolved meanwhile) must not hijack a later refresh.
  const pending = focusCardId;
  if (pending) setTimeout(() => { if (focusCardId === pending) focusCardId = ''; }, 10000);
}

function applyFocus() {
  if (!focusCardId) return;
  const stack = /** @type {any} */ (document.querySelector('cr-decision-stack'));
  if (!stack?.focusCard) return;
  const wanted = focusCardId;
  // Kept until the card element is rendered: the first refresh after a workspace switch may not list it yet.
  void stack.focusCard(wanted).then((done) => { if (done && focusCardId === wanted) focusCardId = ''; });
}

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
    applyFocus();
    stack?.setAutonomy(data.autonomy);
    try {
      const [metricsRes, historyRes] = await Promise.all([
        cretliApiFetch(`/api/decisions/metrics${query}`, { cache: 'no-store' }),
        cretliApiFetch(`/api/decisions/history${query}`, { cache: 'no-store' }),
      ]);
      stack?.setInsights({ metrics: metricsRes.ok ? (await metricsRes.json()).metrics : null, history: historyRes.ok ? (await historyRes.json()).items : [] });
    } catch { /* insights are optional */ }
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
