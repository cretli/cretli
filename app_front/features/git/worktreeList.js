/**
 * Git panel section: task worktrees (registry reconciled with Git) with the
 * Merge / Diff / Reject / Cleanup actions.
 *
 * Merge opens a summary dialog (target branch, base, diffstat, preflight
 * blockers, optional instructions) and then the shared harness/model picker used
 * to start a TODO, so the merge chat runs on a Settings-enabled model.
 */

import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { openTodoAgentChat, openTodoAgentStartModal } from '../chat/index.js';
import '../../components/ui/cr-dialog.js';
import '../../components/ui/cr-bar-button.js';
import '../../components/ui/cr-bar-textarea.js';
import '../../components/ui/cr-checkbox.js';
import { getGitScope } from './gitScope.js';
import { viewContextRuntimeParams } from '../../app/appShell/viewContext.js';
import {
  getViewContextState,
  isViewContextScopedAccessAllowed,
} from '../../app/appShell/viewContextBridge.js';
import { initDropdown, closeAllOpenDropdowns } from '../../lib/dropdown.js';
import { navigateSpa } from '../../app/appShell/spaNavigationBridge.js';
import {
  registerViewMemoryRestoreHandler,
  resolveActiveRouteForViewMemory,
  schedulePanelViewMemoryCapture,
} from '../../app/appShell/viewMemoryBridge.js';
import {
  canStartMerge,
  cleanupNeedsDiscard,
  describeMergeBlocker,
  describeWorktreeState,
  shortCommit,
  summarizeWorktreeChanges,
} from './worktreeListView.js';

/** Monotonic id: a newer refresh drops every older in-flight answer. */
let refreshRequestId = 0;
/** @type {string} */
let listedWorkspaceFolder = '';
/** @type {object[]} */
let listedRows = [];
const WORKTREE_FILTER_STATES = ['active', 'execution_closed', 'integration_ready', 'merging', 'integrated', 'rejected', 'missing', 'foreign', 'creating'];
/** @type {Set<string>} */
let worktreeStateFilter = new Set();
/** @type {{ api: ReturnType<typeof initDropdown>, panel: HTMLElement, list: HTMLElement } | null} */
let worktreeFilterMenu = null;
/** @type {object | null} */
let pendingWorktreeViewMemory = null;

function worktreeScrollContainer() {
  return document.getElementById('git-worktrees-list')?.parentElement || document.getElementById('git-worktrees-list');
}

function buildWorktreeViewMemorySlice() {
  const searchInput = document.getElementById('git-worktrees-search');
  const searchToggle = document.getElementById('git-worktrees-search-toggle');
  return {
    search: String(searchInput?.value || ''),
    searchOpen: searchToggle?.getAttribute('aria-expanded') === 'true',
    filterStates: [...worktreeStateFilter],
    scrollTop: worktreeScrollContainer()?.scrollTop || 0,
  };
}

function scheduleWorktreeViewMemoryCapture() {
  schedulePanelViewMemoryCapture('git', buildWorktreeViewMemorySlice);
}

/**
 * @param {object | null | undefined} slice
 */
function applyWorktreeViewMemorySlice(slice) {
  if (!slice || typeof slice !== 'object') return;
  const route = resolveActiveRouteForViewMemory();
  if (route?.subview !== 'worktrees') return;
  const searchInput = document.getElementById('git-worktrees-search');
  const searchRow = document.getElementById('git-worktrees-search-row');
  const searchToggle = document.getElementById('git-worktrees-search-toggle');
  if (typeof slice.search === 'string' && searchInput) searchInput.value = slice.search;
  if (typeof slice.searchOpen === 'boolean') {
    if (searchRow) searchRow.hidden = !slice.searchOpen;
    searchToggle?.setAttribute('aria-expanded', String(slice.searchOpen));
    searchToggle?.classList.toggle(
      'git-worktrees-search-btn--active',
      slice.searchOpen || !!String(searchInput?.value || '').trim(),
    );
  }
  if (Array.isArray(slice.filterStates)) {
    worktreeStateFilter = new Set(slice.filterStates.map(String));
    syncWorktreeFilterLabel();
  }
  if (!listedRows.length) return;
  // Consumed before the repaint: renderRows ends by retrying the pending
  // slice, so leaving it set here would re-enter this function.
  pendingWorktreeViewMemory = null;
  renderRows(listedWorkspaceFolder, listedRows);
  const scrollEl = worktreeScrollContainer();
  if (scrollEl && Number.isFinite(Number(slice.scrollTop))) scrollEl.scrollTop = Number(slice.scrollTop);
}

