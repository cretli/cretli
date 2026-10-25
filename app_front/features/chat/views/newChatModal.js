/** New-chat modal: open/close, focus handling and keyboard capture. */
import { chatWorktreeTodoId } from '../../sidebar/sidebarOnlyActiveFilter.js';
import { ensureHarnessDefaultsLoaded, applyDefaultNewChatHarnessToModal } from '../../settings/models/harnessSettings.js';
import { initModal } from '../../../lib/modal.js';
import {
  readLastDelegationExecutor,
  prepareMessageDelegationModal,
  prepareBuildPlanModal,
  clearDelegationPlanPreview,
} from '../chatDelegations.js';
import { t } from '../../../i18n/index.js';
import { readNewChatLocationFavorites } from '../newChatLocationOptions.js';
import { readLastNewChatExecutor, readLastNewChatLocation } from '../services/newChatLastSelection.js';
import {
  getSelectedNewChatHarness,
  localChatHarnessIds,
  newChatHarnessStatusTracker,
  newChatModelCatalogChecked,
  normalizeNewChatHarness,
  refreshLocalChatHarnessOptions,
  refreshNewChatUsageLimits,
  selectNewChatHarness,
  syncNewChatAgentModelPicker,
  syncNewChatHarnessUi,
} from '../services/newChatHarnessState.js';
import {
  applyLateDefaultNewChatHarness,
  applyNewChatModalForkLabels,
  getNewChatModalSourceChat,
  refreshNewChatHarnessStatus,
} from '../services/newChatHarnessStatus.js';
import {
  findActiveWorktreeChat,
  newChatLocationRequests,
  newChatLocationWorktrees,
  normalizeFolderForCompare,
} from '../services/newChatLocation.js';
import { newChatModalState } from '../state/newChatModalState.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { chatHost } from '../services/chatHost.js';

