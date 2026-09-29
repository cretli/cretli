import * as api from './core/api/index.js';
import { openTodoAgentChat } from './chat.js';
import { t } from './i18n/index.js';
import { VALID_TRANSPORTS } from '../lib/agent-transport.js';
import {
  canAddTodoChild,
  flattenTodoTree,
  formatTodoAssigneeBadge,
  readTodoRowMark,
  resolveTodoDrop,
  todoDropZoneFromRatio,
} from './features/todo/todoTreeView.js';
import './components/ui/cr-bar-select.js';
import './components/ui/cr-bar-input.js';
import './components/ui/cr-bar-textarea.js';
import './components/ui/cr-bar-button.js';
import './components/ui/cr-dialog.js';
import './components/ui/cr-todo-card.js';

/** @type {HTMLElement|null} */
let listEl = null;
/** @type {HTMLElement|null} */
let statusEl = null;
/** @type {HTMLElement|null} */
let hintEl = null;
/** @type {(panelId: string) => void} */
let showPanelFn = () => {};
/** @type {boolean} */
let sdkReady = false;
/** @type {object[]} */
let latestItems = [];
/** @type {Set<string>} */
let collapsedIds = new Set();
/** @type {string} */
let pendingParentId = '';
/** @type {HTMLElement | null} */
let editorDialog = null;
/** @type {HTMLElement | null} */
let editorCard = null;
/** @type {string} */
let editorTodoId = '';
/** @type {{ id: string, pointerId: number, targetId: string, zone: string } | null} */
let dragState = null;
/** @type {() => void} */
let openNewTodoModal = () => {};

const COLLAPSE_PREFIX = 'cretli-todo-collapsed:';

function resolveTodoStartHarness(item) {
  const stored = String(item?.sourceHarness || item?.sourceChat?.agentTransport || '').trim();
  if (stored) return stored;
  const sel = document.getElementById('chat-new-harness-select');
  return String(sel?.value || 'sdk').trim() || 'sdk';
}

/**
 * @param {string} msg
 * @param {boolean} isErr
 */
function setStatus(msg, isErr) {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('todo-status--error', !!isErr);
}

function getWorkspaceContext() {
  const trigger = document.getElementById('header-workspace-trigger');
  return {
    workspaceFile: trigger?.dataset?.workspaceFile || '',
    workspaceFolder: trigger?.dataset?.workspaceFolder || '',
  };
}

function collapseStorageKey() {
  const folder = getWorkspaceContext().workspaceFolder || 'default';
  return `${COLLAPSE_PREFIX}${folder}`;
}

function loadCollapsed() {
  collapsedIds = new Set();
  try {
    const raw = localStorage.getItem(collapseStorageKey());
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return;
    parsed.forEach((id) => {
      const key = String(id || '').trim();
      if (key) collapsedIds.add(key);
    });
  } catch {
    collapsedIds = new Set();
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(collapseStorageKey(), JSON.stringify([...collapsedIds]));
  } catch {
    // Private mode can reject storage; the tree still works for this view.
  }
}

function bindCardHandlers(card) {
  card.addEventListener('todo-status-change', onStatusChange);
  card.addEventListener('todo-title-save', onTitleBlur);
  card.addEventListener('todo-body-save', onBodyBlur);
  card.addEventListener('todo-delete', onDelete);
  card.addEventListener('todo-start-agent', onStartAgent);
  card.addEventListener('todo-open-chat', onOpenChat);
}

/**
 * @param {string} id
 * @returns {object | null}
 */
function findItem(id) {
  return latestItems.find((item) => String(item?.id || '') === id) || null;
}

function syncEditorItem() {
  if (!editorCard || !editorTodoId) return;
  const item = findItem(editorTodoId);
  if (!item) {
    closeEditor();
    return;
  }
  editorCard.item = item;
  fillEditorFields(item);
}

