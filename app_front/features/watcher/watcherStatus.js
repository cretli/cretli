/**
 * Pure Workspace Watcher view helpers.
 *
 * Extracted from `watcherPanel.js` so the status mapping and the "Why?" table
 * can be unit-tested in Node without a DOM or SCSS import. Nothing here touches
 * `document`; the panel passes in the todo-title lookup and the escape helper.
 */

import { t } from '../../i18n/index.js';

export const WATCHER_MODES = ['off', 'observe', 'autopilot'];

/** Guardrails that mean "there is work but not right now", not "broken". */
export const WATCHER_WAIT_GUARDRAILS = new Set([
  'wait_quiet_hours',
  'wait_budget',
  'wait_cooldown',
  'wait_same_findings',
  'wait_harness_usage',
  'plan_gate',
  'wait_plan_approval',
]);

/**
 * @param {object | null | undefined} watcher
 * @returns {object[]}
 */
function liveWatcherCycles(watcher) {
  if (Array.isArray(watcher?.activeCycles) && watcher.activeCycles.length) return watcher.activeCycles;
  if (watcher?.activeCycle) return [watcher.activeCycle];
  return [];
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeWatcherHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeWatcherAttr(value) {
  return escapeWatcherHtml(value).replace(/'/g, '&#39;');
}

/**
 * Map one `GET /api/workspace-watcher` payload onto the top-bar status.
 *
 * @param {object | null | undefined} view
 * @param {(id: string) => string} [getTodoTitle]
 * @returns {{ key: 'off'|'paused'|'blocked'|'working'|'waiting'|'idle', label: string, reason: string, todoId: string, cycleCount?: number }}
 */
export function deriveWatcherStatus(view, getTodoTitle = () => '') {
  const watcher = view?.watcher || {};
  const guardrails = view?.guardrails || {};
  const mode = String(watcher.mode || 'off');
  if (mode === 'off') {
    return { key: 'off', label: t('todo.watcherStatusOff'), reason: '', todoId: '' };
  }
  if (watcher.paused === true) {
    return { key: 'paused', label: t('todo.watcherStatusPaused'), reason: '', todoId: '' };
  }
  const stopReason = String(watcher.stopReason || '').trim();
  if (stopReason) {
    return {
      key: 'blocked',
      label: t('todo.watcherStatusBlocked', { reason: stopReason }),
      reason: stopReason,
      todoId: '',
    };
  }
  const cycles = liveWatcherCycles(watcher);
  if (cycles.length) {
    const firstTodoId = String(cycles[0].todoIds?.[0] || '').trim();
    // One slot keeps the v1 "working on <title>" line; several slots are shown
    // as a count with the covered todos listed in the reason so the bar never
    // pretends only slot 0 exists.
    if (cycles.length > 1) {
      const titles = cycles
        .map((cycle) => String(cycle.todoIds?.[0] || '').trim())
        .filter(Boolean)
        .map((todoId) => getTodoTitle(todoId) || todoId.slice(0, 8));
      return {
        key: 'working',
        label: t('todo.watcherStatusWorkingMany', { count: cycles.length }),
        reason: titles.join(', '),
        todoId: firstTodoId,
        cycleCount: cycles.length,
      };
    }
    const title = (firstTodoId && getTodoTitle(firstTodoId)) || (firstTodoId ? firstTodoId.slice(0, 8) : '');
    return {
      key: 'working',
      label: title ? t('todo.watcherStatusWorking', { title }) : t('todo.watcherStatusIdle'),
      reason: '',
      todoId: firstTodoId,
      cycleCount: 1,
    };
  }
  const guardrailKind = String(guardrails.kind || '');
  if (WATCHER_WAIT_GUARDRAILS.has(guardrailKind)) {
    const reason = String(guardrails.reason || '').trim();
    const label = reason
      ? t('todo.watcherStatusWaitingReason', { reason })
      : t('todo.watcherStatusWaiting');
    return {
      key: 'waiting',
      label,
      reason: reason || guardrailKind,
      todoId: '',
    };
  }
  const readyCount = Number(view?.snapshot?.readyTodoCount) || 0;
  if (readyCount > 0) {
    return { key: 'waiting', label: t('todo.watcherStatusWaiting'), reason: '', todoId: '' };
  }
  return { key: 'idle', label: t('todo.watcherStatusIdle'), reason: '', todoId: '' };
}

/**
 * @param {object | null | undefined} view
 * @param {{ getTodoTitle?: (id: string) => string, whyOpen?: boolean }} [options]
 * @returns {string}
 */
export function renderWatcherBarHtml(view, options = {}) {
  const getTodoTitle = typeof options.getTodoTitle === 'function' ? options.getTodoTitle : () => '';
  const whyOpen = options.whyOpen === true;
  const watcher = view?.watcher || {};
  const status = deriveWatcherStatus(view, getTodoTitle);
  const modeOptions = WATCHER_MODES.map((mode) => (
    `<option value="${mode}"${String(watcher.mode || 'off') === mode ? ' selected' : ''}>${escapeWatcherHtml(t(`settings.watcherMode_${mode}`))}</option>`
  )).join('');
  const cycles = liveWatcherCycles(watcher);
  // Every live cycle gets its own orchestrator link; only an idle row (no live
  // slot) falls back to the row-level "last known" orchestrator.
  const cycleChatIds = cycles
    .map((cycle) => String(cycle.chatId || '').trim())
    .filter(Boolean);
  const chatIds = cycleChatIds.length
    ? cycleChatIds
    : [String(watcher.orchestratorChatId || '').trim()].filter(Boolean);
  const chatLink = chatIds.map((chatId) => (
    `<button type="button" class="todo-watcher-link" data-watcher-open-chat="${escapeWatcherAttr(chatId)}" title="${escapeWatcherAttr(t('todo.watcherOpenOrchestrator'))}">`
    + '<span class="mdi mdi-forum-outline" aria-hidden="true"></span>'
    + `<span class="todo-watcher-link-id">${escapeWatcherHtml(chatId.slice(0, 8))}</span>`
    + '</button>'
  )).join('');
  const cyclePill = cycles.length > 1
    ? `<span class="todo-watcher-pill" data-tone="working" data-watcher-cycle-count="${escapeWatcherAttr(String(cycles.length))}" title="${escapeWatcherAttr(t('todo.watcherStatusWorkingMany', { count: cycles.length }))}">${escapeWatcherHtml(String(cycles.length))}</span>`
    : '';
  const pauseLabel = watcher.paused === true ? t('todo.watcherResume') : t('todo.watcherPause');
  const pauseAction = watcher.paused === true ? 'resume' : 'pause';
  const pausedBadge = watcher.paused === true
    ? `<span class="todo-watcher-pill" data-tone="paused">${escapeWatcherHtml(t('todo.watcherStatusPaused'))}</span>`
    : '';

  return ''
    + '<span class="todo-watcher-title"><span class="mdi mdi-robot-outline" aria-hidden="true"></span>'
    + `${escapeWatcherHtml(t('todo.watcherBarTitle'))}</span>`
    + `<label class="todo-watcher-mode"><span class="todo-watcher-mode-label">${escapeWatcherHtml(t('todo.watcherMode'))}</span>`
    + `<select class="widget-panel-select" data-watcher-mode aria-label="${escapeWatcherAttr(t('todo.watcherMode'))}">${modeOptions}</select></label>`
    + `<span class="todo-watcher-status" data-state="${escapeWatcherAttr(status.key)}" title="${escapeWatcherAttr(status.reason || status.label)}">${escapeWatcherHtml(status.label)}</span>`
    + pausedBadge
    + cyclePill
    + '<span class="todo-watcher-spacer"></span>'
    + chatLink
    + `<button type="button" class="todo-watcher-btn" data-watcher-action="${pauseAction}">`
    + `<span class="mdi ${watcher.paused === true ? 'mdi-play' : 'mdi-pause'}" aria-hidden="true"></span>`
    + `<span>${escapeWatcherHtml(pauseLabel)}</span></button>`
    + `<button type="button" class="todo-watcher-btn" data-watcher-why aria-expanded="${whyOpen ? 'true' : 'false'}">`
    + '<span class="mdi mdi-help-circle-outline" aria-hidden="true"></span>'
    + `<span>${escapeWatcherHtml(t('todo.watcherWhy'))}</span></button>`;
}

/**
 * Reason column for decision logs: append blocking chat ids when persisted.
 *
 * @param {object | null | undefined} decision
 * @returns {string}
 */
export function formatWatcherDecisionReasonText(decision = {}) {
  const reason = String(decision?.reason ?? '').trim();
  const unknownChats = Array.isArray(decision?.unknownChats) ? decision.unknownChats : [];
  const slotChats = Array.isArray(decision?.slotChats) ? decision.slotChats : [];
  const unknownPart = unknownChats
    .map((row) => {
      const chatId = String(row?.chatId ?? '').trim();
      const chatReason = String(row?.reason ?? '').trim() || 'unknown';
      return chatId ? `${chatId}: ${chatReason}` : '';
    })
    .filter(Boolean)
    .join('; ');
  const slotPart = slotChats
    .map((row) => String(row?.chatId || row?.cycleId || '').trim())
    .filter(Boolean)
    .join('; ');
  const slotHolders = Array.isArray(decision?.slotHolders) ? decision.slotHolders : [];
  const holderPart = slotHolders
    .map((token) => String(token ?? '').trim())
    .filter(Boolean)
    .join('; ');
  const chatPart = [unknownPart, slotPart, holderPart].filter(Boolean).join('; ');
  if (!chatPart) return reason;
  return reason ? `${reason} — ${chatPart}` : chatPart;
}

/**
 * @param {object[]} decisions
 * @returns {string}
 */
export function renderWatcherDecisionsHtml(decisions = []) {
  const rows = Array.isArray(decisions) ? decisions : [];
  if (rows.length === 0) {
    return `<p class="todo-watcher-why-empty">${escapeWatcherHtml(t('todo.watcherWhyEmpty'))}</p>`;
  }
  const body = rows.map((row) => (
    `<tr><td class="todo-watcher-why-at">${escapeWatcherHtml(String(row?.at || ''))}</td>`
    + `<td class="todo-watcher-why-kind">${escapeWatcherHtml(String(row?.kind || ''))}</td>`
    + `<td class="todo-watcher-why-reason">${escapeWatcherHtml(formatWatcherDecisionReasonText(row))}</td></tr>`
  )).join('');
  return '<table class="todo-watcher-why-table"><thead><tr>'
    + `<th>${escapeWatcherHtml(t('todo.watcherDecisionAt'))}</th>`
    + `<th>${escapeWatcherHtml(t('todo.watcherDecisionKind'))}</th>`
    + `<th>${escapeWatcherHtml(t('todo.watcherDecisionReason'))}</th>`
    + `</tr></thead><tbody>${body}</tbody></table>`;
}