export function openNewChatModal(options = {}) {
  ++newChatModalState.newChatLocationGeneration;
  const locationGeneration = newChatModalState.newChatLocationGeneration;
  newChatLocationWorktrees.clear();
  newChatLocationRequests.clear();
  newChatModalState.newChatLocationUserTouched = false;
  const locationPicker = document.getElementById('chat-new-location');
  if (locationPicker) locationPicker.favoritesOnly = readNewChatLocationFavorites().size > 0;
  const combinedPicker = document.getElementById('chat-new-agent-model');
  if (combinedPicker) combinedPicker.favoritesOnly = chatHost.chatPresets.getPresets().length > 0
  if (combinedPicker) combinedPicker.availableOnly = true;
  newChatModelCatalogChecked.clear();
  newChatModalState.newChatHarnessUserTouched = false;
  newChatModalState.newChatModelUserTouched = false;
  newChatModalState.newChatHarnessExplicitChoice = false;
  // Refresh settings defaults in the background; never let the late result override a
  // harness the user picked (or that was resolved from a source chat) after opening.
  void ensureHarnessDefaultsLoaded().then(() => {
    applyLateDefaultNewChatHarness();
  });
  if (!newChatModalState.chatNewModalApi) return;
  const requestedForkId =
    options && typeof options.forkFromChatId === 'string' ? options.forkFromChatId.trim() : '';
  const requestedMonitorId =
    options && typeof options.monitorFromChatId === 'string'
      ? options.monitorFromChatId.trim()
      : '';
  const requestedBuildPlanId =
    options && typeof options.buildPlanFromChatId === 'string'
      ? options.buildPlanFromChatId.trim()
      : '';
  const requestedPassMessageId =
    options && typeof options.passMessageFromChatId === 'string'
      ? options.passMessageFromChatId.trim()
      : '';
  const forkChat = requestedForkId ? chats.find((entry) => entry.id === requestedForkId) : null;
  const monitorChat = requestedMonitorId
    ? chats.find((entry) => entry.id === requestedMonitorId)
    : null;
  const buildPlanChat = requestedBuildPlanId
    ? chats.find((entry) => entry.id === requestedBuildPlanId)
    : null;
  const passMessageChat = requestedPassMessageId
    ? chats.find((entry) => entry.id === requestedPassMessageId)
    : null;
  if (
    (requestedForkId && !forkChat) ||
    (requestedMonitorId && !monitorChat) ||
    (requestedBuildPlanId && !buildPlanChat) ||
    (requestedPassMessageId && !passMessageChat)
  ) {
    newChatModalState.forkSourceChatId = null;
    newChatModalState.forkUpToCreatedAt = null;
    newChatModalState.monitorSourceChatId = null;
    newChatModalState.buildPlanSourceChatId = null;
    newChatModalState.passMessageSourceChatId = null;
    alert(t('chat.noActiveChat'));
    return;
  }
  const requestedCut =
    options && typeof options.upToCreatedAt === 'string' ? options.upToCreatedAt.trim() : '';
  if (monitorChat) {
    newChatModalState.monitorSourceChatId = monitorChat.id;
    newChatModalState.forkSourceChatId = null;
    newChatModalState.forkUpToCreatedAt = null;
    newChatModalState.buildPlanSourceChatId = null;
    newChatModalState.passMessageSourceChatId = null;
  } else if (passMessageChat) {
    newChatModalState.passMessageSourceChatId = passMessageChat.id;
    newChatModalState.passMessageMeta = {
      historySeq: Number(options.historySeq) > 0 ? Number(options.historySeq) : 0,
      createdAt: typeof options.createdAt === 'string' ? options.createdAt.trim() : '',
      text: typeof options.text === 'string' ? options.text : '',
    };
    newChatModalState.forkSourceChatId = null;
    newChatModalState.forkUpToCreatedAt = null;
    newChatModalState.monitorSourceChatId = null;
    newChatModalState.buildPlanSourceChatId = null;
  } else if (buildPlanChat) {
    newChatModalState.buildPlanSourceChatId = buildPlanChat.id;
    newChatModalState.forkSourceChatId = null;
    newChatModalState.forkUpToCreatedAt = null;
    newChatModalState.monitorSourceChatId = null;
    newChatModalState.passMessageSourceChatId = null;
  } else {
    newChatModalState.forkSourceChatId = forkChat?.id || null;
    newChatModalState.forkUpToCreatedAt = forkChat && requestedCut ? requestedCut : null;
    newChatModalState.monitorSourceChatId = null;
    newChatModalState.buildPlanSourceChatId = null;
    newChatModalState.passMessageSourceChatId = null;
  }
  const sourceChat = monitorChat || passMessageChat || buildPlanChat || forkChat;
  applyDefaultNewChatHarnessToModal();
  const harnessSel = document.getElementById('chat-new-harness-select');
  const lastExecutor = (buildPlanChat || passMessageChat)
    ? readLastDelegationExecutor()
    : sourceChat || (typeof options?.harness === 'string' && options.harness.trim())
      ? { harness: '', model: '' }
      : readLastNewChatExecutor();
  if (harnessSel instanceof HTMLSelectElement && typeof options?.harness === 'string' && options.harness.trim()) {
    selectNewChatHarness(harnessSel, normalizeNewChatHarness(options.harness));
  } else if (harnessSel instanceof HTMLSelectElement && sourceChat) {
    selectNewChatHarness(harnessSel, normalizeNewChatHarness(sourceChat.agentTransport || 'sdk'));
  } else if (harnessSel instanceof HTMLSelectElement && lastExecutor.harness) {
    selectNewChatHarness(harnessSel, normalizeNewChatHarness(lastExecutor.harness));
  }
  // Remember that the modal resolved a harness explicitly so a late settings default cannot replace it.
  newChatModalState.newChatHarnessExplicitChoice = !!(
    sourceChat ||
    lastExecutor.harness ||
    (typeof options?.harness === 'string' && options.harness.trim())
  );
  const requestedRawHarness = (
    (typeof options?.harness === 'string' && options.harness.trim())
    || (sourceChat && typeof sourceChat.agentTransport === 'string' ? sourceChat.agentTransport.trim() : '')
  ).toLowerCase();
  void refreshLocalChatHarnessOptions().then(() => {
    // A local id can only be preserved once the enabled-local allowlist loaded.
    // If the modal was opened directly on a local source chat, correct the select
    // after the async refresh instead of letting it collapse to sdk.
    if (newChatModalState.newChatHarnessUserTouched || !requestedRawHarness || !localChatHarnessIds.has(requestedRawHarness)) return;
    const select = document.getElementById('chat-new-harness-select');
    if (select instanceof HTMLSelectElement && select.value !== requestedRawHarness) {
      select.value = requestedRawHarness;
      syncNewChatHarnessUi(requestedRawHarness);
    }
  });
  const preferredWorkspaceFile =
    options && typeof options.workspaceFile === 'string' ? options.workspaceFile.trim() : '';
  const preferredWorkspaceFolder =
    options && typeof options.workspaceFolder === 'string' ? options.workspaceFolder.trim() : '';
  const ctx = chatHost.getWorkspaceContextForChat();
  // Fall back to the last location the user picked when nothing else points anywhere.
  const lastLocation = !sourceChat && !preferredWorkspaceFolder ? readLastNewChatLocation() : null;
  // The active chat's worktree is the default target; it only applies when no
  // explicit workspace points elsewhere.
  const worktreeChat = sourceChat ? null : findActiveWorktreeChat();
  const worktreeMatches = Boolean(worktreeChat) && (
    !preferredWorkspaceFolder ||
    normalizeFolderForCompare(preferredWorkspaceFolder) ===
      normalizeFolderForCompare(worktreeChat.workspaceFolder)
  );
  newChatModalState.newChatWorktreeTarget = lastLocation
    ? { todoId: lastLocation.todoId, workspaceFolder: lastLocation.folder }
    : worktreeMatches
    ? {
      todoId: chatWorktreeTodoId(worktreeChat),
      workspaceFile: String(worktreeChat.workspaceFile || ''),
      workspaceFolder: String(worktreeChat.workspaceFolder || ''),
    }
    : null;
  chatRuntime.selectedWorkspaceFile =
    preferredWorkspaceFile ||
    sourceChat?.workspaceFile ||
    (worktreeMatches ? worktreeChat.workspaceFile : '') ||
    ctx?.workspaceFile ||
    (chatRuntime.workspaces[0] && chatRuntime.workspaces[0].workspaceFile) ||
    null;
  chatRuntime.selectedWorkspaceFolder =
    preferredWorkspaceFolder ||
    sourceChat?.workspaceFolder ||
    lastLocation?.folder ||
    (worktreeMatches ? worktreeChat.workspaceFolder : '') ||
    ctx?.workspaceFolder ||
    null;
  void chatHost.syncNewChatWorktreeRow();
  chatHost.chatController.renderWorkspacesSelects();
  chatHost.ensureEmbedNewChatFolderSelect();
  const model = document.getElementById('chat-new-model-select');
  if (model) {
    model.value = lastExecutor.model || sourceChat?.model || chatRuntime.selectedModel || 'auto';
  }
  chatRuntime.chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
  if (model) {
    newChatModalState.chatNewModelDropdownApi?.refresh?.();
  }
  syncNewChatAgentModelPicker();
  newChatModalState.chatNewFolderDropdownApi?.refresh?.();
  const titleInput = document.getElementById('chat-new-title-input');
  if (titleInput) {
    titleInput.value = monitorChat
      ? t('chat.monitorDefaultTitle', { title: monitorChat.title || 'Chat' })
      : passMessageChat
        ? t('chat.passMessageDefaultTitle', { title: passMessageChat.title || 'Chat' })
        : buildPlanChat
        ? t('chat.buildPlanDefaultTitle', { title: buildPlanChat.title || 'Chat' })
        : '';
    titleInput.placeholder = t('chat.optionalNamePlaceholder');
  }
  const harness = getSelectedNewChatHarness();
  if (!localChatHarnessIds.has(harness)) newChatHarnessStatusTracker.selectHarness(harness);
  // Mirror readiness immediately; background checks keep the selected status current.
  syncNewChatHarnessUi(harness);
  applyNewChatModalForkLabels();
  const activeBeforeOpen = document.activeElement;
  newChatModalState.newChatModalReturnFocus = activeBeforeOpen instanceof HTMLElement ? activeBeforeOpen : null;
  newChatModalState.chatNewModalApi.open();
  void refreshNewChatUsageLimits();
  // The name is optional. Focus the first required choice so opening the dialog
  // does not emphasize an empty field the user may never need to fill in.
  const modelPickerForFocus = document.getElementById('chat-new-agent-model');
  void modelPickerForFocus?.updateComplete?.then(() => modelPickerForFocus.shadowRoot?.querySelector('button')?.focus());
  void chatHost.loadWorkspaces().then(() => {
    if (locationGeneration !== newChatModalState.newChatLocationGeneration) return;
    chatRuntime.selectedWorkspaceFile =
      preferredWorkspaceFile ||
      chatRuntime.selectedWorkspaceFile ||
      chatHost.getWorkspaceContextForChat()?.workspaceFile ||
      chatRuntime.selectedWorkspaceFile;
    chatRuntime.selectedWorkspaceFolder =
      (!newChatModalState.newChatLocationUserTouched ? preferredWorkspaceFolder : '') ||
      chatRuntime.selectedWorkspaceFolder ||
      chatHost.getWorkspaceContextForChat()?.workspaceFolder ||
      chatRuntime.selectedWorkspaceFolder;
    chatHost.chatController.renderWorkspacesSelects();
    chatHost.ensureEmbedNewChatFolderSelect();
    void chatHost.syncNewChatWorktreeRow({ keepSelection: true });
    if (!newChatModalState.newChatModelUserTouched) {
      const m = document.getElementById('chat-new-model-select');
      const source = getNewChatModalSourceChat();
      // Keep the delegation executor model; a late workspace load must not reset it to the
      // generic last-used model.
      if (m) m.value = lastExecutor.model || source?.model || chatRuntime.selectedModel || 'auto';
    }
    chatRuntime.chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
    newChatModalState.chatNewModelDropdownApi?.refresh?.();
    syncNewChatAgentModelPicker();
  });
  void refreshNewChatHarnessStatus();
  if (passMessageChat) {
    void prepareMessageDelegationModal(passMessageChat, newChatModalState.passMessageMeta).then(() => {
      const modelSel = document.getElementById('chat-new-model-select');
      chatRuntime.chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
      if (modelSel instanceof HTMLSelectElement && lastExecutor.model && !newChatModalState.newChatModelUserTouched) {
        modelSel.value = lastExecutor.model;
      }
      newChatModalState.chatNewModelDropdownApi?.refresh?.();
      syncNewChatAgentModelPicker();
      void refreshNewChatHarnessStatus();
      document.getElementById('chat-new-plan-preview-child-agent')?.addEventListener('change', applyNewChatModalForkLabels);
      applyNewChatModalForkLabels();
    });
  } else if (buildPlanChat) {
    void prepareBuildPlanModal(buildPlanChat).then(() => {
      const modelSel = document.getElementById('chat-new-model-select');
      chatRuntime.chatModelSelectApi.refreshNewChatModelPicker(getSelectedNewChatHarness());
      if (modelSel instanceof HTMLSelectElement && lastExecutor.model && !newChatModalState.newChatModelUserTouched) {
        modelSel.value = lastExecutor.model;
      }
      newChatModalState.chatNewModelDropdownApi?.refresh?.();
      syncNewChatAgentModelPicker();
      void refreshNewChatHarnessStatus();
      document.getElementById('chat-new-plan-preview-child-agent')?.addEventListener('change', applyNewChatModalForkLabels);
      applyNewChatModalForkLabels();
    });
  } else {
    clearDelegationPlanPreview();
  }
}

