/** Settings UI: browser storage usage charts/actions and the Browser panel policy form. */
import '../../components/ui/cr-storage-donut.js';
import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { parseBrowserPolicyOrigins } from '../../features/settings/browserPolicyOrigins.js';
import {
  clearAppStorageData,
  clearCacheStorageAppData,
  clearIndexedDbAppData,
  clearLocalStorageAppData,
  clearSessionStorageAppData,
  collectCookieStats,
  collectLocalStorageStats,
  collectSessionStorageStats,
  formatBytes,
  formatPercent,
  getBrowserEnvironmentLines,
  listCacheStorageNames,
  listIndexedDbNames,
  readStorageEstimate,
  readStoragePersistence,
} from './storageStats.js';

function renderBrowserStorageCharts(container, charts, onAction) {
  if (!container) return;
  container.textContent = '';
  if (!Array.isArray(charts) || charts.length === 0) return;
  const fragment = document.createDocumentFragment();
  for (const chart of charts) {
    if (!chart || typeof chart !== 'object') continue;
    const donut = document.createElement('cr-storage-donut');
    donut.label = chart.label || '';
    donut.subtitle = chart.subtitle || '';
    donut.hint = chart.hint || '';
    donut.value = Number(chart.value) || 0;
    donut.total = Number(chart.total) || 0;
    donut.tone = chart.tone || 'primary';
    if (chart.actionId && chart.actionLabel) {
      donut.actionLabel = chart.actionLabel;
      donut.dataset.browserStorageInlineAction = chart.actionId;
      donut.addEventListener('cr-clear', () => onAction(chart.actionId));
    }
    fragment.appendChild(donut);
  }
  container.appendChild(fragment);
}

