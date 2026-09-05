import { appLogger, refreshLogsPanelDom } from '../../logger.js';
import {
  readStorageValueWithAlias,
  writeStorageValueWithAlias,
} from '../../lib/storageKeyAlias.js';
import { buildSpaLocation, parseSpaPath, remapLegacySpaPanel } from '../../../lib/spa-routes.js';
import { t } from '../../i18n/index.js';
import { scheduleChatSendBarReserveSync } from '../../features/chat/chatSendBarLayout.js';

const LAST_PANEL_STORAGE_KEY = 'cretli-last-panel';
const SETTINGS_TAB_STORAGE_KEY = 'cretli-settings-tab';
const STATUS_PARSER_PANEL_STORAGE_KEY = 'cretli-debug-status';

/**
 * The status-parser panel is a developer tool (parser fixtures, flow scenarios,
 * raw buffer playground), so it shares the flag that enables status debug logs:
 * ?debug-status or localStorage 'cretli-debug-status' = '1'.
 * @returns {boolean}
 */
function isStatusParserPanelEnabled() {
  if (typeof window === 'undefined') return false;
  const query = (typeof window.location !== 'undefined' && window.location.search) || '';
  if (/\bdebug-status\b/.test(query)) return true;
  try {
    return readStorageValueWithAlias(localStorage, STATUS_PARSER_PANEL_STORAGE_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

/**
 * Reads a deep-link parameter (PWA shortcut, push notification).
 * @param {string} name
 * @returns {string}
 */
function readQueryParam(name) {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search || '').get(name)?.trim() || '';
  } catch (_) {
    return '';
  }
}

/** @returns {string} */
export function readRequestedPanel() {
  return readQueryParam('panel');
}

/** @returns {string} */
export function readRequestedChatId() {
  return readQueryParam('chat');
}

/** @returns {string} */
export function readRequestedPanelFromPath() {
  if (typeof window === 'undefined') return '';
  return parseSpaPath(window.location?.pathname || '')?.panel || '';
}

/** @returns {string} */
export function readRequestedSettingsTab() {
  if (typeof window === 'undefined') return '';
  const fromPath = parseSpaPath(window.location?.pathname || '')?.settingsTab || '';
  if (fromPath) return fromPath;
  const fromQuery = readQueryParam('tab');
  if (fromQuery) return fromQuery;
  const fromPanelQuery = remapLegacySpaPanel(readQueryParam('panel'))?.settingsTab || '';
  if (fromPanelQuery) return fromPanelQuery;
  try {
    const savedPanel = readStorageValueWithAlias(localStorage, LAST_PANEL_STORAGE_KEY, '');
    return remapLegacySpaPanel(savedPanel)?.settingsTab || '';
  } catch (_) {
    return '';
  }
}

/**
 * @param {string} panelId
 * @param {string} [settingsTab]
 */
export function replaceLocationView(panelId, settingsTab = '') {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const next = buildSpaLocation({
    panel: panelId,
    settingsTab,
    search: window.location.search || '',
  });
  const current = `${window.location.pathname || ''}${window.location.search || ''}`;
  if (current === next) return;
  window.history.replaceState(null, '', next);
}

export function createPanelRouter(deps = {}) {
  const {
    appModes = {},
    mainPanels = [],
    setLastMainPanel = () => {},
    setActivePanel = () => {},
    setSpecialCharsBarVisibility = () => {},
    ensurePanelReady = () => Promise.resolve(),
    fitTerminalPanel = () => {},
    loadChatsFromServer = () => {},
    fitAllChats = () => {},
    getActiveSendBar = () => null,
    getTerminalSendBar = () => null,
    fitTasksTerminal = () => {},
    preloadTasksDropdown = () => {},
    ensureTaskRunsReconnected = () => Promise.resolve(),
    refreshTasksList = () => {},
    fitAgentsTerminal = () => {},
    preloadAgentsDropdown = () => {},
    ensureAgentRunsReconnected = () => Promise.resolve(),
    refreshAgentsList = () => {},
    ensureFilesPanelInitialized = () => {},
    refreshFilesPanel = () => {},
    refreshGitInfo = () => {},
    refreshGithubPanel = () => {},
    refreshTodoList = () => {},
    refreshInstancesPanel = () => {},
    onShowSettings = () => {},
  } = deps;

  function isPanelAllowed(panelId, modeConfig) {
    if (!panelId || !modeConfig?.allowedPanels) return false;
    return modeConfig.allowedPanels.includes(panelId);
  }

  function clearPanelLoadError(panelId) {
    const panel = document.getElementById(`${panelId}-panel`);
    panel?.querySelector(':scope > .panel-load-error')?.remove();
  }

  /**
   * A lazy panel chunk can fail to load even though the server answers 200 —
   * a stale browser cache or a dist directory mixing artifacts from two builds
   * makes webpack reject with ChunkLoadError. Without this the rejection is
   * silent and the panel just stays empty, which is impossible to diagnose.
   * @param {string} panelId
   * @param {unknown} err
   * @param {() => void} retry
   */
  function showPanelLoadError(panelId, err, retry) {
    appLogger.log('panel-load', `Panel "${panelId}" failed to load: ${err?.message || err}`);
    const panel = document.getElementById(`${panelId}-panel`);
    if (!panel) return;
    let box = panel.querySelector(':scope > .panel-load-error');
    if (!box) {
      box = document.createElement('div');
      box.className = 'panel-load-error';
      panel.prepend(box);
    }
    box.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = t('errors.panelLoad');
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'panel-load-error-retry';
    retryBtn.textContent = t('errors.panelLoadRetry');
    retryBtn.addEventListener('click', retry);
    box.append(text, retryBtn);
  }

  /**
   * @param {string} panelId DOM id prefix of the panel container
   * @param {() => void} [onReady]
   * @param {string} [moduleKey] lazy module key when it differs from the panel id
   */
  function runPanelReady(panelId, onReady = () => {}, moduleKey = panelId) {
    const attempt = () => {
      clearPanelLoadError(panelId);
      // Two-argument then: only the chunk load is treated as a panel failure,
      // errors thrown by onReady keep their own handling.
      void ensurePanelReady(moduleKey).then(
        () => onReady(),
        (err) => showPanelLoadError(panelId, err, attempt)
      );
    };
    attempt();
  }

  /**
   * @param {string} panelId
   * @returns {string}
   */
  function resolveLegacyPanel(panelId) {
    const remapped = remapLegacySpaPanel(panelId);
    if (!remapped) return panelId;
    try {
      writeStorageValueWithAlias(localStorage, SETTINGS_TAB_STORAGE_KEY, remapped.settingsTab);
    } catch (_) {}
    return remapped.panel;
  }

  function resolveInitialPanel(modeConfig) {
    const activeTab = document.querySelector('.tab.active');
    const activeTabPanel = activeTab?.dataset?.panel || '';
    const pathPanel = readRequestedPanelFromPath();
    if (isPanelAllowed(pathPanel, modeConfig)) return pathPanel;
    // PWA shortcuts and push notifications link to ?panel=..., so an explicit
    // request must win over the last panel kept in localStorage.
    const requestedPanel = resolveLegacyPanel(readRequestedPanel());
    if (isPanelAllowed(requestedPanel, modeConfig)) return requestedPanel;
    let savedPanel = null;
    try {
      savedPanel = readStorageValueWithAlias(localStorage, LAST_PANEL_STORAGE_KEY, '');
    } catch (_) {}
    const remappedSaved = resolveLegacyPanel(savedPanel || '');
    if (isPanelAllowed(remappedSaved, modeConfig)) return remappedSaved;
    if (isPanelAllowed(activeTabPanel, modeConfig)) return activeTabPanel;
    return modeConfig?.defaultPanel || 'chat';
  }

  function showPanel(panelId, modeConfig = appModes.main) {
    if (!isPanelAllowed(panelId, modeConfig)) return;
    if (mainPanels.includes(panelId)) {
      setLastMainPanel(panelId);
    }
    setActivePanel(panelId);
    setSpecialCharsBarVisibility(false);

    const extraBarWrap = document.getElementById('chat-extra-bar-wrap');
    if (extraBarWrap) extraBarWrap.classList.remove('is-visible');

    document
      .querySelectorAll('.send-keys-toggle-extra-btn.is-open')
      .forEach((btn) => btn.classList.remove('is-open'));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));

    const panel = document.getElementById(panelId + '-panel');
    if (panel) panel.classList.add('active');

    document.querySelectorAll('.tabs button').forEach((btn) => btn.classList.remove('active'));
    const tabBtn = document.querySelector(`.tab[data-panel="${panelId}"]`);
    if (tabBtn) tabBtn.classList.add('active');

    if (panelId === 'chat') {
      loadChatsFromServer();
      requestAnimationFrame(() => {
        setTimeout(() => fitAllChats(), 100);
      });
      const chatBar = getActiveSendBar();
      if (chatBar?.isMultiline?.()) chatBar.attachTextareaToWrap?.();
    }

    if (panelId === 'terminal') {
      runPanelReady('terminal', () => {
        scheduleChatSendBarReserveSync();
        fitTerminalPanel();
        const termBar = getTerminalSendBar();
        if (termBar?.isMultiline?.()) termBar.attachTextareaToWrap?.();
      });
    }

    if (panelId === 'tasks') {
      runPanelReady('tasks', () => {
        fitTasksTerminal();
        preloadTasksDropdown();
        void ensureTaskRunsReconnected().then(() => refreshTasksList({ invalidateCache: true }));
      });
    }

    if (panelId === 'agents') {
      runPanelReady('agents', () => {
        fitAgentsTerminal();
        preloadAgentsDropdown();
        void ensureAgentRunsReconnected().then(() => refreshAgentsList());
      });
    }

    if (panelId === 'logs') {
      refreshLogsPanelDom();
    }

    if (panelId === 'instances') {
      runPanelReady('instances', () => refreshInstancesPanel());
    }

    if (panelId === 'files') {
      runPanelReady('files', () => {
        ensureFilesPanelInitialized();
        refreshFilesPanel();
      });
    }

    if (panelId === 'git') {
      runPanelReady('git', () => refreshGitInfo());
    }

    if (panelId === 'github') {
      const githubTab = document.querySelector('.tab[data-panel="github"]');
      if (githubTab?.hidden) {
        showPanel('git', modeConfig);
        return;
      }
      runPanelReady('github', () => refreshGithubPanel());
    }

    if (panelId === 'todo') {
      refreshTodoList();
    }

    if (panelId === 'tests') {
      if (!isStatusParserPanelEnabled()) {
        showPanel('chat', modeConfig);
        return;
      }
      runPanelReady('tests', () => {}, 'statusTests');
    }

    if (panelId === 'settings') {
      onShowSettings();
    }

    scheduleChatSendBarReserveSync();

    try {
      writeStorageValueWithAlias(localStorage, LAST_PANEL_STORAGE_KEY, panelId);
    } catch (_) {}
    const settingsTab = panelId === 'settings'
      ? (document.getElementById('settings-panel')?.dataset?.activeSettingsTab
        || document.querySelector('#settings-tabs .settings-tab.active')?.dataset?.settingsTab
        || '')
      : '';
    replaceLocationView(panelId, settingsTab);
  }

  function initTabs(modeConfig = appModes.main) {
    document.querySelectorAll('.tab').forEach((btn) => {
      const panelId = btn.dataset.panel || '';
      const allowed = isPanelAllowed(panelId, modeConfig);
      if (panelId === 'github') {
        btn.hidden = true;
      } else if (panelId === 'tests') {
        btn.hidden = !allowed || !isStatusParserPanelEnabled();
      } else {
        btn.hidden = !allowed;
      }
      if (!allowed) return;

      btn.addEventListener('click', () => {
        const targetPanelId = btn.dataset.panel || '';
        if (!isPanelAllowed(targetPanelId, modeConfig)) return;
        if (mainPanels.includes(targetPanelId)) {
          setLastMainPanel(targetPanelId);
        }
        showPanel(targetPanelId, modeConfig);
      });
    });
  }

  return {
    isPanelAllowed,
    resolveInitialPanel,
    showPanel,
    initTabs,
  };
}
