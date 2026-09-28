/**
 * Settings → Delegations: runtime health and repair actions.
 */

import {
  getDelegationRuntime,
  getWorkspaceDelegations,
  postDelegationAck,
  postDelegationCancel,
  postDelegationRetry,
  postDelegationRetryDelivery,
} from '../../api.js';
import { t } from '../../i18n/index.js';

const FILTERS = [
  ['', 'settings.delegationsFilterAll'],
  ['active', 'settings.delegationsFilterActive'],
  ['needs_input', 'settings.delegationsFilterInput'],
  ['failed', 'settings.delegationsFilterFailed'],
  ['uncertain', 'settings.delegationsFilterUncertain'],
  ['pending_delivery', 'settings.delegationsFilterDelivery'],
];

const PAGE_LIMIT = 40;

/** @type {Set<string>} */
const inflightActions = new Set();

/** @type {object[]} */
let loadedRows = [];
let nextCursor = '';
let confirmImpl = (message) => window.confirm(message);

/**
 * Test hook for confirmation prompts.
 *
 * @param {(message: string) => boolean} fn
 */
export function setDelegationCenterConfirm(fn) {
  confirmImpl = typeof fn === 'function' ? fn : (message) => window.confirm(message);
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @returns {{ workspaceFolder: string, workspaceFile: string }}
 */
function getActiveWorkspaceScope() {
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFolder: String(trigger?.dataset?.workspaceFolder || '').trim(),
    workspaceFile: String(trigger?.dataset?.workspaceFile || '').trim(),
  };
}

/**
 * @returns {void}
 */
function fillFilter() {
  const select = document.getElementById('delegation-center-filter');
  if (!select) return;
  const current = select.value != null ? String(select.value) : '';
  select.options = FILTERS.map(([value, key]) => ({ value, label: t(key) }));
  select.setAttribute('aria-label', t('settings.delegationsFilter'));
  select.value = current;
}

/**
 * @param {object} runtime
 */
function renderHealth(runtime) {
  const box = document.getElementById('delegation-runtime-health');
  if (!box) return;
  const processOn = runtime?.processAlive === true;
  const workerOn = runtime?.workerRunning === true || runtime?.worker?.running === true;
  const stale = runtime?.worker?.staleTick === true;
  const hung = runtime?.worker?.hungTick === true;
  const ready = runtime?.readiness === true || (runtime?.ok === true && !stale && !hung && String(runtime?.lifecycle?.state || '') === 'ready');
  const state = String(runtime?.lifecycle?.state || '');
  const counts = runtime?.counts || {};
  const lines = [
    processOn ? t('settings.delegationsServerUp') : t('settings.delegationsServerDown'),
    workerOn ? t('settings.delegationsWorkerOn') : t('settings.delegationsWorkerOff'),
    hung ? t('settings.delegationsTickHung') : (stale ? t('settings.delegationsTickStale') : t('settings.delegationsTickOk')),
    ready ? t('settings.delegationsReady') : t('settings.delegationsNotReady'),
    state === 'degraded' ? t('settings.delegationsDegraded') : '',
    state === 'initializing' ? t('settings.delegationsInitializing') : '',
    runtime?.code ? String(runtime.code) : '',
  ].filter(Boolean);
  box.innerHTML = `
    <ul class="delegation-center-health-list">
      ${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}
      <li>${escapeHtml(t('settings.delegationsCountsHint', {
        uncertainJobs: Number(counts.uncertainDelegations) || 0,
        failedJobs: Number(counts.failedDelegations) || 0,
        pendingMailbox: Number(counts.pendingMailbox) || 0,
        failedMailbox: Number(counts.failedMailbox) || 0,
      }))}</li>
    </ul>
  `;
}

/**
 * @param {object} row
 * @returns {string}
 */
