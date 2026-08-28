/**
 * Tasks panel: like Chat/Terminal — many runs, each with its own console (xterm), picked from a select.
 * After a page reload it reattaches to the runs still active on the server (GET /api/task-runs, ws-task?run=).
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_FONT_FAMILY } from './config.js';
import { safeFit, isMobile, observeContainerResize } from './terminalViewport.js';
import { deleteTaskRun, getTaskRuns, getSettings, getTasks } from './core/api/index.js';
import { initDropdown } from './lib/dropdown.js';
import { createFavoritesStore } from './lib/favorites.js';
import { initModal } from './lib/modal.js';
import {
  getBackgroundGraceMs,
  getLastBackgroundDurationMs,
  getReconnectModalDelayMs,
  isPageCurrentlyHidden,
  clearLastBackgroundDurationMs,
} from './lib/pageBackgroundGrace.js';
import {
  SERVER_RESTART_READY_EVENT,
  notifyServerRestartRecoveryComplete,
  kickServerRestartRecoveryIfStuck,
  shouldSuppressServerDisconnectUi,
} from './app/serverRestartCoordinator.js';
import { createRunPanelEngine } from './shared/runPanels/runPanelEngine.js';
import { getTerminalTheme, listenForTerminalThemeChanges } from './terminalTheme.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from './lib/storageKeyAlias.js';
import { t } from './i18n/index.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

/** @type {Array<{ id: string, runId: string | null, taskLabel: string, term: import('@xterm/xterm').Terminal, fitAddon: object, pane: HTMLElement, ws: WebSocket | null }>} */
let activeTaskRunId = null;

export function getTasksTerminalState() {
  const run = activeTaskRunId ? taskRunEngine.findRunById(activeTaskRunId) : null;
  if (!run) return { term: null, fitAddon: null, ws: null };
  return { term: run.term, fitAddon: run.fitAddon, ws: run.ws || null };
}

export function fitTasksTerminal() {
  const run = activeTaskRunId ? taskRunEngine.findRunById(activeTaskRunId) : null;
  if (!run?.term || !run?.fitAddon || !run?.pane) return;
  const wrap = run.pane.querySelector('.terminal-viewport-wrap');
  if (wrap) safeFit(run.term, run.fitAddon, wrap);
}

const TASK_VALUE_PREFIX = 'task:';
let selectedTaskBarValue = '';
let tasksDropdownApi = null;
const taskFavorites = createFavoritesStore('cretli-favorites-tasks');
const TASK_AUTOSTART_STORAGE_KEY = 'cretli-autostart-tasks';
const TASK_SERVER_INSTANCE_TOKEN_STORAGE_KEY = 'cretli-server-instance-token';
const TASK_CATCHUP_MAX_CHARS = 12000;
const TASK_OUTPUT_FLUSH_INTERVAL_MS = 16;
const TASK_DEBUG_STORAGE_KEY = 'cretli-debug-tasks';
const TASK_PERF_STORAGE_KEY = 'cretli-debug-tasks-perf';
const TASK_DEBUG_REPORT_INTERVAL_MS = 1000;
const TASK_DEBUG_EVENT_LOOP_TICK_MS = 500;
const TASK_DEBUG_EVENT_LOOP_LAG_WARN_MS = 180;
let autoStartBootDone = false;
const TASK_RECOVERY_POLL_INTERVAL_MS = 1500;
const TASK_RECOVERY_TIMEOUT_MS = 90000;
let reconnectRecoveryStartedAt = 0;
let reconnectRecoveryTimerId = null;
let reconnectRecoveryInProgress = false;
let reconnectModalDelayTimerId = null;
let reconnectModalApi = null;
let tasksDebugLoopMonitorStarted = false;
let reconnectTaskRunsPromise = null;
let serverRestartListenerBound = false;
const taskRunEngine = createRunPanelEngine({
  createSocket: (run) => buildTaskRunSocket(run),
  output: {
    flushIntervalMs: TASK_OUTPUT_FLUSH_INTERVAL_MS,
    maxQueueChars: TASK_CATCHUP_MAX_CHARS,
    transformCatchUp: (data) => processCatchUpOutput(data),
    onFlush: ({ run, output, shouldReset }) => flushTaskRunOutput(run, output, shouldReset),
  },
  onBeforeConnect: ({ run }) => {
    const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof location !== 'undefined' ? location.host : '';
    let wsPath = '/ws-task?task=' + encodeURIComponent(run.taskLabel);
    if (run.runId) wsPath += '&run=' + encodeURIComponent(run.runId);
    tasksDebugLog('Opening ws-task connection', {
      taskLabel: run.taskLabel,
      runId: run.runId,
      wsPath: protocol + '//' + host + wsPath,
    });
  },
  onMessage: ({ run, message }) => {
    if (message.type === 'output') {
      if (run.debugStats) {
        const msgChars = typeof message.data === 'string' ? message.data.length : 0;
        run.debugStats.msgCount += 1;
        run.debugStats.bytes += msgChars;
        if (message.catchUp) {
          run.debugStats.catchUpCount += 1;
          run.debugStats.catchUpBytes += msgChars;
        }
        const queueLen = typeof run.pendingOutput === 'string' ? run.pendingOutput.length : 0;
        if (queueLen > run.debugStats.maxQueueChars) run.debugStats.maxQueueChars = queueLen;
      }
      maybeReportRunDebugStats(run);
    }
    if (message.type === 'taskRunId' && message.runId) {
      run.runId = message.runId;
      tasksDebugLog('Received taskRunId', {
        taskLabel: run.taskLabel,
        runId: run.runId,
      });
      updateTaskRunSelect();
    }
  },
  onOpen: ({ run }) => {
    if (run.runId) {
      run.term.writeln('\x1b[32m' + t('tasks.joinedSession', { label: run.taskLabel }) + '\x1b[0m\r\n');
    } else {
      run.term.writeln('\x1b[32m' + t('tasks.starting', { label: run.taskLabel }) + '\x1b[0m\r\n');
    }
    hideTasksReconnectModal();
    stopReconnectRecovery();
    fitTasksTerminal();
    tasksDebugLog('ws-task opened', {
      taskLabel: run.taskLabel,
      runId: run.runId,
      activeTaskRunId,
    });
  },
  onClose: ({ run, event }) => {
    updateTaskRunSelect();
    tasksDebugLog('ws-task closed', {
      taskLabel: run.taskLabel,
      runId: run.runId,
      code: event?.code,
      wasClean: event?.wasClean,
      reason: event?.reason || '',
    });
    if (!shouldRecoverTaskRun(run, event)) return;
    run.term.writeln('\x1b[33m' + t('tasks.connectionLost') + '\x1b[0m\r\n');
    startReconnectRecovery();
  },
});
const taskRuns = taskRunEngine.getRuns();
listenForTerminalThemeChanges(() => taskRuns.map((run) => run.term));

