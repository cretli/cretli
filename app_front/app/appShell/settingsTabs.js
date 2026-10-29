/** Settings panel tabs: heavy-module init, tab bar state, per-tab refresh and click wiring. */
import { applySettingsFooters } from '../../features/settings/settingsFooters.js';
import { initLanSettings } from '../../features/settings/models/lanSettings.js';
import { initModelSettings, refreshModelSettingsPanel } from '../../features/settings/models/modelSettings.js';
import { HARNESS_MODEL_SETTINGS_PANELS, syncOptionalHarnessPanels } from '../../features/settings/models/harnessModelSettingsPanels.js';
import { showHarnessStatistics } from '../../features/harness-health/harnessHealthCard.js';
import { refreshHarnessSettingsPanel } from '../../features/settings/models/harnessSettings.js';
import { refreshHarnessVersionCardsForTab } from '../../features/settings/harnessVersionCard.js';
import { refreshUsageSettings } from '../../features/usage/usageSettings.js';
import { refreshWakeupsSettings } from '../../features/wakeups/wakeupsSettings.js';
import { initApprovalBrokerSettings, refreshApprovalBrokerSettings } from '../../features/approval/approvalBrokerSettings.js';
import { refreshDelegationCenter } from '../../features/delegations/delegationCenter.js';
import { refreshDelegationSettings } from '../../features/settings/delegationSettings.js';
import { refreshAgentPromptsSettings } from '../../features/settings/agentPromptsSettings.js';
import { showMcpOperatorSettingsTab } from '../../features/settings/mcpOperatorSettings.js';
import { refreshReviewLessonsSettings } from '../../features/settings/reviewLessonsSettings.js';
import { refreshDataBackupSettings } from '../../features/settings/dataBackupSettings.js';
import {
  SPA_HARNESS_IDS,
  SPA_SETTINGS_TABS,
  isHarnessSettingsTab,
  isHarnessSubtabOf,
  isInterfaceSettingsTab,
  isChatSettingsTab,
  isDelegationSettingsTab,
  isWatcherSettingsTab,
  isConnectionSettingsTab,
  isMcpSettingsTab,
  isMcpOperatorSettingsTab,
  remapSettingsTab,
} from '../../../lib/spa-routes.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../lib/storageKeyAlias.js';
import { readRequestedSettingsTab } from './panelRouter.js';
import { getSharedSpaNavigation } from './spaNavigationBridge.js';
import { callLoadedPanel, loadSettingsPanel } from './panelLoader.js';

let settingsHeavyModulesInitialized = false;

export function ensureSettingsHeavyModules() {
  if (settingsHeavyModulesInitialized) return;
  settingsHeavyModulesInitialized = true;
  initLanSettings();
  initModelSettings();
  for (const panel of HARNESS_MODEL_SETTINGS_PANELS) panel.init();
  void syncOptionalHarnessPanels();
  initApprovalBrokerSettings();
}

const SETTINGS_TAB_LS_KEY = 'cretli-settings-tab';
const SETTINGS_TABS = SPA_SETTINGS_TABS;

/**
 * Returns the harness id for third-level settings tabs such as
 * `harness-opencode-models`, or `''` for the overview/unknown tabs.
 *
 * @param {string} tabId
 * @returns {string}
 */
function getHarnessIdFromSettingsTab(tabId) {
  const raw = typeof tabId === 'string' ? tabId.trim() : '';
  if (!raw.startsWith('harness-')) return '';
  return SPA_HARNESS_IDS.find(
    (harnessId) => raw === `harness-${harnessId}` || raw.startsWith(`harness-${harnessId}-`),
  ) || '';
}

/**
 * True for a harness Keys/Models sub-tab (the model catalog is loaded there).
 * The OpenCode Approvals tab is excluded.
 *
 * @param {string} tabId
 * @param {string} harnessId
 * @returns {boolean}
 */
function isHarnessModelSubtab(tabId, harnessId) {
  if (!isHarnessSubtabOf(tabId, harnessId)) return false;
  return tabId === `harness-${harnessId}-keys` || tabId === `harness-${harnessId}-models`;
}

export function ensureSettingsTabsVisible() {
  const tabBar = document.getElementById('settings-tabs');
  if (!tabBar) return;
  tabBar.hidden = false;
  tabBar.style.display = 'flex';
  tabBar.style.visibility = 'visible';
  tabBar.style.opacity = '1';
  tabBar.querySelectorAll('.settings-tab').forEach((btn) => {
    btn.hidden = false;
    btn.style.display = 'inline-flex';
    btn.style.visibility = 'visible';
    btn.style.opacity = '1';
  });
}

/**
 * @param {string} tabId
 */
