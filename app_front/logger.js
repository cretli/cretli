/**
 * In-app log system — in-memory buffer + subscribers (e.g. the Logs panel).
 * Makes logs readable from a phone, without dev tools.
 */
import { initModal } from './lib/modal.js';
import {
  UI_FREEZE_DIAG_LS_KEY,
  LOGS_FILTER_ALL,
  LOGS_FILTER_FREEZE,
  LOGS_FILTER_RESUME,
  matchesLogsPanelFilter,
} from './lib/uiFreezeTrace.js';
import {
  appendFreezeLogEntry,
  clearPersistedFreezeLogs,
  getOrCreateFreezeSessionId,
  readPreviousSessionFreezeEntries,
  rotateFreezeSessionId,
} from './lib/freezeLogPersist.js';
import { getClientInstanceId, getClientUserAgentShort } from './lib/clientInstance.js';
import { getSettings, patchSettings } from './core/api/index.js';
import { readStorageValueWithAlias, writeStorageValueWithAlias } from './lib/storageKeyAlias.js';
import { t } from './i18n/index.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

const MAX_ENTRIES = 2000;
const STARTUP_DEBUG_FLAG_LS_KEY = 'cretli-debug-startup';
const API_DEBUG_FLAG_LS_KEY = 'cretli-debug-api';
const TASKS_DEBUG_FLAG_LS_KEY = 'cretli-debug-tasks';
const TASKS_PERF_FLAG_LS_KEY = 'cretli-debug-tasks-perf';
const OVERLAY_DEBUG_FLAG_LS_KEY = 'cretli-debug-overlay';
const REMOTE_DEBUG_FLAG_LS_KEY = 'cretli-debug-remote';
const SESSION_OVERLAY_SUPPRESS_KEY = 'cr-debug-overlay-suppressed';

function formatArg(a) {
  if (a === null) return 'null';
  if (a === undefined) return 'undefined';
  if (a instanceof Error) {
    const base = `${a.name}: ${a.message}`;
    return a.stack ? `${base}\n${a.stack}` : base;
  }
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch (_) {
      return String(a);
    }
  }
  return String(a);
}

class AppLogger {
  constructor() {
    this.entries = [];
    this.subscribers = new Set();
  }

  /**
   * Appends an entry to the buffer and notifies subscribers.
   * @param {string} tag - e.g. 'fork-title', 'fork-summary', 'auto-title'
   * @param {...*} args - any arguments (objects are serialized to JSON)
   */
  log(tag, ...args) {
    const ts = new Date();
    const timeStr = ts.toTimeString().slice(0, 8) + '.' + String(ts.getMilliseconds()).padStart(3, '0');
    const text = args.map(formatArg).join(' ');
    const entry = { ts: ts.getTime(), timeStr, tag, text };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    this.subscribers.forEach((fn) => {
      try {
        fn(entry);
      } catch (_) {}
    });
  }

  getEntries() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
    this.subscribers.forEach((fn) => {
      try {
        fn(null);
      } catch (_) {}
    });
  }

  /**
   * Subscribes fn: called with the entry on every log, and with null on clear.
   * @param {(object | null) => void} fn
   */
  subscribe(fn) {
    this.subscribers.add(fn);
  }

  unsubscribe(fn) {
    this.subscribers.delete(fn);
  }
}

export const appLogger = new AppLogger();

let logsPanelFilter = LOGS_FILTER_ALL;
/** @type {((reason: string, extraLines?: string[]) => void) | null} */
let clientDebugRemoteFlush = null;
let clientDebugInstrumentationInstalled = false;

const FREEZE_REMOTE_FLUSH_TAGS = new Set([
  'ui-freeze',
  'ui-freeze-perf',
  'ui-freeze-touch',
  'ui-freeze-trace',
  'ui-freeze-http',
  'ui-freeze-ws',
  'page-resume',
]);

/**
 * Queues an immediate remote debug flush (when debugRemote is enabled).
 * @param {string} reason
 * @param {string[]} [extraLines]
 */
export function requestClientDebugRemoteFlush(reason, extraLines = []) {
  if (!clientDebugRemoteFlush) return;
  clientDebugRemoteFlush(reason, extraLines);
}

/**
 * Restores freeze logs from the previous killed session and persists new entries.
 */