function normalizeScopePath(pathValue) {
  if (typeof pathValue !== 'string') return '';
  return pathValue.replace(/\\/g, '/').replace(/\/$/, '').trim();
}

function readCurrentWorkspaceScope() {
  if (typeof document === 'undefined') {
    return { workspaceFile: '', workspaceFolder: '' };
  }
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFile: normalizeScopePath(trigger?.dataset?.workspaceFile || ''),
    workspaceFolder: normalizeScopePath(trigger?.dataset?.workspaceFolder || ''),
  };
}

function getTasksScopeCacheKey() {
  const scope = readCurrentWorkspaceScope();
  return `${scope.workspaceFile}::${scope.workspaceFolder}`;
}

function stampRunWorkspaceScope(run) {
  if (!run || typeof run !== 'object') return;
  const scope = readCurrentWorkspaceScope();
  run.workspaceFile = scope.workspaceFile;
  run.workspaceFolder = scope.workspaceFolder;
}

function isRunInWorkspaceScope(run, scope = readCurrentWorkspaceScope()) {
  if (!run || !scope.workspaceFile) return false;
  const runWorkspaceFile = normalizeScopePath(run.workspaceFile || '');
  if (!runWorkspaceFile || runWorkspaceFile !== scope.workspaceFile) return false;

  const scopeFolder = normalizeScopePath(scope.workspaceFolder || '');
  if (!scopeFolder) return true;

  const runWorkspaceFolder = normalizeScopePath(run.workspaceFolder || '');
  return !!runWorkspaceFolder && runWorkspaceFolder === scopeFolder;
}

function getScopedTaskRuns(scope = readCurrentWorkspaceScope()) {
  return taskRuns.filter((run) => isRunInWorkspaceScope(run, scope));
}

function removeRunFromUi(runId) {
  if (!runId) return;
  const run = taskRunEngine.findRunById(runId);
  if (!run) return;
  run.preventRecoveryOnce = true;
  if (run.ws && (run.ws.readyState === WebSocket.OPEN || run.ws.readyState === WebSocket.CONNECTING)) {
    try {
      run.ws.close(1000, 'workspace-scope-changed');
    } catch (_) {}
  }
  if (run.pane?.parentNode) run.pane.parentNode.removeChild(run.pane);
  taskRunEngine.removeRunById(runId);
}

function pruneOutOfScopeTaskRuns() {
  const scope = readCurrentWorkspaceScope();
  if (!scope.workspaceFile) return;
  const staleRunIds = taskRuns
    .filter((run) => !isRunInWorkspaceScope(run, scope))
    .map((run) => run.id)
    .filter(Boolean);
  for (const runId of staleRunIds) {
    removeRunFromUi(runId);
  }
  if (activeTaskRunId && !taskRunEngine.findRunById(activeTaskRunId)) {
    activeTaskRunId = null;
  }
}

function isTasksDebugEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.CRETLI_DEBUG_TASKS === true) return true;
  if (window.CURSOR_REMOTE_DEBUG_TASKS === true) return true;
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search || '');
    if (params.get('tasksDebug') === '1') return true;
  }
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, TASK_DEBUG_STORAGE_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function tasksDebugLog(message, details) {
  if (!isTasksDebugEnabled()) return;
  if (typeof details === 'undefined') {
    console.log('[tasks-debug]', message);
    return;
  }
  console.log('[tasks-debug]', message, details);
}

function isTasksPerfEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.CRETLI_DEBUG_TASKS_PERF === true) return true;
  if (window.CURSOR_REMOTE_DEBUG_TASKS_PERF === true) return true;
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search || '');
    if (params.get('tasksPerf') === '1') return true;
  }
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, TASK_PERF_STORAGE_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

function tasksPerfLog(message, details) {
  if (!isTasksPerfEnabled()) return;
  if (typeof details === 'undefined') {
    console.log('[tasks-perf]', message);
    return;
  }
  console.log('[tasks-perf]', message, details);
}

function ensureTasksDebugLoopMonitor() {
  if (!isTasksDebugEnabled()) return;
  if (tasksDebugLoopMonitorStarted) return;
  tasksDebugLoopMonitorStarted = true;
  let expected = Date.now() + TASK_DEBUG_EVENT_LOOP_TICK_MS;
  setInterval(() => {
    const now = Date.now();
    const lagMs = now - expected;
    if (lagMs > TASK_DEBUG_EVENT_LOOP_LAG_WARN_MS) {
      tasksDebugLog('Main thread lag detected', { lagMs });
    }
    expected = now + TASK_DEBUG_EVENT_LOOP_TICK_MS;
  }, TASK_DEBUG_EVENT_LOOP_TICK_MS);
  tasksDebugLog('Event loop monitor started', {
    tickMs: TASK_DEBUG_EVENT_LOOP_TICK_MS,
    warnLagMs: TASK_DEBUG_EVENT_LOOP_LAG_WARN_MS,
  });
}

function stopReconnectModalDelay() {
  if (reconnectModalDelayTimerId == null) return;
  clearTimeout(reconnectModalDelayTimerId);
  reconnectModalDelayTimerId = null;
}

function scheduleReconnectModalIfNeeded(message) {
  if (shouldSuppressServerDisconnectUi()) return;
  if (reconnectModalDelayTimerId != null) return;
  const delayMs = getReconnectModalDelayMs({
    hidden: isPageCurrentlyHidden(),
    recentBackgroundMs: getLastBackgroundDurationMs(),
    graceMs: getBackgroundGraceMs(),
  });
  if (delayMs == null) return;
  reconnectModalDelayTimerId = setTimeout(() => {
    reconnectModalDelayTimerId = null;
    if (shouldSuppressServerDisconnectUi()) return;
    showTasksReconnectModalIfVisible(message);
  }, delayMs);
}