function renderList(data) {
  if (!listEl) return;
  latestItems = Array.isArray(data?.items) ? data.items : [];
  if (!latestItems.length) {
    listEl.innerHTML =
      '<div class="todo-empty-state">' +
      '<span class="todo-empty-icon mdi mdi-checkbox-marked-circle-outline" aria-hidden="true"></span>' +
      `<p class="todo-empty">${t('todo.none')}</p>` +
      '</div>';
    syncEditorItem();
    return;
  }
  const rows = flattenTodoTree(latestItems, collapsedIds);
  let wrapEl = listEl.querySelector('.todo-rows');
  if (!wrapEl) {
    listEl.innerHTML = '';
    wrapEl = document.createElement('div');
    wrapEl.className = 'todo-rows';
    wrapEl.setAttribute('role', 'tree');
    wrapEl.setAttribute('aria-label', t('todo.treeAria'));
    listEl.appendChild(wrapEl);
  }
  wrapEl.setAttribute('aria-label', t('todo.treeAria'));
  const existing = new Map(
    [...wrapEl.querySelectorAll('.todo-row')].map((row) => [String(row.dataset.id || ''), row])
  );
  const nextIds = new Set(rows.map((row) => String(row.item.id)));
  for (const [id, row] of existing) {
    if (nextIds.has(id)) continue;
    row.remove();
    existing.delete(id);
  }
  rows.forEach((row, index) => {
    const id = String(row.item.id);
    let el = existing.get(id);
    if (!el) {
      el = createTodoRow();
      const before = wrapEl.children[index] || null;
      wrapEl.insertBefore(el, before);
    } else if (wrapEl.children[index] !== el) {
      wrapEl.insertBefore(el, wrapEl.children[index] || null);
    }
    paintTodoRow(el, row);
  });
  syncEditorItem();
}

function createTodoRow() {
  const row = document.createElement('div');
  row.className = 'todo-row';
  row.setAttribute('role', 'treeitem');
  row.innerHTML =
    '<button type="button" class="todo-row-grip" draggable="false">' +
    '<span class="mdi mdi-drag-vertical" aria-hidden="true"></span></button>' +
    '<button type="button" class="todo-row-toggle" hidden></button>' +
    '<button type="button" class="todo-row-main">' +
    '<span class="todo-item-status-dot" aria-hidden="true"></span>' +
    '<span class="todo-row-title"></span>' +
    '<span class="todo-row-badge" hidden></span>' +
    '<span class="todo-row-mark" hidden></span>' +
    '</button>' +
    '<button type="button" class="todo-row-add">' +
    '<span class="mdi mdi-plus" aria-hidden="true"></span></button>';
  const grip = row.querySelector('.todo-row-grip');
  const toggle = row.querySelector('.todo-row-toggle');
  const main = row.querySelector('.todo-row-main');
  const add = row.querySelector('.todo-row-add');
  grip?.addEventListener('pointerdown', onGripPointerDown);
  grip?.addEventListener('pointermove', onGripPointerMove);
  grip?.addEventListener('pointerup', onGripPointerUp);
  grip?.addEventListener('pointercancel', onGripPointerUp);
  toggle?.addEventListener('click', onToggleClick);
  main?.addEventListener('click', onRowOpen);
  add?.addEventListener('click', onAddChildClick);
  return row;
}

/**
 * @param {HTMLElement} el
 * @param {{ item: object, level: number, hasChildren: boolean, collapsed: boolean }} row
 */
function paintTodoRow(el, row) {
  const id = String(row.item.id || '');
  const status = String(row.item.status || 'idea');
  el.dataset.id = id;
  el.dataset.status = status;
  el.className = `todo-row todo-row--${status}`;
  el.style.setProperty('--todo-level', String(row.level));
  el.setAttribute('aria-level', String(row.level + 1));
  const toggle = el.querySelector('.todo-row-toggle');
  const title = el.querySelector('.todo-row-title');
  const badge = el.querySelector('.todo-row-badge');
  const mark = el.querySelector('.todo-row-mark');
  const grip = el.querySelector('.todo-row-grip');
  const add = el.querySelector('.todo-row-add');
  const main = el.querySelector('.todo-row-main');
  if (title) title.textContent = String(row.item.title || '');
  if (grip instanceof HTMLElement) grip.setAttribute('aria-label', t('todo.dragHandle'));
  if (main instanceof HTMLElement) main.setAttribute('aria-label', t('todo.editTask'));
  if (toggle instanceof HTMLButtonElement) {
    toggle.hidden = !row.hasChildren;
    toggle.textContent = '';
    const icon = document.createElement('span');
    icon.className = `mdi ${row.collapsed ? 'mdi-chevron-right' : 'mdi-chevron-down'}`;
    icon.setAttribute('aria-hidden', 'true');
    toggle.appendChild(icon);
    toggle.setAttribute('aria-label', row.collapsed ? t('todo.expand') : t('todo.collapse'));
    if (row.hasChildren) el.setAttribute('aria-expanded', row.collapsed ? 'false' : 'true');
    else el.removeAttribute('aria-expanded');
  }
  const badgeText = formatTodoAssigneeBadge(row.item);
  if (badge instanceof HTMLElement) {
    badge.hidden = !badgeText;
    badge.textContent = badgeText;
  }
  const markKind = readTodoRowMark(latestItems, row.item);
  if (mark instanceof HTMLElement) {
    mark.hidden = !markKind;
    mark.textContent = markKind === 'blocked' ? t('todo.blocked') : t('todo.ready');
    mark.dataset.mark = markKind;
  }
  if (add instanceof HTMLButtonElement) {
    const allowed = canAddTodoChild(latestItems, id);
    add.disabled = !allowed;
    add.setAttribute('aria-label', t('todo.addChild'));
    add.title = allowed ? t('todo.addChild') : t('todo.depthLimit');
  }
}

