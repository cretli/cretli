/**
 * Settings → Account: check GitHub and apply the same update as Termux.
 */

import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { showChoiceDialog } from '../../lib/choiceDialog.js';

const POLL_MS = 2000;

/**
 * @typedef {object} AppUpdateEls
 * @property {HTMLElement} root
 * @property {HTMLElement|null} version
 * @property {HTMLElement|null} localSha
 * @property {HTMLElement|null} remoteSha
 * @property {HTMLElement|null} summary
 * @property {HTMLElement|null} status
 * @property {HTMLElement|null} log
 * @property {HTMLElement|null} checkBtn
 * @property {HTMLElement|null} applyBtn
 */

/**
 * @returns {AppUpdateEls|null}
 */
function queryEls() {
  const root = document.getElementById('settings-app-update');
  if (!root) return null;
  return {
    root,
    version: document.getElementById('app-update-version'),
    localSha: document.getElementById('app-update-local-sha'),
    remoteSha: document.getElementById('app-update-remote-sha'),
    summary: document.getElementById('app-update-summary'),
    status: document.getElementById('app-update-status'),
    log: document.getElementById('app-update-log'),
    checkBtn: document.getElementById('app-update-check-btn'),
    applyBtn: document.getElementById('app-update-apply-btn'),
  };
}

/**
 * @param {HTMLElement|null} el
 * @param {string} text
 */
function setText(el, text) {
  if (!el) return;
  el.textContent = text;
}

/**
 * @param {HTMLElement|null} el
 * @param {boolean} disabled
 */
function setDisabled(el, disabled) {
  if (!el) return;
  el.disabled = disabled;
}

/**
 * @param {object|null} data
 * @returns {string}
 */
function summaryFor(data) {
  if (!data?.isRepo) return t('settings.appUpdateNoRepo');
  if (data.busy) return t('settings.appUpdateBusy');
  if (data.phase === 'done' && data.canRestart === false) return t('settings.appUpdateDoneManual');
  if (data.phase === 'done') return t('settings.appUpdateDone');
  if (data.phase === 'error' || data.error) return data.error || t('settings.appUpdateError');
  if (data.fetchError) return data.fetchError;
  if (data.behind) return t('settings.appUpdateBehind');
  if (data.localSha && data.remoteSha) return t('settings.appUpdateUpToDate');
  return '';
}

/**
 * @param {AppUpdateEls} els
 * @param {object|null} data
 * @param {string} [statusText]
 */
function renderStatus(els, data, statusText = '') {
  setText(els.version, data?.version || '—');
  setText(els.localSha, data?.localSha || '—');
  setText(els.remoteSha, data?.remoteSha || '—');
  setText(els.summary, summaryFor(data));
  setText(els.status, statusText);
  const lines = Array.isArray(data?.logTail) ? data.logTail : [];
  if (els.log) {
    els.log.hidden = lines.length === 0;
    els.log.textContent = lines.join('\n');
  }
  const busy = Boolean(data?.busy);
  setDisabled(els.checkBtn, busy);
  setDisabled(els.applyBtn, busy || !data?.canApply);
}

/**
 * @param {AppUpdateEls} els
 * @param {boolean} [check]
 */
async function refreshStatus(els, check = false) {
  const data = await api.getUpdateStatus({ check });
  renderStatus(els, data, check ? '' : (els.status?.textContent || ''));
  return data;
}

/**
 * @param {AppUpdateEls} els
 */
async function pollUntilIdle(els) {
  let data = await refreshStatus(els, false);
  while (data?.busy) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    data = await refreshStatus(els, false);
  }
  if (data?.phase === 'error' || data?.error) {
    renderStatus(els, data, t('settings.appUpdateError'));
    return data;
  }
  if (data?.canRestart === false) {
    renderStatus(els, data, t('settings.appUpdateDoneManual'));
    return data;
  }
  renderStatus(els, data, t('settings.appUpdateDone'));
  return data;
}

/**
 * Initialize the Account update block.
 */
export function initAppUpdateSettings() {
  const els = queryEls();
  if (!els) return;
  refreshStatus(els, false)
    .then((data) => {
      if (data?.busy) return pollUntilIdle(els);
      return data;
    })
    .catch(() => {});
  els.checkBtn?.addEventListener('click', async () => {
    if (els.checkBtn?.disabled) return;
    setDisabled(els.checkBtn, true);
    setText(els.status, t('settings.appUpdateChecking'));
    try {
      await refreshStatus(els, true);
    } catch (err) {
      setText(els.status, err?.message || t('settings.appUpdateError'));
    } finally {
      setDisabled(els.checkBtn, false);
    }
  });
  els.applyBtn?.addEventListener('click', async () => {
    if (els.applyBtn?.disabled) return;
    const choice = await showChoiceDialog({
      heading: t('settings.appUpdateConfirmTitle'),
      body: t('settings.appUpdateConfirmBody'),
      cancelLabel: t('settings.appUpdateConfirmCancel'),
      options: [{
        value: 'apply',
        label: t('settings.appUpdateConfirmApply'),
        variant: 'danger',
      }],
    });
    if (choice !== 'apply') return;
    setDisabled(els.applyBtn, true);
    setDisabled(els.checkBtn, true);
    setText(els.status, t('settings.appUpdateBusy'));
    try {
      await api.postUpdateApply();
      await pollUntilIdle(els);
    } catch (err) {
      setText(els.status, err?.message || t('settings.appUpdateError'));
      setDisabled(els.applyBtn, false);
      setDisabled(els.checkBtn, false);
    }
  });
}