export function initBrowserStorageTools() {
  const refreshBtn = document.getElementById('browser-storage-refresh-btn');
  const clearLocalBtn = document.getElementById('browser-storage-clear-local-btn');
  const clearIdbBtn = document.getElementById('browser-storage-clear-idb-btn');
  const clearCacheBtn = document.getElementById('browser-storage-clear-cache-btn');
  const clearAllBtn = document.getElementById('browser-storage-clear-all-btn');
  const chartsEl = document.getElementById('browser-storage-charts');
  const summaryEl = document.getElementById('browser-storage-summary');
  const detailsEl = document.getElementById('browser-storage-details');
  const envEl = document.getElementById('browser-storage-environment');
  const statusEl = document.getElementById('browser-storage-status');
  if (!refreshBtn || !clearLocalBtn || !clearIdbBtn || !clearCacheBtn || !clearAllBtn) return;
  if (!chartsEl || !summaryEl || !detailsEl || !envEl || !statusEl) return;

  const setStatus = (text, isError = false) => {
    statusEl.textContent = text;
    statusEl.style.color = isError ? 'var(--cr-error)' : '';
  };

  const clearLocalAction = () => runClearAction(t('settings.browserStorageConfirmLocal'), async () => {
    clearLocalStorageAppData();
    clearSessionStorageAppData();
  });
  const clearIdbAction = () => runClearAction(t('settings.browserStorageConfirmIdb'), () => clearIndexedDbAppData());
  const clearCacheAction = () => runClearAction(t('settings.browserStorageConfirmCache'), () => clearCacheStorageAppData());
  const clearAllAction = () => runClearAction(t('settings.browserStorageConfirmAll'), async () => {
    await clearAppStorageData();
    setTimeout(() => window.location.reload(), 450);
  });
  const runInlineAction = (actionId) => {
    if (actionId === 'clear-local') {
      void clearLocalAction();
      return;
    }
    if (actionId === 'clear-idb') {
      void clearIdbAction();
      return;
    }
    if (actionId === 'clear-cache') {
      void clearCacheAction();
    }
  };

  const renderSnapshot = async () => {
    setStatus(t('common.loading'));
    const [estimate, localStats, sessionStats, idbNames, cacheNames, persisted] = await Promise.all([
      readStorageEstimate(),
      Promise.resolve(collectLocalStorageStats()),
      Promise.resolve(collectSessionStorageStats()),
      listIndexedDbNames(),
      listCacheStorageNames(),
      readStoragePersistence(),
    ]);
    const cookieStats = collectCookieStats();
    const usagePct = formatPercent(estimate.usage, estimate.quota);
    const idbUsage = Number(estimate.usageDetails?.indexedDB) || 0;
    const cacheUsage = Number(estimate.usageDetails?.caches) || 0;
    const localShareValue = localStats.appBytes;
    const localShareTotal = localStats.allBytes;
    const sessionShareValue = sessionStats.appBytes;
    const sessionShareTotal = sessionStats.allBytes;

    renderBrowserStorageCharts(chartsEl, [
      {
        label: t('settings.browserStorageChartOrigin'),
        subtitle: `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`,
        value: estimate.usage,
        total: estimate.quota,
        hint: t('settings.browserStorageChartOriginHint', { percent: usagePct }),
        tone: 'primary',
      },
      {
        label: t('settings.browserStorageChartLocal'),
        subtitle: `${formatBytes(localShareValue)} / ${formatBytes(localShareTotal)}`,
        value: localShareValue,
        total: localShareTotal,
        hint: t('settings.browserStorageChartLocalHint', {
          percent: formatPercent(localShareValue, localShareTotal),
        }),
        tone: 'success',
        actionId: 'clear-local',
        actionLabel: t('settings.browserStorageClearLocalShort'),
      },
      {
        label: t('settings.browserStorageChartSession'),
        subtitle: `${formatBytes(sessionShareValue)} / ${formatBytes(sessionShareTotal)}`,
        value: sessionShareValue,
        total: sessionShareTotal,
        hint: t('settings.browserStorageChartSessionHint', {
          percent: formatPercent(sessionShareValue, sessionShareTotal),
        }),
        tone: 'success',
        actionId: 'clear-local',
        actionLabel: t('settings.browserStorageClearLocalShort'),
      },
      {
        label: t('settings.browserStorageChartIdb'),
        subtitle: `${formatBytes(idbUsage)} / ${formatBytes(estimate.usage)}`,
        value: idbUsage,
        total: estimate.usage,
        hint: estimate.hasUsageDetails
          ? t('settings.browserStorageChartIdbHint', { percent: formatPercent(idbUsage, estimate.usage) })
          : t('settings.browserStorageChartBreakdownUnavailable'),
        tone: 'warn',
        actionId: 'clear-idb',
        actionLabel: t('settings.browserStorageClearIdbShort'),
      },
      {
        label: t('settings.browserStorageChartCache'),
        subtitle: `${formatBytes(cacheUsage)} / ${formatBytes(estimate.usage)}`,
        value: cacheUsage,
        total: estimate.usage,
        hint: estimate.hasUsageDetails
          ? t('settings.browserStorageChartCacheHint', { percent: formatPercent(cacheUsage, estimate.usage) })
          : t('settings.browserStorageChartBreakdownUnavailable'),
        tone: 'warn',
        actionId: 'clear-cache',
        actionLabel: t('settings.browserStorageClearCacheShort'),
      },
    ], runInlineAction);

    summaryEl.textContent =
      `${t('settings.browserStorageUsageOrigin')}: ${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)} (${usagePct})\n` +
      `${t('settings.browserStorageUsagePersisted')}: ${persisted}\n` +
      `${t('settings.browserStorageUsageLocalAll')}: ${formatBytes(localStats.allBytes)} (${localStats.allCount})\n` +
      `${t('settings.browserStorageUsageLocalApp')}: ${formatBytes(localStats.appBytes)} (${localStats.appItems.length})\n` +
      `${t('settings.browserStorageUsageSessionAll')}: ${formatBytes(sessionStats.allBytes)} (${sessionStats.allCount})\n` +
      `${t('settings.browserStorageUsageSessionApp')}: ${formatBytes(sessionStats.appBytes)} (${sessionStats.appItems.length})\n` +
      `${t('settings.browserStorageUsageIdb')}: ${idbNames.length}\n` +
      `${t('settings.browserStorageUsageCache')}: ${cacheNames.length}\n` +
      `${t('settings.browserStorageUsageCookies')}: ${cookieStats.count} (${formatBytes(cookieStats.bytes)})`;

    const topKeys = localStats.appItems
      .slice(0, 12)
      .map((item, idx) => `${idx + 1}. ${item.key} — ${formatBytes(item.bytes)}`);
    const topSessionKeys = sessionStats.appItems
      .slice(0, 12)
      .map((item, idx) => `${idx + 1}. ${item.key} — ${formatBytes(item.bytes)}`);
    const idbLines = idbNames.length ? idbNames.map((name) => `- ${name}`) : ['- (none)'];
    const cacheLines = cacheNames.length ? cacheNames.map((name) => `- ${name}`) : ['- (none)'];
    detailsEl.textContent =
      `${t('settings.browserStorageTopLocal')}:\n${topKeys.length ? topKeys.join('\n') : '- (none)'}\n\n` +
      `${t('settings.browserStorageTopSession')}:\n${topSessionKeys.length ? topSessionKeys.join('\n') : '- (none)'}\n\n` +
      `${t('settings.browserStorageIndexedDbList')}:\n${idbLines.join('\n')}\n\n` +
      `${t('settings.browserStorageCacheList')}:\n${cacheLines.join('\n')}`;
    envEl.textContent = `${t('settings.browserStorageEnvironmentList')}:\n${getBrowserEnvironmentLines().join('\n')}`;
    setStatus('OK');
  };

  const setActionsDisabled = (disabled) => {
    refreshBtn.disabled = disabled;
    clearLocalBtn.disabled = disabled;
    clearIdbBtn.disabled = disabled;
    clearCacheBtn.disabled = disabled;
    clearAllBtn.disabled = disabled;
    const inlineDonuts = chartsEl.querySelectorAll('cr-storage-donut[data-browser-storage-inline-action]');
    for (const donut of inlineDonuts) {
      donut.actionDisabled = disabled;
    }
  };

  const runClearAction = async (confirmText, clearFn) => {
    if (!window.confirm(confirmText)) return;
    setActionsDisabled(true);
    setStatus(t('common.removing'));
    try {
      await clearFn();
      setStatus(t('common.removed'));
      await renderSnapshot();
    } catch (err) {
      setStatus(`${t('settings.browserStorageErrorPrefix')}: ${err?.message || t('errors.unknown')}`, true);
    } finally {
      setActionsDisabled(false);
    }
  };

  refreshBtn.addEventListener('click', () => {
    void renderSnapshot();
  });

  clearLocalBtn.addEventListener('click', () => void clearLocalAction());

  clearIdbBtn.addEventListener('click', () => void clearIdbAction());

  clearCacheBtn.addEventListener('click', () => void clearCacheAction());

  clearAllBtn.addEventListener('click', () => void clearAllAction());

  void renderSnapshot();
}