/**
 * @param {boolean} visible
 */
function setTodoPlanReviewerModeRowVisible(visible) {
  const row = document.getElementById('chat-new-plan-reviewer-row');
  if (row instanceof HTMLElement) row.hidden = !visible;
}

/**
 * @returns {'independent' | 'exchange' | 'collaborative'}
 */
export function readTodoPlanReviewerCooperationModeFromModal() {
  const select = document.getElementById('chat-new-plan-reviewer-mode');
  const raw = select instanceof HTMLSelectElement ? String(select.value || '').trim().toLowerCase() : '';
  if (raw === 'exchange' || raw === 'collaborative') return raw;
  return 'independent';
}

/** Open the shared harness/model picker for starting a TODO agent. */
export function openTodoAgentStartModal({ harness = '', onStart, planReviewerCooperationMode = false } = {}) {
  if (typeof onStart !== 'function') return;
  if (!newChatModalState.chatNewModalApi) {
    const modal = document.getElementById('chat-new-modal');
    if (!(modal instanceof HTMLElement)) return;
    newChatModalState.chatNewModalApi = initModal(modal, { backdropSelector: '.chat-settings-backdrop' });
  }
  newChatModalState.todoAgentModalPlanReviewerMode = planReviewerCooperationMode === true;
  setTodoPlanReviewerModeRowVisible(newChatModalState.todoAgentModalPlanReviewerMode);
  newChatModalState.todoAgentModalSubmit = onStart;
  openNewChatModal({ harness });
}