function bindBackgroundReconnectUi() {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopReconnectModalDelay();
      return;
    }
    if (!isTasksPanelActive()) {
      stopReconnectModalDelay();
      reconnectModalApi?.close?.();
    }
    if (!reconnectRecoveryStartedAt) return;
    clearLastBackgroundDurationMs();
    scheduleReconnectRecovery(0);
    scheduleReconnectModalIfNeeded(t('tasks.serverDisconnected'));
  });
}

function isRunSocketActive(run) {
  return taskRunEngine.isSocketActive(run);
}

function ensureTasksReconnectModal() {
  if (reconnectModalApi) return reconnectModalApi;
  const modal = document.getElementById('tasks-reconnect-modal');
  if (!modal) return null;
  reconnectModalApi = initModal(modal);
  const retryBtn = document.getElementById('tasks-reconnect-retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      startReconnectRecovery();
    });
  }
  return reconnectModalApi;
}

function isTasksPanelActive() {
  if (typeof document === 'undefined') return false;
  return document.getElementById('tasks-panel')?.classList.contains('active') === true;
}

function showTasksReconnectModal(message) {
  const modalApi = ensureTasksReconnectModal();
  if (!modalApi) return;
  const text = document.getElementById('tasks-reconnect-text');
  if (text && message) text.textContent = message;
  modalApi.open();
}

function showTasksReconnectModalIfVisible(message) {
  if (!isTasksPanelActive()) return;
  showTasksReconnectModal(message);
}

function hideTasksReconnectModal() {
  const modalApi = ensureTasksReconnectModal();
  if (!modalApi) return;
  modalApi.close();
}

function stopReconnectRecovery() {
  if (reconnectRecoveryTimerId != null) {
    clearTimeout(reconnectRecoveryTimerId);
    reconnectRecoveryTimerId = null;
  }
  stopReconnectModalDelay();
  reconnectRecoveryStartedAt = 0;
}

function scheduleReconnectRecovery(delayMs = TASK_RECOVERY_POLL_INTERVAL_MS) {
  reconnectRecoveryTimerId = setTimeout(() => {
    reconnectRecoveryTimerId = null;
    pollReconnectRecovery();
  }, delayMs);
}

function readStoredServerInstanceToken() {
  if (typeof localStorage === 'undefined') return '';
  try {
    const token = readStorageValueWithAlias(localStorage, TASK_SERVER_INSTANCE_TOKEN_STORAGE_KEY, '');
    if (!token || typeof token !== 'string') return '';
    return token.trim();
  } catch (_) {
    return '';
  }
}

function writeStoredServerInstanceToken(token) {
  if (typeof localStorage === 'undefined') return;
  if (!token || typeof token !== 'string') return;
  const clean = token.trim();
  if (!clean) return;
  try {
    writeStorageValueWithAlias(localStorage, TASK_SERVER_INSTANCE_TOKEN_STORAGE_KEY, clean);
  } catch (_) {}
}

function extractServerInstanceToken(settingsData) {
  if (!settingsData || typeof settingsData !== 'object') return '';
  if (typeof settingsData.serverInstanceToken !== 'string') return '';
  return settingsData.serverInstanceToken.trim();
}

function didServerRestart(settingsData) {
  const currentToken = extractServerInstanceToken(settingsData);
  if (!currentToken) return false;
  const previousToken = readStoredServerInstanceToken();
  writeStoredServerInstanceToken(currentToken);
  if (!previousToken) return false;
  return previousToken !== currentToken;
}

function cacheServerInstanceTokenOnInit() {
  getSettings()
    .then((data) => {
      if (!data?.ok) return;
      const token = extractServerInstanceToken(data);
      if (!token) return;
      writeStoredServerInstanceToken(token);
    })
    .catch(() => {});
}

function readTaskAutostartSet() {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = readStorageValueWithAlias(localStorage, TASK_AUTOSTART_STORAGE_KEY, '');
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x) => typeof x === 'string' && x.trim()));
  } catch (_) {
    return new Set();
  }
}

function writeTaskAutostartSet(set) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, TASK_AUTOSTART_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch (_) {}
}

function isTaskAutoStart(taskLabel) {
  if (!taskLabel || typeof taskLabel !== 'string') return false;
  return readTaskAutostartSet().has(taskLabel);
}

function toggleTaskAutoStart(taskLabel) {
  if (!taskLabel || typeof taskLabel !== 'string') return false;
  const set = readTaskAutostartSet();
  if (set.has(taskLabel)) {
    set.delete(taskLabel);
    writeTaskAutostartSet(set);
    return false;
  }
  set.add(taskLabel);
  writeTaskAutostartSet(set);
  return true;
}

function getTaskLabelFromValue(value) {
  if (!value || !value.startsWith(TASK_VALUE_PREFIX)) return '';
  return value.slice(TASK_VALUE_PREFIX.length);
}

function shouldRecoverTaskRun(run, closeEvent) {
  if (!run) return false;
  if (run.preventRecoveryOnce === true) {
    run.preventRecoveryOnce = false;
    return false;
  }
  if (closeEvent?.wasClean && closeEvent?.code === 1000) return false;
  if (!run.runId && !isTaskAutoStart(run.taskLabel)) return false;
  return true;
}

