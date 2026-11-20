/**
 * Scout scan history and the shared proposal inbox.
 */

import { ws } from './store.js';
import { t } from '../../../i18n/index.js';
import { SCOUT_INBOX_PAGE_SIZE, SCOUT_INBOX_SOURCE_PAGE_SIZE } from '../../watcher/scoutFindingsInboxView.js';
import { SCOUT_HISTORY_PAGE_SIZE, scoutScanCapacityExceeded } from '../../watcher/scoutHistoryView.js';
import { watcherApi } from './api.js';
import { SCOUT_PENDING_FINDINGS_CAPACITY } from './constants.js';
import { reloadScoutProfiles } from './scoutProfiles.js';

/* -------------------------------------------------------------------------- */
/* Scout scan history + shared inbox (stage 5.3)                              */
/* -------------------------------------------------------------------------- */

/**
 * @param {any | null | undefined} scoutMeta
 * @param {any[] | undefined} history
 * @returns {boolean}
 */
export function scoutInboxCapacityFlag(scoutMeta, history) {
  if (Array.isArray(history) && history.some((entry) => scoutScanCapacityExceeded(entry))) return true;
  return Number(scoutMeta?.pendingFindings) >= SCOUT_PENDING_FINDINGS_CAPACITY;
}

/**
 * @param {{ status?: number, json?: any | null } | null} res
 */
export function applyScoutHistoryResponse(res) {
  const next = { ...ws.scoutHistoryState, loading: false, busy: false };
  if (res?.json?.ok === true && Array.isArray(res.json.history)) {
    ws.scoutHistoryState = {
      ...next,
      error: '',
      history: res.json.history,
      total: Number(res.json.total) || res.json.history.length,
    };
    ws.scoutInboxState = {
      ...ws.scoutInboxState,
      capacityExceeded: scoutInboxCapacityFlag(ws.lastView?.scout, ws.scoutHistoryState.history),
    };
    return;
  }
  ws.scoutHistoryState = {
    ...next,
    error: res?.json?.error || t('settings.watcherScoutHistoryError'),
    history: [],
    total: 0,
  };
}

/**
 * @param {{ status?: number, json?: any | null } | null} res
 * @param {any | null | undefined} [scoutMeta]
 */
export function applyScoutInboxResponse(res, scoutMeta) {
  const next = { ...ws.scoutInboxState, loading: false, busy: false, busyId: '' };
  if (res?.json?.ok === true && Array.isArray(res.json.findings)) {
    ws.scoutInboxState = {
      ...next,
      error: '',
      findings: res.json.findings,
      total: Number(res.json.total) || res.json.findings.length,
      capacityExceeded: scoutInboxCapacityFlag(scoutMeta ?? ws.lastView?.scout, ws.scoutHistoryState.history),
    };
    return;
  }
  ws.scoutInboxState = {
    ...next,
    error: res?.json?.error || t('settings.watcherScoutInboxError'),
    findings: [],
    total: 0,
  };
}

/**
 * @returns {string}
 */
export function scoutHistoryFetchPath() {
  const params = new URLSearchParams();
  const scoutId = String(ws.scoutHistoryState.scoutId || '').trim();
  if (scoutId) params.set('scoutId', scoutId);
  const max = Math.max(SCOUT_HISTORY_PAGE_SIZE, Math.floor(Number(ws.scoutHistoryState.max) || SCOUT_HISTORY_PAGE_SIZE));
  params.set('max', String(max));
  const query = params.toString();
  return query
    ? `/api/workspace-watcher/scout/history?${query}`
    : `/api/workspace-watcher/scout/history?max=${max}`;
}

/**
 * @returns {string}
 */
export function scoutInboxFetchPath() {
  const params = new URLSearchParams();
  const scoutId = String(ws.scoutInboxState.scoutId || '').trim();
  const category = String(ws.scoutInboxState.category || '').trim();
  const status = String(ws.scoutInboxState.status || '').trim();
  if (scoutId) params.set('scoutId', scoutId);
  if (category) params.set('category', category);
  if (status) params.set('status', status);
  const max = Math.max(SCOUT_INBOX_PAGE_SIZE, Math.floor(Number(ws.scoutInboxState.max) || SCOUT_INBOX_PAGE_SIZE));
  params.set('max', String(max));
  return `/api/workspace-watcher/scout?${params.toString()}`;
}

export async function reloadScoutHistory() {
  ws.scoutHistoryState = { ...ws.scoutHistoryState, loading: true, error: '', busy: false };
  let res;
  try {
    res = await watcherApi(scoutHistoryFetchPath());
  } catch {
    res = null;
  }
  applyScoutHistoryResponse(res);
}

/**
 * @param {any | null | undefined} [scoutMeta]
 */
export async function reloadScoutInbox(scoutMeta) {
  ws.scoutInboxState = { ...ws.scoutInboxState, loading: true, error: '', busy: false, busyId: '' };
  let res;
  try {
    res = await watcherApi(scoutInboxFetchPath());
  } catch {
    res = null;
  }
  applyScoutInboxResponse(res, scoutMeta);
}

/**
 * @param {any | null | undefined} [scoutMeta]
 */
