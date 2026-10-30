/**
 * Lazy panel loading: loads a panel chunk the first time its tab opens and
 * runs its one-time init. Holds the per-panel init state for the shell.
 */
import { getActiveChatIdValue, getChatsList } from '../../features/chat/index.js';
import { appLogger } from '../../core/logging/logger.js';
import { safeFit } from '../../features/terminal/services/terminalViewport.js';
import { loadPanelModule, getLoadedPanelModule, hasLazyPanelModule } from './lazyPanelModules.js';

let filesPanelInitialized = false;
/** Set by the shell once the panel router exists (`showPanel` is its product). */
let showPanelFn = () => {};
let initWidgetPanelFn = () => {};

/**
 * @param {{ showPanel: any, initWidgetPanel: any }} deps
 */
export function configurePanelLoader({ showPanel, initWidgetPanel }) {
  showPanelFn = showPanel;
  initWidgetPanelFn = initWidgetPanel;
}

export function ensureFilesPanelInitialized() {
  if (filesPanelInitialized) return;
  const filesModule = getLoadedPanelModule('files');
  if (!filesModule) return;
  filesModule.initFilesPanel();
  filesPanelInitialized = true;
}

/** @type {{ getActiveTerminal?: () => object | null } | null} */
let terminalPanelState = null;

/**
 * Loads and initializes a lazy panel module the first time its tab is opened.
 * @param {string} panelKey
 * @returns {Promise<void>}
 */
export function ensurePanelReady(panelKey) {
  if (!hasLazyPanelModule(panelKey)) return Promise.resolve();
  return loadPanelModule(panelKey).then((mod) => {
    if (panelKey === 'terminal' && !terminalPanelState) {
      terminalPanelState = mod.initTerminalPanel('terminal-container');
      return;
    }
    if (panelKey === 'tasks') {
      initPanelOnce(panelKey, () => mod.initTasksPanel());
      return;
    }
    if (panelKey === 'apps') {
      initPanelOnce(panelKey, () => mod.initAppsPanel());
      return;
    }
    if (panelKey === 'agentsSettings') {
      initPanelOnce(panelKey, () => mod.initAgentsPanel());
      return;
    }
    if (panelKey === 'files') {
      ensureFilesPanelInitialized();
      return;
    }
    if (panelKey === 'git') {
      initPanelOnce(panelKey, () => mod.initGitPanel());
      return;
    }
    if (panelKey === 'github') {
      initPanelOnce(panelKey, () => {
        mod.setGithubPanelRouter(showPanelFn);
        mod.initGithubPanel();
      });
      return;
    }
    if (panelKey === 'widget') {
      initPanelOnce(panelKey, () => initWidgetPanelFn(mod));
      return;
    }
    if (panelKey === 'mcpSettings') {
      initPanelOnce(panelKey, () => mod.initMcpSettingsPanel());
      return;
    }
    if (panelKey === 'executionSettings') {
      initPanelOnce(panelKey, () => mod.initExecutionSettingsPanel());
      return;
    }
    if (panelKey === 'watcherSettings') {
      initPanelOnce(panelKey, () => mod.initWorkspaceWatcherSettingsPanel());
      return;
    }
    if (panelKey === 'instances') {
      initPanelOnce(panelKey, () => mod.initInstancesPanel());
      return;
    }
    if (panelKey === 'browser') {
      initPanelOnce(panelKey, () => mod.initBrowserPanel({
        getActiveChatId: getActiveChatIdValue,
        getChats: getChatsList,
      }));
      return;
    }
    if (panelKey === 'statusTests') {
      initPanelOnce(panelKey, () => mod.initStatusTestsPanel());
    }
  });
}

const initializedPanels = new Set();

function initPanelOnce(panelKey, initFn) {
  if (initializedPanels.has(panelKey)) return;
  initializedPanels.add(panelKey);
  initFn();
}

export function fitTerminalPanel() {
  const activeTerminal = terminalPanelState?.getActiveTerminal?.();
  if (!activeTerminal?.term || !activeTerminal.fitAddon || !activeTerminal.pane) return;
  const viewportWrap = activeTerminal.pane.querySelector('.terminal-viewport-wrap');
  if (!viewportWrap) return;
  safeFit(activeTerminal.term, activeTerminal.fitAddon, viewportWrap);
}

export function getTerminalSendBar() {
  return getLoadedPanelModule('terminal')?.getTerminalSendBar?.() ?? null;
}

export function getTasksTerminalState() {
  return getLoadedPanelModule('tasks')?.getTasksTerminalState?.() ?? null;
}

/**
 * Settings tabs load their module lazily. A chunk that fails to load (stale
 * cache or a rebuild mixing two dist generations) must be logged, not left as
 * an unhandled rejection; reopening the tab retries the import.
 * @param {string} panelKey
 * @param {() => void} onReady
 */
export function loadSettingsPanel(panelKey, onReady) {
  ensurePanelReady(panelKey).then(onReady, (err) => {
    appLogger.log('panel-load', `Settings module "${panelKey}" failed to load: ${err?.message || err}`);
  });
}

/**
 * Panels that were never opened have nothing to refresh, so these wrappers stay
 * silent instead of pulling their chunk in the background.
 */
export function callLoadedPanel(panelKey, methodName, ...args) {
  const mod = getLoadedPanelModule(panelKey);
  const fn = mod?.[methodName];
  if (typeof fn !== 'function') return undefined;
  return fn(...args);
}

/** @returns {{ getActiveTerminal?: () => object | null } | null} */
export function getTerminalPanelState() {
  return terminalPanelState;
}