/** Fills the select with running runs plus startable tasks from the API; picking a run switches the output view. */
function updateTaskRunSelect(options = {}) {
  pruneOutOfScopeTaskRuns();
  const triggerLabel = document.getElementById('tasks-bar-trigger-label');
  const listEl = document.getElementById('tasks-list-items');
  if (!triggerLabel && !listEl) return;
  const prev = selectedTaskBarValue;
  const cacheGeneration = tasksCacheGeneration;
  const scopedRuns = getScopedTaskRuns();
  const scopeCacheKey = getTasksScopeCacheKey();

  const useCached =
    cachedTasksData &&
    cachedTasksScopeKey === scopeCacheKey &&
    (Date.now() - (cachedTasksData._cachedAt || 0) < CACHED_TASKS_MAX_AGE_MS);
  const fetchPromise = useCached ? Promise.resolve(cachedTasksData) : getTasksApi(options).then((data) => {
    if (cacheGeneration !== tasksCacheGeneration) return null;
    cachedTasksData = data ? { ...data, _cachedAt: Date.now() } : null;
    cachedTasksScopeKey = scopeCacheKey;
    return data;
  });

  fetchPromise.then((data) => {
    if (cacheGeneration !== tasksCacheGeneration) return;
    const tasks = data?.ok && Array.isArray(data.tasks) ? data.tasks : [];

    const runningLabels = new Set(scopedRuns.map((r) => r.taskLabel));
    const tasksAvailable = tasks.filter((t) => !runningLabels.has(t.label));
    const orderedTaskRuns = scopedRuns
      .map((run, idx) => ({ run, idx }))
      .sort((a, b) => {
        const af = taskFavorites.isFavorite(a.run.taskLabel) ? 1 : 0;
        const bf = taskFavorites.isFavorite(b.run.taskLabel) ? 1 : 0;
        if (af !== bf) return bf - af;
        return a.idx - b.idx;
      })
      .map((x) => x.run);
    const orderedTasksAvailable = tasksAvailable
      .map((task, idx) => ({ task, idx }))
      .sort((a, b) => {
        const af = taskFavorites.isFavorite(a.task.label) ? 1 : 0;
        const bf = taskFavorites.isFavorite(b.task.label) ? 1 : 0;
        if (af !== bf) return bf - af;
        return a.idx - b.idx;
      })
      .map((x) => x.task);

    if (prev) {
      if (scopedRuns.some((r) => r.id === prev)) {
        selectedTaskBarValue = prev;
        if (prev !== activeTaskRunId) selectTaskRun(prev);
      } else if (tasksAvailable.some((t) => TASK_VALUE_PREFIX + t.label === prev)) {
        selectedTaskBarValue = prev;
      } else if (activeTaskRunId && scopedRuns.some((r) => r.id === activeTaskRunId)) {
        selectedTaskBarValue = activeTaskRunId;
      } else if (scopedRuns.length > 0) {
        selectedTaskBarValue = scopedRuns[0].id;
        if (scopedRuns[0].id !== activeTaskRunId) selectTaskRun(scopedRuns[0].id);
      } else {
        selectedTaskBarValue = '';
      }
    } else if (scopedRuns.length > 0 && activeTaskRunId && scopedRuns.some((r) => r.id === activeTaskRunId)) {
      selectedTaskBarValue = activeTaskRunId;
    } else if (!selectedTaskBarValue && tasksAvailable.length > 0) {
      selectedTaskBarValue = TASK_VALUE_PREFIX + tasksAvailable[0].label;
    } else if (!selectedTaskBarValue) {
      selectedTaskBarValue = '';
    }

    if (triggerLabel) {
      if (selectedTaskBarValue && selectedTaskBarValue.startsWith(TASK_VALUE_PREFIX)) {
        const label = getTaskLabelFromValue(selectedTaskBarValue);
        triggerLabel.textContent = label ? t('tasks.toRun', { label }) : '—';
      } else {
        const run = selectedTaskBarValue ? scopedRuns.find((r) => r.id === selectedTaskBarValue) : null;
        triggerLabel.textContent = run ? run.taskLabel : '—';
      }
    }

    if (listEl) {
      const runningItems = orderedTaskRuns
        .map((r) => {
          const selected = selectedTaskBarValue === r.id ? ' is-active' : '';
          return (
            '<li class="chat-list-item' +
            selected +
            '" role="option" data-task-value="' +
            escapeHtml(r.id) +
            '" data-task-label="' +
            escapeHtml(r.taskLabel) +
            '" tabindex="-1">' +
            '<span class="chat-list-item-state chat-list-item-state--active" aria-hidden="true"></span>' +
            '<span class="chat-list-item-title">' +
            escapeHtml(r.taskLabel + (r.runId ? '' : t('tasks.connectingSuffix'))) +
            '</span>' +
            '</li>'
          );
        })
        .join('');
      const availableItems = orderedTasksAvailable
        .map((t) => {
          const value = TASK_VALUE_PREFIX + t.label;
          const selected = selectedTaskBarValue === value ? ' is-active' : '';
          return (
            '<li class="chat-list-item' +
            selected +
            '" role="option" data-task-value="' +
            escapeHtml(value) +
            '" data-task-label="' +
            escapeHtml(t.label) +
            '" tabindex="-1">' +
            '<span class="chat-list-item-state chat-list-item-state--idle" aria-hidden="true"></span>' +
            '<span class="chat-list-item-title">' +
            escapeHtml(t.label) +
            '</span>' +
            '</li>'
          );
        })
        .join('');
      listEl.innerHTML =
        (runningItems
          ? '<li class="chat-list-item chat-list-item-header">' + escapeHtml(t('tasks.active')) + '</li>' + runningItems
          : '') +
        (availableItems
          ? '<li class="chat-list-item chat-list-item-header">' + escapeHtml(t('tasks.available')) + '</li>' + availableItems
          : '') +
        (!runningItems && !availableItems
          ? '<li class="chat-list-item tasks-start-empty">' + escapeHtml(t('tasks.none')) + '</li>'
          : '');
      listEl.querySelectorAll('li[data-task-value]').forEach((el) => {
        const taskLabel = el.dataset.taskLabel || '';
        if (taskLabel) {
          const autoStartActive = isTaskAutoStart(taskLabel);
          const autoBtn = document.createElement('button');
          autoBtn.type = 'button';
          autoBtn.className = 'dropdown-fav-btn dropdown-auto-btn';
          autoBtn.title = autoStartActive ? t('tasks.disableAutostart') : t('tasks.enableAutostart');
          autoBtn.setAttribute('aria-label', autoBtn.title);
          autoBtn.innerHTML =
            '<span class="mdi ' +
            (autoStartActive ? 'mdi-rocket-launch dropdown-auto-btn--active' : 'mdi-rocket-launch-outline') +
            '" aria-hidden="true"></span>';
          autoBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const active = toggleTaskAutoStart(taskLabel);
            autoBtn.title = active ? t('tasks.disableAutostart') : t('tasks.enableAutostart');
            autoBtn.setAttribute('aria-label', autoBtn.title);
            autoBtn.innerHTML =
              '<span class="mdi ' +
              (active ? 'mdi-rocket-launch dropdown-auto-btn--active' : 'mdi-rocket-launch-outline') +
              '" aria-hidden="true"></span>';
          });
          el.appendChild(autoBtn);

          const favActive = taskFavorites.isFavorite(taskLabel);
          const favBtn = document.createElement('button');
          favBtn.type = 'button';
          favBtn.className = 'dropdown-fav-btn';
          favBtn.title = favActive ? t('tasks.favoriteRemove') : t('tasks.favoriteAdd');
          favBtn.setAttribute('aria-label', favBtn.title);
          favBtn.innerHTML =
            '<span class="mdi ' +
            (favActive ? 'mdi-star dropdown-fav-btn--active' : 'mdi-star-outline') +
            '" aria-hidden="true"></span>';
          favBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            const active = taskFavorites.toggleFavorite(taskLabel);
            favBtn.title = active ? t('tasks.favoriteRemove') : t('tasks.favoriteAdd');
            favBtn.setAttribute('aria-label', favBtn.title);
            favBtn.innerHTML =
              '<span class="mdi ' +
              (active ? 'mdi-star dropdown-fav-btn--active' : 'mdi-star-outline') +
              '" aria-hidden="true"></span>';
          });
          el.appendChild(favBtn);
        }
        el.addEventListener('click', () => {
          const value = el.dataset.taskValue || '';
          if (!value) return;
          selectedTaskBarValue = value;
          if (!value.startsWith(TASK_VALUE_PREFIX) && scopedRuns.some((r) => r.id === value)) {
            selectTaskRun(value);
          } else {
            updateTaskRunSelect();
          }
          tasksDropdownApi?.close();
        });
      });
    }
  }).catch(() => {
    if (activeTaskRunId && scopedRuns.some((r) => r.id === activeTaskRunId)) {
      selectedTaskBarValue = activeTaskRunId;
    }
    if (triggerLabel) {
      const run = selectedTaskBarValue ? scopedRuns.find((r) => r.id === selectedTaskBarValue) : null;
      triggerLabel.textContent = run ? run.taskLabel : '—';
    }
  });
}