export async function refreshScoutHistoryAndInbox(scoutMeta) {
  await Promise.all([reloadScoutHistory(), reloadScoutInbox(scoutMeta)]);
}

/**
 * @param {string} action
 */
export async function runScoutHistoryAction(action) {
  if (action === 'history-reload') {
    ws.scoutHistoryState = { ...ws.scoutHistoryState, max: SCOUT_HISTORY_PAGE_SIZE, message: '', messageTone: 'ok' };
    await reloadScoutHistory();
    return;
  }
  if (action !== 'history-more') return;
  const base = Math.max(SCOUT_HISTORY_PAGE_SIZE, Math.floor(Number(ws.scoutHistoryState.max) || SCOUT_HISTORY_PAGE_SIZE));
  ws.scoutHistoryState = { ...ws.scoutHistoryState, max: base + SCOUT_HISTORY_PAGE_SIZE, busy: true, message: '', messageTone: 'ok' };
  await reloadScoutHistory();
}

/**
 * @param {string} todoId
 */
export function openScoutLinkedTodo(todoId) {
  const id = String(todoId || '').trim();
  if (!id) return;
  document.dispatchEvent(new CustomEvent('cretli-open-todo', { detail: { todoId: id }, bubbles: true }));
}

/**
 * @param {string} action
 * @param {string} [findingId]
 * @param {string} [todoId]
 */
export async function runScoutInboxAction(action, findingId = '', todoId = '') {
  if (action === 'inbox-reload') {
    ws.scoutInboxState = {
      ...ws.scoutInboxState,
      max: SCOUT_INBOX_PAGE_SIZE,
      expandedSources: {},
      message: '',
      messageTone: 'ok',
    };
    await reloadScoutInbox();
    return;
  }
  if (action === 'open-todo') {
    openScoutLinkedTodo(todoId);
    return;
  }
  if (action === 'inbox-sources-more') {
    const id = String(findingId || '').trim();
    if (!id) return;
    const prev = ws.scoutInboxState.expandedSources[id] || SCOUT_INBOX_SOURCE_PAGE_SIZE;
    ws.scoutInboxState = {
      ...ws.scoutInboxState,
      expandedSources: { ...ws.scoutInboxState.expandedSources, [id]: prev + SCOUT_INBOX_SOURCE_PAGE_SIZE },
    };
    return;
  }
  if (action === 'inbox-more') {
    const base = Math.max(SCOUT_INBOX_PAGE_SIZE, Math.floor(Number(ws.scoutInboxState.max) || SCOUT_INBOX_PAGE_SIZE));
    ws.scoutInboxState = { ...ws.scoutInboxState, max: base + SCOUT_INBOX_PAGE_SIZE, busy: true, message: '', messageTone: 'ok' };
    await reloadScoutInbox();
    return;
  }
  if (action !== 'inbox-accept' && action !== 'inbox-reject') return;
  const id = String(findingId || '').trim();
  if (!id) return;
  ws.scoutInboxState = { ...ws.scoutInboxState, busy: true, busyId: id, message: '', messageTone: 'ok' };
  let res;
  try {
    res = await watcherApi('/api/workspace-watcher/scout', {
      method: 'POST',
      body: { action: action === 'inbox-accept' ? 'accept' : 'reject', ids: [id] },
    });
  } catch {
    res = { status: 0, json: null };
  }
  if (res?.json?.ok === true) {
    ws.scoutInboxState = {
      ...ws.scoutInboxState,
      message: action === 'inbox-accept'
        ? t('settings.watcherScoutInboxAccepted')
        : t('settings.watcherScoutInboxRejected'),
      messageTone: 'ok',
    };
  } else {
    ws.scoutInboxState = {
      ...ws.scoutInboxState,
      message: res?.json?.error || t('settings.watcherActionError'),
      messageTone: 'error',
    };
  }
  await reloadScoutInbox();
  await reloadScoutProfiles();
}

/**
 * Server-side filter changes for history and inbox (native `<select>` controls).
 *
 * @param {HTMLElement} root
 */
export function bindScoutHistoryInboxFilters(root) {
  root.querySelector('#watcher-scout-history')?.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? /** @type {any} */ (event.target) : null;
    if (!target) return;
    if (target.getAttribute('data-scout-history-filter') !== 'scoutId') return;
    ws.scoutHistoryState = {
      ...ws.scoutHistoryState,
      scoutId: String(target.value || '').trim(),
      max: SCOUT_HISTORY_PAGE_SIZE,
      message: '',
      messageTone: 'ok',
    };
    void reloadScoutHistory();
  });
  root.querySelector('#watcher-scout-inbox')?.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? /** @type {any} */ (event.target) : null;
    if (!target) return;
    const filter = String(target.getAttribute('data-scout-inbox-filter') || '').trim();
    if (!filter || !['scoutId', 'category', 'status'].includes(filter)) return;
    ws.scoutInboxState = {
      ...ws.scoutInboxState,
      [filter]: String(target.value || '').trim(),
      max: SCOUT_INBOX_PAGE_SIZE,
      message: '',
      messageTone: 'ok',
    };
    void reloadScoutInbox();
  });
}