export function closeNewChatModal() {
  ++newChatModalState.newChatLocationGeneration;
  ++newChatModalState.newChatWorktreeLoadSeq;
  document.getElementById('chat-new-location')?.closeDropdown?.();
  ++newChatModalState.newChatModelCatalogLoadSequence;
  document.getElementById('chat-new-agent-model')?.closeDropdown?.();
  ++newChatModalState.newChatUsageCheckSequence;
  newChatModalState.newChatUsageCheckPending = false;
  clearTimeout(newChatModalState.newChatLimitExpiryTimer);
  newChatModalState.todoAgentModalSubmit = null;
  newChatModalState.todoAgentModalPlanReviewerMode = false;
  setTodoPlanReviewerModeRowVisible(false);
  newChatModalState.chatNewFolderDropdownApi?.close?.();
  newChatModalState.chatNewModelDropdownApi?.close?.();
  newChatModalState.forkSourceChatId = null;
  newChatModalState.forkUpToCreatedAt = null;
  newChatModalState.monitorSourceChatId = null;
  newChatModalState.buildPlanSourceChatId = null;
  newChatModalState.passMessageSourceChatId = null;
  newChatModalState.passMessageMeta = { historySeq: 0, createdAt: '', text: '' };
  clearDelegationPlanPreview();
  applyNewChatModalForkLabels();
  newChatModalState.chatNewModalApi?.close();
  restoreNewChatModalFocus();
}