function selectTaskRun(id) {
  const scopedRuns = getScopedTaskRuns();
  if (!scopedRuns.some((run) => run.id === id)) {
    activeTaskRunId = null;
    selectedTaskBarValue = '';
    updateTaskRunSelect();
    return;
  }
  activeTaskRunId = id;
  taskRunEngine.selectRun(id);
  selectedTaskBarValue = id;
  document.querySelectorAll('.tasks-tab-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.taskRunId === id);
  });
  const run = scopedRuns.find((r) => r.id === id);
  tasksDebugLog('Selecting task run', {
    runId: id,
    taskLabel: run?.taskLabel || '',
    hasSocket: !!run?.ws,
    readyState: run?.ws?.readyState,
  });
  if (run && !isRunSocketActive(run)) connectTaskRun(run);
  updateTaskRunSelect();
  fitTasksTerminal();
}

function getTasksApi(options = {}) {
  return getTasks(options);
}

/** Task list cache, so the dropdown can render immediately when the panel is opened. */
let cachedTasksData = null;
let cachedTasksScopeKey = '';
let lastTasksScopeKey = '';
const CACHED_TASKS_MAX_AGE_MS = 60000;
let tasksCacheGeneration = 0;

function invalidateTasksCache() {
  cachedTasksData = null;
  cachedTasksScopeKey = '';
  tasksCacheGeneration += 1;
}

/**
 * Attaches to the runs still active on the server (after a page reload).
 * Returns a promise — once it settles the select has its "running" section filled in.
 */
function reconnectTaskRuns() {
  if (reconnectTaskRunsPromise) return reconnectTaskRunsPromise;
  reconnectTaskRunsPromise = getTaskRuns()
    .then((data) => {
      if (!data?.ok || !Array.isArray(data.runs)) return;
      if (data.runs.length > 1) {
        tasksPerfLog('Detected multiple active task runs during reconnect', {
          count: data.runs.length,
          runs: data.runs.map((x) => ({ taskLabel: x.taskLabel, runId: x.runId })),
        });
      }
      const preferredRunId = activeTaskRunId || null;
      tasksDebugLog('Reconnect task runs fetched', {
        serverRuns: data.runs.length,
        preferredRunId,
        localRuns: taskRuns.length,
      });
      for (const { runId, taskLabel } of data.runs) {
        if (!runId || !taskLabel) continue;
        const existingByRunId = taskRuns.find((r) => r.id === runId || r.runId === runId);
        if (existingByRunId) {
          existingByRunId.runId = runId;
          if (preferredRunId && existingByRunId.id === preferredRunId && !isRunSocketActive(existingByRunId)) {
            connectTaskRun(existingByRunId);
          }
          continue;
        }
        const existingByLabel = taskRuns.find((r) => r.taskLabel === taskLabel && !r.runId && !isRunSocketActive(r));
        if (existingByLabel) {
          existingByLabel.runId = runId;
          if (preferredRunId && existingByLabel.id === preferredRunId) connectTaskRun(existingByLabel);
          continue;
        }
        createTaskRunPane(taskLabel, runId, { autoSelect: false });
      }
      const scopedRuns = getScopedTaskRuns();
      if (!activeTaskRunId && scopedRuns.length > 0) {
        selectTaskRun(scopedRuns[0].id);
      }
      tasksDebugLog('Reconnect task runs complete', {
        localRunsAfter: taskRuns.length,
        activeTaskRunId,
      });
      updateTaskRunSelect();
    })
    .catch(() => {})
    .finally(() => {
      reconnectTaskRunsPromise = null;
    });
  return reconnectTaskRunsPromise;
}

/** Call when the Tasks panel opens — attaches to existing sessions first, so the select can be refreshed afterwards. */
export function ensureTaskRunsReconnected() {
  return reconnectTaskRuns();
}

/**
 * Starts a task by its label, without going through the panel UI.
 * Used by the voice agent tool `run_task`.
 *
 * @param {string} taskLabel
 * @returns {boolean} false when the label is empty
 */
export function runTaskByLabel(taskLabel) {
  const label = String(taskLabel || '').trim();
  if (!label) return false;
  runTask(label);
  return true;
}

/** Called when the Tasks panel opens — preloads the task list. */
export function preloadTasksDropdown() {
  const cacheGeneration = tasksCacheGeneration;
  const scopeCacheKey = getTasksScopeCacheKey();
  getTasksApi().then((data) => {
    if (cacheGeneration !== tasksCacheGeneration) return;
    cachedTasksData = data ? { ...data, _cachedAt: Date.now() } : null;
    cachedTasksScopeKey = scopeCacheKey;
  }).catch(() => {
    if (cacheGeneration !== tasksCacheGeneration) return;
    cachedTasksData = null;
    cachedTasksScopeKey = '';
  });
  reconnectTaskRuns();
}