function tryApplyPendingWorktreeViewMemory() {
  if (!pendingWorktreeViewMemory) return;
  applyWorktreeViewMemorySlice(pendingWorktreeViewMemory);
}

/**
 * @returns {string} scope workspace folder; empty lets the server use its cwd
 */
function currentWorkspaceFolder() {
  const fromGit = getGitScope().workspaceFolder || '';
  if (fromGit) return fromGit;
  return viewContextRuntimeParams(getViewContextState() || {}).workspaceFolder || '';
}

/**
 * @returns {boolean}
 */
function isWorktreeListBlocked() {
  const folder = currentWorkspaceFolder();
  if (folder) return false;
  return !isViewContextScopedAccessAllowed();
}

/**
 * @returns {boolean} false when the action must not run (pending scope or missing folder)
 */
function guardWorktreeAction() {
  if (isWorktreeListBlocked()) {
    setStatus(t('workspace.contextPending'), false);
    return false;
  }
  if (!currentWorkspaceFolder()) {
    setStatus(t('worktrees.loadFailed'), true);
    return false;
  }
  return true;
}

/**
 * @param {string} message
 * @param {boolean} [isError]
 */
function setStatus(message, isError = false) {
  const el = document.getElementById('git-worktrees-status');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.tone = isError ? 'error' : '';
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * @param {string} label
 * @param {() => void} onClick
 * @param {{ variant?: string, disabled?: boolean, title?: string }} [options]
 * @returns {HTMLElement}
 */
function button(label, onClick, options = {}) {
  const node = document.createElement('cr-bar-button');
  node.textContent = label;
  if (options.variant) node.setAttribute('variant', options.variant);
  if (options.disabled) node.setAttribute('disabled', '');
  if (options.title) node.title = options.title;
  node.addEventListener('click', () => {
    if (!options.disabled) onClick();
  });
  return node;
}

/**
 * Modal shell: heading, body node and action buttons; resolves on close.
 *
 * @param {{ heading: string, body: HTMLElement, actions: HTMLElement[], maxWidth?: string }} input
 * @returns {{ dialog: HTMLElement, close: () => void }}
 */
function openDialog(input) {
  const dialog = document.createElement('cr-dialog');
  dialog.heading = input.heading;
  dialog.style.setProperty('--cr-dialog-max-width', input.maxWidth || '34rem');
  dialog.append(input.body);
  const actions = el('div');
  actions.setAttribute('slot', 'actions');
  actions.append(...input.actions);
  dialog.append(actions);
  document.body.append(dialog);
  const close = () => dialog.hide();
  dialog.addEventListener('cr-dialog-close', () => dialog.remove(), { once: true });
  dialog.show();
  return { dialog, close };
}

/**
 * @param {object} row
 * @param {Array<[string, string]>} entries
 * @returns {HTMLElement}
 */
function buildFactList(entries) {
  const list = el('div', 'git-worktree-facts');
  for (const [label, value] of entries) {
    const line = el('div', 'git-info-row');
    line.append(el('span', 'git-info-label', label), el('span', 'git-info-value', value || '—'));
    list.append(line);
  }
  return list;
}

/**
 * @param {string} workspaceFolder
 * @param {object} row
 */
async function openDiff(workspaceFolder, row) {
  if (!guardWorktreeAction()) return;
  const data = await api.getWorktreeDiff(row.todoId, workspaceFolder);
  const body = el('div', 'git-worktree-diff');
  if (!data?.ok) {
    body.append(el('p', 'cr-hint', t('worktrees.diffFailed')));
  } else {
    const output = el('pre', 'git-output', `${data.stat || ''}\n${data.patch || t('worktrees.diffEmpty')}`.trim());
    output.style.maxHeight = '60vh';
    body.append(output);
    if (data.truncated) body.append(el('p', 'cr-hint', t('worktrees.diffTruncated')));
  }
  const handle = openDialog({ heading: t('worktrees.diffTitle', { branch: row.branch }), body, actions: [], maxWidth: '60rem' });
  const closeBtn = button(t('common.close'), () => handle.close());
  handle.dialog.querySelector('[slot="actions"]')?.append(closeBtn);
}

/**
 * @param {{ heading: string, message: string, confirmLabel: string, extra?: HTMLElement[] }} input
 * @returns {Promise<boolean>}
 */
function confirmDialog(input) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const body = el('div');
    body.append(el('p', '', input.message), ...(input.extra || []));
    const handle = openDialog({
      heading: input.heading,
      body,
      actions: [
        button(t('common.cancel'), () => handle.close()),
        button(input.confirmLabel, () => {
          finish(true);
          handle.close();
        }, { variant: 'primary' }),
      ],
    });
    handle.dialog.addEventListener('cr-dialog-close', () => finish(false), { once: true });
  });
}