export function initFreezeLogRecovery() {
  if (typeof window === 'undefined') return;
  const previousSessionId = getOrCreateFreezeSessionId();
  const restored = readPreviousSessionFreezeEntries(previousSessionId);
  rotateFreezeSessionId();
  appLogger.subscribe((entry) => {
    if (!entry) return;
    appendFreezeLogEntry(entry);
    if (!FREEZE_REMOTE_FLUSH_TAGS.has(String(entry.tag || ''))) return;
    requestClientDebugRemoteFlush(String(entry.tag || 'ui-freeze'));
  });
  if (restored.length === 0) return;
  appLogger.log(
    'system',
    `Restored ${restored.length} freeze entries from the previous session (the app may have been killed after a hang).`
  );
  for (const entry of restored) {
    appLogger.entries.push(entry);
  }
  if (appLogger.entries.length > MAX_ENTRIES) {
    appLogger.entries = appLogger.entries.slice(-MAX_ENTRIES);
  }
  clearPersistedFreezeLogs();
}

function isDebugFlagEnabled(lsKey, queryKey) {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search || '');
    const query = (params.get(queryKey) || '').trim().toLowerCase();
    if (query === '1' || query === 'true' || query === 'yes' || query === 'on') return true;
    if (query === '0' || query === 'false' || query === 'no' || query === 'off') return false;
  }
  if (typeof localStorage === 'undefined') return false;
  try {
    const stored = readStorageValueWithAlias(localStorage, lsKey, '');
    if (!stored) return false;
    const normalized = String(stored).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  } catch (_) {
    return false;
  }
}

function setDebugFlag(lsKey, enabled) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, lsKey, enabled ? '1' : '0');
  } catch (_) {}
}

async function fetchDebugFlagsFromServer() {
  try {
    const data = await getSettings();
    if (!data?.ok) return null;
    return {
      startup: data.debugStartup === true,
      api: data.debugApi === true,
      http: data.debugHttpTiming === true,
      tasks: data.debugTasks === true,
      freeze: data.debugUiFreeze === true,
      overlay: data.debugOverlay === true,
      remote: data.debugRemote === true,
    };
  } catch (_) {
    return null;
  }
}

async function saveDebugFlagsOnServer(flags) {
  try {
    const data = await patchSettings({
      debugStartup: flags.startup,
      debugApi: flags.api,
      debugHttpTiming: flags.http,
      debugTasks: flags.tasks,
      debugUiFreeze: flags.freeze,
      debugOverlay: flags.overlay,
      debugRemote: flags.remote,
    });
    return data?.ok === true;
  } catch (_) {
    return false;
  }
}

/**
 * Mirrors server-persisted debug flags into localStorage before boot hooks read them.
 * @returns {Promise<void>}
 */
export async function syncClientDebugFlagsFromServer() {
  const serverFlags = await fetchDebugFlagsFromServer();
  if (serverFlags === null) return;
  setDebugFlag(STARTUP_DEBUG_FLAG_LS_KEY, serverFlags.startup);
  setDebugFlag(API_DEBUG_FLAG_LS_KEY, serverFlags.api);
  setDebugFlag(TASKS_DEBUG_FLAG_LS_KEY, serverFlags.tasks);
  setDebugFlag(TASKS_PERF_FLAG_LS_KEY, serverFlags.tasks);
  setDebugFlag(UI_FREEZE_DIAG_LS_KEY, serverFlags.freeze);
  setDebugFlag(OVERLAY_DEBUG_FLAG_LS_KEY, serverFlags.overlay);
  setDebugFlag(REMOTE_DEBUG_FLAG_LS_KEY, serverFlags.remote);
}

function isDebugConsoleAllEnabled() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search || '');
  const q = (params.get('debugConsoleAll') || '').trim().toLowerCase();
  return q === '1' || q === 'true' || q === 'yes';
}

function isClientDebugOverlayEnabled() {
  return isDebugFlagEnabled(OVERLAY_DEBUG_FLAG_LS_KEY, 'debugOverlay');
}

function isClientDebugRemoteEnabled() {
  return isDebugFlagEnabled(REMOTE_DEBUG_FLAG_LS_KEY, 'debugRemote');
}

