/** Settings → MCP → MCP operator prompt overrides and proposal approval. */

import { t, getCurrentLang } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import { folderOptions, normalizePath } from './mcpOperatorFolders.js';
import { getViewContextRuntimeScope, withViewContextQuery } from '../../app/appShell/viewContextBridge.js';
import '../../components/ui/cr-bar-textarea.js';
import './mcp-operator-settings.scss';

const ROOT_ID = 'settings-mcp-operator-root';
/** Settings route (third-level tab in the settings header) → panel id. */
const TAB_PANELS = {
  'mcp-operator': 'instructions',
  'mcp-operator-playbook': 'playbook',
  'mcp-operator-proposals': 'proposals',
  'mcp-operator-activity': 'activity',
};
const PANELS = Object.values(TAB_PANELS);
const state = {
  workspaceFile: '',
  workspaceFolder: '',
  folders: [],
  data: null,
  bound: false,
  panel: 'instructions',
};

/** Toggle panels in place: rebuilding would drop unsaved textarea edits. */
function applyPanel() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  for (const panel of root.querySelectorAll('[data-mcp-operator-panel]')) {
    /** @type {HTMLElement} */ (panel).hidden = panel.getAttribute('data-mcp-operator-panel') !== state.panel;
  }
}

/** The pending-proposal count lives on the sub-tab in the settings header. */
function applyProposalCount(count) {
  const badge = /** @type {HTMLElement | null} */ (document.querySelector('[data-mcp-operator-proposals-count]'));
  if (!badge) return;
  badge.textContent = count ? String(count) : '';
  badge.hidden = !count;
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', 'Accept-Language': getCurrentLang() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await cretliApiFetch(path, { method: options.method || 'GET', headers, credentials: 'include', body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child != null) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

/** Show the status next to the block that was saved, so it stays in view on a phone. */
function setStatus(message, tone = '', key = '') {
  const root = document.getElementById(ROOT_ID);
  const node = (key && root?.querySelector(`[data-mcp-operator-status-for="${key}"]`)) || root?.querySelector('[data-mcp-operator-status]');
  if (!node) return;
  node.textContent = message;
  node.setAttribute('data-tone', tone);
}

function blockLabel(key) {
  return t(`settings.mcpOperator.block_${key}`);
}

function noteKindLabel(kind) {
  const labels = {
    decision: t('settings.mcpOperator.noteKind_decision'),
    question: t('settings.mcpOperator.noteKind_question'),
    in_progress: t('settings.mcpOperator.noteKind_in_progress'),
    temporary_setting: t('settings.mcpOperator.noteKind_temporary_setting'),
    lesson: t('settings.mcpOperator.noteKind_lesson'),
  };
  return labels[kind] || kind;
}

function renderBlock(block) {
  // Shared field primitive: same size and skin as every other Settings field.
  const textarea = /** @type {any} */ (el('cr-bar-textarea', { class: 'mcp-operator-text', 'data-mcp-operator-text': block.key }));
  textarea.rows = block.key === 'playbook' ? 16 : 8;
  textarea.ariaLabel = blockLabel(block.key);
  textarea.value = block.text;
  const counter = el('span', { class: 'cr-hint', 'data-mcp-operator-counter': block.key }, []);
  const updateCounter = () => {
    if (block.key === 'playbook') {
      counter.textContent = t('settings.mcpOperator.characters', { chars: textarea.value.length });
      return;
    }
    const texts = Object.fromEntries(state.data.blocks.map((row) => [row.key, row.key === block.key ? textarea.value.trim() : row.text]));
    const locked = state.data.lockedSafetyRules.map((rule) => `- ${rule}`).join('\n');
    const planChars = [texts.common, locked].join('\n').length;
    const operatorChars = [texts.common, texts.operator, locked].join('\n').length;
    const limit = state.data?.maxInstructionsChars || 3500;
    const suffix = block.key === 'operator'
      ? t('settings.mcpOperator.operatorCharactersLimit', { chars: operatorChars, limit })
      : t('settings.mcpOperator.modeCharactersLimit', { planChars, operatorChars, limit });
    counter.textContent = suffix;
  };
  textarea.addEventListener('input', updateCounter);
  updateCounter();
  return el('div', { class: 'cr-card mcp-operator-block' }, [
    el('span', { class: 'cr-field-label' }, [blockLabel(block.key)]),
    el('div', { class: 'mcp-operator-meta' }, [counter, block.overridden ? el('span', { class: 'cr-hint' }, [t('settings.mcpOperator.overridden')]) : null]),
    textarea,
    el('div', { class: 'cr-row' }, [
      el('cr-bar-button', { variant: 'primary', 'data-mcp-operator-action': 'save', 'data-key': block.key }, [t('settings.mcpOperator.save')]),
      el('cr-bar-button', { 'data-mcp-operator-action': 'reset', 'data-key': block.key, ...(block.overridden ? {} : { disabled: '' }) }, [t('settings.mcpOperator.reset')]),
    ]),
    el('span', { class: 'cr-status', 'data-mcp-operator-status-for': block.key, 'aria-live': 'polite' }),
  ]);
}

function render() {
  const root = document.getElementById(ROOT_ID);
  if (!root || !state.data) return;
  const workspace = /** @type {any} */ (document.createElement('cr-searchable-select'));
  workspace.id = 'mcp-operator-workspace';
  workspace.options = state.folders;
  workspace.value = state.workspaceFolder;
  workspace.addEventListener('cr-change', (/** @type {CustomEvent} */ event) => {
    state.workspaceFolder = String(event.detail?.value || '');
    void loadData();
  });
  const locked = el('div', { class: 'cr-card mcp-operator-locked' }, [
    el('div', { class: 'mcp-operator-lock-title' }, [el('span', { class: 'mdi mdi-lock', 'aria-hidden': 'true' }), t('settings.mcpOperator.lockedTitle')]),
    el('p', { class: 'cr-hint' }, [t('settings.mcpOperator.lockedHint')]),
    el('ul', {}, state.data.lockedSafetyRules.map((rule) => el('li', {}, [rule]))),
  ]);
  const proposals = state.data.proposals.filter((row) => row.status === 'pending').map((proposal) => el('div', { class: 'cr-card mcp-operator-proposal' }, [
    el('span', { class: 'cr-field-label' }, [blockLabel(proposal.promptKey)]),
    el('p', { class: 'cr-hint' }, [proposal.reason]),
    el('pre', { class: 'mcp-operator-preview' }, [proposal.text]),
    el('div', { class: 'cr-row' }, [
      el('cr-bar-button', { variant: 'primary', 'data-mcp-operator-action': 'approve', 'data-id': proposal.id }, [t('settings.mcpOperator.approve')]),
      el('cr-bar-button', { 'data-mcp-operator-action': 'reject', 'data-id': proposal.id }, [t('settings.mcpOperator.reject')]),
    ]),
  ]));
  const journal = (state.data.journal || []).map((note) => el('div', { class: 'cr-card mcp-operator-journal-entry' }, [
    el('div', { class: 'mcp-operator-meta' }, [
      el('span', { class: 'cr-field-label' }, [noteKindLabel(note.kind)]),
      el('span', { class: 'cr-hint' }, [new Date(note.createdAt).toLocaleString(getCurrentLang())]),
    ]),
    el('p', {}, [note.text]),
    note.todoId ? el('span', { class: 'cr-hint' }, [`TODO ${note.todoId}`]) : null,
    note.expiresAt ? el('span', { class: 'cr-hint' }, [t('settings.mcpOperator.expires', { date: new Date(note.expiresAt).toLocaleString(getCurrentLang()) })]) : null,
    note.kind === 'question' ? el('cr-bar-button', { 'data-mcp-operator-action': 'resolve-note', 'data-id': note.id }, [t('settings.mcpOperator.resolveQuestion')]) : null,
  ]));
  const sessions = (state.data.operatorSessions || []).map((session) => el('div', { class: 'cr-card mcp-operator-session' }, [
    el('span', { class: 'cr-field-label' }, [`${session.clientName} · ${session.sessionId}`]),
    el('span', { class: 'cr-hint' }, [session.active ? t('settings.mcpOperator.sessionActive') : t('settings.mcpOperator.sessionLastSeen', { date: new Date(session.lastSeenAt).toLocaleString(getCurrentLang()) })]),
  ]));
  const section = (title, children) => el('section', { class: 'mcp-operator-section' }, [
    el('h3', { class: 'cr-section-title' }, [title]),
    ...children,
  ]);
  const history = state.data.history.map((row) => el('details', { class: 'cr-card mcp-operator-history' }, [
    el('summary', {}, [`${blockLabel(row.promptKey)} · ${row.action} · ${new Date(row.createdAt).toLocaleString(getCurrentLang())}`]),
    row.text ? el('pre', { class: 'mcp-operator-preview' }, [row.text]) : el('p', { class: 'cr-hint' }, [t('settings.mcpOperator.defaultRestored')]),
  ]));
  const previews = state.data.previews.map((preview) => el('details', { class: 'cr-card mcp-operator-history' }, [
    el('summary', {}, [`${preview.mode} — ${preview.chars}/${preview.budget}`]),
    preview.overBudget ? el('p', { class: 'cr-status', 'data-tone': 'error' }, [t('settings.mcpOperator.overLimit')]) : null,
    el('pre', { class: 'mcp-operator-preview' }, [preview.text]),
  ]));
  const empty = (key) => [el('p', { class: 'cr-hint' }, [t(key)])];
  const blocks = Object.fromEntries(state.data.blocks.map((block) => [block.key, block]));
  const panels = {
    instructions: [
      ...state.data.blocks.filter((block) => block.key !== 'playbook').map(renderBlock),
      locked,
      section(t('settings.mcpOperator.previewTitle'), previews),
    ],
    playbook: blocks.playbook ? [renderBlock(blocks.playbook)] : [],
    proposals: proposals.length ? proposals : empty('settings.mcpOperator.noProposals'),
    activity: [
      section(t('settings.mcpOperator.journalTitle'), journal.length ? journal : empty('settings.mcpOperator.noJournal')),
      section(t('settings.mcpOperator.sessionsTitle'), sessions.length ? sessions : empty('settings.mcpOperator.noSessions')),
      section(t('settings.mcpOperator.historyTitle'), history.length ? history : empty('settings.mcpOperator.noHistory')),
    ],
  };
  root.replaceChildren(el('div', { class: 'mcp-operator-page' }, [
    el('div', { class: 'cr-field' }, [el('span', { class: 'cr-field-label' }, [t('settings.mcpOperator.workspace')]), workspace]),
    el('p', { class: 'cr-hint' }, [t('settings.mcpOperator.hint')]),
    el('p', { class: 'cr-status', 'data-mcp-operator-status': '1', 'aria-live': 'polite' }),
    ...PANELS.map((panel) => el('div', { class: 'mcp-operator-panel', 'data-mcp-operator-panel': panel }, panels[panel])),
  ]));
  applyProposalCount(proposals.length);
  applyPanel();
}

async function loadData() {
  const root = document.getElementById(ROOT_ID);
  if (!root || !state.workspaceFolder) return;
  const result = await api(`/api/prompt-registry/mcp-operator?workspaceFolder=${encodeURIComponent(state.workspaceFolder)}`);
  if (!result.json?.ok) {
    root.textContent = result.json?.error || t('settings.mcpOperator.loadFailed');
    return;
  }
  state.data = result.json;
  render();
}

export async function refreshMcpOperatorSettings() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.textContent = t('settings.mcpOperator.loading');
  const scope = getViewContextRuntimeScope();
  const [context, workspaces] = await Promise.all([
    scope.workspaceFolder ? null : api(withViewContextQuery('/api/workspace/context')),
    api('/api/workspaces'),
  ]);
  // Default to the folder the tab's workspace uses (same as chats and todos).
  const current = normalizePath(scope.workspaceFolder || context?.json?.folder?.resolvedPath);
  const workspaceFile = scope.workspaceFile || String(context?.json?.workspace?.workspaceFile || '');
  state.folders = folderOptions(Array.isArray(workspaces.json?.workspaces) ? workspaces.json.workspaces : [], workspaceFile, current);
  const keepSelection = workspaceFile === state.workspaceFile && state.folders.some((row) => row.value === state.workspaceFolder);
  state.workspaceFile = workspaceFile;
  if (!keepSelection) state.workspaceFolder = current || state.folders[0]?.value || '';
  await loadData();
}