export function refreshSettingsTabPanels(tabId) {
  const settingsPanel = document.getElementById('settings-panel');
  if (!settingsPanel?.classList.contains('active')) return;
  ensureSettingsHeavyModules();
  if (tabId === 'harness' || tabId.startsWith('harness-overview-')) refreshHarnessSettingsPanel(tabId);
  refreshHarnessVersionCardsForTab(tabId);
  if (getHarnessIdFromSettingsTab(tabId) && tabId.endsWith('-stats')) void showHarnessStatistics(getHarnessIdFromSettingsTab(tabId));
  if (isHarnessModelSubtab(tabId, 'sdk')) refreshModelSettingsPanel();
  for (const panel of HARNESS_MODEL_SETTINGS_PANELS) {
    if (isHarnessModelSubtab(tabId, panel.harness)) panel.refresh();
  }
  if (tabId === 'harness-opencode-approvals') void refreshApprovalBrokerSettings();
  if (tabId.endsWith('-approvals')) {
    const section = document.querySelector(`.settings-section[data-settings-tab="${tabId}"]`);
    section?.querySelectorAll('cr-permission-grants').forEach((panel) => void panel.refresh());
  }
  if (tabId === 'chat') {
    refreshModelSettingsPanel();
    loadSettingsPanel('agentsSettings', () => {});
  }
  if (tabId === 'connection-certificates') {
    void import('../../features/settings/tlsSettings.js').then(({ refreshTlsSettings }) => refreshTlsSettings());
  }
  if (tabId === 'usage') void refreshUsageSettings();
  if (tabId === 'wakeups') void refreshWakeupsSettings();
  if (tabId === 'backups') void refreshDataBackupSettings();
  if (tabId === 'delegations') void refreshDelegationCenter();
  if (tabId === 'delegations-lessons') void refreshReviewLessonsSettings();
  else if (tabId === 'delegations-prompts') void refreshAgentPromptsSettings();
  else if (isDelegationSettingsTab(tabId) && tabId !== 'delegations') void refreshDelegationSettings();
  if (tabId === 'widgets') {
    loadSettingsPanel('widget', () => callLoadedPanel('widget', 'refreshWidgetPanel'));
  }
  if (tabId === 'mcp-clients') {
    loadSettingsPanel('mcpSettings', () => callLoadedPanel('mcpSettings', 'refreshExternalMcpSettingsPanel'));
  }
  if (isMcpOperatorSettingsTab(tabId)) void showMcpOperatorSettingsTab(tabId);
  if (tabId === 'mcp') {
    loadSettingsPanel('mcpSettings', () => callLoadedPanel('mcpSettings', 'refreshMcpSettingsPanel'));
  }
  if (tabId === 'execution') {
    loadSettingsPanel('executionSettings', () => callLoadedPanel('executionSettings', 'refreshExecutionSettingsPanel'));
  }
  if (isWatcherSettingsTab(tabId)) {
    loadSettingsPanel('watcherSettings', () => {
      const root = document.getElementById('settings-watcher-root');
      if (root?.dataset.rendered === 'true') {
        callLoadedPanel('watcherSettings', 'syncWorkspaceWatcherSettingsTab');
        return;
      }
      callLoadedPanel('watcherSettings', 'refreshWorkspaceWatcherSettingsPanel');
    });
  }
}

/**
 * @param {HTMLElement} btn
 * @param {string} tabId
 * @param {boolean} inMainBar
 * @returns {boolean}
 */
function isSettingsTabButtonActive(btn, tabId, inMainBar) {
  const btnTab = btn.dataset.settingsTab || '';
  if (inMainBar && btnTab === 'harness') return isHarnessSettingsTab(tabId);
  if (inMainBar && btnTab === 'interface') return isInterfaceSettingsTab(tabId);
  if (inMainBar && btnTab === 'chat') return isChatSettingsTab(tabId);
  if (inMainBar && btnTab === 'delegations') return isDelegationSettingsTab(tabId);
  if (inMainBar && btnTab === 'watcher') return isWatcherSettingsTab(tabId);
  if (inMainBar && btnTab === 'connection') return isConnectionSettingsTab(tabId);
  if (inMainBar && btnTab === 'mcp') return isMcpSettingsTab(tabId);
  if (!inMainBar && btnTab === 'mcp-operator' && btn.closest('#settings-mcp-tabs')) return isMcpOperatorSettingsTab(tabId);
  const harnessTab = btn.dataset.harnessTab || '';
  if (!inMainBar && btnTab === 'harness' && btn.closest('#settings-harness-tabs')) return tabId === 'harness' || tabId.startsWith('harness-overview-');
  if (harnessTab) return isHarnessSubtabOf(tabId, harnessTab);
  return btnTab === tabId;
}

/**
 * @param {HTMLElement | null} root
 * @param {string} tabId
 * @param {boolean} inMainBar
 * @returns {HTMLElement | null}
 */
export function applySettingsTabButtonState(root, tabId, inMainBar) {
  let activeBtn = null;
  root?.querySelectorAll('.settings-tab').forEach((btn) => {
    const isActive = isSettingsTabButtonActive(btn, tabId, inMainBar);
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) activeBtn = btn;
  });
  return activeBtn;
}