/**
 * @param {string} taskLabel
 * @param {string} [joinRunId] - when set, attach to an existing run (after a page reload)
 * @param {{ autoSelect?: boolean }} [options]
 */
function createTaskRunPane(taskLabel, joinRunId, options = {}) {
  const { autoSelect = true } = options;
  const id = joinRunId || 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const pane = document.createElement('div');
  pane.className = 'tasks-tab-pane';
  pane.dataset.taskRunId = id;

  const viewportWrap = document.createElement('div');
  viewportWrap.className = 'terminal-viewport-wrap';
  const container = document.createElement('div');
  viewportWrap.appendChild(container);
  pane.appendChild(viewportWrap);

  const term = new Terminal({
    cursorBlink: true,
    theme: getTerminalTheme(),
    fontFamily: TERMINAL_FONT_FAMILY,
    lineHeight: 1,
    letterSpacing: 0,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  term.loadAddon(new CanvasAddon());

  const run = {
    id,
    runId: joinRunId || null,
    taskLabel,
    term,
    fitAddon,
    pane,
    ws: null,
    pendingOutput: '',
    needsTerminalReset: false,
    flushTimerId: null,
    debugStats: {
      lastReportAt: Date.now(),
      msgCount: 0,
      bytes: 0,
      catchUpCount: 0,
      catchUpBytes: 0,
      flushCount: 0,
      flushedChars: 0,
      maxQueueChars: 0,
      maxFlushMs: 0,
    },
  };
  stampRunWorkspaceScope(run);
  taskRunEngine.addRun(run);

  const tabsEl = document.getElementById('tasks-tabs');
  if (tabsEl) tabsEl.appendChild(pane);

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      if (run.id === activeTaskRunId) fitTasksTerminal();
    });
    if (isMobile()) {
      observeContainerResize(viewportWrap, () => {
        if (run.id === activeTaskRunId) fitTasksTerminal();
      });
    }
  }

  updateTaskRunSelect();
  if (autoSelect) selectTaskRun(id);
  return run;
}

function processCatchUpOutput(data) {
  let out = typeof data === 'string' ? data : '';
  if (out.length > 0) {
    tasksPerfLog('Received catch-up payload', { chars: out.length });
  }
  if (out.length <= TASK_CATCHUP_MAX_CHARS) return out;
  out = out.slice(-TASK_CATCHUP_MAX_CHARS);
  return (
    '\r\n\x1b[33m' + t('tasks.catchUpTruncated', { chars: TASK_CATCHUP_MAX_CHARS }) + '\x1b[0m\r\n' + out
  );
}

function flushTaskRunOutput(run, output, shouldReset) {
  if (!run) return;
  const startTs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (shouldReset) run.term.reset();
  if (output) run.term.write(output);
  const endTs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const flushMs = endTs - startTs;
  if (run.debugStats) {
    run.debugStats.flushCount += 1;
    run.debugStats.flushedChars += output.length;
    if (flushMs > run.debugStats.maxFlushMs) run.debugStats.maxFlushMs = flushMs;
    maybeReportRunDebugStats(run);
  }
  if (flushMs > 24) {
    tasksPerfLog('Slow terminal flush', {
      taskLabel: run.taskLabel,
      runId: run.runId,
      flushMs: Number(flushMs.toFixed(2)),
      outputChars: output.length,
      shouldReset,
    });
    tasksDebugLog('Slow flush detected', {
      taskLabel: run.taskLabel,
      runId: run.runId,
      flushMs,
      outputChars: output.length,
      shouldReset,
    });
  }
}

function buildTaskRunSocket(run) {
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : '';
  let wsPath = '/ws-task?task=' + encodeURIComponent(run.taskLabel);
  if (run.runId) wsPath += '&run=' + encodeURIComponent(run.runId);
  return new WebSocket(protocol + '//' + host + wsPath);
}

function maybeReportRunDebugStats(run) {
  if (!isTasksDebugEnabled()) return;
  if (!run?.debugStats) return;
  const now = Date.now();
  if (now - run.debugStats.lastReportAt < TASK_DEBUG_REPORT_INTERVAL_MS) return;
  const s = run.debugStats;
  tasksDebugLog('Run stats', {
    taskLabel: run.taskLabel,
    runId: run.runId,
    wsState: run.ws ? run.ws.readyState : null,
    msgCount: s.msgCount,
    bytes: s.bytes,
    catchUpCount: s.catchUpCount,
    catchUpBytes: s.catchUpBytes,
    flushCount: s.flushCount,
    flushedChars: s.flushedChars,
    maxQueueChars: s.maxQueueChars,
    maxFlushMs: Number(s.maxFlushMs.toFixed(2)),
  });
  run.debugStats.lastReportAt = now;
  run.debugStats.msgCount = 0;
  run.debugStats.bytes = 0;
  run.debugStats.catchUpCount = 0;
  run.debugStats.catchUpBytes = 0;
  run.debugStats.flushCount = 0;
  run.debugStats.flushedChars = 0;
  run.debugStats.maxQueueChars = 0;
  run.debugStats.maxFlushMs = 0;
}

function connectTaskRun(run) {
  if (!run) return;
  taskRunEngine.ensureConnected(run);
}

function runTask(taskLabel) {
  if (!taskLabel) return;
  const scopedRuns = getScopedTaskRuns();
  const existingDisconnected = scopedRuns.find(
    (r) => r.taskLabel === taskLabel && !r.runId && !isRunSocketActive(r)
  );
  if (existingDisconnected) {
    connectTaskRun(existingDisconnected);
    return;
  }
  const run = createTaskRunPane(taskLabel);
  connectTaskRun(run);
}

function getSelectedTaskLabel() {
  const selectedValue = String(selectedTaskBarValue || '').trim();
  const scopedRuns = getScopedTaskRuns();
  if (selectedValue.startsWith(TASK_VALUE_PREFIX)) {
    return getTaskLabelFromValue(selectedValue);
  }
  const selectedRun = selectedValue ? scopedRuns.find((r) => r.id === selectedValue) : null;
  if (selectedRun?.taskLabel) return selectedRun.taskLabel;
  const activeRun = activeTaskRunId ? scopedRuns.find((r) => r.id === activeTaskRunId) : null;
  return activeRun?.taskLabel || '';
}

