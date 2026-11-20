/**
 * Settings → Usage: paints the delegation outcomes panel (model × role table,
 * cards, unused models and the loop table) from the stats payload.
 */

import { getCurrentLang, t } from '../../../i18n/index.js';
import { renderUsage } from '../usageDom.js';
import {
  delegationLoopLeaves,
  delegationLoopViewState,
  delegationStatsRows,
  delegationStatsUnused,
  delegationStatsUnusedState,
  delegationStatsViewState,
  renderDelegationLoopCardsView,
  renderDelegationLoopHeadView,
  renderDelegationLoopRowsView,
  renderDelegationStatsCardsView,
  renderDelegationStatsHeadView,
  delegationStatsMetaText,
  renderDelegationStatsRowsView,
  renderDelegationUnusedView,
} from '../delegationStatsView.js';

/** @param {string} id @returns {any} */
const byId = (id) => document.getElementById(id);

/**
 * Per-section loading/error/content toggle for the delegation model × role
 * panel. The panel lives inside the Usage tab but has its own endpoint, so it
 * keeps its own state instead of hiding the whole tab.
 *
 * @param {'loading'|'ready'|'error'} view
 * @returns {void}
 */
export function setDelegationStatsView(view) {
  const loadingEl = byId('delegation-stats-loading');
  const errorEl = byId('delegation-stats-error');
  const errorTextEl = byId('delegation-stats-error-text');
  const contentEl = byId('delegation-stats-content');
  if (loadingEl) loadingEl.hidden = view !== 'loading';
  if (errorEl) errorEl.hidden = view !== 'error';
  if (contentEl) contentEl.hidden = view !== 'ready';
  if (view === 'error' && errorTextEl) errorTextEl.textContent = t('delegationStats.loadFailed');
}

/**
 * @param {PromiseSettledResult<any>} result
 * @returns {void}
 */
export function renderDelegationStats(result) {
  if (result.status === 'rejected' || result.value?.ok !== true) {
    const reason = result.status === 'rejected'
      ? result.reason?.message || String(result.reason)
      : (result.value?.error || 'delegations stats request failed');
    console.warn('[usage] delegation stats failed:', reason);
    setDelegationStatsView('error');
    return;
  }
  const payload = result.value;
  const rows = delegationStatsRows(payload);
  const hasRows = delegationStatsViewState(payload) === 'ready';
  const lang = getCurrentLang();
  const metaEl = byId('delegation-stats-meta');
  if (metaEl) metaEl.textContent = delegationStatsMetaText(payload, t);
  const head = byId('delegation-stats-head');
  if (head) renderUsage(head, renderDelegationStatsHeadView(t));
  const body = byId('delegation-stats-body');
  if (body) renderUsage(body, renderDelegationStatsRowsView(rows, t, lang));
  const cards = byId('delegation-stats-cards');
  if (cards) renderUsage(cards, renderDelegationStatsCardsView(rows, t, lang));
  const unusedEl = byId('delegation-stats-unused-list');
  if (unusedEl) {
    renderUsage(unusedEl, renderDelegationUnusedView(
      delegationStatsUnused(payload),
      t,
      delegationStatsUnusedState(payload),
    ));
  }
  const table = byId('delegation-stats-table');
  if (table) table.hidden = !hasRows;
  if (cards) cards.hidden = !hasRows;
  const emptyEl = byId('delegation-stats-empty');
  if (emptyEl) emptyEl.hidden = hasRows;
  const loopLeaves = delegationLoopLeaves(payload);
  const hasLoop = delegationLoopViewState(payload) === 'ready';
  const loopHead = byId('delegation-loop-head');
  if (loopHead) renderUsage(loopHead, renderDelegationLoopHeadView(t));
  const loopBody = byId('delegation-loop-body');
  if (loopBody) renderUsage(loopBody, renderDelegationLoopRowsView(loopLeaves, t, lang));
  const loopCards = byId('delegation-loop-cards');
  if (loopCards) renderUsage(loopCards, renderDelegationLoopCardsView(loopLeaves, t, lang));
  const loopTable = byId('delegation-loop-table');
  if (loopTable) loopTable.hidden = !hasLoop;
  if (loopCards) loopCards.hidden = !hasLoop;
  const loopEmpty = byId('delegation-loop-empty');
  if (loopEmpty) loopEmpty.hidden = hasLoop;
  setDelegationStatsView('ready');
}
