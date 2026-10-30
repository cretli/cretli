import * as api from '../../../core/api/index.js';
import { openTodoAgentChat, openTodoAgentStartModal } from '../../chat/index.js';
import { startTodoForVoice } from '../todoVoiceStart.js';
import { t } from '../../../i18n/index.js';
import { navigateSpa } from '../../../app/appShell/spaNavigationBridge.js';
import { chooseDirtyWorktreePolicy, askDeferDetails } from '../views/todoDialogs.js';
import { buildTodoReviewTaskText, resolveTodoReviewParentChatId } from '../todoReviewStart.js';
import { findItem } from './todoDetail.js';
import { refreshTodoList } from './todoListRefresh.js';
import { getWorkspaceContext, resolveTodoStartHarness, setStatus } from './todoPanelContext.js';
import {
  S,
  TODO_START_POLL_INTERVAL_MS,
  TODO_START_POLL_TIMEOUT_MS,
  startAgentInFlight,
} from '../state/todoPanelState.js';
import { renderList } from '../views/todoListRender.js';
import { confirmAction } from '../views/todoToolbar.js';

/** @param {any} e */
export function onOpenChat(e) {
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
  S.showPanelFn('chat');
  setStatus(t('todo.openedLinkedChat'));
}

/** Opens the worktree list scoped to one task via the Git route. */
export function onOpenGit(e) {
  const id = String(e?.detail?.id || '').trim();
  if (!id) return;
  void navigateSpa({
    panel: 'git',
    subview: 'worktrees',
    scope: 'todo',
    resource: { type: 'todo', id },
    query: { todo: id },
  }, { explicit: true });
}

/** @param {Event} e */
export async function onStartAgent(e) {
  const id = e?.detail?.id;
  if (!id) return;
  const forceNew = e?.detail?.forceNew === true;
  if (forceNew) {
    openTodoStartPicker(e.target instanceof Element ? e.target.closest('cr-todo-card')?.item || findItem(String(id)) : findItem(String(id)));
    return;
  }
  const agentTransport = String(e?.detail?.agentTransport || '').trim();
  const cardEl = e.target instanceof Element ? e.target.closest('cr-todo-card') : null;
  const btnEl = cardEl?.querySelector(forceNew ? '.todo-item-newchat' : '.todo-item-agent');
  const setBtnDisabled = (disabled) => {
    if (btnEl instanceof HTMLElement && 'disabled' in btnEl) btnEl.disabled = disabled;
  };
  setBtnDisabled(true);
  try {
    await startTodoAgent(String(id), {
      forceNew,
      agentTransport,
      item: cardEl?.item || null,
    });
  } finally {
    setBtnDisabled(false);
  }
}

/** Open the shared harness and model picker before creating a fresh TODO chat. */
export function openTodoStartPicker(item) {
  if (!item?.id) return;
  const harness = resolveTodoStartHarness(item);
  openTodoAgentStartModal({
    harness,
    onStart: ({ harness: selectedHarness, model }) => startTodoAgent(String(item.id), {
      forceNew: true,
      agentTransport: selectedHarness,
      model,
      item,
    }),
  });
}

/**
 * Pick harness and model for the "do everything" orchestrator chat. The server
 * records it as the root's orchestrator chat; a human still approves the plan.
 * Stop it by cancelling that chat's run (chat WebSocket `{ type: 'cancel' }`,
 * the same path as the chat stop button) and its children through
 * `POST /api/delegations/:id/cancel` with `tree: true`.
 */
export function openTodoFullPicker(item) {
  if (!item?.id || String(item.status || '') === 'done') return;
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    onStart: ({ harness, model }) => startTodoAgent(String(item.id), {
      mode: 'full',
      forceNew: true,
      agentTransport: harness,
      model,
      item,
    }),
  });
}

/**
 * Pick harness and model for a chat that runs the plan review-and-refine loop
 * (`cretli-todo-refine-loop` skill). The chat is linked to the todo but does not
 * become its executor chat and does not change its status.
 */
export function openTodoRefinePicker(item) {
  if (!item?.id || String(item.status || '') === 'done') return;
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    planReviewerCooperationMode: true,
    onStart: ({ harness, model, planReviewerCooperationMode }) => startTodoAgent(String(item.id), {
      mode: 'refine',
      forceNew: true,
      agentTransport: harness,
      model,
      item,
      planReviewerCooperationMode,
    }),
  });
}

/** Review button on the card: the shared picker chooses harness and model of the reviewer chat. */
export function onReviewStart(e) {
  const id = String(e?.detail?.id || '').trim();
  const subject = e?.detail?.subject === 'plan' ? 'plan' : 'code';
  const item = findItem(id);
  if (!item?.id) return;
  if (!resolveTodoReviewParentChatId(item)) {
    setStatus(t('todo.reviewStartNoChat'), true);
    return;
  }
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    onStart: ({ harness, model }) => startTodoReview(item, subject, harness, model),
  });
}

