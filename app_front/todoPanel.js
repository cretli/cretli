import * as api from './core/api/index.js';
import { openTodoAgentChat } from './chat.js';
import { t } from './i18n/index.js';
import './components/ui/cr-bar-select.js';
import './components/ui/cr-bar-input.js';
import './components/ui/cr-bar-textarea.js';
import './components/ui/cr-bar-button.js';
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

function bindCardHandlers(card) {
  card.addEventListener('todo-status-change', onStatusChange);
  card.addEventListener('todo-title-save', onTitleBlur);
  card.addEventListener('todo-body-save', onBodyBlur);
  card.addEventListener('todo-delete', onDelete);
  card.addEventListener('todo-start-agent', onStartAgent);
  card.addEventListener('todo-open-chat', onOpenChat);
}

function renderList(data) {
  if (!listEl) return;
  const items = data?.items || [];
  if (!items.length) {
    listEl.innerHTML =
      '<div class="todo-empty-state">' +
      '<span class="todo-empty-icon mdi mdi-checkbox-marked-circle-outline" aria-hidden="true"></span>' +
      `<p class="todo-empty">${t('todo.none')}</p>` +
      '</div>';
    return;
  }
  let wrapEl = listEl.querySelector('.todo-items');
  const existingCards = wrapEl
    ? [...wrapEl.querySelectorAll('cr-todo-card')]
    : [];
  const cardsById = new Map(
    existingCards.map((card) => [String(card.item?.id || ''), card])
  );
  if (!wrapEl) {
    listEl.innerHTML = '';
    wrapEl = document.createElement('div');
    wrapEl.className = 'todo-items';
    listEl.appendChild(wrapEl);
  }
  const nextIds = new Set(items.map((it) => String(it.id || '')));
  for (const [id, card] of cardsById) {
    if (nextIds.has(id)) continue;
    card.remove();
    cardsById.delete(id);
  }
  items.forEach((it, index) => {
    const id = String(it.id || '');
    let card = cardsById.get(id);
    if (!card) {
      card = document.createElement('cr-todo-card');
      card.className = 'todo-card';
      bindCardHandlers(card);
      const before = wrapEl.children[index] || null;
      wrapEl.insertBefore(card, before);
    }
    card.item = it;
  });
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

  const item = cardEl?.item || {};
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
    setStatus(t('todo.deleted'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

export function refreshTodoList() {
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

  api.getAgentSdkStatus().then((data) => {
    sdkReady = !!data?.ready;
  });

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
  };

  const openNewTodoModal = () => {
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
  newOpenBtn?.addEventListener('click', openNewTodoModal);
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
    try {
      const data = await api.postTodo({ title, body });
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
}