/**
 * @param {string} workspaceFolder
 * @param {object} row
 */
async function runReject(workspaceFolder, row) {
  if (!guardWorktreeAction()) return;
  const ok = await confirmDialog({
    heading: t('worktrees.rejectTitle'),
    message: t('worktrees.rejectMessage', { branch: row.branch }),
    confirmLabel: t('worktrees.reject'),
  });
  if (!ok) return;
  setStatus(t('worktrees.working'));
  const data = await api.rejectWorktree(row.todoId, workspaceFolder);
  setStatus(data?.ok ? t('worktrees.rejected') : t('worktrees.actionFailed', { detail: data?.error || '' }), !data?.ok);
  await refreshWorktreeList();
}

/**
 * @param {string} workspaceFolder
 * @param {object} row
 */
async function runCleanup(workspaceFolder, row) {
  if (!guardWorktreeAction()) return;
  const discard = cleanupNeedsDiscard(row);
  const deleteBranchBox = document.createElement('cr-checkbox');
  const deleteBranchLabel = el('label', 'cr-check');
  deleteBranchLabel.append(deleteBranchBox, el('span', '', t('worktrees.deleteBranch')));
  const ok = await confirmDialog({
    heading: t('worktrees.cleanupTitle'),
    message: discard
      ? t('worktrees.cleanupDiscardMessage', { path: row.worktreePath, branch: row.branch })
      : t('worktrees.cleanupMessage', { path: row.worktreePath }),
    confirmLabel: t('worktrees.cleanup'),
    extra: [deleteBranchLabel],
  });
  if (!ok) return;
  setStatus(t('worktrees.working'));
  const data = await api.cleanupWorktree(row.todoId, workspaceFolder, {
    deleteBranch: deleteBranchBox.checked === true,
    discard,
    confirmBranch: discard ? row.branch : '',
  });
  if (!data?.ok) {
    setStatus(t('worktrees.actionFailed', { detail: data?.message || data?.error || '' }), true);
  } else if (deleteBranchBox.checked && !data.branchDeleted) {
    setStatus(t('worktrees.branchKept', { detail: data.branchMessage || '' }), true);
  } else {
    setStatus(t('worktrees.cleaned'));
  }
  await refreshWorktreeList();
}

/**
 * @param {string} workspaceFolder
 * @param {object} row
 * @param {string} instructions
 * @param {{ harness: string, model: string }} picked
 */
async function startMerge(workspaceFolder, row, instructions, picked) {
  if (!guardWorktreeAction()) return;
  setStatus(t('worktrees.mergeStarting'));
  const data = await api.startWorktreeMerge(row.todoId, workspaceFolder, {
    agentTransport: picked.harness,
    model: String(picked.model || 'auto'),
    instructions,
  });
  if (!data?.ok || !data.chat) {
    const blocker = Array.isArray(data?.blockers) && data.blockers[0]
      ? describeMergeBlocker(data.blockers[0], t)
      : String(data?.error || '');
    setStatus(t('worktrees.mergeFailed', { detail: blocker }), true);
    await refreshWorktreeList();
    return;
  }
  setStatus(t('worktrees.mergeStarted'));
  openTodoAgentChat(data.chat, { initialPrompt: data.initialPrompt });
  window.dispatchEvent(new CustomEvent('cretli-panel-open', { detail: { panel: 'chat' } }));
  await refreshWorktreeList();
}

/**
 * Merge summary dialog; "Choose model" continues into the shared model picker.
 *
 * @param {string} workspaceFolder
 * @param {object} row
 */
