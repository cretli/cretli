/**
 * Agents panel: reuses the chat machinery (create-chat + /ws-agent) and keeps one run at a time.
 * Starting a run means POST with forAgentRun plus /ws-agent, where the server injects the agent body;
 * when the run ends the panel shows the summary and final status.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { TERMINAL_FONT_FAMILY } from '../../../config.js';
import { safeFit, isMobile, observeContainerResize } from '../../terminal/services/terminalViewport.js';
import {
  getAgentRuns,
  getAgents,
  getAgentsSchedule,
  patchAgentsSchedule,
  postChat,
} from '../../../core/api/index.js';
import { initDropdown } from '../../../lib/dropdown.js';
import { createFavoritesStore } from '../../../lib/favorites.js';
import { createRunPanelEngine } from '../../../shared/runPanels/runPanelEngine.js';
import { getTerminalTheme, listenForTerminalThemeChanges } from '../../terminal/services/terminalTheme.js';
import { t } from '../../../i18n/index.js';
import { escapeHtml } from '../../chat/chatHtmlUtils.js';
import { AGENT_VALUE_PREFIX, createAgentsState } from '../agentsState.js';
import '../agentsViews.js';

/** @type {Array<{ id: string, runId: string | null, agentName: string, term: import('@xterm/xterm').Terminal, fitAddon: object, pane: HTMLElement, ws: WebSocket | null }>} */
let activeAgentRunId = null;

export function getAgentsTerminalState() {
  const run = activeAgentRunId ? agentRuns.find((r) => r.id === activeAgentRunId) : null;
  if (!run) return { term: null, fitAddon: null, ws: null };
  return { term: run.term, fitAddon: run.fitAddon, ws: run.ws || null };
}

export function fitAgentsTerminal() {
  const run = activeAgentRunId ? agentRuns.find((r) => r.id === activeAgentRunId) : null;
  if (!run?.term || !run?.fitAddon || !run?.pane) return;
  const wrap = run.pane.querySelector('.terminal-viewport-wrap');
  if (wrap) safeFit(run.term, run.fitAddon, wrap);
}

let agentsDropdownApi = null;
const agentFavorites = createFavoritesStore('cretli-favorites-agents');
const agentsState = createAgentsState((name) => agentFavorites.isFavorite(name), t);
/** Mounted view elements (set by initAgentsPanel). */
let agentsListEl = null;
let agentsScheduleEl = null;

/** Max length of the run name shown in the UI, taken from the summary JSON. */
const AGENT_RUN_TITLE_MAX_LEN = 60;
const AGENT_TITLE_BUFFER_MAX_CHARS = 8000;
const AGENT_OUTPUT_FLUSH_INTERVAL_MS = 16;
const AGENT_OUTPUT_BUFFER_MAX_CHARS = 12000;

/** Strips ANSI escape codes so JSON can be parsed out of raw terminal output. */
function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z@]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '');
}

/** Matches {"title": "..."}; capture group 1 holds the title value. */
const AGENT_RUN_TITLE_REGEX = /\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

/**
 * Extracts the run title from the output buffer, using the last JSON object that carries "title".
 * @param {string} buffer
 * @returns {string | null}
 */
function extractAgentRunTitle(buffer) {
  if (!buffer || typeof buffer !== 'string') return null;
  const clean = stripAnsi(buffer);
  let lastTitle = null;
  AGENT_RUN_TITLE_REGEX.lastIndex = 0;
  let m;
  while ((m = AGENT_RUN_TITLE_REGEX.exec(clean)) !== null) {
    const t = (m[1] || '').replace(/\\"/g, '"').trim();
    if (t) lastTitle = t;
  }
  if (lastTitle) {
    return lastTitle.length > AGENT_RUN_TITLE_MAX_LEN ? lastTitle.slice(0, AGENT_RUN_TITLE_MAX_LEN) : lastTitle;
  }
  const lines = clean.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.title === 'string' && obj.title.trim()) {
        const t = obj.title.trim();
        return t.length > AGENT_RUN_TITLE_MAX_LEN ? t.slice(0, AGENT_RUN_TITLE_MAX_LEN) : t;
      }
    } catch (_) {}
  }
  return null;
}