/**
 * Entry from the settings router. Switching between the operator sub-tabs only
 * toggles panels (unsaved edits stay); a first visit or another workspace
 * reloads the page.
 *
 * @param {string} tabId
 */
export async function showMcpOperatorSettingsTab(tabId) {
  state.panel = TAB_PANELS[tabId] || 'instructions';
  const root = document.getElementById(ROOT_ID);
  const rendered = Boolean(state.data && root?.querySelector('[data-mcp-operator-panel]'));
  const workspaceFile = getViewContextRuntimeScope().workspaceFile || state.workspaceFile;
  if (rendered && workspaceFile === state.workspaceFile) {
    applyPanel();
    return;
  }
  await refreshMcpOperatorSettings();
}

export function initMcpOperatorSettings() {
  const root = document.getElementById(ROOT_ID);
  if (!root || state.bound) return;
  state.bound = true;
  root.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-mcp-operator-action]') : null;
    if (!button || button.hasAttribute('disabled')) return;
    const action = button.getAttribute('data-mcp-operator-action');
    const key = button.getAttribute('data-key') || '';
    let result;
    if (action === 'resolve-note') {
      result = await api(`/api/prompt-registry/mcp-operator/notes/${encodeURIComponent(button.getAttribute('data-id') || '')}/resolve`, { method: 'POST', body: { workspaceFolder: state.workspaceFolder } });
    } else if (action === 'save') {
      const text = /** @type {any} */ (root.querySelector(`[data-mcp-operator-text="${key}"]`))?.value || '';
      result = await api(`/api/prompt-registry/mcp-operator/${encodeURIComponent(key)}`, { method: 'PUT', body: { workspaceFolder: state.workspaceFolder, text } });
    } else if (action === 'reset') {
      result = await api(`/api/prompt-registry/mcp-operator/${encodeURIComponent(key)}`, { method: 'DELETE', body: { workspaceFolder: state.workspaceFolder } });
    } else {
      result = await api(`/api/prompt-registry/mcp-operator/proposals/${encodeURIComponent(button.getAttribute('data-id') || '')}/decision`, { method: 'POST', body: { workspaceFolder: state.workspaceFolder, approve: action === 'approve' } });
    }
    if (!result.json?.ok) return setStatus(result.json?.error || t('settings.mcpOperator.saveFailed'), 'error', key);
    await loadData();
    setStatus(t('settings.mcpOperator.saved'), 'success', key);
  });
  window.addEventListener('cr-lang-changed', () => { if (state.data) render(); });
}