async function openMergeDialog(workspaceFolder, row) {
  if (!guardWorktreeAction()) return;
  const preview = await api.getWorktreeMergePreview(row.todoId, workspaceFolder);
  const pre = preview?.ok ? preview.preflight : null;
  const body = el('div', 'git-worktree-merge');
  if (!pre) {
    body.append(el('p', '', t('worktrees.previewFailed')));
  } else {
    body.append(buildFactList([
      [t('worktrees.mergeInto'), `${row.branch} → ${pre.targetBranch || '—'}`],
      [t('worktrees.base'), shortCommit(pre.baseCommit)],
      [t('worktrees.diffstat'), pre.diffStat || t('worktrees.noChanges')],
      [t('worktrees.uncommitted'), String(pre.uncommittedFiles || 0)],
      [t('worktrees.conflictForecast'), t(`worktrees.forecast.${pre.conflictForecast || 'unknown'}`)],
    ]));
    for (const blocker of pre.blockers || []) {
      const line = el('p', 'cr-hint', describeMergeBlocker(blocker, t));
      line.dataset.tone = 'error';
      body.append(line);
      if (Array.isArray(blocker.paths) && blocker.paths.length) {
        body.append(el('pre', 'git-output', blocker.paths.join('\n')));
      }
    }
    if (pre.conflictForecast === 'conflicts') {
      const warn = el('p', 'cr-hint', t('worktrees.conflictWarning'));
      warn.dataset.tone = 'error';
      body.append(warn);
    }
    body.append(el('p', 'cr-hint', t('worktrees.policyNote')));
  }
  const instructions = document.createElement('cr-bar-textarea');
  instructions.setAttribute('placeholder', t('worktrees.instructionsPlaceholder'));
  instructions.setAttribute('aria-label', t('worktrees.instructions'));
  const field = el('div', 'cr-field');
  field.append(el('span', 'cr-field-label', t('worktrees.instructions')), instructions);
  body.append(field);
  const handle = openDialog({
    heading: t('worktrees.mergeTitle'),
    body,
    actions: [
      button(t('common.cancel'), () => handle.close()),
      button(t('worktrees.chooseModel'), () => {
        const text = String(instructions.value || '');
        handle.close();
        openTodoAgentStartModal({
          harness: '',
          onStart: (picked) => startMerge(workspaceFolder, row, text, picked),
        });
      }, { variant: 'primary', disabled: !canStartMerge(pre) }),
    ],
  });
}

/**
 * @param {string} workspaceFolder
 * @param {object} row
 * @returns {HTMLElement}
 */
function renderRow(workspaceFolder, row) {
  const node = el('div', 'git-worktree-row');
  node.setAttribute('role', 'listitem');
  node.dataset.todoId = row.todoId;
  node.dataset.state = row.state;
  const state = describeWorktreeState(row.state, t);
  const head = el('div', 'git-worktree-head');
  head.append(el('strong', 'git-worktree-title', row.title || row.todoId));
  const badge = el('span', 'git-status-badge', state.label);
  badge.dataset.tone = state.tone;
  head.append(badge);
  const meta = el('div', 'git-worktree-meta');
  meta.append(
    el('span', `git-worktree-todo-link${row.todoExists ? '' : ' git-worktree-todo-link--missing'}`, t(row.todoExists ? 'worktrees.todoLinked' : 'worktrees.todoMissing')),
    el('span', 'git-info-value', row.branch || '—'),
    el('span', 'cr-hint', `${shortCommit(row.baseCommit)} → ${shortCommit(row.headCommit)}`),
    el('span', 'cr-hint', summarizeWorktreeChanges(row, t)),
    el('span', 'git-worktree-chat-count', t('worktrees.chatCount', { count: Number(row.chatCount) || 0 })),
  );
  node.append(head, meta);
  const detail = row.integrationReason || row.message || row.error;
  if (detail) {
    const hint = el('div', 'cr-hint', detail);
    hint.dataset.tone = row.state === 'missing' || row.state === 'foreign' ? 'error' : '';
    node.append(hint);
  }
  const actions = el('div', 'git-worktree-actions cr-row');
  actions.append(
    button(t('worktrees.merge'), () => { void openMergeDialog(workspaceFolder, row); }, {
      variant: 'primary',
      disabled: !row.actions?.merge,
    }),
    button(t('worktrees.diff'), () => { void openDiff(workspaceFolder, row); }, { disabled: !row.actions?.diff }),
    button(t('worktrees.reject'), () => { void runReject(workspaceFolder, row); }, { disabled: !row.actions?.reject }),
    button(t('worktrees.cleanup'), () => { void runCleanup(workspaceFolder, row); }, { disabled: !row.actions?.cleanup }),
  );
  node.append(actions);
  return node;
}