const agentRunEngine = createRunPanelEngine({
  createSocket: (run) => buildAgentRunSocket(run),
  output: {
    flushIntervalMs: AGENT_OUTPUT_FLUSH_INTERVAL_MS,
    maxQueueChars: AGENT_OUTPUT_BUFFER_MAX_CHARS,
    onFlush: ({ run, output, shouldReset }) => {
      if (!run) return;
      if (shouldReset) run.term.reset();
      if (output) run.term.write(output);
    },
  },
  onMessage: ({ run, message }) => {
    if (message.type === 'output') {
      const raw = typeof message.data === 'string' ? message.data : '';
      if (raw) {
        run._titleBuffer = (run._titleBuffer + raw).slice(-AGENT_TITLE_BUFFER_MAX_CHARS);
        const title = extractAgentRunTitle(run._titleBuffer);
        if (title && title !== run.displayTitle) {
          run.displayTitle = title;
          updateAgentRunSelect();
        }
      }
    }
    if (message.type === 'agentRunId' && message.runId) {
      run.runId = message.runId;
      updateAgentRunSelect();
    }
  },
  onOpen: ({ run }) => {
    const openMessage = run.openMessage || buildAgentOpenMessage(run);
    run.term.writeln('\x1b[32m' + openMessage + '\x1b[0m\r\n');
    fitAgentsTerminal();
  },
  onClose: ({ run }) => {
    if (run.markFinishedOnClose === true) {
      run.status = 'finished';
      run.markFinishedOnClose = false;
    }
    updateAgentRunSelect();
  },
});
const agentRuns = agentRunEngine.getRuns();
listenForTerminalThemeChanges(() => agentRuns.map((run) => run.term));

function isAgentRunSocketActive(run) {
  return agentRunEngine.isSocketActive(run);
}

function getAgentsApi() {
  return getAgents();
}

let cachedAgentsData = null;
const CACHED_AGENTS_MAX_AGE_MS = 60000;

function getAgentNameFromValue(value) {
  if (!value || !value.startsWith(AGENT_VALUE_PREFIX)) return '';
  return value.slice(AGENT_VALUE_PREFIX.length);
}

/** Selection is plain state; the list view re-renders from the signal. */
function getSelectedValue() {
  return agentsState.selectedValue.get();
}
function setSelectedValue(v) {
  agentsState.selectedValue.set(v);
}

function setTriggerLabel(triggerLabel) {
  if (!triggerLabel) return;
  const selected = getSelectedValue();
  if (selected && selected.startsWith(AGENT_VALUE_PREFIX)) {
    const name = getAgentNameFromValue(selected);
    triggerLabel.textContent = name ? t('agents.toRun', { name }) : '—';
  } else {
    const run = selected ? agentRuns.find((r) => r.id === selected) : null;
    triggerLabel.textContent = run ? (run.displayTitle || run.agentName) : '—';
  }
}

/** Syncs run and agent signals; the list view re-renders only what changed. */
function updateAgentRunSelect() {
  const triggerLabel = document.getElementById('agents-bar-trigger-label');
  if (!triggerLabel && !agentsListEl) return;
  const prev = getSelectedValue();

  const useCached = cachedAgentsData && (Date.now() - (cachedAgentsData._cachedAt || 0) < CACHED_AGENTS_MAX_AGE_MS);
  const fetchPromise = useCached ? Promise.resolve(cachedAgentsData) : getAgentsApi().then((data) => {
    cachedAgentsData = data ? { ...data, _cachedAt: Date.now() } : null;
    return data;
  });

  fetchPromise.then((data) => {
    const agents = data?.ok && Array.isArray(data.agents) ? data.agents : [];
    agentsState.agents.set(agents);
    agentsState.syncRuns(agentRuns);
    const agentsAvailable = agentsState.availableAgents.get();

    if (prev) {
      if (agentRuns.some((r) => r.id === prev)) {
        setSelectedValue(prev);
        if (prev !== activeAgentRunId) selectAgentRun(prev);
      } else if (agentsAvailable.some((a) => AGENT_VALUE_PREFIX + a.name === prev)) {
        setSelectedValue(prev);
      } else if (activeAgentRunId && agentRuns.some((r) => r.id === activeAgentRunId)) {
        setSelectedValue(activeAgentRunId);
      } else if (agentRuns.length > 0) {
        setSelectedValue(agentRuns[0].id);
        if (agentRuns[0].id !== activeAgentRunId) selectAgentRun(agentRuns[0].id);
      } else {
        setSelectedValue('');
      }
    } else if (agentRuns.length > 0 && activeAgentRunId && agentRuns.some((r) => r.id === activeAgentRunId)) {
      setSelectedValue(activeAgentRunId);
    } else if (agentsAvailable.length > 0) {
      setSelectedValue(AGENT_VALUE_PREFIX + agentsAvailable[0].name);
    }
    setTriggerLabel(triggerLabel);
  }).catch(() => {
    if (activeAgentRunId && agentRuns.some((r) => r.id === activeAgentRunId)) {
      setSelectedValue(activeAgentRunId);
    }
    setTriggerLabel(triggerLabel);
  });
}

