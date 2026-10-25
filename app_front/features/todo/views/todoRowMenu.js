import * as api from '../../../core/api/index.js';
import { openTodoAgentChat, openTodoAgentStartModal } from '../../chat/index.js';
import { t } from '../../../i18n/index.js';
import { formatTodoRef } from '../../../../lib/todo-ref.js';
import { initDropdown, closeAllOpenDropdowns } from '../../../lib/dropdown.js';
import { canAddTodoChild } from '../todoTreeView.js';
import {
  canIntegrateWorktree,
  canConfirmIntegrationFromMenu,
  integrationFailureMessage,
} from '../services/todoIntegrationRules.js';
import { refreshWatcherPanel } from '../../watcher/watcherPanel.js';
import {
  canRestoreToTree,
  deferTodoItem,
  onReviewStart,
  openTodoFullPicker,
  openTodoRefinePicker,
  openTodoStartPicker,
  patchTodoLifecycle,
  restoreTodoItem,
  startTodoAgent,
} from '../services/todoAgentStart.js';
import { copyTodoText, disposeRowMenu } from '../services/todoCardActions.js';
import { findItem } from '../services/todoDetail.js';
import { refreshTodoList } from '../services/todoListRefresh.js';
import { getWorkspaceContext, resolveTodoStartHarness, setStatus } from '../services/todoPanelContext.js';
import { S, rowMenus } from '../state/todoPanelState.js';
import { closeEditor, openEditor } from './todoEditor.js';
import { renderList } from './todoListRender.js';
import { confirmAction } from './todoToolbar.js';

/**
 * Creates the row action menu on first open (portal to <body>, like other
 * Cretli dropdowns) and wires the shared dropdown controller for keyboard
 * support. The instance is destroyed again when it closes, so rows never
 * accumulate document-level listeners while idle.
 *
 * @param {HTMLElement} row
 * @returns {{ api: ReturnType<typeof initDropdown>, panel: HTMLElement, destroying: boolean } | null}
 */
export function ensureRowMenu(row) {
  const existing = rowMenus.get(row);
  if (existing) return existing;
  const trigger = row.querySelector('.todo-row-menu');
  if (!(trigger instanceof HTMLButtonElement)) return null;
  const panel = document.createElement('div');
  panel.className = 'chat-list-modal todo-row-menu-panel';
  panel.hidden = true;
  const list = document.createElement('div');
  list.className = 'chat-list-panel todo-row-menu-list';
  list.setAttribute('role', 'menu');
  list.addEventListener('click', (event) => onRowMenuSelect(event, row));
  panel.appendChild(list);
  document.body.appendChild(panel);
  /** @type {{ api: ReturnType<typeof initDropdown>, panel: HTMLElement, destroying: boolean }} */
  const entry = {
    api: initDropdown({
      triggerEl: trigger,
      floatingEl: panel,
      compact: true,
      placement: 'bottom-end',
      minWidthPx: 210,
      maxHeightPx: 280,
      onOpen: () => renderRowMenuItems(row, list),
      // Escape must not strand focus inside the now-hidden panel.
      onClose: (reason) => {
        if (reason === 'escape') trigger.focus();
        // Lazy instance: drop it (and its document listeners) once closed.
        if (!entry.destroying) disposeRowMenu(row);
      },
    }),
    panel,
    destroying: false,
  };
  rowMenus.set(row, entry);
  return entry;
}

/**
 * Rebuilds the menu for the row's current item each time it opens, so labels
 * and disabled state follow the latest data and language.
 *
 * @param {HTMLElement} row
 * @param {HTMLElement} list
 */