async function restartTask(taskLabel) {
  if (!taskLabel) return;
  let serverRunId = '';
  try {
    const runsData = await getTaskRuns();
    if (runsData?.ok && Array.isArray(runsData.runs)) {
      const existingServerRun = runsData.runs.find((r) => r.taskLabel === taskLabel && r.runId);
      if (existingServerRun?.runId) serverRunId = existingServerRun.runId;
    }
  } catch (_) {}

  const scopedRuns = getScopedTaskRuns();
  const localRun = scopedRuns.find(
    (r) => r.taskLabel === taskLabel && (r.runId === serverRunId || isRunSocketActive(r))
  );
  if (!serverRunId && localRun?.runId) {
    serverRunId = localRun.runId;
  }
  if (localRun) {
    localRun.preventRecoveryOnce = true;
    if (localRun.ws && (localRun.ws.readyState === WebSocket.OPEN || localRun.ws.readyState === WebSocket.CONNECTING)) {
      try {
        localRun.ws.close(1000, 'restart');
      } catch (_) {}
    }
  }

  if (serverRunId) {
    try {
      await deleteTaskRun(serverRunId);
    } catch (_) {}
  }

  if (localRun) {
    localRun.runId = null;
    localRun.term.reset();
    localRun.term.writeln('\x1b[33m' + t('tasks.restarting') + '\x1b[0m\r\n');
    connectTaskRun(localRun);
    selectTaskRun(localRun.id);
    return;
  }

  runTask(taskLabel);
}

/**
 * Starts a task, or attaches to its existing session when the same task is started again after a reload.
 */
function startOrJoinTask(taskLabel) {
  getTaskRuns().then((data) => {
    if (!data?.ok || !Array.isArray(data.runs)) {
      runTask(taskLabel);
      return;
    }
    const existing = data.runs.find((r) => r.taskLabel === taskLabel);
    if (existing) {
      const scopedRuns = getScopedTaskRuns();
      const alreadyHave = scopedRuns.some((r) => r.id === existing.runId || r.runId === existing.runId);
      if (alreadyHave) {
        selectTaskRun(existing.runId);
        return;
      }
      const run = createTaskRunPane(taskLabel, existing.runId);
      connectTaskRun(run);
      return;
    }
    runTask(taskLabel);
  }).catch(() => runTask(taskLabel));
}

function runTaskAutoStartOnLoad() {
  if (autoStartBootDone) return;
  autoStartBootDone = true;
  const autoStartLabels = Array.from(readTaskAutostartSet());
  if (autoStartLabels.length === 0) return;
  getTasksApi()
    .then((data) => {
      const tasks = data?.ok && Array.isArray(data.tasks) ? data.tasks : [];
      if (tasks.length === 0) return;
      const availableLabels = new Set(tasks.map((t) => t.label).filter((x) => typeof x === 'string' && x));
      for (const label of autoStartLabels) {
        if (!availableLabels.has(label)) continue;
        startOrJoinTask(label);
      }
    })
    .catch(() => {});
}

function restoreRunsAfterBackendRecovered() {
  if (reconnectRecoveryInProgress) return Promise.resolve(1);
  reconnectRecoveryInProgress = true;
  let reconnectCount = 0;
  return getTaskRuns()
    .then((data) => {
      const scopedRuns = getScopedTaskRuns();
      const runs = data?.ok && Array.isArray(data.runs) ? data.runs : [];
      const serverRunIds = new Set(runs.map((x) => x.runId).filter((x) => typeof x === 'string' && x));
      const serverLabels = new Set(runs.map((x) => x.taskLabel).filter((x) => typeof x === 'string' && x));
      for (const run of scopedRuns) {
        if (isRunSocketActive(run)) continue;
        if (run.runId && serverRunIds.has(run.runId)) {
          connectTaskRun(run);
          reconnectCount += 1;
          continue;
        }
        if (!isTaskAutoStart(run.taskLabel)) continue;
        if (serverLabels.has(run.taskLabel)) {
          const serverRun = runs.find((x) => x.taskLabel === run.taskLabel && x.runId);
          if (!serverRun?.runId) continue;
          run.runId = serverRun.runId;
          connectTaskRun(run);
          reconnectCount += 1;
          continue;
        }
        run.runId = null;
        connectTaskRun(run);
        reconnectCount += 1;
      }
      const autoStartLabels = Array.from(readTaskAutostartSet());
      if (autoStartLabels.length === 0) return reconnectCount;
      for (const label of autoStartLabels) {
        if (!label) continue;
        if (serverLabels.has(label)) continue;
        if (scopedRuns.some((r) => r.taskLabel === label && isRunSocketActive(r))) continue;
        runTask(label);
        reconnectCount += 1;
      }
      return reconnectCount;
    })
    .catch(() => 0)
    .finally(() => {
      reconnectRecoveryInProgress = false;
      updateTaskRunSelect();
    });
}

function pollReconnectRecovery() {
  if (!reconnectRecoveryStartedAt) reconnectRecoveryStartedAt = Date.now();
  if (Date.now() - reconnectRecoveryStartedAt > TASK_RECOVERY_TIMEOUT_MS) {
    showTasksReconnectModalIfVisible(t('tasks.noServer'));
    stopReconnectRecovery();
    return;
  }
  getSettings()
    .then((data) => {
      if (!data?.ok) {
        scheduleReconnectModalIfNeeded(t('tasks.serverDisconnected'));
        scheduleReconnectRecovery();
        return;
      }
      if (shouldSuppressServerDisconnectUi()) {
        kickServerRestartRecoveryIfStuck();
      }
      const serverRestarted = didServerRestart(data);
      if (serverRestarted) {
        scheduleReconnectModalIfNeeded(t('tasks.serverRestarted'));
      }
      restoreRunsAfterBackendRecovered().then((reconnectCount) => {
        const socketConnecting = getScopedTaskRuns().some(
          (run) => run.ws?.readyState === WebSocket.CONNECTING
        );
        if (reconnectCount > 0 || socketConnecting) {
          scheduleReconnectRecovery(3000);
          return;
        }
        hideTasksReconnectModal();
        stopReconnectRecovery();
        notifyServerRestartRecoveryComplete();
      });
    })
    .catch(() => {
      scheduleReconnectRecovery();
    });
}