function onAgentListPick(value) {
  if (!value) return;
  setSelectedValue(value);
  if (!value.startsWith(AGENT_VALUE_PREFIX) && agentRuns.some((r) => r.id === value)) {
    selectAgentRun(value);
  } else {
    updateAgentRunSelect();
  }
  agentsDropdownApi?.close();
}

function selectAgentRun(id) {
  activeAgentRunId = id;
  agentRunEngine.selectRun(id);
  setSelectedValue(id);
  document.querySelectorAll('.agents-tab-pane').forEach((p) => {
    p.classList.toggle('active', p.dataset.agentRunId === id);
  });
  const run = agentRuns.find((x) => x.id === id);
  if (run && !isAgentRunSocketActive(run)) {
    connectAgentRun(run);
  }
  updateAgentRunSelect();
  fitAgentsTerminal();
}

function reconnectAgentRuns() {
  return getAgentRuns()
    .then((data) => {
      if (!data?.ok || !Array.isArray(data.runs)) return;
      const preferredRunId = activeAgentRunId || null;
      for (const { runId, agentName } of data.runs) {
        if (!runId || !agentName) continue;
        const existingRun = agentRuns.find((r) => r.id === runId || r.runId === runId);
        if (existingRun) {
          existingRun.runId = runId;
          if (preferredRunId && existingRun.id === preferredRunId && !isAgentRunSocketActive(existingRun)) {
            connectAgentRun(existingRun);
          }
          continue;
        }
        const run = createAgentRunPane(agentName, runId);
        connectAgentRun(run);
      }
      if (!activeAgentRunId && agentRuns.length > 0) {
        selectAgentRun(agentRuns[0].id);
      }
      updateAgentRunSelect();
    })
    .catch(() => {});
}

export function ensureAgentRunsReconnected() {
  return reconnectAgentRuns();
}

export function preloadAgentsDropdown() {
  getAgentsApi().then((data) => {
    cachedAgentsData = data ? { ...data, _cachedAt: Date.now() } : null;
  }).catch(() => {
    cachedAgentsData = null;
  });
  reconnectAgentRuns();
}

function createAgentRunPane(agentName, joinRunId) {
  const id = joinRunId || 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const pane = document.createElement('div');
  pane.className = 'agents-tab-pane';
  pane.dataset.agentRunId = id;

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
    agentName,
    displayTitle: null,
    status: 'running',
    _titleBuffer: '',
    term,
    fitAddon,
    pane,
    ws: null,
  };
  agentRunEngine.addRun(run);

  const tabsEl = document.getElementById('agents-tabs');
  if (tabsEl) tabsEl.appendChild(pane);

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      if (run.id === activeAgentRunId) fitAgentsTerminal();
    });
    if (isMobile()) {
      observeContainerResize(viewportWrap, () => {
        if (run.id === activeAgentRunId) fitAgentsTerminal();
      });
    }
  }

  updateAgentRunSelect();
  selectAgentRun(id);
  return run;
}

function buildAgentOpenMessage(run) {
  const name = run?.agentName || '';
  return run?.runId ? t('agents.joinedSession', { name }) : t('agents.startingAgent', { name });
}

function buildAgentRunSocket(run) {
  if (typeof run?.socketFactory === 'function') {
    return run.socketFactory(run);
  }
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : '';
  let wsPath = '/ws-agent-run?agent=' + encodeURIComponent(run.agentName);
  if (run.runId) wsPath += '&run=' + encodeURIComponent(run.runId);
  return new WebSocket(protocol + '//' + host + wsPath);
}