export function renderRowMenuItems(row, list) {
  const id = String(row.dataset.id || '');
  const item = findItem(id);
  if (!item) return;
  const chats = Array.isArray(item.chats) ? item.chats.filter((chat) => !chat.deleted) : [];
  const canAdd = canAddTodoChild(S.latestItems, id);
  const itemStatus = String(item.status || 'idea');
  // Ordered by lifecycle: plan -> execute -> integrate -> utilities -> delete.
  // `groupStart` draws a visual separator before the item.
  const actions = [
    // Per-todo orchestrator loop: refine -> approval gate -> implement -> integrate.
    {
      id: 'orchestratorFull',
      icon: 'mdi-robot-happy-outline',
      label: t('todo.orchestratorFull'),
      title: t('todo.orchestratorFullHint'),
      disabled: String(item.status || '') === 'done',
    },
    {
      id: 'refinePlan',
      icon: 'mdi-file-document-edit-outline',
      label: t('todo.refinePlan'),
      disabled: String(item.status || '') === 'done',
    },
    // Plan-review delegation (review_subject=plan), same path as the card's plan review button.
    { id: 'reviewPlanAgent', icon: 'mdi-robot-outline', label: t('todo.reviewPlanAgent') },
    // A leaf starts a direct executor (no child delegations), a parent an orchestrator.
    { id: 'newChat', icon: 'mdi-robot-outline', label: t(S.latestItems.some((row) => String(row?.parentId || '') === id) ? 'todo.continueNewChat' : 'todo.continueNewChatLeaf'), groupStart: true },
    // Code-review delegation (review_subject=code), same path as the card's code review button.
    { id: 'reviewCodeAgent', icon: 'mdi-robot-outline', label: t('todo.reviewCodeAgent') },
    // Only offered when the item's tree really owns an un-integrated worktree;
    // a permanently disabled row on every other task would be noise.
    ...(canIntegrateWorktree(item)
      ? [
        { id: 'integrate', icon: 'mdi-source-merge', label: t('todo.integrationMerge'), groupStart: true },
        { id: 'smartMerge', icon: 'mdi-robot-outline', label: t('todo.smartMerge') },
      ]
      : []),
    ...(canConfirmIntegrationFromMenu(item)
      ? [
        { id: 'verifyIntegration', icon: 'mdi-robot-outline', label: t('todo.verifyIntegration') },
        { id: 'confirmIntegration', icon: 'mdi-check-decagram-outline', label: t('todo.integrationConfirmMenu') },
      ]
      : []),
    {
      id: 'openChat',
      icon: 'mdi-chat-outline',
      label: t('todo.openLastChat'),
      disabled: chats.length === 0 && !(item.chatCount > 0) && !item.chatId && !item.sourceChat?.id,
      groupStart: true,
    },
    ...(itemStatus === 'deferred'
      ? [
        { id: 'restore', icon: 'mdi-restore', label: t('todo.restoreAction'), groupStart: true },
        ...(canRestoreToTree(item)
          ? [{ id: 'restoreToTree', icon: 'mdi-source-branch', label: t('todo.restoreToTreeAction') }]
          : []),
      ]
      : itemStatus === 'done'
        ? []
        : [{ id: 'defer', icon: 'mdi-calendar-clock-outline', label: t('todo.deferAction'), groupStart: true }]),
    { id: 'addChild', icon: 'mdi-plus', label: t('todo.addChild'), disabled: !canAdd },
    { id: 'move', icon: 'mdi-drag-vertical', label: t('todo.moveTask') },
    { id: 'copyId', icon: 'mdi-identifier', label: t('todo.copyId') },
    { id: 'copyRef', icon: 'mdi-link-variant', label: t('todo.copyRef') },
    { id: 'delete', icon: 'mdi-delete-outline', label: t('todo.delete'), danger: true, groupStart: true },
  ];
  list.textContent = '';
  actions.forEach((action) => {
    // Visual group boundary without adding a focusable item the dropdown
    // keyboard walk would trip over.
    if (action.groupStart) {
      const separator = document.createElement('div');
      separator.className = 'todo-row-menu-separator';
      separator.setAttribute('role', 'separator');
      list.appendChild(separator);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'chat-list-item todo-row-menu-item' + (action.danger ? ' todo-row-menu-item--danger' : '');
    button.setAttribute('role', 'menuitem');
    button.dataset.action = action.id;
    button.disabled = action.disabled === true;
    const icon = document.createElement('span');
    icon.className = `mdi ${action.icon}`;
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'chat-list-item-title';
    label.textContent = action.label;
    button.append(icon, label);
    if (action.id === 'copyId') button.title = String(item.id || '');
    if (action.title) button.title = action.title;
    list.appendChild(button);
  });
}

/** @param {MouseEvent} event */
export function onRowMenuClick(event) {
  const row = event.currentTarget instanceof Element ? event.currentTarget.closest('.todo-row') : null;
  if (!(row instanceof HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  const entry = ensureRowMenu(row);
  if (!entry) return;
  // Only one row menu at a time; toggle keeps the common open/close behavior.
  if (!entry.api.isOpen()) closeAllOpenDropdowns();
  entry.api.toggle();
}

/**
 * Opens the row action menu with ArrowDown. The dropdown instance is created
 * lazily on first open, so this single delegated listener on the list covers
 * the very first key press before any per-row controller exists. Once the
 * panel is open, navigation runs through the dropdown's own keydown handling.
 *
 * @param {KeyboardEvent} event
 */
export function onRowMenuTriggerKeydown(event) {
  if (event.key !== 'ArrowDown') return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const trigger = target.closest('.todo-row-menu');
  if (!(trigger instanceof HTMLButtonElement)) return;
  const row = trigger.closest('.todo-row');
  if (!(row instanceof HTMLElement)) return;
  // The live instance handles its own trigger once it exists.
  if (rowMenus.get(row)?.api.isOpen()) return;
  event.preventDefault();
  const entry = ensureRowMenu(row);
  if (!entry) return;
  entry.api.open();
  // Mirror the dropdown's ArrowDown-on-trigger behavior: enter at the top.
  requestAnimationFrame(() => {
    const first = entry.panel.querySelector('[role="menuitem"]:not([disabled])');
    if (first instanceof HTMLElement) first.focus();
  });
}

/**
 * @param {MouseEvent} event
 * @param {HTMLElement} row
 */
export async function onRowMenuSelect(event, row) {
  const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (!(button instanceof HTMLElement)) return;
  const action = String(button.dataset.action || '');
  rowMenus.get(row)?.api.close();
  // Selecting an item hides the panel; move focus back to the row trigger
  // instead of leaving it on a hidden menuitem.
  const trigger = row.querySelector('.todo-row-menu');
  if (trigger instanceof HTMLElement) trigger.focus();
  const id = String(row.dataset.id || '');
  const item = findItem(id);
  if (!item) return;
  if (action === 'move') {
    const wasMoving = row.classList.contains('todo-row--moving');
    S.listEl?.querySelectorAll('.todo-row--moving').forEach((entry) => entry.classList.remove('todo-row--moving'));
    if (!wasMoving) {
      row.classList.add('todo-row--moving');
      row.querySelector('.todo-row-grip')?.focus();
    }
    return;
  }
  await runRowMenuAction(action, item);
}

/**
 * @param {string} action
 * @param {object} item
 */
export async function runRowMenuAction(action, item) {
  const id = String(item.id || '');
  if (!id) return;
  if (action === 'addChild') {
    if (!canAddTodoChild(S.latestItems, id)) {
      setStatus(t('todo.depthLimit'), true);
      return;
    }
    S.pendingParentId = id;
    S.openNewTodoModal();
    return;
  }
  if (action === 'copyId') {
    await copyTodoText(id, t('todo.copiedId'));
    return;
  }
  if (action === 'copyRef') {
    await copyTodoText(formatTodoRef(id), t('todo.copiedRef'));
    return;
  }
  if (action === 'openChat') {
    openLatestTodoChat(item);
    return;
  }
  if (action === 'newChat') {
    openTodoStartPicker(item);
    return;
  }
  if (action === 'defer') {
    await deferTodoItem(item);
    return;
  }
  if (action === 'restore') {
    await restoreTodoItem(item);
    return;
  }
  if (action === 'restoreToTree') {
    await patchTodoLifecycle(() => api.restoreTodoToTree(String(item.id)));
    return;
  }
  if (action === 'orchestratorFull') {
    openTodoFullPicker(item);
    return;
  }
  if (action === 'refinePlan') {
    openTodoRefinePicker(item);
    return;
  }
  if (action === 'reviewPlanAgent') {
    onReviewStart({ detail: { id, subject: 'plan' } });
    return;
  }
  if (action === 'reviewCodeAgent') {
    onReviewStart({ detail: { id, subject: 'code' } });
    return;
  }
  if (action === 'integrate') {
    await mergeTodoWithWorkspace(item);
    return;
  }
  if (action === 'smartMerge') {
    openSmartMergePicker(item, []);
    return;
  }
  if (action === 'confirmIntegration') {
    await confirmTodoIntegrationFromMenu(item);
    return;
  }
  if (action === 'verifyIntegration') {
    openVerifyIntegrationPicker(item);
    return;
  }
  if (action === 'delete') {
    await deleteTodoWithConfirm(id);
  }
}

/**
 * One-click confirmation: the server records the current workspace branch and
 * HEAD as proof, so the operator never types a commit SHA.
 *
 * @param {object} item
 */
export async function confirmTodoIntegrationFromMenu(item) {
  const id = String(item?.id || '').trim();
  const revision = String(item?.updatedAt || '').trim();
  const ctx = getWorkspaceContext();
  if (!id || !revision || !ctx.workspaceFolder) return;
  if (!confirmAction(t('todo.integrationSimpleConfirm', { title: item.title || id }))) return;
  setStatus(t('todo.integrationSaving'));
  try {
    const result = await api.integrateTodo(id, ctx.workspaceFolder, 'confirm', revision, '', { simple: true });
    if (!result?.ok) {
      const message = integrationFailureMessage('confirm', result);
      setStatus(message, true);
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    setStatus(t('todo.integrationConfirmed'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Agent variant of the confirmation: the agent verifies the task change is in the
 * workspace branch and records the integration proof itself.
 *
 * @param {object} item
 */
export function openVerifyIntegrationPicker(item) {
  const id = String(item?.id || '').trim();
  if (!id) return;
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    onStart: ({ harness, model }) => runVerifyIntegration(id, { harness, model }),
  });
}

/**
 * @param {string} todoId
 * @param {{ harness: string, model: string }} options
 */
export async function runVerifyIntegration(todoId, options) {
  const ctx = getWorkspaceContext();
  if (!ctx.workspaceFile || !ctx.workspaceFolder) {
    setStatus(t('todo.selectWorkspace'), true);
    return;
  }
  setStatus(t('todo.verifyIntegrationStarting'));
  try {
    const data = await api.verifyIntegrationTodo(todoId, ctx.workspaceFolder, {
      workspaceFile: ctx.workspaceFile,
      agentTransport: options.harness,
      model: String(options.model || 'auto'),
    });
    if (!data?.ok || !data.chat) {
      setStatus(t('todo.verifyIntegrationFailed'), true);
      return;
    }
    await refreshTodoList();
    openTodoAgentChat(data.chat, { initialPrompt: data.initialPrompt });
    S.showPanelFn('chat');
    setStatus(t('todo.verifyIntegrationStarted'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Explicit human integration from the row menu: apply the worktree result to the
 * logical workspace through the server's guarded three-way merge. The task stays
 * `doing` with `integration.state = ready`, so the card still offers
 * confirm/reject.
 *
 * @param {object} item
 */
export async function mergeTodoWithWorkspace(item) {
  const id = String(item?.id || '').trim();
  const ctx = getWorkspaceContext();
  if (!id || !ctx.workspaceFolder) return;
  const ownerTodoId = String(item?.worktree?.ownerTodoId || id).trim();
  const branch = String(item?.worktree?.branch || '').trim() || t('todo.gitBadgeGeneric');
  if (!confirmAction(t('todo.integrationMergeConfirm', { branch }))) return;
  setStatus(t('todo.integrationMerging'));
  try {
    const result = await api.integrateTodo(id, ctx.workspaceFolder, 'merge', '');
    if (!result?.ok) {
      const conflicts = Array.isArray(result?.conflicts) ? result.conflicts.filter(Boolean) : [];
      const error = String(result?.error || '');
      const message = error === 'no_worktree'
        ? t('todo.integrationNoWorktree')
        : error === 'integration_conflict'
          ? t('todo.integrationMergeConflict', { paths: conflicts.join(', ') || '—' })
          : t('todo.integrationMergeFailed');
      setStatus(message, true);
      // A conflicting worktree is handed to an agent instead of dead-ending.
      if (error === 'integration_conflict' && confirmAction(t('todo.smartMergeOffer', { paths: conflicts.join(', ') || '—' }))) {
        openSmartMergePicker(item, conflicts);
      }
      return;
    }
    await refreshTodoList();
    await refreshWatcherPanel();
    openEditor(ownerTodoId);
    setStatus(result.alreadyApplied ? t('todo.integrationMergedAlready') : t('todo.integrationMerged'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Smart merge: pick an agent (harness + model) that merges the worktree result
 * into the workspace, commits only those task files, and records the integration
 * proof. The chat runs in the logical workspace, not in the worktree. It does
 * not push.
 *
 * @param {object} item
 * @param {string[]} conflicts
 */
export function openSmartMergePicker(item, conflicts) {
  const id = String(item?.id || '').trim();
  if (!id) return;
  openTodoAgentStartModal({
    harness: resolveTodoStartHarness(item),
    onStart: ({ harness, model }) => runSmartMerge(id, { harness, model, conflicts }),
  });
}

/**
 * @param {string} todoId
 * @param {{ harness: string, model: string, conflicts: string[] }} options
 */
export async function runSmartMerge(todoId, options) {
  const ctx = getWorkspaceContext();
  if (!ctx.workspaceFile || !ctx.workspaceFolder) {
    setStatus(t('todo.selectWorkspace'), true);
    return;
  }
  setStatus(t('todo.smartMergeStarting'));
  try {
    const data = await api.smartMergeTodo(todoId, ctx.workspaceFolder, {
      workspaceFile: ctx.workspaceFile,
      agentTransport: options.harness,
      model: String(options.model || 'auto'),
      conflicts: options.conflicts,
    });
    if (!data?.ok || !data.chat) {
      setStatus(data?.error === 'no_worktree' ? t('todo.integrationNoWorktree') : t('todo.smartMergeFailed'), true);
      return;
    }
    await refreshTodoList();
    openTodoAgentChat(data.chat, { initialPrompt: data.initialPrompt });
    S.showPanelFn('chat');
    setStatus(t('todo.smartMergeStarted'));
  } catch {
    setStatus(t('todo.networkError'), true);
  }
}

/**
 * Opens the newest non-deleted chat of a todo, falling back to chatId/sourceChat.
 *
 * @param {object} item
 */
export function openLatestTodoChat(item) {
  const chats = Array.isArray(item?.chats) ? item.chats.filter((chat) => !chat.deleted) : [];
  const latest = chats[0] || item?.latestChat || null;
  const chatId = String(latest?.id || item?.chatId || item?.sourceChat?.id || '').trim();
  if (!chatId) {
    void startTodoAgent(String(item?.id || ''), {});
    return;
  }
  const agentTransport = String(latest?.harness || resolveTodoStartHarness(item)).trim();
  openTodoAgentChat(
    agentTransport ? { id: chatId, agentTransport } : { id: chatId },
    { reused: true }
  );
  S.showPanelFn('chat');
  setStatus(t('todo.openedLinkedChat'));
}

/**
 * Open the watcher's orchestrator chat from the top bar.
 *
 * @param {string} chatId
 */
export function openWatcherChat(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  openTodoAgentChat({ id }, { reused: true });
  S.showPanelFn('chat');
}

/** @param {string} id */
export async function deleteTodoWithConfirm(id) {
  if (!confirmAction(t('todo.confirmDelete'))) return;
  try {
    const data = await api.deleteTodo(id);
    if (!data?.ok) {
      setStatus(data?.error || t('todo.deleteError'), true);
      refreshTodoList();
      return;
    }
    if (S.editorTodoId === String(id)) closeEditor();
    setStatus(t('todo.deleted'));
    renderList(data);
  } catch {
    setStatus(t('todo.networkError'), true);
    refreshTodoList();
  }
}