/**
 * @param {object[]} rows
 */
function renderRows(workspaceFolder, rows) {
  const host = document.getElementById('git-worktrees-list');
  if (!host) return;
  host.replaceChildren();
  const query = String(document.getElementById('git-worktrees-search')?.value || '').trim().toLocaleLowerCase();
  const visible = rows.filter((row) => row.state !== 'cleaned'
    && (!worktreeStateFilter.size || worktreeStateFilter.has(row.state))
    && (!query || [row.title, row.todoId, row.branch, row.state, row.worktreePath]
    .some((value) => String(value || '').toLocaleLowerCase().includes(query))));
  if (!visible.length) {
    host.append(el('p', 'cr-hint', query || worktreeStateFilter.size ? t('worktrees.noSearchResults') : t('worktrees.empty')));
    return;
  }
  for (const row of visible) host.append(renderRow(workspaceFolder, row));
  tryApplyPendingWorktreeViewMemory();
  scheduleWorktreeViewMemoryCapture();
}

/**
 * Fetch and repaint the list. A late answer for a previous workspace/request
 * is dropped.
 *
 * @returns {Promise<void>}
 */
export async function refreshWorktreeList() {
  const host = document.getElementById('git-worktrees-list');
  if (!host) return;
  const requestId = ++refreshRequestId;
  if (isWorktreeListBlocked()) {
    listedRows = [];
    host.replaceChildren();
    setStatus(t('workspace.contextPending'), false);
    return;
  }
  const folder = currentWorkspaceFolder();
  if (!folder) {
    listedRows = [];
    host.replaceChildren();
    setStatus(t('worktrees.loadFailed'), true);
    return;
  }
  let data = null;
  try {
    data = await api.listWorktrees(folder);
  } catch {
    data = null;
  }
  if (requestId !== refreshRequestId) return;
  if (!data?.ok) {
    listedRows = [];
    host.replaceChildren();
    setStatus(t('worktrees.loadFailed'), true);
    return;
  }
  listedWorkspaceFolder = data.workspaceFolder || folder;
  listedRows = Array.isArray(data.rows) ? data.rows : [];
  setStatus('');
  renderRows(listedWorkspaceFolder, listedRows);
}

/**
 * @param {string} view
 */
function requestGitSubviewNavigation(view) {
  const subview = view === 'worktrees' ? 'worktrees' : 'main';
  void navigateSpa({ panel: 'git', subview }, { explicit: true });
}

export function initWorktreeList() {
  document.querySelectorAll('[data-git-view]').forEach((button) => {
    button.addEventListener('click', () => requestGitSubviewNavigation(button.dataset.gitView));
  });
  const searchInput = document.getElementById('git-worktrees-search');
  const searchRow = document.getElementById('git-worktrees-search-row');
  const searchToggle = document.getElementById('git-worktrees-search-toggle');
  initWorktreeFilterMenu();
  searchInput?.addEventListener('input', () => {
    renderRows(listedWorkspaceFolder, listedRows);
    searchToggle?.classList.toggle('git-worktrees-search-btn--active', !!String(searchInput.value || '').trim());
    scheduleWorktreeViewMemoryCapture();
  });
  searchToggle?.addEventListener('click', () => {
    const isOpen = searchRow?.hidden === true;
    if (searchRow) searchRow.hidden = !isOpen;
    searchToggle.setAttribute('aria-expanded', String(isOpen));
    searchToggle.classList.toggle('git-worktrees-search-btn--active', isOpen || !!String(searchInput?.value || '').trim());
    if (isOpen) searchInput?.focus?.();
    else if (searchInput) {
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    scheduleWorktreeViewMemoryCapture();
  });
  registerViewMemoryRestoreHandler('git', (slice) => {
    pendingWorktreeViewMemory = slice;
    tryApplyPendingWorktreeViewMemory();
  });
  worktreeScrollContainer()?.addEventListener('scroll', () => scheduleWorktreeViewMemoryCapture(), { passive: true });
  window.addEventListener('cretli-git-changed', () => {
    if (document.getElementById('git-panel')?.classList.contains('active') && !document.getElementById('git-worktrees')?.hidden) void refreshWorktreeList();
  });
  document.getElementById('git-worktrees-refresh')?.addEventListener('click', () => {
    void refreshWorktreeList();
  });
  window.addEventListener('cr-lang-changed', () => {
    void refreshWorktreeList();
  });
}

function initWorktreeFilterMenu() {
  const trigger = document.getElementById('git-worktrees-filter-toggle');
  if (!trigger || worktreeFilterMenu) return;
  const panel = el('div', 'chat-list-modal todo-status-filter-panel');
  panel.hidden = true;
  const list = el('div', 'chat-list-panel todo-status-filter-list');
  list.setAttribute('role', 'menu');
  panel.append(list);
  document.body.append(panel);
  const api = initDropdown({
    triggerEl: trigger,
    floatingEl: panel,
    compact: true,
    placement: 'bottom-start',
    minWidthPx: 220,
    maxHeightPx: 320,
    onOpen: renderWorktreeFilterMenu,
  });
  worktreeFilterMenu = { api, panel, list };
  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!api.isOpen()) closeAllOpenDropdowns();
    api.toggle();
  });
  list.addEventListener('cr-change', (event) => {
    const row = event.target instanceof Element ? event.target.closest('[data-worktree-state]') : null;
    if (!(row instanceof HTMLElement)) return;
    const state = String(row.dataset.worktreeState || '');
    const checkbox = row.querySelector('cr-checkbox');
    if (!state) {
      worktreeStateFilter.clear();
      list.querySelectorAll('[data-worktree-state] cr-checkbox').forEach((box) => { box.checked = false; });
    } else if (checkbox?.checked) {
      worktreeStateFilter.add(state);
    } else {
      worktreeStateFilter.delete(state);
    }
    renderWorktreeFilterMenu();
    syncWorktreeFilterLabel();
    renderRows(listedWorkspaceFolder, listedRows);
    scheduleWorktreeViewMemoryCapture();
  });
}