function renderRow(row) {
  const id = escapeHtml(row.id);
  const status = String(row.status || '');
  const slotHeld = row.slotOccupied === true || row.runStopping === true;
  const canRetry = !slotHeld && ['completed', 'failed', 'interrupted', 'cancelled'].includes(status);
  // Stop is per job (slotHeld). Two active reviews each keep their own Stop; no bulk cancel.
  const canCancel = (row.active === true || slotHeld) && status !== 'cancelling';
  const canRetryDelivery = row.retryableDelivery === true
    || row.pendingOutbox === true
    || String(row.acceptState || '') === 'uncertain';
  const canAck = !String(row.acknowledgedAt || '').trim()
    && (status === 'completed' || status === 'failed' || status === 'interrupted');
  const mailboxId = escapeHtml(String(row.retryableMailboxId || ''));
  return `
    <article class="cr-card delegation-center-card" role="listitem" tabindex="0" data-delegation-id="${id}">
      <header class="delegation-center-card-head">
        <strong>${escapeHtml(status)}</strong>
        <span>${escapeHtml(row.executor?.model || row.executor?.transport || '')}</span>
      </header>
      <p class="cr-hint">${escapeHtml(row.error || row.sourceKind || '')}</p>
      <p class="cr-hint">${escapeHtml(t('settings.delegationsAttemptHint', { count: Number(row.attemptCount) || 0 }))}</p>
      <div class="delegation-center-actions">
        ${canCancel ? `<cr-bar-button data-act="cancel" data-id="${id}">${escapeHtml(t('chat.delegationCancel'))}</cr-bar-button>` : ''}
        ${canAck ? `<cr-bar-button data-act="ack" data-id="${id}">${escapeHtml(t('chat.delegationAcknowledge'))}</cr-bar-button>` : ''}
        ${canRetry ? `<cr-bar-button data-act="retry-task" data-id="${id}">${escapeHtml(t('settings.delegationsRetryTask'))}</cr-bar-button>` : ''}
        ${canRetryDelivery ? `<cr-bar-button data-act="retry-delivery" data-id="${id}" data-mailbox-id="${mailboxId}" data-attempt-id="${escapeHtml(String(row.attemptId || ''))}">${escapeHtml(t('settings.delegationsRetryDelivery'))}</cr-bar-button>` : ''}
      </div>
    </article>
  `;
}

/**
 * @param {boolean} append
 */
function paintList(append) {
  const list = document.getElementById('delegation-center-list');
  const more = document.getElementById('delegation-center-more');
  if (!list) return;
  if (!append) {
    list.innerHTML = loadedRows.length
      ? loadedRows.map(renderRow).join('')
      : `<p class="cr-hint">${escapeHtml(t('settings.delegationsEmpty'))}</p>`;
  } else {
    const empty = list.querySelector('.cr-hint');
    if (empty && loadedRows.length) empty.remove();
    const extra = loadedRows.slice(-PAGE_LIMIT).map(renderRow).join('');
    list.insertAdjacentHTML('beforeend', extra);
  }
  if (more) more.hidden = !nextCursor;
}

/**
 * @param {{ append?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function refreshDelegationCenter(options = {}) {
  const list = document.getElementById('delegation-center-list');
  const status = document.getElementById('delegation-center-status');
  const filter = document.getElementById('delegation-center-filter');
  if (!list) return;
  fillFilter();
  const append = options.append === true && nextCursor;
  if (!append) {
    loadedRows = [];
    nextCursor = '';
  }
  const attention = filter?.value != null ? String(filter.value || '') : '';
  const scope = getActiveWorkspaceScope();
  const [runtime, rows] = await Promise.all([
    getDelegationRuntime(scope),
    getWorkspaceDelegations({
      attention,
      limit: PAGE_LIMIT,
      cursor: append ? nextCursor : '',
      ...scope,
    }),
  ]);
  if (runtime?.ok) renderHealth(runtime.runtime || runtime);
  if (rows?.ok === false) {
    if (status) status.textContent = String(rows.error || t('settings.delegationsActionError'));
    return;
  }
  const items = Array.isArray(rows?.delegations) ? rows.delegations : [];
  loadedRows = append ? [...loadedRows, ...items] : items;
  nextCursor = String(rows?.nextCursor || '');
  paintList(append);
  if (status) status.textContent = '';
}

/**
 * @param {Element} target
 * @param {boolean} disabled
 */
function setActionDisabled(target, disabled) {
  if ('disabled' in target) target.disabled = disabled;
  if (disabled) target.setAttribute('disabled', '');
  else target.removeAttribute('disabled');
}