function clearDropMarks() {
  listEl?.querySelectorAll('.todo-row').forEach((row) => {
    row.classList.remove('todo-row--drop-before', 'todo-row--drop-after', 'todo-row--drop-nest');
  });
}

/** @param {PointerEvent} event */
function onGripPointerDown(event) {
  if (event.button !== 0) return;
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id || !(event.currentTarget instanceof HTMLElement)) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  dragState = { id, pointerId: event.pointerId, targetId: '', zone: '' };
  row.classList.add('todo-row--dragging');
}

/** @param {PointerEvent} event */
function onGripPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const row = hit instanceof Element ? hit.closest('.todo-row') : null;
  clearDropMarks();
  dragState.targetId = '';
  dragState.zone = '';
  if (!(row instanceof HTMLElement) || row.dataset.id === dragState.id) return;
  const rect = row.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
  const zone = todoDropZoneFromRatio(ratio);
  dragState.targetId = String(row.dataset.id || '');
  dragState.zone = zone;
  row.classList.add(`todo-row--drop-${zone}`);
}

/** @param {PointerEvent} event */
function onGripPointerUp(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const move = dragState;
  dragState = null;
  clearDropMarks();
  listEl?.querySelectorAll('.todo-row--dragging').forEach((row) => {
    row.classList.remove('todo-row--dragging');
  });
  if (!move.targetId || !move.zone) return;
  const decision = resolveTodoDrop({
    items: latestItems,
    draggedId: move.id,
    targetId: move.targetId,
    zone: move.zone,
  });
  if (!decision.ok) {
    if (decision.reason !== 'noop' && decision.reason !== 'self') {
      setStatus(t('todo.dropRejected'), true);
    }
    return;
  }
  void patchMove(move.id, decision.parentId, decision.siblingIndex);
}

/** @param {MouseEvent} event */
function onToggleClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  if (collapsedIds.has(id)) collapsedIds.delete(id);
  else collapsedIds.add(id);
  saveCollapsed();
  renderList({ items: latestItems });
}

/** @param {MouseEvent} event */
function onRowOpen(event) {
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  openEditor(id);
}

/** @param {MouseEvent} event */
function onAddChildClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  const id = String(row?.dataset.id || '');
  if (!id) return;
  if (!canAddTodoChild(latestItems, id)) {
    setStatus(t('todo.depthLimit'), true);
    return;
  }
  pendingParentId = id;
  openNewTodoModal();
}

/**
 * @param {string} id
 * @param {string | null} parentId
 * @param {number} siblingIndex
 */