/**
 * Restore focus to the control that opened the new-chat modal.
 */
function restoreNewChatModalFocus() {
  const target = newChatModalState.newChatModalReturnFocus;
  newChatModalState.newChatModalReturnFocus = null;
  if (!(target instanceof HTMLElement)) return;
  if (!target.isConnected) return;
  target.focus();
}

/**
 * @returns {boolean}
 */
export function isNewChatModalOpen() {
  const modal = document.getElementById('chat-new-modal');
  return !!modal && !modal.hidden;
}

/**
 * Whether one of the new-chat portaled dropdowns is currently open.
 * @returns {boolean}
 */
export function isNewChatDropdownOpen() {
  return (
    document.getElementById('chat-new-agent-model')?.isDropdownOpen?.() === true ||
    newChatModalState.chatNewModelDropdownApi?.isOpen?.() === true ||
    newChatModalState.chatNewFolderDropdownApi?.isOpen?.() === true
  );
}

/**
 * Close the open new-chat dropdown (at most one is open at a time) and return the
 * trigger that should regain focus.
 * @returns {HTMLElement|null}
 */
function closeOpenNewChatDropdown() {
  for (const host of document.querySelectorAll('#chat-new-modal cr-searchable-select')) {
    if (host.isDropdownOpen?.() !== true) continue;
    const trigger = host.shadowRoot?.querySelector('.trigger') || null;
    host.closeDropdown?.();
    return trigger instanceof HTMLElement ? trigger : null;
  }
  return null;
}