/**
 * Starts a review delegation of one subject for the todo. The reviewer runs in its
 * own new chat; the server attaches its verdict to the todo's review block.
 *
 * @param {object} item
 * @param {'code'|'plan'} subject
 * @param {string} harness
 * @param {string} model
 */
export async function startTodoReview(item, subject, harness, model) {
  const todoId = String(item.id);
  setStatus(t('todo.reviewStarting'));
  try {
    const data = await api.postManualChatDelegation(resolveTodoReviewParentChatId(item), {
      executor: { transport: harness, model },
      idempotencyKey: `todo-review:${todoId}:${subject}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      sourceKind: 'text',
      taskText: buildTodoReviewTaskText(item, subject),
      title: `${String(item.title || '').trim()} (review ${subject})`,
      assignment: 'review',
      reviewSubject: subject,
      leafId: todoId,
    });
    if (!data?.ok) {
      setStatus(data?.error || t('todo.reviewStartFailed'), true);
      return;
    }
    setStatus(t('todo.reviewStarted'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Opens the linked chat or creates one. `forceNew` always creates a fresh chat
 * and keeps the previous one in the todo history.
 *
 * @param {string} id
 * @param {{ forceNew?: boolean, reuseChatId?: string, expectedUpdatedAt?: string, agentTransport?: string, model?: string, item?: object | null }} [options]
 */
export async function startTodoAgent(id, options = {}) {
  const todoId = String(id || '').trim();
  if (!todoId) return;
  // The row menu and the card button can both fire; never create two chats for
  // the same todo while the first request is in flight.
  if (startAgentInFlight.has(todoId)) return;
  startAgentInFlight.add(todoId);
  try {
    await startTodoAgentOnce(todoId, options);
  } finally {
    startAgentInFlight.delete(todoId);
  }
}

/**
 * @param {string} todoId
 * @param {{
 *   forceNew?: boolean,
 *   mode?: 'refine' | 'full',
 *   agentTransport?: string,
 *   model?: string,
 *   item?: object | null,
 *   planReviewerCooperationMode?: string,
 *   reuseChatId?: string,
 *   expectedUpdatedAt?: string,
 * }} [options]
 */
export async function startTodoAgentOnce(todoId, options = {}) {
  const forceNew = options.forceNew === true;
  const reuseChatId = String(options.reuseChatId || '').trim();
  const refine = options.mode === 'refine';
  const item = options.item || findItem(todoId) || {};
  const ctx = getWorkspaceContext();
  if (!ctx.workspaceFile || !ctx.workspaceFolder) {
    setStatus(t('todo.selectWorkspace'), true);
    return;
  }
  const harness = String(options.agentTransport || resolveTodoStartHarness(item)).trim();
  // The server only reuses `todo.chatId`; sourceChat/plan links do not count.
  const willCreate = !reuseChatId && (forceNew || !item.chatId);
  if (willCreate && harness === 'sdk' && !S.sdkReady) {
    setStatus(t('todo.sdkRequiresApiKey'), true);
    return;
  }
  if (forceNew && !refine && String(item.status || '') === 'done' && !confirmAction(t('todo.confirmStartDone'))) {
    return;
  }
  setStatus(t('todo.creatingAgent'));
  /** @type {any} */
  const payload = {
    workspaceFile: ctx.workspaceFile,
    workspaceFolder: ctx.workspaceFolder,
    model: String(options.model || 'auto'),
    agentTransport: harness,
    ...(options.dirtyPolicy ? { dirtyPolicy: options.dirtyPolicy } : {}),
  };
  if (forceNew) payload.forceNew = true;
  if (reuseChatId) {
    payload.reuseChatId = reuseChatId;
    payload.expectedUpdatedAt = String(options.expectedUpdatedAt || /** @type {any} */ (item).updatedAt || '');
  }
  // Continuing in a fresh chat runs the executor, never a plan-mode draft.
  if (forceNew && !refine) payload.sdkMode = 'agent';
  if (refine) payload.mode = 'refine';
  if (options.mode === 'full') payload.mode = 'full';
  if (refine && options.planReviewerCooperationMode) {
    payload.cooperationMode = options.planReviewerCooperationMode;
  }
  try {
    let data = await api.postTodoStartAgent(todoId, payload);
    if (data?.ok && data.state === 'preparing') {
      // Worktree prepare can take minutes; the server answered 202 and the UI
      // polls until the chat exists (D4).
      setStatus(t('todo.worktreePreparing'));
      data = await pollTodoStartAgentStatus(todoId, ctx.workspaceFolder, forceNew, reuseChatId);
    }
    if (!data?.ok || !data.chat) {
      if (data?.code === 'WORKTREE_DIRTY' && Array.isArray(data.details?.dirtyPaths)) {
        const choice = await chooseDirtyWorktreePolicy(data.details.dirtyPaths);
        if (choice) return startTodoAgentOnce(todoId, { ...options, dirtyPolicy: choice });
      }
      if (reuseChatId && String(data?.code || '').startsWith('TODO_REUSE_')) {
        setStatus(`${data.error || t('todo.startAgentFailed')} ${t('todo.reuseTryNew')}`, true);
        return;
      }
      setStatus(data?.error || t('todo.startAgentFailed'), true,
        data?.code === 'WORKTREE_PREPARE_FAILED' ? data.details || {} : null);
      return;
    }
    renderList(data);
    openTodoAgentChat(data.chat, {
      initialPrompt: data.initialPrompt,
      continuationPrompt: data.continuationPrompt,
      reused: !!data.reused,
    });
    S.showPanelFn('chat');
    setStatus(refine ? t('todo.refinePlanStarted') : data.reused ? t('todo.openedLinkedChat') : t('todo.startedAgent'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Voice entry point for starting a todo agent. Uses the same API call, prepare
 * polling and chat opening as `startTodoAgentOnce`, but never opens a dialog:
 * a dirty worktree or a missing SDK key is reported back as a short error.
 * `ok: true` means the chat was opened and its initial prompt was handed over.
 *
 * @param {string} todoId
 * @param {{ agentTransport?: string, workspaceFile: string, workspaceFolder: string }} options
 * @returns {Promise<{ ok: boolean, error?: string, code?: string }>}
 */
export async function startTodoAgentForVoice(todoId, options) {
  return startTodoForVoice(todoId, options, {
    findItem,
    resolveHarness: (item) => resolveTodoStartHarness(item),
    isSdkReady: () => S.sdkReady,
    startAgent: (id, body) => api.postTodoStartAgent(id, body),
    pollStatus: (id, workspaceFolder) => pollTodoStartAgentStatus(id, workspaceFolder, false),
    renderList,
    openChat: openTodoAgentChat,
    showChatPanel: () => S.showPanelFn('chat'),
    messages: {
      sdkRequiresApiKey: t('todo.sdkRequiresApiKey'),
      startFailed: t('todo.startAgentFailed'),
      networkError: t('todo.networkError'),
    },
  });
}

/** @param {{ id?: string }} item */
export async function deferTodoItem(item) {
  const id = String(item?.id || '');
  if (!id) return;
  const hasParent = !!String(/** @type {any} */ (item)?.parentId || '').trim();
  const isLeaf = !S.latestItems.some((row) => row?.parentId === id);
  const details = await askDeferDetails(hasParent && isLeaf);
  if (!details) {
    // Revert an optimistic status change made by the card's select.
    refreshTodoList();
    return;
  }
  await patchTodoLifecycle(() => api.deferTodo(id, details));
}

/**
 * A parked leaf can return when its recorded origin still exists in the list.
 *
 * @param {{ id?: string, sourceTodoId?: string, parentId?: string }} item
 */
export function canRestoreToTree(item) {
  const origin = String(item?.sourceTodoId || '').trim();
  if (!origin || origin === String(item?.parentId || '')) return false;
  return S.latestItems.some((row) => row?.id === origin);
}

/** @param {{ id?: string }} item */
export async function restoreTodoItem(item) {
  const id = String(item?.id || '');
  if (!id) return;
  await patchTodoLifecycle(() => api.restoreDeferredTodo(id));
}

/** @param {() => Promise<any>} request */
export async function patchTodoLifecycle(request) {
  try {
    const data = await request();
    if (!data?.ok) {
      setStatus(data?.error || t('todo.saveError'), true);
      refreshTodoList();
      return;
    }
    setStatus(t('todo.saved'), false);
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}

/**
 * @param {string} todoId
 * @param {string} workspaceFolder
 * @param {boolean} forceNew
 * @returns {Promise<object>}
 */
export async function pollTodoStartAgentStatus(todoId, workspaceFolder, forceNew, reuseChatId = '') {
  const deadline = Date.now() + TODO_START_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TODO_START_POLL_INTERVAL_MS));
    let status;
    try {
      status = await api.getTodoStartAgentStatus(todoId, workspaceFolder, forceNew, reuseChatId);
    } catch {
      continue;
    }
    if (!status || status.state === 'preparing') continue;
    if (status.state === 'idle') return { ok: false, error: t('todo.startAgentFailed') };
    return status;
  }
  return { ok: false, error: t('todo.startAgentFailed') };
}