async function patchMove(id, parentId, siblingIndex) {
  try {
    const data = await api.patchTodo(id, { parentId, siblingIndex });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

function ensureEditor() {
  if (editorDialog) return;
  const dialog = document.createElement('cr-dialog');
  dialog.className = 'todo-editor-dialog';
  dialog.style.setProperty('--cr-dialog-max-width', '40rem');
  const wrap = document.createElement('div');
  wrap.className = 'todo-editor';
  const card = document.createElement('cr-todo-card');
  card.className = 'todo-card';
  bindCardHandlers(card);
  const fields = document.createElement('div');
  fields.className = 'todo-editor-fields';
  fields.innerHTML =
    '<p class="todo-editor-label" data-field="assignee-label"></p>' +
    '<div class="todo-editor-grid">' +
    '<label class="cr-field"><span class="cr-field-label" data-field="harness-label"></span>' +
    '<cr-bar-select class="todo-editor-harness" size="md"></cr-bar-select></label>' +
    '<label class="cr-field"><span class="cr-field-label" data-field="model-label"></span>' +
    '<cr-bar-input class="todo-editor-model" maxlength="200"></cr-bar-input></label>' +
    '<label class="cr-field"><span class="cr-field-label" data-field="role-label"></span>' +
    '<cr-bar-select class="todo-editor-role" size="md"></cr-bar-select></label>' +
    '<label class="cr-field"><span class="cr-field-label" data-field="run-label"></span>' +
    '<cr-bar-select class="todo-editor-run" size="md"></cr-bar-select></label>' +
    '</div>';
  wrap.appendChild(card);
  wrap.appendChild(fields);
  dialog.appendChild(wrap);
  dialog.addEventListener('cr-dialog-close', () => {
    editorTodoId = '';
  });
  fields.querySelector('.todo-editor-harness')?.addEventListener('cr-change', () => {
    void saveEditorAssignee();
  });
  fields.querySelector('.todo-editor-role')?.addEventListener('cr-change', () => {
    void saveEditorAssignee();
  });
  fields.querySelector('.todo-editor-model')?.addEventListener('blur', () => {
    void saveEditorAssignee();
  });
  fields.querySelector('.todo-editor-run')?.addEventListener('cr-change', () => {
    void saveEditorRunMode();
  });
  document.body.appendChild(dialog);
  editorDialog = dialog;
  editorCard = card;
}

function editorControl(className) {
  return editorDialog?.querySelector(className) || null;
}

function fillEditorLabels() {
  if (!editorDialog) return;
  const setText = (selector, key) => {
    const el = editorDialog.querySelector(selector);
    if (el) el.textContent = t(key);
  };
  setText('[data-field="assignee-label"]', 'todo.assignee');
  setText('[data-field="harness-label"]', 'todo.harness');
  setText('[data-field="model-label"]', 'todo.model');
  setText('[data-field="role-label"]', 'todo.role');
  setText('[data-field="run-label"]', 'todo.runMode');
  const harness = editorControl('.todo-editor-harness');
  const role = editorControl('.todo-editor-role');
  const run = editorControl('.todo-editor-run');
  const model = editorControl('.todo-editor-model');
  if (harness) {
    harness.options = [
      { value: '', label: t('todo.noAssignee') },
      ...VALID_TRANSPORTS.map((id) => ({ value: id, label: id })),
    ];
    harness.ariaLabel = t('todo.harness');
  }
  if (role) {
    role.options = [
      { value: 'plan', label: t('todo.rolePlan') },
      { value: 'implement', label: t('todo.roleImplement') },
      { value: 'review', label: t('todo.roleReview') },
    ];
    role.ariaLabel = t('todo.role');
  }
  if (run) {
    run.options = [
      { value: 'parallel', label: t('todo.runParallel') },
      { value: 'sequential', label: t('todo.runSequential') },
    ];
    run.ariaLabel = t('todo.runMode');
  }
  if (model) model.placeholder = t('todo.model');
}

/**
 * @param {object} item
 */
function fillEditorFields(item) {
  fillEditorLabels();
  const harness = editorControl('.todo-editor-harness');
  const role = editorControl('.todo-editor-role');
  const run = editorControl('.todo-editor-run');
  const model = editorControl('.todo-editor-model');
  const assignee = item?.assignee && typeof item.assignee === 'object' ? item.assignee : null;
  if (harness) harness.value = String(assignee?.harness || '');
  if (role) role.value = String(assignee?.role || 'implement');
  const modelFocused = model instanceof HTMLElement && document.activeElement === model;
  if (model && 'value' in model && !modelFocused) model.value = String(assignee?.model || '');
  if (run) run.value = item?.runMode === 'sequential' ? 'sequential' : 'parallel';
}

function openEditor(id) {
  const item = findItem(id);
  if (!item) return;
  ensureEditor();
  if (!editorDialog || !editorCard) return;
  editorTodoId = id;
  editorDialog.heading = t('todo.editTask');
  editorCard.item = item;
  fillEditorFields(item);
  editorDialog.show();
}

function closeEditor() {
  editorTodoId = '';
  editorDialog?.hide();
}

function sameAssignee(item, assignee) {
  const current = item?.assignee && typeof item.assignee === 'object' ? item.assignee : null;
  if (!assignee && !current?.harness) return true;
  if (!assignee || !current) return false;
  return current.harness === assignee.harness
    && current.role === assignee.role
    && String(current.model || '') === String(assignee.model || '');
}

async function saveEditorAssignee() {
  if (!editorTodoId) return;
  const harness = String(editorControl('.todo-editor-harness')?.value || '').trim();
  const role = String(editorControl('.todo-editor-role')?.value || '').trim();
  const modelEl = editorControl('.todo-editor-model');
  const model = modelEl && 'value' in modelEl ? String(modelEl.value || '').trim() : '';
  const assignee = harness
    ? { harness, role: role || 'implement', ...(model ? { model } : {}) }
    : null;
  if (sameAssignee(findItem(editorTodoId), assignee)) return;
  try {
    const data = await api.patchTodo(editorTodoId, { assignee });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

async function saveEditorRunMode() {
  if (!editorTodoId) return;
  const runMode = editorControl('.todo-editor-run')?.value === 'sequential' ? 'sequential' : 'parallel';
  const current = findItem(editorTodoId)?.runMode === 'sequential' ? 'sequential' : 'parallel';
  if (current === runMode) return;
  try {
    const data = await api.patchTodo(editorTodoId, { runMode });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/** @param {Event} e */
function onOpenChat(e) {
  const chatId = String(e?.detail?.chatId || '').trim();
  if (!chatId) {
    void onStartAgent(e);
    return;
  }
  const agentTransport = String(e?.detail?.agentTransport || '').trim();
  openTodoAgentChat(
    agentTransport ? { id: chatId, agentTransport } : { id: chatId },
    { reused: true }
  );
  showPanelFn('chat');
  setStatus(t('todo.openedLinkedChat'));
}

/** @param {Event} e */
async function onStartAgent(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const cardEl = e.target instanceof Element ? e.target.closest('cr-todo-card') : null;
  const btnEl = cardEl?.querySelector('.todo-item-agent');
  if (!(btnEl instanceof HTMLElement) || !('disabled' in btnEl)) return;
  const ctx = getWorkspaceContext();
  if (!ctx.workspaceFile || !ctx.workspaceFolder) {
    setStatus(t('todo.selectWorkspace'), true);
    return;
  }
  const item = cardEl?.item || findItem(String(id)) || {};
  const hasLinkedChat = !!(item.chatId || item.sourceChat?.id);
  const harness = resolveTodoStartHarness(item);
  if (!hasLinkedChat && harness === 'sdk' && !sdkReady) {
    setStatus(t('todo.sdkRequiresApiKey'), true);
    return;
  }
  btnEl.disabled = true;
  setStatus(t('todo.creatingAgent'));
  const payload = {
    workspaceFile: ctx.workspaceFile,
    workspaceFolder: ctx.workspaceFolder,
    model: 'auto',
    agentTransport: harness,
  };
  try {
    const data = await api.postTodoStartAgent(id, payload);
    if (!data?.ok || !data.chat) {
      setStatus(data?.error || t('todo.startAgentFailed'), true);
      return;
    }
    renderList(data);
    openTodoAgentChat(data.chat, {
      initialPrompt: data.initialPrompt,
      reused: !!data.reused,
    });
    showPanelFn('chat');
    setStatus(data.reused ? t('todo.openedLinkedChat') : t('todo.startedAgent'));
  } catch {
    setStatus(t('todo.networkError'), true);
  } finally {
    btnEl.disabled = false;
  }
}

/** @param {Event} e */
async function onStatusChange(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const status = e.detail?.status || e.detail?.value;
  if (!status) return;
  try {
    const data = await api.patchTodo(id, { status });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

/** @param {Event} e */
async function onTitleBlur(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const title = String(e?.detail?.title || '').trim();
  if (!title) {
    setStatus(t('todo.titleRequired'), true);
    refreshTodoList();
    return;
  }
  try {
    const data = await api.patchTodo(id, { title });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

/** @param {Event} e */
async function onBodyBlur(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const body = String(e?.detail?.body || '');
  try {
    const data = await api.patchTodo(id, { body });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

/** @param {Event} e */
async function onDelete(e) {
  const id = e?.detail?.id;
  if (!id) return;
  try {
    const data = await api.deleteTodo(id);
    if (!data?.ok) {
      setStatus(data?.error || t('todo.deleteError'), true);
      refreshTodoList();
      return;
    }
    if (editorTodoId === String(id)) closeEditor();
    setStatus(t('todo.deleted'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

export function refreshTodoList() {
  loadCollapsed();
  void api.getAgentSdkStatus().then((data) => {
    sdkReady = !!data?.ready;
  }).catch(() => {});
  return api
    .getTodos()
    .then((data) => {
      if (!data?.ok) {
        setStatus(data?.error || t('todo.loadFailed'), true);
        if (hintEl) hintEl.textContent = '';
        renderList({ items: [] });
        return;
      }
      if (hintEl) {
        if (data.cwd) {
          hintEl.textContent = data.cwd;
          hintEl.hidden = false;
        } else {
          hintEl.textContent = '';
          hintEl.hidden = true;
        }
      }
      setStatus('');
      renderList(data);
    })
    .catch(() => {
      setStatus(t('todo.loadError'), true);
      renderList({ items: [] });
    });
}

/**
 * @param {{ showPanel?: (panelId: string) => void }} [options]
 */
export function initTodoPanel(options = {}) {
  if (typeof options.showPanel === 'function') {
    showPanelFn = options.showPanel;
  }
  listEl = document.getElementById('todo-list');
  statusEl = document.getElementById('todo-status');
  hintEl = document.getElementById('todo-cwd-hint');
  const newOpenBtn = document.getElementById('todo-new-open-btn');
  const modalEl = document.getElementById('todo-new-modal');
  const modalBackdropEl = modalEl?.querySelector('.chat-settings-backdrop') || null;
  const cancelBtn = document.getElementById('todo-new-cancel-btn');
  const addBtn = document.getElementById('todo-add-btn');
  const titleInp = document.getElementById('todo-new-title');
  const bodyInp = document.getElementById('todo-new-body');
  const refreshBtn = document.getElementById('todo-refresh-btn');

  const closeNewTodoModal = () => {
    if (!modalEl) return;
    modalEl.hidden = true;
    newOpenBtn?.setAttribute('aria-expanded', 'false');
    pendingParentId = '';
  };

  openNewTodoModal = () => {
    if (!modalEl) return;
    modalEl.hidden = false;
    newOpenBtn?.setAttribute('aria-expanded', 'true');
    if (titleInp && 'value' in titleInp) titleInp.value = '';
    if (bodyInp && 'value' in bodyInp) bodyInp.value = '';
    titleInp?.focus?.();
  };

  refreshBtn?.addEventListener('click', () => {
    refreshTodoList();
  });
  newOpenBtn?.addEventListener('click', () => {
    pendingParentId = '';
    openNewTodoModal();
  });
  modalBackdropEl?.addEventListener('click', closeNewTodoModal);
  cancelBtn?.addEventListener('click', closeNewTodoModal);
  modalEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeNewTodoModal();
  });
  titleInp?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addBtn?.click();
  });
  addBtn?.addEventListener('click', async () => {
    const titleRaw = titleInp && 'value' in titleInp ? titleInp.value : '';
    const title = String(titleRaw || '').trim();
    if (!title) {
      setStatus(t('todo.provideTitle'), true);
      return;
    }
    const bodyRaw = bodyInp && 'value' in bodyInp ? bodyInp.value : '';
    const body = String(bodyRaw || '').trim();
    const parentId = pendingParentId;
    if (parentId && !canAddTodoChild(latestItems, parentId)) {
      setStatus(t('todo.depthLimit'), true);
      return;
    }
    try {
      const data = await api.postTodo(parentId ? { title, body, parentId } : { title, body });
      if (!data?.ok) {
        setStatus(data?.error || t('todo.error'), true);
        return;
      }
      if (titleInp && 'value' in titleInp) titleInp.value = '';
      if (bodyInp && 'value' in bodyInp) bodyInp.value = '';
      setStatus(t('todo.added'));
      renderList(data);
      closeNewTodoModal();
    } catch {
      setStatus(t('todo.networkError'), true);
    }
  });
  window.addEventListener('cr-lang-changed', () => {
    if (latestItems.length || listEl?.querySelector('.todo-empty')) renderList({ items: latestItems });
    if (editorTodoId) fillEditorLabels();
  });
}