/**
 * Visible overlay + error/console hooks — for debugging on a phone or without DevTools.
 * Enable with ?debugOverlay=1 / ?debugRemote=1 (or from the Debug modal in the Logs tab, via
 * localStorage). "Remote" prints on the server side (RDP).
 */
export function installClientDebugInstrumentation() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (clientDebugInstrumentationInstalled) return;
  const overlayWanted = isClientDebugOverlayEnabled();
  const remoteWanted = isClientDebugRemoteEnabled();
  if (!overlayWanted && !remoteWanted) return;
  clientDebugInstrumentationInstalled = true;

  let overlaySuppressed = false;
  if (overlayWanted) {
    try {
      overlaySuppressed = sessionStorage.getItem(SESSION_OVERLAY_SUPPRESS_KEY) === '1';
    } catch (_) {
      overlaySuppressed = false;
    }
  }
  const showOverlay = overlayWanted && !overlaySuppressed;

  const remoteEnabled = remoteWanted;
  let remoteSentCount = 0;

  function flushRemote(reason, extraLines = []) {
    if (!remoteEnabled) return;
    const entries = appLogger.getEntries();
    if (remoteSentCount > entries.length) remoteSentCount = 0;
    const slice = entries.slice(remoteSentCount);
    remoteSentCount = entries.length;
    const lines = slice.map((e) => `${e.timeStr} [${e.tag}] ${e.text}`);
    for (const line of extraLines) {
      if (typeof line === 'string' && line.trim()) lines.push(line);
    }
    if (lines.length === 0 && reason !== 'heartbeat') return;

    if (reason === 'heartbeat' && lines.length === 0) {
      lines.push(`${new Date().toISOString()} [debug-heartbeat-remote] ok`);
    }
    const ua =
      typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent.slice(0, 600) : '';
    const payload = JSON.stringify({
      reason,
      ua: ua || getClientUserAgentShort(),
      clientInstanceId: getClientInstanceId(),
      lines: lines.slice(-120),
    });
    try {
      fetch(`${window.location.origin || ''}/api/client-debug-log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cr-debug-log': '1',
        },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  }

  clientDebugRemoteFlush = flushRemote;

  window.addEventListener('error', (ev) => {
    const msg = ev?.message || 'error';
    const loc = ev?.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : '';
    const stack = ev?.error?.stack ? String(ev.error.stack) : '';
    appLogger.log('window-error', msg, loc, stack);
    flushRemote('window-error');
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev?.reason;
    const text = r?.stack ? String(r.stack) : String(r);
    appLogger.log('unhandled-rejection', text);
    flushRemote('unhandled-rejection');
  });

  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.warn = (...args) => {
    origWarn(...args);
    appLogger.log('console-warn', ...args.map(formatArg));
    flushRemote('console');
  };
  console.error = (...args) => {
    origError(...args);
    appLogger.log('console-error', ...args.map(formatArg));
    flushRemote('console');
  };

  if (isDebugConsoleAllEnabled()) {
    console.log = (...args) => {
      origLog(...args);
      appLogger.log('console-log', ...args.map(formatArg));
    };
    console.info = (...args) => {
      origInfo(...args);
      appLogger.log('console-info', ...args.map(formatArg));
    };
  }

  let hbN = 0;
  window.setInterval(() => {
    hbN += 1;
    let extra = '';
    if (typeof performance !== 'undefined' && performance.memory?.usedJSHeapSize) {
      extra = ` heap≈${Math.round(performance.memory.usedJSHeapSize / 1048576)}MiB`;
    }
    appLogger.log('debug-heartbeat', `#${hbN}${extra}`);
    flushRemote('heartbeat');
  }, 8000);

  document.addEventListener(
    'visibilitychange',
    () => {
      appLogger.log('visibility', document.visibilityState);
      flushRemote('visibility');
    },
    false
  );

  const attachOverlayUi = () => {
    if (document.getElementById('cr-debug-overlay')) return;

    const root = document.createElement('div');
    root.id = 'cr-debug-overlay';
    root.className = 'cr-debug-overlay';

    const header = document.createElement('div');
    header.className = 'cr-debug-overlay-header';

    const title = document.createElement('span');
    title.className = 'cr-debug-overlay-title';
    title.textContent = t('logs.clientDebug');

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'cr-debug-overlay-btn';
    toggleBtn.textContent = t('logs.collapse');

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'cr-debug-overlay-btn';
    clearBtn.textContent = t('logs.clear');

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'cr-debug-overlay-btn';
    copyBtn.textContent = t('common.copy');

    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'cr-debug-overlay-btn';
    hideBtn.title = t('logs.hideTitle');
    hideBtn.textContent = t('logs.hide');

    header.appendChild(title);
    header.appendChild(toggleBtn);
    header.appendChild(clearBtn);
    header.appendChild(copyBtn);
    header.appendChild(hideBtn);

    const body = document.createElement('div');
    body.className = 'cr-debug-overlay-body';

    const stream = document.createElement('pre');
    stream.className = 'cr-debug-overlay-stream';
    stream.setAttribute('aria-live', 'polite');

    body.appendChild(stream);
    root.appendChild(header);
    root.appendChild(body);

    const updateOverlayHeight = () => {
      const height = Math.ceil(root.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--cr-debug-overlay-height', `${height}px`);
    };
    const overlayResizeObserver =
      typeof ResizeObserver === 'function' ? new ResizeObserver(updateOverlayHeight) : null;

    let collapsed = false;
    const applyCollapsed = () => {
      root.classList.toggle('cr-debug-overlay--collapsed', collapsed);
      toggleBtn.textContent = collapsed ? t('logs.expand') : t('logs.collapse');
      window.requestAnimationFrame(updateOverlayHeight);
    };

    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      applyCollapsed();
    });

    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      appLogger.clear();
    });

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = appLogger
        .getEntries()
        .map((entry) => `${entry.timeStr} [${entry.tag}] ${entry.text}`)
        .join('\n');
      if (!text) return;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    });

    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        sessionStorage.setItem(SESSION_OVERLAY_SUPPRESS_KEY, '1');
      } catch (_) {}
      overlayResizeObserver?.disconnect();
      document.documentElement.style.setProperty('--cr-debug-overlay-height', '0px');
      root.remove();
    });

    function appendLine(entry) {
      const isPinnedToBottom =
        stream.scrollHeight - stream.scrollTop - stream.clientHeight < 24;
      const line = document.createElement('div');
      line.className = 'cr-debug-overlay-line';
      line.textContent = `${entry.timeStr} [${entry.tag}] ${entry.text}`;
      stream.appendChild(line);
      while (stream.childNodes.length > 400) {
        stream.removeChild(stream.firstChild);
      }
      if (isPinnedToBottom) stream.scrollTop = stream.scrollHeight;
    }

    appLogger.subscribe((entry) => {
      if (!entry) {
        stream.textContent = '';
        return;
      }
      appendLine(entry);
    });

    appLogger.getEntries().forEach(appendLine);

    document.body.appendChild(root);
    overlayResizeObserver?.observe(root);
    updateOverlayHeight();
    appLogger.log(
      'system',
      'Debug overlay: ?debugOverlay=1 | remote: ?debugRemote=1 (logs in the server console / RDP). Full console: ?debugConsoleAll=1'
    );
  };

  if (!showOverlay) {
    appLogger.log(
      'system',
      'Remote debug (no overlay): logs on the server / RDP — set ?debugRemote=1. Overlay: ?debugOverlay=1. Full console: ?debugConsoleAll=1'
    );
    return;
  }

  if (document.body) {
    attachOverlayUi();
  } else {
    document.addEventListener('DOMContentLoaded', attachOverlayUi, { once: true });
  }
}

