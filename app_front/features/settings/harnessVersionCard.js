/**
 * Settings → Harness: read-only version inventory and explicit model refresh.
 */

import { getHarnessVersions, refreshHarnessModelsCatalog } from '../../api.js';
import { t, getCurrentLang } from '../../i18n/index.js';
import { isHarnessSubtabOf } from '../../../lib/spa-routes.js';
import {
  HARNESS_VERSION_CARD_IDS,
  buildHarnessVersionCardModel,
  buildOverviewVersionModel,
  countUpdatableHarnesses,
  renderHarnessVersionCardHtml,
} from './harnessVersionModel.js';

/** @type {object|null} */
let cachedVersionsPayload = null;
/** @type {Map<string, { hosts: HTMLElement[], harnessId: string, modelsRefreshResult: object|null, busy: string, error: string }>} */
const controllers = new Map();
let wired = false;

/**
 * @param {string} harnessId
 * @returns {string}
 */
function harnessLabel(harnessId) {
  const keyById = {
    sdk: 'settings.harnessSdk',
    openrouter: 'settings.harnessOpenRouter',
    opencode: 'settings.harnessOpenCode',
    codebuddy: 'settings.harnessCodeBuddy',
    deepseek: 'settings.harnessDeepSeek',
    qwen: 'settings.harnessQwen',
    claude: 'settings.harnessClaude',
    codex: 'settings.harnessCodex',
  };
  const key = keyById[harnessId];
  return key ? t(key) : harnessId;
}

/**
 * @param {object} record
 * @returns {void}
 */
function paintRecord(record) {
  const lang = getCurrentLang();
  const model = record.harnessId === 'overview'
    ? buildOverviewVersionModel(cachedVersionsPayload, { lang })
    : buildHarnessVersionCardModel(cachedVersionsPayload, record.harnessId, { lang });
  const html = renderHarnessVersionCardHtml(model, {
    t,
    lang,
    harnessLabel: record.harnessId === 'overview' ? undefined : harnessLabel(record.harnessId),
    modelsRefreshResult: record.harnessId === 'overview' ? null : record.modelsRefreshResult,
    busy: record.busy,
    error: record.error,
  });
  for (const host of record.hosts) {
    host.innerHTML = html;
    wireHostActions(host, record);
  }
}

/**
 * @param {HTMLElement} host
 * @param {{ harnessId: string, busy: string }} record
 * @returns {void}
 */
function wireHostActions(host, record) {
  const checkBtn = host.querySelector('[data-action="check-updates"]');
  if (checkBtn instanceof HTMLButtonElement) {
    checkBtn.onclick = () => {
      void runCheckUpdates(record.harnessId);
    };
  }
  const refreshBtn = host.querySelector('[data-action="refresh-models"]');
  if (refreshBtn instanceof HTMLButtonElement) {
    refreshBtn.onclick = () => {
      if (record.harnessId === 'overview') return;
      void runRefreshModels(record.harnessId);
    };
  }
}

/**
 * @param {string} scopeHarnessId
 * @returns {void}
 */
function applyOverviewTabBadge() {
  const overviewBtn = document.querySelector('#settings-harness-tabs [data-settings-tab="harness"]');
  if (!(overviewBtn instanceof HTMLElement)) return;
  const count = countUpdatableHarnesses(cachedVersionsPayload);
  overviewBtn.dataset.harnessUpdates = count > 0 ? 'true' : 'false';
  overviewBtn.setAttribute('aria-description', count > 0
    ? t('harnessVersion.overviewBadge', { count })
    : '');
}

/**
 * @param {string} harnessId
 * @returns {Promise<void>}
 */
async function runCheckUpdates(harnessId) {
  const record = controllers.get(harnessId);
  if (!record || record.busy) return;
  record.busy = 'check';
  record.error = '';
  paintRecord(record);
  try {
    const data = await getHarnessVersions({ check: true });
    if (!data?.ok) {
      record.error = data?.error || t('harnessVersion.loadFailed');
      return;
    }
    cachedVersionsPayload = data;
    applyOverviewTabBadge();
    for (const row of controllers.values()) paintRecord(row);
  } catch {
    record.error = t('harnessVersion.loadFailed');
  } finally {
    record.busy = '';
    paintRecord(record);
  }
}

