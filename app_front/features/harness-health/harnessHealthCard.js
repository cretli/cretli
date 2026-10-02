/**
 * Settings → Harness: visible limit status and expandable statistics.
 *
 * One `GET /api/harnesses/health` request feeds every expanded row; the
 * payload is memoized by `harnessHealthCache.js` for
 * `HARNESS_HEALTH_CACHE_TTL_MS`. Expanding a row for the first time (or pressing
 * Refresh) triggers a load, and a failed load only affects the open card — it
 * never clears the harness list itself.
 *
 * The card is appended inside the harness row `<li>`; `attachHarnessHealthRow`
 * tags that row with `.harness-health-row`, which lays the controls out on one
 * grid line and lets the card span the full width underneath. The drag handle
 * keeps reordering whole rows (card included).
 */

import { getHarnessHealth, clearHarnessUsageLimit } from '../../api.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import { addDaysIso } from '../usage/usageCharts.js';
import {
  HARNESS_HEALTH_RANGE_DAYS,
  buildHealthCardModel,
  renderHealthCardHtml,
} from './harnessHealthModel.js';
import {
  HARNESS_HEALTH_CACHE_TTL_MS,
  createHarnessHealthCache,
} from './harnessHealthCache.js';

export { HARNESS_HEALTH_CACHE_TTL_MS };

/** @type {Map<string, { harnessId: string, label: string, toggle: HTMLElement, card: HTMLElement, summary: HTMLElement, state: string, notice: string }>} */
const cards = new Map();
/** @type {Set<string>} */
const expanded = new Set();
const statisticsPanels = new Map();
let langListenerWired = false;
let resetTimer = null;

/**
 * @param {number} [now]
 * @returns {{ from: string, to: string }}
 */
export function harnessHealthRangeQuery(now = Date.now()) {
  const to = new Date(now).toISOString().slice(0, 10);
  return { from: addDaysIso(to, -(HARNESS_HEALTH_RANGE_DAYS - 1)), to };
}

const healthCache = createHarnessHealthCache({
  // The wrapper keeps the request shape explicit for the UI contract test.
  fetchHealth: ({ from, to, fresh }) => getHarnessHealth({ from, to, fresh }),
  rangeQuery: harnessHealthRangeQuery,
  ttlMs: HARNESS_HEALTH_CACHE_TTL_MS,
});

/**
 * Repaints one card from the cached payload and restores its sticky notice.
 *
 * @param {{ harnessId: string, label: string, card: HTMLElement, notice: string }} record
 * @returns {void}
 */
function renderCard(record) {
  const payload = healthCache.getCached();
  const entry = payload?.harnesses ? payload.harnesses[record.harnessId] : null;
  const model = buildHealthCardModel(entry, { now: Date.now(), lang: getCurrentLang() });
  record.card.innerHTML = renderHealthCardHtml(model, {
    t,
    lang: getCurrentLang(),
    harnessLabel: record.label,
  });
  record.card.hidden = false;
  record.state = 'ready';
  applyNotice(record);
}

/**
 * @returns {void}
 */
function renderExpandedCards() {
  if (resetTimer) clearTimeout(resetTimer);
  let nextReset = Infinity;
  for (const record of cards.values()) {
    const entry = healthCache.getCached()?.harnesses?.[record.harnessId];
    const model = buildHealthCardModel(entry, { now: Date.now(), lang: getCurrentLang() });
    record.summary.hidden = !model.activeLimit;
    record.summary.textContent = model.activeLimit
      ? t('harnessHealth.rowBlocked', { time: model.activeLimit.resetTime })
        + (model.activeLimit.model ? ` · ${t('harnessHealth.activeLimitModel', { model: model.activeLimit.model })}` : '')
      : '';
    if (model.activeLimit) nextReset = Math.min(nextReset, Date.parse(model.activeLimit.resetAt));
  }
  for (const id of expanded) {
    const record = cards.get(id);
    if (record && healthCache.hasCache()) renderCard(record);
  }
  if (healthCache.hasCache()) {
    for (const record of statisticsPanels.values()) {
      renderCard(record);
      const limit = buildHealthCardModel(healthCache.getCached()?.harnesses?.[record.harnessId]).activeLimit;
      if (limit) nextReset = Math.min(nextReset, Date.parse(limit.resetAt));
    }
  }
  if (Number.isFinite(nextReset)) resetTimer = setTimeout(renderExpandedCards, Math.min(2_147_483_647, Math.max(1, nextReset - Date.now() + 20)));
}

/**
 * The `hidden` attribute is protected by CSS; the state string only drives the
 * busy/error affordances.
 *
 * @param {{ card: HTMLElement, state: string, notice: string }} record
 * @param {'loading'|'error'} state
 * @returns {void}
 */