function renderWorktreeFilterMenu() {
  const entry = worktreeFilterMenu;
  if (!entry) return;
  entry.list.replaceChildren();
  const addRow = (state, label, checked) => {
    const row = el('div', 'todo-status-filter-row');
    row.dataset.worktreeState = state;
    const checkbox = document.createElement('cr-checkbox');
    checkbox.checked = checked;
    checkbox.setAttribute('aria-label', label);
    checkbox.append(el('span', '', label));
    row.append(checkbox);
    entry.list.append(row);
  };
  addRow('', t('worktrees.filterAll'), worktreeStateFilter.size === 0);
  WORKTREE_FILTER_STATES.forEach((state) => addRow(state, describeWorktreeState(state, t).label, worktreeStateFilter.has(state)));
}

function syncWorktreeFilterLabel() {
  const label = document.getElementById('git-worktrees-filter-label');
  const trigger = document.getElementById('git-worktrees-filter-toggle');
  const selected = WORKTREE_FILTER_STATES.filter((state) => worktreeStateFilter.has(state));
  if (label) label.textContent = selected.length ? selected.map((state) => describeWorktreeState(state, t).label).join(', ') : t('worktrees.filterAll');
  trigger?.classList.toggle('todo-status-filter-trigger--active', selected.length > 0);
}

export function showWorktreeView() {
  requestGitSubviewNavigation('worktrees');
}

/**
 * Paint the Git panel sub-view without touching the URL (route apply path).
 *
 * @param {string} subview canonical route sub-view (`main` | `worktrees`)
 */
export function applyGitSubviewFromRoute(subview) {
  const view = subview === 'worktrees' ? 'worktrees' : 'main';
  paintGitSubview(view);
}

/**
 * @param {string} view `main` | `worktrees`
 */
function paintGitSubview(view) {
  document.querySelectorAll('[data-git-view]').forEach((tab) => {
    const isActive = tab.dataset.gitView === view;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  document.getElementById('git-main-view')?.toggleAttribute('hidden', view !== 'main');
  document.getElementById('git-worktrees')?.toggleAttribute('hidden', view !== 'worktrees');
  document.getElementById('git-main-toolbar-actions')?.toggleAttribute('hidden', view !== 'main');
  document.getElementById('git-worktrees-toolbar')?.toggleAttribute('hidden', view !== 'worktrees');
  document.getElementById('git-worktrees-search-row')?.toggleAttribute('hidden', view !== 'worktrees' || document.getElementById('git-worktrees-search-toggle')?.getAttribute('aria-expanded') !== 'true');
  if (view === 'worktrees') void refreshWorktreeList();
}
