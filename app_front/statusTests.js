import {
  parseTerminalInteraction,
  resolveTerminalState,
  STATUS_TEST_FIXTURES,
} from '../lib/status-parser.js';
import { getStatusFlowScenariosFixture } from './core/api/index.js';
import { getActiveChatBufferTail } from './chat.js';
import { t } from './i18n/index.js';
import { escapeHtml } from './features/chat/chatHtmlUtils.js';

function getById(id) {
  return document.getElementById(id);
}

function renderResult(target, data) {
  if (!target) return;
  target.textContent = JSON.stringify(data, null, 2);
}

function runParser(input, connection, agent) {
  const parsed = parseTerminalInteraction(input || '');
  const recentOutput = false;
  const state = resolveTerminalState(parsed, connection, agent, recentOutput);
  return { state, parsed };
}

async function loadFlowScenariosFromJson() {
  const json = await getStatusFlowScenariosFixture();
  if (!json || !Array.isArray(json.scenarios)) return [];
  return json.scenarios.map((scenario) => ({
    id: scenario.id,
    name: scenario.name || scenario.id,
    group: scenario.group || 'Flow',
    assumptions: scenario.assumptions || {},
    defaults: json.defaults || {},
    steps: Array.isArray(scenario.steps) ? scenario.steps : [],
  }));
}

function getStatusLabel(status) {
  if (status === 'running') return 'Running';
  if (status === 'pass') return 'OK';
  if (status === 'fail') return t('statusTests.statusError');
  return '—';
}

function setBadgeState(el, status) {
  if (!el) return;
  el.className = 'status-tests-badge status-tests-badge--' + status;
  el.textContent = getStatusLabel(status);
}