function connectAgentRun(run) {
  if (!run) return;
  run.socketFactory = () => buildAgentRunSocket(run);
  run.markFinishedOnClose = false;
  run.openMessage = buildAgentOpenMessage(run);
  agentRunEngine.ensureConnected(run);
}

/** One run at a time: closes the socket and drops the current run from the panel. */
function clearCurrentAgentRun() {
  while (agentRuns.length > 0) {
    const r = agentRuns[0];
    if (r.ws) r.ws.close();
    r.pane?.remove();
    agentRunEngine.removeRunById(r.id);
  }
  activeAgentRunId = null;
  updateAgentRunSelect();
}

/**
 * Attaches the run to a chat session (create-chat + /ws-agent); the agent body is injected server-side.
 */
function connectAgentRunViaChat(run, cursorSessionId, workspaceFile, workspaceFolder, model) {
  run.socketFactory = () => {
    const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = typeof location !== 'undefined' ? location.host : '';
    const params = new URLSearchParams();
    params.set('resume', cursorSessionId);
    params.set('agentRun', run.agentName);
    if (workspaceFile) params.set('workspace', workspaceFile);
    if (workspaceFolder) params.set('workspaceFolder', workspaceFolder);
    params.set('model', model || 'auto');
    return new WebSocket(protocol + '//' + host + '/ws-agent?' + params.toString());
  };
  run.openMessage = t('agents.startingAgent', { name: run.agentName });
  run.markFinishedOnClose = true;
  agentRunEngine.ensureConnected(run);
}

function startOrJoinAgent(agentName) {
  const trigger = document.getElementById('header-workspace-trigger');
  const workspaceFile = trigger?.dataset?.workspaceFile || null;
  const workspaceFolder = trigger?.dataset?.workspaceFolder ?? null;
  if (!workspaceFile && !workspaceFolder) {
    alert(t('agents.selectWorkspace'));
    return;
  }
  clearCurrentAgentRun();
  postChat({
    forAgentRun: true,
    agentName,
    workspaceFile: workspaceFile || undefined,
    workspaceFolder: workspaceFolder || undefined,
    model: 'auto',
  })
    .then((data) => {
      if (!data?.ok || !data?.chat?.cursorSessionId) {
        alert(data?.error || t('agents.createFailed'));
        return;
      }
      const chat = data.chat;
      const run = createAgentRunPane(agentName, null);
      connectAgentRunViaChat(
        run,
        chat.cursorSessionId,
        chat.workspaceFile || workspaceFile,
        chat.workspaceFolder || workspaceFolder,
        chat.model || 'auto'
      );
    })
    .catch(() => alert(t('agents.serverConnectionError')));
}

function getScheduleApi() {
  return getAgentsSchedule();
}

function patchScheduleApi(schedules) {
  return patchAgentsSchedule(schedules);
}