export function applySettingsTab(tabId) {
  const resolvedTabId = remapSettingsTab(tabId);
  if (!SETTINGS_TABS.includes(resolvedTabId)) return;
  const settingsPanel = document.getElementById('settings-panel');
  if (settingsPanel) settingsPanel.dataset.activeSettingsTab = resolvedTabId;
  const mainBar = document.getElementById('settings-tabs');
  const harnessBar = document.getElementById('settings-harness-tabs');
  const interfaceBar = document.getElementById('settings-interface-tabs');
  const chatBar = document.getElementById('settings-chat-tabs');
  const delegationBar = document.getElementById('settings-delegation-tabs');
  const watcherBar = document.getElementById('settings-watcher-tabs');
  const connectionBar = document.getElementById('settings-connection-tabs');
  const mcpBar = document.getElementById('settings-mcp-tabs');
  const mcpOperatorBar = document.getElementById('settings-mcp-operator-tabs');
  let activeBtn = applySettingsTabButtonState(mainBar, resolvedTabId, true);
  activeBtn = applySettingsTabButtonState(harnessBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(interfaceBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(chatBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(delegationBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(watcherBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(connectionBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(mcpBar, resolvedTabId, false) || activeBtn;
  activeBtn = applySettingsTabButtonState(mcpOperatorBar, resolvedTabId, false) || activeBtn;

  const activeHarnessId = resolvedTabId === 'harness' || resolvedTabId.startsWith('harness-overview-')
    ? 'overview' : getHarnessIdFromSettingsTab(resolvedTabId);
  document.querySelectorAll('.settings-harness-subtab-bar').forEach((bar) => {
    const barHarnessId = bar.dataset.harnessId || '';
    const isVisible = Boolean(activeHarnessId) && barHarnessId === activeHarnessId;
    bar.hidden = !isVisible;
    const barActiveBtn = applySettingsTabButtonState(bar, resolvedTabId, false);
    if (isVisible) activeBtn = barActiveBtn || activeBtn;
  });

  if (harnessBar) harnessBar.hidden = !isHarnessSettingsTab(resolvedTabId);
  if (interfaceBar) interfaceBar.hidden = !isInterfaceSettingsTab(resolvedTabId);
  if (chatBar) chatBar.hidden = !isChatSettingsTab(resolvedTabId);
  if (delegationBar) delegationBar.hidden = !isDelegationSettingsTab(resolvedTabId);
  if (watcherBar) watcherBar.hidden = !isWatcherSettingsTab(resolvedTabId);
  if (connectionBar) connectionBar.hidden = !isConnectionSettingsTab(resolvedTabId);
  if (mcpBar) mcpBar.hidden = !isMcpSettingsTab(resolvedTabId);
  if (mcpOperatorBar) mcpOperatorBar.hidden = !isMcpOperatorSettingsTab(resolvedTabId);
  document.querySelectorAll('.settings-section[data-settings-tab]').forEach((section) => {
    if (section.id === 'settings-account-section' && section.dataset.accountEnabled !== 'true') {
      section.hidden = true;
      return;
    }
    const sectionTab = section.dataset.settingsTab || '';
    if (sectionTab === 'watcher') {
      section.hidden = !isWatcherSettingsTab(resolvedTabId);
      return;
    }
    // One MCP operator page; its sub-tabs only switch panels inside it.
    if (sectionTab === 'mcp-operator') {
      /** @type {HTMLElement} */ (section).hidden = !isMcpOperatorSettingsTab(resolvedTabId);
      return;
    }
    section.hidden = sectionTab !== resolvedTabId;
  });
  applySettingsFooters(document, resolvedTabId);
  try {
    writeStorageValueWithAlias(localStorage, SETTINGS_TAB_LS_KEY, resolvedTabId);
  } catch (_) {}
  if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
    activeBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
  refreshSettingsTabPanels(resolvedTabId);
}

function bindSettingsTabClicks(root) {
  if (!root) return;
  root.querySelectorAll('.settings-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.settingsTab || 'workspace';
      void getSharedSpaNavigation()?.navigate(
        { panel: 'settings', settingsTab: tabId },
        { explicit: true },
      );
    });
  });
}

export function initSettingsTabs() {
  const tabBar = document.getElementById('settings-tabs');
  if (!tabBar) return;
  ensureSettingsTabsVisible();

  let initialTab = 'workspace';
  const requestedTab = remapSettingsTab(readRequestedSettingsTab());
  if (requestedTab && SETTINGS_TABS.includes(requestedTab)) {
    initialTab = requestedTab;
  } else {
    try {
      const stored = remapSettingsTab(readStorageValueWithAlias(localStorage, SETTINGS_TAB_LS_KEY, ''));
      if (stored && SETTINGS_TABS.includes(stored)) initialTab = stored;
    } catch (_) {}
  }

  bindSettingsTabClicks(tabBar);
  bindSettingsTabClicks(document.getElementById('settings-harness-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-interface-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-chat-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-delegation-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-watcher-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-connection-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-mcp-tabs'));
  bindSettingsTabClicks(document.getElementById('settings-mcp-operator-tabs'));
  document.querySelectorAll('.settings-harness-subtab-bar').forEach((bar) => {
    bindSettingsTabClicks(bar);
  });
  applySettingsTab(initialTab);
}