function createUiSuite({
  items,
  groupsWrap,
  summaryEl,
  runAllGroupsBtn,
  rowTitleGetter,
  rowTooltipGetter,
  runSingle,
  output,
}) {
  if (!groupsWrap || !summaryEl || !runAllGroupsBtn || !Array.isArray(items) || items.length === 0) return null;

  const stateById = new Map();
  const groups = new Map();
  const rowBadgeById = new Map();
  const groupSectionByName = new Map();
  const groupBadgeByName = new Map();
  const fallbackGroupName = t('statusTests.groupOther');
  items.forEach((item) => {
    const group = item.group || fallbackGroupName;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
    stateById.set(item.id, 'idle');
  });

  function computeGroupStatus(groupItems) {
    const states = groupItems.map((item) => stateById.get(item.id) || 'idle');
    if (states.some((s) => s === 'running')) return 'running';
    if (states.every((s) => s === 'pass')) return 'pass';
    if (states.some((s) => s === 'fail')) return 'fail';
    return 'idle';
  }

  function renderSummary() {
    const all = items.map((item) => stateById.get(item.id) || 'idle');
    const pass = all.filter((s) => s === 'pass').length;
    const fail = all.filter((s) => s === 'fail').length;
    const running = all.filter((s) => s === 'running').length;
    if (running > 0) summaryEl.textContent = `Running: ${running}`;
    else summaryEl.textContent = t('statusTests.summary', { pass, fail, total: all.length });
    summaryEl.className =
      'status-tests-summary status-tests-summary--' +
      (running > 0 ? 'running' : fail > 0 ? 'fail' : pass === all.length ? 'pass' : 'idle');
  }

  function updateGroupUi(groupName) {
    const groupItems = groups.get(groupName);
    if (!groupItems) return;
    const status = computeGroupStatus(groupItems);
    const section = groupSectionByName.get(groupName);
    const badge = groupBadgeByName.get(groupName);
    if (section) section.className = 'status-tests-group status-tests-group--' + status;
    setBadgeState(badge, status);
  }

  function updateItemUi(id) {
    const item = items.find((x) => x.id === id);
    if (!item) return;
    const status = stateById.get(id) || 'idle';
    setBadgeState(rowBadgeById.get(id), status);
    updateGroupUi(item.group || fallbackGroupName);
    renderSummary();
  }

  async function runItemById(id) {
    const item = items.find((x) => x.id === id);
    if (!item) return;
    stateById.set(id, 'running');
    updateItemUi(id);
    await new Promise((r) => setTimeout(r, 20));
    const result = await runSingle(item);
    stateById.set(id, result.pass ? 'pass' : 'fail');
    renderResult(output, result.output);
    updateItemUi(id);
  }

  function renderGroups() {
    groupsWrap.innerHTML = '';
    rowBadgeById.clear();
    groupSectionByName.clear();
    groupBadgeByName.clear();

    Array.from(groups.entries()).forEach(([groupName, groupItems]) => {
      const section = document.createElement('section');
      const groupStatus = computeGroupStatus(groupItems);
      section.className = 'status-tests-group status-tests-group--' + groupStatus;
      section.innerHTML =
        '<div class="status-tests-group-header">' +
        `<div class="status-tests-group-title">${escapeHtml(groupName)}</div>` +
        `<div class="status-tests-group-actions"><span class="status-tests-badge status-tests-badge--${groupStatus}">${escapeHtml(getStatusLabel(groupStatus))}</span><button type="button" class="chat-settings-btn status-tests-run-group-btn">${escapeHtml(t('statusTests.runGroup'))}</button></div>` +
        '</div>' +
        '<div class="status-tests-list"></div>';

      groupSectionByName.set(groupName, section);
      groupBadgeByName.set(groupName, section.querySelector('.status-tests-group-actions .status-tests-badge'));

      const list = section.querySelector('.status-tests-list');
      groupItems.forEach((item) => {
        const status = stateById.get(item.id) || 'idle';
        const row = document.createElement('div');
        row.className = 'status-tests-row';
        row.dataset.testId = item.id;
        row.innerHTML =
          `<div class="status-tests-row-label" title="${escapeHtml(rowTooltipGetter(item))}">${escapeHtml(rowTitleGetter(item))}</div>` +
          `<div class="status-tests-row-right"><span class="status-tests-badge status-tests-badge--${status}">${escapeHtml(getStatusLabel(status))}</span><button type="button" class="logs-clear-btn status-tests-run-one-btn">${escapeHtml(t('common.start'))}</button></div>`;
        rowBadgeById.set(item.id, row.querySelector('.status-tests-row-right .status-tests-badge'));
        list.appendChild(row);
      });

      section.querySelector('.status-tests-run-group-btn').addEventListener('click', async () => {
        for (const item of groupItems) {
          await runItemById(item.id);
          await new Promise((r) => setTimeout(r, 80));
        }
      });

      list.querySelectorAll('.status-tests-run-one-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.status-tests-row');
          const id = row?.dataset?.testId;
          if (!id) return;
          await runItemById(id);
        });
      });

      groupsWrap.appendChild(section);
    });

    renderSummary();
  }

  runAllGroupsBtn.addEventListener('click', async () => {
    for (const [, groupItems] of groups.entries()) {
      for (const item of groupItems) {
        await runItemById(item.id);
        await new Promise((r) => setTimeout(r, 80));
      }
    }
  });

  return { renderGroups };
}