/**
 * @param {string} harnessId
 * @returns {Promise<void>}
 */
async function runRefreshModels(harnessId) {
  const record = controllers.get(harnessId);
  if (!record || record.busy || harnessId === 'overview') return;
  record.busy = 'refresh';
  record.error = '';
  paintRecord(record);
  try {
    const data = await refreshHarnessModelsCatalog(harnessId);
    if (!data?.ok) {
      record.error = data?.error || t('harnessVersion.modelsRefreshFailed');
      record.modelsRefreshResult = null;
      return;
    }
    record.modelsRefreshResult = data;
    const eventByHarness = {
      sdk: 'cretli-chat-models-changed',
      openrouter: 'cretli-openrouter-models-changed',
      opencode: 'cretli-opencode-models-changed',
      codebuddy: 'cretli-codebuddy-models-changed',
      deepseek: 'cretli-deepseek-models-changed',
      qwen: 'cretli-qwen-models-changed',
      claude: 'cretli-claude-models-changed',
      codex: 'cretli-codex-models-changed',
    };
    const eventName = eventByHarness[harnessId];
    if (eventName) window.dispatchEvent(new CustomEvent(eventName));
  } catch {
    record.error = t('harnessVersion.modelsRefreshFailed');
    record.modelsRefreshResult = null;
  } finally {
    record.busy = '';
    paintRecord(record);
  }
}

/**
 * @param {string} harnessId
 * @returns {Promise<void>}
 */
async function loadSnapshotForHarness(harnessId) {
  const record = controllers.get(harnessId);
  if (!record || record.busy === 'load') return;
  if (cachedVersionsPayload) {
    paintRecord(record);
    return;
  }
  record.busy = 'load';
  record.error = '';
  paintRecord(record);
  try {
    const data = await getHarnessVersions({ check: false, persist: true });
    if (!data?.ok) {
      record.error = data?.error || t('harnessVersion.loadFailed');
      return;
    }
    cachedVersionsPayload = data;
    applyOverviewTabBadge();
    for (const row of controllers.values()) {
      row.busy = row.harnessId === harnessId ? '' : row.busy;
      if (row.busy !== 'check' && row.busy !== 'refresh') paintRecord(row);
    }
  } catch {
    record.error = t('harnessVersion.loadFailed');
  } finally {
    if (record.busy === 'load') record.busy = '';
    paintRecord(record);
  }
}

/**
 * Registers mount hosts from the static HTML shell.
 *
 * @returns {void}
 */
export function initHarnessVersionCards() {
  if (wired) return;
  wired = true;
  document.querySelectorAll('[data-harness-version-host]').forEach((host) => {
    if (!(host instanceof HTMLElement)) return;
    const harnessId = String(host.dataset.harnessVersionHost || '').trim().toLowerCase();
    if (!harnessId) return;
    let record = controllers.get(harnessId);
    if (!record) {
      record = {
        hosts: [],
        harnessId,
        modelsRefreshResult: null,
        busy: '',
        error: '',
      };
      controllers.set(harnessId, record);
    }
    record.hosts.push(host);
  });
  window.addEventListener('cr-lang-changed', () => {
    for (const record of controllers.values()) paintRecord(record);
  });
}

/**
 * Lazy-load when a harness settings tab becomes visible.
 *
 * @param {string} tabId
 * @returns {void}
 */
export function refreshHarnessVersionCardsForTab(tabId) {
  if (!wired) initHarnessVersionCards();
  if (tabId === 'harness') {
    void loadSnapshotForHarness('overview');
    return;
  }
  for (const harnessId of HARNESS_VERSION_CARD_IDS) {
    if (isHarnessSubtabOf(tabId, harnessId)) {
      void loadSnapshotForHarness(harnessId);
      return;
    }
  }
}