function startReconnectRecovery() {
  if (shouldSuppressServerDisconnectUi()) return;
  if (!reconnectRecoveryStartedAt) reconnectRecoveryStartedAt = Date.now();
  scheduleReconnectModalIfNeeded(t('tasks.serverDisconnected'));
  if (reconnectRecoveryTimerId != null) return;
  scheduleReconnectRecovery(isPageCurrentlyHidden() ? 100 : 300);
}

function bindServerRestartRecovery() {
  if (serverRestartListenerBound) return;
  serverRestartListenerBound = true;
  window.addEventListener(SERVER_RESTART_READY_EVENT, () => {
    try {
      stopReconnectRecovery();
      hideTasksReconnectModal();
    } catch (err) {
      console.warn('[tasks] server restart handler failed', err);
    }
    void restoreRunsAfterBackendRecovered().finally(() => {
      notifyServerRestartRecoveryComplete();
      kickServerRestartRecoveryIfStuck();
    });
  });
}

export function initTasksPanel() {
  tasksPerfLog('Tasks panel initialized', {
    debugEnabled: isTasksDebugEnabled(),
    catchUpMaxChars: TASK_CATCHUP_MAX_CHARS,
    flushIntervalMs: TASK_OUTPUT_FLUSH_INTERVAL_MS,
  });
  ensureTasksDebugLoopMonitor();
  bindServerRestartRecovery();
  bindBackgroundReconnectUi();
  tasksDebugLog('Tasks panel init', {
    catchUpMaxChars: TASK_CATCHUP_MAX_CHARS,
    flushIntervalMs: TASK_OUTPUT_FLUSH_INTERVAL_MS,
  });
  cacheServerInstanceTokenOnInit();
  const clearBtn = document.getElementById('tasks-clear-btn');
  const barTrigger = document.getElementById('tasks-bar-trigger');
  const listModal = document.getElementById('tasks-list-modal');
  const startBtn = document.getElementById('tasks-start-btn');
  const restartBtn = document.getElementById('tasks-restart-btn');
  const startDropdown = document.getElementById('tasks-start-dropdown');
  const startList = document.getElementById('tasks-start-list');

  if (barTrigger && listModal) {
    tasksDropdownApi = initDropdown({
      triggerEl: barTrigger,
      floatingEl: listModal,
      placement: 'bottom-start',
      matchTriggerWidth: true,
      offsetPx: 6,
      viewportPadding: 8,
      minWidthPx: 240,
      maxHeightPx: 420,
    });
    barTrigger.addEventListener('click', () => {
      if (tasksDropdownApi?.isOpen()) {
        tasksDropdownApi.close();
        return;
      }
      updateTaskRunSelect();
      tasksDropdownApi?.open();
    });
    barTrigger.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (tasksDropdownApi?.isOpen()) {
        tasksDropdownApi.close();
        return;
      }
      updateTaskRunSelect();
      tasksDropdownApi?.open();
    });
    updateTaskRunSelect();
  }

  if (startBtn && startDropdown && startList) {
    startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const selVal = (selectedTaskBarValue || '').trim();
      if (selVal.startsWith(TASK_VALUE_PREFIX)) {
        startOrJoinTask(selVal.slice(TASK_VALUE_PREFIX.length));
        return;
      }
      if (startDropdown.hidden) {
        const scopeCacheKey = getTasksScopeCacheKey();
        const useCached =
          cachedTasksData &&
          cachedTasksScopeKey === scopeCacheKey &&
          (Date.now() - (cachedTasksData._cachedAt || 0) < CACHED_TASKS_MAX_AGE_MS);
        const fetchPromise = useCached
          ? Promise.resolve(cachedTasksData)
          : getTasksApi().then((data) => {
              cachedTasksData = { ...data, _cachedAt: Date.now() };
              cachedTasksScopeKey = scopeCacheKey;
              return data;
            });
        fetchPromise.then((data) => {
          if (!data.ok || !Array.isArray(data.tasks) || data.tasks.length === 0) {
            startList.innerHTML =
              '<li class="tasks-start-empty">' + escapeHtml(t('tasks.noTasksFile')) + '</li>';
          } else {
            const runningLabels = new Set(getScopedTaskRuns().map((r) => r.taskLabel));
            const available = data.tasks.filter((t) => !runningLabels.has(t.label));
            if (available.length === 0) {
              startList.innerHTML = '<li class="tasks-start-empty">' + escapeHtml(t('tasks.allRunning')) + '</li>';
            } else {
              startList.innerHTML = available
                .map(
                  (t) =>
                    '<li role="option" tabindex="0" data-task="' + escapeHtml(t.label) + '">' + escapeHtml(t.label) + '</li>'
                )
                .join('');
              startList.querySelectorAll('li[data-task]').forEach((li) => {
                li.addEventListener('click', () => {
                  startOrJoinTask(li.dataset.task);
                  startDropdown.hidden = true;
                });
              });
            }
          }
          startDropdown.hidden = false;
        });
      } else {
        startDropdown.hidden = true;
      }
    });
    document.addEventListener('click', () => {
      if (!startDropdown.hidden) startDropdown.hidden = true;
    });
    startDropdown.addEventListener('click', (e) => e.stopPropagation());
  }

  if (restartBtn) {
    restartBtn.addEventListener('click', async () => {
      const taskLabel = getSelectedTaskLabel();
      if (!taskLabel) return;
      await restartTask(taskLabel);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const run = activeTaskRunId ? taskRunEngine.findRunById(activeTaskRunId) : null;
      if (run?.term) run.term.clear();
    });
  }

  reconnectTaskRuns().then(() => {
    runTaskAutoStartOnLoad();
  });
}

/**
 * Refreshes the list of running runs in the select.
 * @param {{ invalidateCache?: boolean }} [options]
 */
export function refreshTasksList(options = {}) {
  const scopeKey = getTasksScopeCacheKey();
  if (lastTasksScopeKey && scopeKey !== lastTasksScopeKey) {
    invalidateTasksCache();
  } else if (options.invalidateCache) {
    invalidateTasksCache();
  }
  lastTasksScopeKey = scopeKey;
  pruneOutOfScopeTaskRuns();
  updateTaskRunSelect({ fresh: options.invalidateCache === true });
}