/**
 * Resolve the action host even when the click starts inside a Shadow DOM button.
 *
 * @param {Event} event
 * @returns {Element | null}
 */
function actionTargetFromEvent(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const node of path) {
    if (node instanceof Element && node.hasAttribute('data-act')) return node;
  }
  if (!(event.target instanceof Element)) return null;
  return event.target.closest('[data-act]');
}

/**
 * @param {string} act
 * @param {object} row
 * @returns {string}
 */
function confirmMessage(act, row) {
  if (act === 'retry-delivery') return t('settings.delegationsConfirmRetryDeliveryUncertain');
  if (act === 'retry-task') return t('settings.delegationsConfirmRetryTask');
  if (act === 'cancel') return t('settings.delegationsConfirmStop');
  if (act === 'ack') return t('settings.delegationsConfirmAck');
  return t('settings.delegationsConfirmGeneric');
}

/**
 * @param {MouseEvent} event
 */
async function onListClick(event) {
  const target = actionTargetFromEvent(event);
  if (!target) return;
  const id = String(target.getAttribute('data-id') || '');
  const act = String(target.getAttribute('data-act') || '');
  if (!id || !act) return;
  const row = loadedRows.find((item) => String(item.id) === id) || {};
  if (!confirmImpl(confirmMessage(act, row))) return;
  const mailboxId = String(target.getAttribute('data-mailbox-id') || '');
  const key = act === 'retry-delivery' ? `${act}:${id}:${mailboxId}` : `${act}:${id}`;
  if (inflightActions.has(key)) return;
  inflightActions.add(key);
  setActionDisabled(target, true);
  const status = document.getElementById('delegation-center-status');
  if (status) status.textContent = t('settings.delegationsActionPending');
  try {
    /** @type {{ ok?: boolean, error?: string, status?: number }} */
    let result = { ok: true };
    if (act === 'cancel') result = await postDelegationCancel(id);
    if (act === 'ack') result = await postDelegationAck(id, { reason: 'reviewed' });
    if (act === 'retry-task') result = await postDelegationRetry(id);
    if (act === 'retry-delivery') {
      result = await postDelegationRetryDelivery(id, {
        mailboxId,
        attemptId: String(target.getAttribute('data-attempt-id') || row.attemptId || ''),
      });
    }
    if (result && result.ok === false && status) {
      status.textContent = String(result.error || t('settings.delegationsActionError'));
    }
  } catch (err) {
    if (status) status.textContent = String(err?.message || t('settings.delegationsActionError'));
  } finally {
    try {
      await refreshDelegationCenter();
    } finally {
      inflightActions.delete(key);
    }
  }
}

/**
 * @param {KeyboardEvent} event
 */
function onListKeydown(event) {
  const list = event.currentTarget;
  if (!(list instanceof HTMLElement)) return;
  const cards = [...list.querySelectorAll('[data-delegation-id]')];
  if (!cards.length) return;
  const current = event.target instanceof Element
    ? event.target.closest('[data-delegation-id]')
    : null;
  const index = current ? cards.indexOf(current) : -1;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = Math.min(cards.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
    const next = cards[nextIndex];
    if (next instanceof HTMLElement) next.focus();
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && current && event.target === current) {
    event.preventDefault();
    const btn = current.querySelector('[data-act]');
    if (btn instanceof HTMLElement) btn.click();
  }
}

export function initDelegationCenter() {
  fillFilter();
  const refresh = document.getElementById('delegation-center-refresh');
  const filter = document.getElementById('delegation-center-filter');
  const list = document.getElementById('delegation-center-list');
  const more = document.getElementById('delegation-center-more');
  refresh?.addEventListener('click', () => {
    void refreshDelegationCenter();
  });
  filter?.addEventListener('change', () => {
    void refreshDelegationCenter();
  });
  filter?.addEventListener('cr-change', () => {
    void refreshDelegationCenter();
  });
  list?.addEventListener('click', (event) => {
    void onListClick(event);
  });
  list?.addEventListener('keydown', onListKeydown);
  more?.addEventListener('click', () => {
    void refreshDelegationCenter({ append: true });
  });
  window.addEventListener('cr-lang-changed', () => {
    fillFilter();
    void refreshDelegationCenter();
  });
}