function setCardState(record, state) {
  record.state = state;
  record.card.hidden = false;
  if (state === 'loading') {
    record.card.innerHTML = '<div class="harness-health-panel">'
      + `<p class="harness-health-loading">${escapeForText(t('harnessHealth.loading'))}</p>`
      + noticeSlotHtml(record)
      + '</div>';
    return;
  }
  record.card.innerHTML = '<div class="harness-health-panel harness-health-error">'
    + `<p>${escapeForText(t('harnessHealth.loadFailed'))}</p>`
    + `<button type="button" class="harness-health-retry" data-action="retry">${escapeForText(t('harnessHealth.retry'))}</button>`
    + noticeSlotHtml(record)
    + '</div>';
}

/**
 * @param {{ notice: string }} record
 * @returns {string}
 */
function noticeSlotHtml(record) {
  return `<span class="harness-health-notice" data-role="notice" aria-live="polite">${escapeForText(record.notice)}</span>`;
}

/**
 * Local escape for the few strings injected outside the model renderer.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeForText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Re-writes the sticky notice into whichever panel is currently mounted.
 *
 * @param {{ card: HTMLElement, notice: string }} record
 * @returns {void}
 */
function applyNotice(record) {
  const notice = record.card.querySelector('[data-role="notice"]');
  if (notice) notice.textContent = record.notice || '';
}

/**
 * Stores the notice on the record so a later re-render (including the error
 * state) can restore it. Without this, a forced refresh after "Unlock" would
 * erase the success message when the refresh fails.
 *
 * @param {{ card: HTMLElement, notice: string }} record
 * @param {string} message
 * @returns {void}
 */
function setNotice(record, message) {
  record.notice = message == null ? '' : String(message);
  applyNotice(record);
}

/**
 * Marks every expanded card as failed. The harness list is untouched.
 *
 * @returns {void}
 */
function markExpandedError() {
  for (const record of statisticsPanels.values()) setCardState(record, 'error');
  for (const id of expanded) {
    const record = cards.get(id);
    if (record) setCardState(record, 'error');
  }
}

/**
 * @param {object} record
 * @returns {Promise<void>}
 */
async function loadAndRender(record) {
  setCardState(record, 'loading');
  try {
    const data = await healthCache.load(false);
    if (!data) return;
    renderExpandedCards();
  } catch {
    markExpandedError();
  }
}

/**
 * @param {object} record
 * @param {boolean} force
 * @returns {Promise<void>}
 */
async function reloadCard(record, force) {
  setCardState(record, 'loading');
  try {
    const data = await healthCache.load(force);
    if (!data) return;
    renderExpandedCards();
  } catch {
    markExpandedError();
  }
}

/**
 * POSTs the manual unlock, drops the memoized payload and only then refreshes.
 * Dropping the cache first means a failing refresh can never re-render the
 * lockout that the POST just cleared.
 *
 * @param {object} record
 * @param {string} model
 * @returns {Promise<void>}
 */
async function unlockHarness(record, model) {
  const label = record.label || record.harnessId;
  if (typeof window !== 'undefined' && !window.confirm(t('harnessHealth.unlockConfirm', { harness: label }))) {
    return;
  }
  setNotice(record, t('harnessHealth.unlocking'));
  const button = record.card.querySelector('[data-action="unlock"]');
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    const data = await clearHarnessUsageLimit(record.harnessId, { model });
    if (!data?.ok) throw new Error(data?.error || 'clear failed');
    healthCache.invalidate();
    renderExpandedCards();
    await reloadCard(record, true);
    setNotice(record, data.removed > 0 ? t('harnessHealth.unlockDone') : t('harnessHealth.unlockNone'));
  } catch {
    const stillThere = record.card.querySelector('[data-action="unlock"]');
    if (stillThere instanceof HTMLButtonElement) stillThere.disabled = false;
    setNotice(record, t('harnessHealth.unlockFailed'));
  }
}

/**
 * Opens Settings → Usage grouped by harness (the closest supported filter).
 *
 * @param {string} _harnessId
 * @returns {void}
 */