function renderScheduleSection(agents, schedules) {
  const wrap = document.getElementById('agents-schedule-wrap');
  if (!wrap || !agentsScheduleEl) return;
  if (!agents?.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  agentsScheduleEl.resetChunks();
  agentsState.setSchedule(agents, schedules || []);
}

/** Replaces a static placeholder with a signal-driven view element, keeping its place in the DOM. */
function mountView(placeholderId, tagName, props) {
  const placeholder = document.getElementById(placeholderId);
  if (!placeholder) return null;
  const el = document.createElement(tagName);
  Object.assign(el, props);
  placeholder.replaceWith(el);
  return el;
}

export function initAgentsPanel() {
  const barTrigger = document.getElementById('agents-bar-trigger');
  const listModal = document.getElementById('agents-list-modal');
  const startBtn = document.getElementById('agents-start-btn');
  const startDropdown = document.getElementById('agents-start-dropdown');
  const startList = document.getElementById('agents-start-list');
  const clearBtn = document.getElementById('agents-clear-btn');

  agentsListEl = mountView('agents-list-items', 'cr-agents-list', {
    state: agentsState,
    isFavorite: (name) => agentFavorites.isFavorite(name),
    toggleFavorite: (name) => {
      const active = agentFavorites.toggleFavorite(name);
      agentsState.favoritesTick.set(agentsState.favoritesTick.get() + 1);
      return active;
    },
    onPick: onAgentListPick,
  });
  agentsScheduleEl = mountView('agents-schedule-list', 'cr-agents-schedule', { state: agentsState });

  if (barTrigger && listModal) {
    agentsDropdownApi = initDropdown({
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
      if (agentsDropdownApi?.isOpen()) {
        agentsDropdownApi.close();
        return;
      }
      updateAgentRunSelect();
      agentsDropdownApi?.open();
    });
    barTrigger.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (agentsDropdownApi?.isOpen()) {
        agentsDropdownApi.close();
        return;
      }
      updateAgentRunSelect();
      agentsDropdownApi?.open();
    });
    updateAgentRunSelect();
  }

  if (startBtn && startDropdown && startList) {
    startBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const selVal = (getSelectedValue() || '').trim();
      if (selVal.startsWith(AGENT_VALUE_PREFIX)) {
        startOrJoinAgent(selVal.slice(AGENT_VALUE_PREFIX.length));
        return;
      }
      if (startDropdown.hidden) {
        const useCached =
          cachedAgentsData &&
          (Date.now() - (cachedAgentsData._cachedAt || 0) < CACHED_AGENTS_MAX_AGE_MS);
        const fetchPromise = useCached
          ? Promise.resolve(cachedAgentsData)
          : getAgentsApi().then((data) => {
              cachedAgentsData = data ? { ...data, _cachedAt: Date.now() } : null;
              return data;
            });
        fetchPromise.then((data) => {
          if (!data.ok || !Array.isArray(data.agents) || data.agents.length === 0) {
            startList.innerHTML =
              '<li class="agents-start-empty">' + escapeHtml(t('agents.noAgents')) + '</li>';
          } else {
            const hasRun = agentRuns.length > 0;
            startList.innerHTML =
              (hasRun ? '<li class="agents-start-empty">' + escapeHtml(t('agents.oneAtATime')) + '</li>' : '') +
              data.agents
                .map(
                  (a) =>
                    '<li role="option" tabindex="0" data-agent="' + escapeHtml(a.name) + '">' + escapeHtml(a.name) + '</li>'
                )
                .join('');
            startList.querySelectorAll('li[data-agent]').forEach((li) => {
              li.addEventListener('click', () => {
                startOrJoinAgent(li.dataset.agent);
                startDropdown.hidden = true;
              });
            });
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

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const run = activeAgentRunId ? agentRuns.find((r) => r.id === activeAgentRunId) : null;
      if (run?.term) run.term.clear();
    });
  }

  getAgentsApi().then((agentsData) => {
    const agents = agentsData?.ok && Array.isArray(agentsData.agents) ? agentsData.agents : [];
    getScheduleApi().then((scheduleData) => {
      const schedules = scheduleData?.ok && Array.isArray(scheduleData.schedules) ? scheduleData.schedules : [];
      renderScheduleSection(agents, schedules);
    });
  });

  const scheduleSaveBtn = document.getElementById('agents-schedule-save-btn');
  if (scheduleSaveBtn) {
    scheduleSaveBtn.addEventListener('click', () => {
      getAgentsApi().then((data) => {
        const agents = data.ok && Array.isArray(data.agents) ? data.agents : [];
        const schedules = agentsState.collectSchedules(agents);
        patchScheduleApi(schedules).catch(() => {});
      });
    });
  }
}

/**
 * @param {string} runId
 */
export function restoreAgentRunFromRoute(runId) {
  const id = typeof runId === 'string' ? runId.trim() : '';
  if (!id) return;
  selectAgentRun(id);
}

/**
 * @returns {string[]}
 */
export function listScopedAgentRunIdsForRoute() {
  return agentRuns.map((run) => String(run.id || '').trim()).filter(Boolean);
}

export function refreshAgentsList() {
  updateAgentRunSelect();
  getAgentsApi().then((agentsData) => {
    const agents = agentsData?.ok && Array.isArray(agentsData.agents) ? agentsData.agents : [];
    getScheduleApi().then((scheduleData) => {
      const schedules = scheduleData?.ok && Array.isArray(scheduleData.schedules) ? scheduleData.schedules : [];
      renderScheduleSection(agents, schedules);
    });
  });
}