export function initStatusTestsPanel() {
  const input = getById('status-tests-input');
  const output = getById('status-tests-output');
  const runParserBtn = getById('status-tests-run-btn');
  const fixtureGroupsWrap = getById('status-tests-groups');
  const fixtureRunAllGroupsBtn = getById('status-tests-run-all-groups-btn');
  const fixtureSummaryEl = getById('status-tests-summary');
  const flowGroupsWrap = getById('status-flow-tests-groups');
  const flowRunAllGroupsBtn = getById('status-flow-tests-run-all-groups-btn');
  const flowSummaryEl = getById('status-flow-tests-summary');
  const loadActiveBtn = getById('status-tests-load-active-btn');
  const connSelect = getById('status-tests-connection-select');
  const agentSelect = getById('status-tests-agent-select');
  if (!input || !output || !runParserBtn || !fixtureGroupsWrap || !fixtureRunAllGroupsBtn || !fixtureSummaryEl || !loadActiveBtn || !connSelect || !agentSelect) return;

  const fixtureSuite = createUiSuite({
    items: STATUS_TEST_FIXTURES,
    groupsWrap: fixtureGroupsWrap,
    summaryEl: fixtureSummaryEl,
    runAllGroupsBtn: fixtureRunAllGroupsBtn,
    rowTitleGetter: (item) => item.name,
    rowTooltipGetter: (item) => item.input,
    runSingle: async (item) => {
      const parsed = parseTerminalInteraction(item.input || '');
      const state = resolveTerminalState(
        parsed,
        item.connection || 'connected',
        item.agent || 'idle',
        item.recentOutput === true
      );
      const passTone = state.tone === item.expectedTone;
      const passGenerating =
        typeof item.expectedGenerating !== 'boolean' || parsed.generating === item.expectedGenerating;
      return {
        pass: passTone && passGenerating,
        output: {
          type: 'fixture',
          fixture: item.name,
          expectedTone: item.expectedTone,
          expectedGenerating: item.expectedGenerating,
          passTone,
          passGenerating,
          pass: passTone && passGenerating,
          state,
          parsed,
        },
      };
    },
    output,
  });
  fixtureSuite?.renderGroups();

  flowSummaryEl.textContent = t('statusTests.flowLoading');
  loadFlowScenariosFromJson()
    .then((flowScenarios) => {
      const flowSuite = createUiSuite({
        items: flowScenarios,
        groupsWrap: flowGroupsWrap,
        summaryEl: flowSummaryEl,
        runAllGroupsBtn: flowRunAllGroupsBtn,
        rowTitleGetter: (item) => item.name || item.id,
        rowTooltipGetter: (item) => (item.steps || []).map((s) => s.name).join(' -> '),
        runSingle: async (scenario) => {
          let buffer = '';
          const stepResults = [];
          let allPass = true;
          for (const step of scenario.steps || []) {
            const mode = step.mode || scenario.assumptions?.mode || scenario.defaults?.mode || 'append';
            if (mode === 'replace') buffer = step.input || '';
            else buffer += step.input || '';
            const parsed = parseTerminalInteraction(buffer);
            const state = resolveTerminalState(
              parsed,
              step.connection || scenario.assumptions?.connection || scenario.defaults?.connection || 'connected',
              step.agent || scenario.assumptions?.agent || scenario.defaults?.agent || 'active',
              step.recentOutput === true
                ? true
                : scenario.assumptions?.recentOutput === true
                  ? true
                  : scenario.defaults?.recentOutput === true
            );
            const ensures = Array.isArray(step.ensures) ? step.ensures : [];
            const ensureResults = ensures.map((ensure) => {
              const actual =
                ensure.path === 'state.tone'
                  ? state.tone
                  : ensure.path === 'parsed.generating'
                    ? parsed.generating
                    : ensure.path === 'parsed.awaiting'
                      ? parsed.awaiting
                      : undefined;
              const pass = JSON.stringify(actual) === JSON.stringify(ensure.equals);
              return { ...ensure, actual, pass };
            });
            const pass = ensureResults.every((e) => e.pass);
            if (!pass) allPass = false;
            stepResults.push({
              name: step.name,
              mode,
              pass,
              ensures: ensureResults,
            });
          }
          return {
            pass: allPass,
            output: {
              type: 'flow',
              flow: scenario.name || scenario.id,
              pass: allPass,
              steps: stepResults,
            },
          };
        },
        output,
      });
      flowSuite?.renderGroups();
    })
    .catch((err) => {
      flowSummaryEl.textContent = t('statusTests.flowLoadError');
      flowSummaryEl.className = 'status-tests-summary status-tests-summary--fail';
      flowGroupsWrap.innerHTML =
        '<section class="status-tests-group status-tests-group--fail"><div class="status-tests-group-header"><div class="status-tests-group-title">Flow JSON</div><div class="status-tests-group-actions"><span class="status-tests-badge status-tests-badge--fail">' +
        escapeHtml(t('statusTests.statusError')) +
        '</span></div></div><div class="status-tests-list"><div class="status-tests-row"><div class="status-tests-row-label">' +
        t('statusTests.flowLoadFailed', { detail: escapeHtml(String(err)) }) +
        '</div></div></div></section>';
    });

  runParserBtn.addEventListener('click', () => {
    const result = runParser(input.value, connSelect.value, agentSelect.value);
    renderResult(output, result);
  });
  loadActiveBtn.addEventListener('click', () => {
    input.value = getActiveChatBufferTail(4000);
    const result = runParser(input.value, connSelect.value, agentSelect.value);
    renderResult(output, result);
  });
  const first = STATUS_TEST_FIXTURES[0];
  if (first) {
    input.value = first.input;
    renderResult(output, runParser(first.input, connSelect.value, agentSelect.value));
  }
}