function openUsageForHarness(_harnessId) {
  if (typeof document === 'undefined') return;
  const groupSelect = document.getElementById('usage-group-select');
  if (groupSelect instanceof HTMLSelectElement) {
    groupSelect.value = 'harness';
    groupSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const tabBtn = document.querySelector('#settings-tabs [data-settings-tab="usage"]')
    || document.querySelector('.settings-tab[data-settings-tab="usage"]');
  if (tabBtn instanceof HTMLElement) tabBtn.click();
}

/**
 * Keeps the chevron's accessible name in sync with the open/closed state and
 * the active language.
 *
 * @param {{ toggle: HTMLElement, label: string }} record
 * @param {boolean} isOpen
 * @returns {void}
 */
function applyToggleLabel(record, isOpen) {
  const text = t(isOpen ? 'harnessHealth.toggleAriaHide' : 'harnessHealth.toggleAriaShow', { harness: record.label });
  record.toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  record.toggle.classList.toggle('is-open', isOpen);
  record.toggle.setAttribute('aria-label', text);
  record.toggle.title = text;
  const label = record.toggle.querySelector('[data-role="stats-label"]');
  if (label) label.textContent = t('harnessHealth.statistics');
}

/**
 * Appends the chevron + health card to one harness row. Safe to call again
 * after a list re-render: expanded state and cached data are preserved.
 *
 * @param {HTMLElement} itemEl the `.harness-setup-status-row` element
 * @param {string} harnessId
 * @param {string} label translated harness label
 * @returns {void}
 */
export function attachHarnessHealthRow(itemEl, harnessId, label) {
  if (typeof document === 'undefined' || !(itemEl instanceof HTMLElement)) return;
  const id = String(harnessId || '').trim().toLowerCase();
  if (!id) return;
  const safeLabel = String(label || id);

  const previous = cards.get(id);
  if (previous?.card?.isConnected) previous.card.remove();
  if (previous?.toggle?.isConnected) previous.toggle.remove();
  if (previous?.summary?.isConnected) previous.summary.remove();

  // Grid keeps drag/checkbox/status/usage/chevron on one line at 320–360 px;
  // the card spans the full width on the row underneath.
  itemEl.classList.add('harness-health-row');

  const isOpen = expanded.has(id);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `harness-health-toggle${isOpen ? ' is-open' : ''}`;
  toggle.dataset.harnessId = id;
  toggle.setAttribute('aria-controls', `harness-health-card-${id}`);
  toggle.innerHTML = '<span data-role="stats-label"></span><span class="mdi mdi-chevron-down" aria-hidden="true"></span>';

  const summary = document.createElement('span');
  summary.className = 'harness-health-row-limit';
  summary.hidden = true;
  summary.setAttribute('role', 'status');

  const card = document.createElement('div');
  card.className = 'harness-health-card';
  card.id = `harness-health-card-${id}`;
  card.dataset.harnessId = id;
  card.hidden = !isOpen;

  const record = { harnessId: id, label: safeLabel, toggle, card, summary, state: 'idle', notice: '' };
  cards.set(id, record);
  applyToggleLabel(record, isOpen);

  itemEl.append(toggle, summary, card);
  // One cached request feeds all summaries; expanding statistics adds no read.
  void healthCache.load(false).then((data) => {
    if (data) renderExpandedCards();
  }).catch(() => { /* Unknown health must not imply a lockout. */ });

  toggle.addEventListener('click', () => {
    const open = !expanded.has(id);
    applyToggleLabel(record, open);
    if (!open) {
      expanded.delete(id);
      card.hidden = true;
      return;
    }
    expanded.add(id);
    card.hidden = false;
    if (healthCache.isCacheFresh()) {
      renderCard(record);
      return;
    }
    void loadAndRender(record);
  });

  bindCardActions(record);

  if (isOpen) {
    if (healthCache.hasCache()) renderCard(record);
    else void loadAndRender(record);
  }

  ensureLanguageListener();
}


function bindCardActions(record) {
  record.card.addEventListener('click', (event) => {
    const raw = event.target;
    const target = raw instanceof Element ? raw.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    if (action === 'refresh' || action === 'retry') {
      event.preventDefault();
      void reloadCard(record, true);
    } else if (action === 'unlock') {
      event.preventDefault();
      void unlockHarness(record, target.getAttribute('data-model') || '');
    } else if (action === 'details') {
      event.preventDefault();
      openUsageForHarness(record.harnessId);
    }
  });
}

/** Opens the dedicated statistics tab without replacing the overview row. */
export async function showHarnessStatistics(harnessId) {
  const card = document.querySelector(`.settings-section[data-settings-tab="harness-${harnessId}-stats"] [data-role="harness-statistics"]`);
  if (!(card instanceof HTMLElement)) return;
  let record = statisticsPanels.get(harnessId);
  if (!record || record.card !== card) {
    const label = document.querySelector(`#settings-harness-tabs [data-harness-tab="${harnessId}"]`)?.textContent || harnessId;
    record = { harnessId, label, card, state: 'idle', notice: '' };
    statisticsPanels.set(harnessId, record);
    bindCardActions(record);
  }
  ensureLanguageListener();
  await loadAndRender(record);
}


function ensureLanguageListener() {
  if (!langListenerWired && typeof window !== 'undefined') {
    langListenerWired = true;
    window.addEventListener('cr-lang-changed', () => {
      for (const [cardId, cardRecord] of cards) {
        if (cardRecord) applyToggleLabel(cardRecord, expanded.has(cardId));
      }
      if (!healthCache.hasCache()) return;
      renderExpandedCards();
      for (const openId of expanded) {
        const openRecord = cards.get(openId);
        if (openRecord) renderCard(openRecord);
      }
    });
  }
}