/**
 * Short label for a policy key: the workspace file name without its
 * extension, or the folder name; the full key goes to the tooltip.
 *
 * @param {string} key
 * @returns {string}
 */
function browserPolicyWorkspaceLabel(key) {
  const parts = String(key || '').split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] || String(key || '');
  return last.replace(/\.code-workspace$/i, '');
}

export function initBrowserSelfOriginSetting() {
  const checkbox = document.getElementById('browser-policy-self-origin');
  const privateNetwork = document.getElementById('browser-policy-private-network');
  const insecureTls = document.getElementById('browser-policy-insecure-tls');
  const externalBrowser = document.getElementById('browser-policy-external-browser');
  const originsInput = document.getElementById('browser-policy-allowed-origins');
  const saveBtn = document.getElementById('browser-policy-self-origin-save');
  const status = document.getElementById('browser-policy-self-origin-status');
  const workspaceHint = document.getElementById('browser-policy-workspace');
  if (!checkbox || !privateNetwork || !insecureTls || !externalBrowser || !originsInput || !saveBtn || !status) return;

  // The policy is per workspace; name the one being edited so it is never
  // mistaken for the policy of another tab or of the global selection.
  const showWorkspace = (key) => {
    if (!workspaceHint) return;
    const value = String(key || '').trim();
    workspaceHint.hidden = !value;
    workspaceHint.textContent = value
      ? t('settings.browserPolicyWorkspace', { key: browserPolicyWorkspaceLabel(value) })
      : '';
    workspaceHint.title = value;
  };

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    if (isError) status.dataset.tone = 'error';
    else delete status.dataset.tone;
  };
  const render = (result) => {
    showWorkspace(result?.workspaceKey);
    checkbox.checked = result?.policy?.allowSelfOrigin === true;
    privateNetwork.checked = result?.policy?.allowPrivateNetwork === true;
    insecureTls.checked = result?.policy?.allowInsecureTls === true;
    externalBrowser.checked = result?.policy?.allowExternalBrowser === true;
    originsInput.value = Array.isArray(result?.policy?.allowedOrigins)
      ? result.policy.allowedOrigins.join('\n')
      : '';
  };
  const load = async () => {
    try {
      render(await api.getBrowserPolicy());
      setStatus('');
    } catch (err) {
      setStatus(err?.message || t('errors.unknown'), true);
    }
  };
  saveBtn.addEventListener('click', async () => {
    const { origins, invalid } = parseBrowserPolicyOrigins(originsInput.value);
    if (invalid.length > 0) {
      setStatus(t('settings.browserPolicyInvalidOrigins', { list: invalid.join(', ') }), true);
      originsInput.focus();
      return;
    }
    saveBtn.disabled = true;
    setStatus(t('common.saving'));
    try {
      const result = await api.patchBrowserPolicy({
        allowSelfOrigin: checkbox.checked,
        allowPrivateNetwork: privateNetwork.checked,
        allowInsecureTls: insecureTls.checked,
        allowExternalBrowser: externalBrowser.checked,
        allowedOrigins: origins,
      });
      // Show what the server actually stored (normalized, deduplicated).
      if (result?.policy) render(result);
      setStatus(t('common.saved'));
    } catch (err) {
      setStatus(err?.message || t('errors.unknown'), true);
    } finally {
      saveBtn.disabled = false;
    }
  });
  // Switching the tab to another workspace switches the policy being edited.
  window.addEventListener('cretli-view-context-changed', () => void load());
  void load();
}