/**
 * Resets instrumentation guard (tests only).
 */
export function resetClientDebugInstrumentationForTests() {
  clientDebugInstrumentationInstalled = false;
  clientDebugRemoteFlush = null;
}

function initLogsDebugControls() {
  const openDebugBtn = document.getElementById('logs-debug-settings-btn');
  const debugModalEl = document.getElementById('logs-debug-modal');
  const startupCb = document.getElementById('logs-debug-startup-checkbox');
  const apiCb = document.getElementById('logs-debug-api-checkbox');
  const httpCb = document.getElementById('logs-debug-http-checkbox');
  const tasksCb = document.getElementById('logs-debug-tasks-checkbox');
  const freezeCb = document.getElementById('logs-debug-freeze-checkbox');
  const overlayCb = document.getElementById('logs-debug-overlay-checkbox');
  const remoteCb = document.getElementById('logs-debug-remote-checkbox');
  const saveBtn = document.getElementById('logs-debug-save');
  const cancelBtn = document.getElementById('logs-debug-cancel');
  if (
    !openDebugBtn ||
    !debugModalEl ||
    !startupCb ||
    !apiCb ||
    !httpCb ||
    !tasksCb ||
    !freezeCb ||
    !overlayCb ||
    !remoteCb ||
    !saveBtn ||
    !cancelBtn
  ) {
    return;
  }

  const debugModalApi = initModal(debugModalEl);

  openDebugBtn.addEventListener('click', async () => {
    startupCb.checked = isDebugFlagEnabled(STARTUP_DEBUG_FLAG_LS_KEY, 'debugStartup');
    apiCb.checked = isDebugFlagEnabled(API_DEBUG_FLAG_LS_KEY, 'debugApi');
    tasksCb.checked =
      isDebugFlagEnabled(TASKS_DEBUG_FLAG_LS_KEY, 'tasksDebug') ||
      isDebugFlagEnabled(TASKS_PERF_FLAG_LS_KEY, 'tasksPerf');
    freezeCb.checked = isDebugFlagEnabled(UI_FREEZE_DIAG_LS_KEY, 'uiFreezeDiag');
    overlayCb.checked = isDebugFlagEnabled(OVERLAY_DEBUG_FLAG_LS_KEY, 'debugOverlay');
    remoteCb.checked = isDebugFlagEnabled(REMOTE_DEBUG_FLAG_LS_KEY, 'debugRemote');
    debugModalApi.open();
    httpCb.disabled = true;
    const serverFlags = await fetchDebugFlagsFromServer();
    if (serverFlags === null) {
      appLogger.log('system', 'Failed to load debug settings from the server.');
      httpCb.disabled = true;
    } else {
      startupCb.checked = serverFlags.startup;
      apiCb.checked = serverFlags.api;
      httpCb.checked = serverFlags.http;
      tasksCb.checked = serverFlags.tasks;
      freezeCb.checked = serverFlags.freeze;
      overlayCb.checked = serverFlags.overlay;
      remoteCb.checked = serverFlags.remote;
      httpCb.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', () => {
    debugModalApi.close();
  });

  saveBtn.addEventListener('click', async () => {
    const startupEnabled = !!startupCb.checked;
    const apiEnabled = !!apiCb.checked;
    const httpEnabled = !!httpCb.checked;
    const tasksEnabled = !!tasksCb.checked;
    const freezeEnabled = !!freezeCb.checked;
    const overlayEnabled = !!overlayCb.checked;
    const remoteEnabled = !!remoteCb.checked;
    setDebugFlag(STARTUP_DEBUG_FLAG_LS_KEY, startupEnabled);
    setDebugFlag(API_DEBUG_FLAG_LS_KEY, apiEnabled);
    setDebugFlag(TASKS_DEBUG_FLAG_LS_KEY, tasksEnabled);
    setDebugFlag(TASKS_PERF_FLAG_LS_KEY, tasksEnabled);
    setDebugFlag(UI_FREEZE_DIAG_LS_KEY, freezeEnabled);
    setDebugFlag(OVERLAY_DEBUG_FLAG_LS_KEY, overlayEnabled);
    setDebugFlag(REMOTE_DEBUG_FLAG_LS_KEY, remoteEnabled);
    saveBtn.disabled = true;
    const serverSaved = await saveDebugFlagsOnServer({
      startup: startupEnabled,
      api: apiEnabled,
      http: httpEnabled,
      tasks: tasksEnabled,
      freeze: freezeEnabled,
      overlay: overlayEnabled,
      remote: remoteEnabled,
    });
    saveBtn.disabled = false;
    appLogger.log(
      'system',
      `Debug saved: startup=${startupEnabled ? 'on' : 'off'}, api=${apiEnabled ? 'on' : 'off'}, http=${httpEnabled ? 'on' : 'off'}, tasks=${tasksEnabled ? 'on' : 'off'}, freeze=${freezeEnabled ? 'on' : 'off'}, overlay=${overlayEnabled ? 'on' : 'off'}, remote=${remoteEnabled ? 'on' : 'off'}.`
    );
    if (!serverSaved) {
      appLogger.log('system', 'Failed to save debug settings on the server.');
    }
    if (startupEnabled || overlayEnabled || remoteEnabled || freezeEnabled) {
      appLogger.log(
        'system',
        'Overlay / remote debug / startup / freeze diag — reload the page to capture logs from the very start of loading.'
      );
    }
    debugModalApi.close();
  });
}

/**
 * Initializes the Logs panel: subscribes to appLogger, renders entries, wires the Clear button.
 */
export function initLogsPanel() {
  const content = document.getElementById('logs-content');
  const clearBtn = document.getElementById('logs-clear-btn');
  const filterSelect = document.getElementById('logs-filter-select');
  if (!content) return;

  function renderEntry(entry) {
    if (!matchesLogsPanelFilter(entry.tag, logsPanelFilter)) return;
    const line = document.createElement('div');
    line.className = 'log-line';
    if (entry.tag && String(entry.tag).startsWith('ui-freeze')) {
      line.classList.add('log-line--freeze');
    }
    line.innerHTML =
      '<span class="log-time">' +
      escapeHtml(entry.timeStr) +
      '</span>' +
      '<span class="log-tag">[' +
      escapeHtml(entry.tag) +
      ']</span>' +
      escapeHtml(entry.text);
    content.appendChild(line);
  }

  function isLogsPanelActive() {
    const panel = document.getElementById('logs-panel');
    return panel?.classList.contains('active') === true;
  }

  if (filterSelect) {
    function applyLogsFilterOptions() {
      if (!('options' in filterSelect)) return;
      filterSelect.options = [
        { value: LOGS_FILTER_ALL, label: t('logs.filterAll') },
        { value: LOGS_FILTER_FREEZE, label: t('logs.filterFreeze') },
        { value: LOGS_FILTER_RESUME, label: t('logs.filterResume') },
      ];
    }
    applyLogsFilterOptions();
    filterSelect.value = logsPanelFilter;
    filterSelect.addEventListener('change', () => {
      logsPanelFilter = filterSelect.value || LOGS_FILTER_ALL;
      refreshLogsPanelDom();
    });
    window.addEventListener('cr-lang-changed', () => {
      applyLogsFilterOptions();
      filterSelect.value = logsPanelFilter;
    });
  }

  appLogger.subscribe((entry) => {
    if (!isLogsPanelActive()) return;
    if (entry) {
      renderEntry(entry);
      content.scrollTop = content.scrollHeight;
      return;
    }
    content.innerHTML = '';
  });

  const copyBtn = document.getElementById('logs-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const entries = appLogger.getEntries();
      const text = entries
        .map((e) => e.timeStr + ' [' + e.tag + '] ' + e.text)
        .join('\n');
      if (!text) {
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          const label = copyBtn.textContent;
          copyBtn.textContent = t('common.copied');
          copyBtn.disabled = true;
          setTimeout(() => {
            copyBtn.textContent = label;
            copyBtn.disabled = false;
          }, 2000);
        }).catch(() => {});
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      appLogger.clear();
    });
  }

  initLogsDebugControls();
}

/**
 * Rebuilds the logs panel DOM from the in-memory buffer (call when opening the Logs tab).
 */
export function refreshLogsPanelDom() {
  const content = document.getElementById('logs-content');
  if (!content) return;
  content.innerHTML = '';
  for (const entry of appLogger.getEntries()) {
    if (!matchesLogsPanelFilter(entry.tag, logsPanelFilter)) continue;
    const line = document.createElement('div');
    line.className = 'log-line';
    if (entry.tag && String(entry.tag).startsWith('ui-freeze')) {
      line.classList.add('log-line--freeze');
    }
    line.innerHTML =
      '<span class="log-time">' +
      escapeHtml(entry.timeStr) +
      '</span>' +
      '<span class="log-tag">[' +
      escapeHtml(entry.tag) +
      ']</span>' +
      escapeHtml(entry.text);
    content.appendChild(line);
  }
  content.scrollTop = content.scrollHeight;
  if (appLogger.getEntries().length === 0) {
    appLogger.log('system', 'Logs panel ready. Fork logs (title from content, summary) and API logs are recorded automatically.');
  }
}