/**
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isNewChatFocusableVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.hidden) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return el.getClientRects().length > 0 || el === document.activeElement;
}

/**
 * Ordered focus targets of the new-chat dialog plus its open portaled dropdowns.
 * The cr-searchable-select triggers live in shadow DOM and are represented by their host.
 * @returns {Array<{ id: HTMLElement, focus: () => void }>}
 */
function collectNewChatFocusTargets() {
  const modal = document.getElementById('chat-new-modal');
  if (!modal || modal.hidden) return [];
  const targets = [];
  const nativeSelector =
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const pushNative = (el, { allowRovingOption = false } = {}) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.getAttribute('aria-disabled') === 'true') return;
    if (el.classList.contains('chat-settings-select-hidden')) return;
    // Searchable-select options use roving tabindex: -1 options can still receive
    // programmatic focus from arrow-key navigation and must remain in the trap.
    if (el.getAttribute('tabindex') === '-1' && !(allowRovingOption && el.getAttribute('role') === 'option')) return;
    if (!isNewChatFocusableVisible(el)) return;
    targets.push({ id: el, focus: () => el.focus() });
  };
  const pushPanel = (panel) => {
    if (!(panel instanceof HTMLElement)) return;
    for (const el of panel.querySelectorAll(`${nativeSelector}, [role="option"]`)) {
      pushNative(el, { allowRovingOption: true });
    }
  };
  for (const el of modal.querySelectorAll('*')) {
    if (el.tagName === 'CR-ICON-BUTTON') {
      const control = el.shadowRoot?.querySelector('button');
      if (control && !control.disabled && isNewChatFocusableVisible(control)) {
        targets.push({ id: el, focus: () => control.focus() });
      }
      continue;
    }
    if (el.tagName === 'CR-SEARCHABLE-SELECT') {
      const trigger = el.shadowRoot?.querySelector('.trigger');
      if (trigger instanceof HTMLElement && !trigger.disabled && isNewChatFocusableVisible(trigger)) {
        targets.push({ id: el, focus: () => trigger.focus() });
      }
      if (el.isDropdownOpen?.() === true && el._panelEl instanceof HTMLElement) {
        pushPanel(el._panelEl);
      }
      continue;
    }
    if (el.matches(nativeSelector)) pushNative(el);

  }
  return targets;
}

/**
 * Capture-phase keyboard handling for the new-chat dialog.
 *
 * Escape first closes an open portaled dropdown (without also closing the modal);
 * Tab/Shift+Tab cycle focus inside the dialog plus any open dropdown, so focus can
 * never escape the modal. Registered on document capture because the portaled panels
 * live outside the dialog.
 *
 * @param {KeyboardEvent} event
 */
export function handleNewChatModalCaptureKeydown(event) {
  if (!isNewChatModalOpen()) return;
  if (event.key === 'Escape') {
    const trigger = closeOpenNewChatDropdown();
    if (trigger) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (trigger.isConnected) trigger.focus();
    }
    return;
  }
  if (event.key !== 'Tab') return;
  const targets = collectNewChatFocusTargets();
  if (targets.length === 0) return;
  const active = document.activeElement;
  const index = targets.findIndex((t) => t.id === active);
  event.preventDefault();
  event.stopImmediatePropagation();
  if (index === -1) {
    const fallback = event.shiftKey ? targets[targets.length - 1] : targets[0];
    fallback.focus();
    return;
  }
  const offset = event.shiftKey ? -1 : 1;
  targets[(index + offset + targets.length) % targets.length].focus();
}
