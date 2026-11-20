/**
 * Event wiring of the new-chat, delete/archive confirm and context-details modals.
 */
import { syncNewChatWorktreeRow } from './newChatWorktreeRow.js';
import * as api from '../../../core/api/index.js';
import { applyEnabledHarnesses, applyHarnessOrder, getEnabledHarnessIds } from '../../settings/models/harnessSettings.js';
import { listHarnessUiMeta } from '../../../core/harness/harnessUiRegistry.js';
import { initModal } from '../../../lib/modal.js';
import { writeLocalStorageSafe } from '../chatLocalStorage.js';
import { chatPresetsStore } from '../chatPresets.js';
import { decodeNewChatLocation, toggleNewChatLocationFavorite } from '../newChatLocationOptions.js';
import { decodeNewChatModelChoice } from '../newChatModelOptions.js';
import { createChatFromModal } from '../services/chatCreateFromModal.js';
import {
  closeChatDeleteConfirmModal,
  confirmDeleteChat,
  settleArchiveConfirm,
} from '../services/chatDeleteArchive.js';
import {
  applyEnabledModelsForHarness,
  getWorkspaceContextForChat,
} from '../services/chatWorkspaceContext.js';
import {
  getSelectedNewChatHarness,
  loadNewChatModelCatalogs,
  localChatHarnessIds,
  newChatHarnessStatusTracker,
  refreshNewChatUsageLimits,
  syncNewChatAgentModelPicker,
  syncNewChatHarnessUi,
} from '../services/newChatHarnessState.js';
import { refreshNewChatHarnessStatus } from '../services/newChatHarnessStatus.js';
import { LAST_NEW_CHAT_EXECUTOR_KEY, LAST_NEW_CHAT_LOCATION_KEY } from '../services/newChatLastSelection.js';
import {
  loadNewChatLocationGroups,
  resolveDefaultNewChatLocation,
  syncNewChatLocationPicker,
} from '../services/newChatLocation.js';
import { chatRuntime } from '../state/chatRuntimeState.js';
import { chatShell } from '../state/chatShellState.js';
import { newChatModalState } from '../state/newChatModalState.js';
import { bindChatContextTabs, closeChatContextDetailsModal } from './chatContextDetails.js';
import {
  closeNewChatModal,
  handleNewChatModalCaptureKeydown,
  isNewChatDropdownOpen,
} from './newChatModal.js';

/** Wire modal elements and listeners. */
export function bindChatPanelModals() {
  newChatModalState.chatNewModalApi = initModal(document.getElementById('chat-new-modal'), {
    backdropSelector: '.chat-settings-backdrop',
  });
  chatShell.chatDeleteConfirmModalApi = initModal(document.getElementById('chat-delete-confirm-modal'), {
    backdropSelector: '.chat-settings-backdrop',
  });
  chatShell.chatArchiveConfirmModalApi = initModal(document.getElementById('chat-archive-confirm-modal'), {
    backdropSelector: '.chat-settings-backdrop',
  });
  bindChatContextTabs();
  chatRuntime.chatContextDetailsModalApi = initModal(document.getElementById('chat-context-details-modal'), {
    backdropSelector: '.chat-settings-backdrop',
  });
  const chatDeleteBackdrop = document.querySelector('#chat-delete-confirm-modal .chat-settings-backdrop');
  if (chatDeleteBackdrop) {
    chatDeleteBackdrop.addEventListener('click', () => {
      chatShell.pendingDeleteChatId = null;
    });
  }
  // `settleArchiveConfirm(false)` hides the modal too; initModal's backdrop
  // handler closes it first, so the order here only needs to resolve the promise.
  const chatArchiveBackdrop = document.querySelector('#chat-archive-confirm-modal .chat-settings-backdrop');
  if (chatArchiveBackdrop) {
    chatArchiveBackdrop.addEventListener('click', () => settleArchiveConfirm(false));
  }
  if (!chatShell.newChatKeydownCaptureBound) {
    chatShell.newChatKeydownCaptureBound = true;
    document.addEventListener('keydown', handleNewChatModalCaptureKeydown, { capture: true });
  }
  const newChatForm = document.getElementById('chat-new-form');
  if (newChatForm) {
    newChatForm.addEventListener('submit', (e) => {
      // Enter inside the form submits; the button stays the single create path.
      e.preventDefault();
      if (isNewChatDropdownOpen()) return;
      const createBtn = document.getElementById('chat-new-create');
      if (createBtn?.disabled) return;
      createChatFromModal();
    });
  }
  // The shared modal helper only hides on backdrop click; clear state and restore
  // focus there too, without changing how the other dialogs behave.
  const newChatBackdrop = document.querySelector('#chat-new-modal .chat-settings-backdrop');
  if (newChatBackdrop) newChatBackdrop.addEventListener('click', () => closeNewChatModal());
  const newCancelBtn = document.getElementById('chat-new-cancel');
  const newHarnessSel = document.getElementById('chat-new-harness-select');
  if (newCancelBtn) newCancelBtn.addEventListener('click', (e) => { e.preventDefault(); closeNewChatModal(); });
  if (newHarnessSel) {
    newHarnessSel.addEventListener('change', () => {
      newChatModalState.newChatHarnessUserTouched = true;
      newChatModalState.chatNewModelDropdownApi?.close?.();
      const selected = getSelectedNewChatHarness();
      if (!localChatHarnessIds.has(selected)) newChatHarnessStatusTracker.selectHarness(selected);
      syncNewChatAgentModelPicker();
      void refreshNewChatHarnessStatus({ forceCloseDropdown: true });
    });
  }
  const newModelSel = document.getElementById('chat-new-model-select');
  if (newModelSel) {
    newModelSel.addEventListener('change', () => {
      newChatModalState.newChatModelUserTouched = true;
      syncNewChatHarnessUi();
      syncNewChatAgentModelPicker();
    });
  }
  const deleteConfirmCancelBtn = document.getElementById('chat-delete-confirm-cancel');
  const deleteConfirmBtn = document.getElementById('chat-delete-confirm-delete');
  const deleteConfirmSkipBtn = document.getElementById('chat-delete-confirm-delete-skip');
  const contextDetailsCloseBtn = document.getElementById('chat-context-details-close');
  if (deleteConfirmCancelBtn) {
    deleteConfirmCancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeChatDeleteConfirmModal();
    });
  }
  if (deleteConfirmBtn) {
    deleteConfirmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      confirmDeleteChat(false);
    });
  }
  if (deleteConfirmSkipBtn) {
    deleteConfirmSkipBtn.addEventListener('click', (e) => {
      e.preventDefault();
      confirmDeleteChat(true);
    });
  }
  const archiveConfirmCancelBtn = document.getElementById('chat-archive-confirm-cancel');
  const archiveConfirmBtn = document.getElementById('chat-archive-confirm-confirm');
  if (archiveConfirmCancelBtn) {
    archiveConfirmCancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      settleArchiveConfirm(false);
    });
  }
  if (archiveConfirmBtn) {
    archiveConfirmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      settleArchiveConfirm(true);
    });
  }
  if (contextDetailsCloseBtn) {
    contextDetailsCloseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeChatContextDetailsModal();
    });
  }

  const combinedModelPicker = document.getElementById('chat-new-agent-model');
  combinedModelPicker?.addEventListener('cr-favorite-toggle', (event) => {
    const choice = decodeNewChatModelChoice(event.detail?.value);
    if (!choice?.model || localChatHarnessIds.has(choice.harness)) return;
    chatPresetsStore.toggleFavorite(choice);
  });
  combinedModelPicker?.addEventListener('cr-open', () => {
    document.getElementById('chat-new-location')?.closeDropdown?.();
    if (!newChatModalState.newChatUsageCheckPending) void refreshNewChatUsageLimits();
    void loadNewChatModelCatalogs();
  });
  combinedModelPicker?.addEventListener('cr-change', (event) => {
    const choice = decodeNewChatModelChoice(event.detail?.value);
    const option = combinedModelPicker.options.find((row) => row.value === event.detail?.value);
    if (!choice || !option || option.disabled || newChatModalState.chatCreateInFlight) return;
    const harnessSelect = document.getElementById('chat-new-harness-select');
    const modelSelect = document.getElementById('chat-new-model-select');
    harnessSelect.value = choice.harness;
    newChatModalState.newChatHarnessUserTouched = true;
    newChatModalState.newChatModelUserTouched = true;
    if (!localChatHarnessIds.has(choice.harness)) newChatHarnessStatusTracker.selectHarness(choice.harness);
    chatRuntime.chatModelSelectApi.setModelPickerHarness(choice.harness);
    chatRuntime.chatModelSelectApi.renderModelSelectOptions(modelSelect, choice.model);
    modelSelect.value = choice.model;
    writeLocalStorageSafe(LAST_NEW_CHAT_EXECUTOR_KEY, JSON.stringify(choice), 'newChatLastExecutor');
    syncNewChatHarnessUi();
    syncNewChatAgentModelPicker();
  });
  const locationPicker = document.getElementById('chat-new-location');
  newChatModalState.chatNewFolderDropdownApi = {
    refresh: syncNewChatLocationPicker,
    close: () => locationPicker?.closeDropdown?.(),
    isOpen: () => locationPicker?.isDropdownOpen?.() === true,
  };
  locationPicker?.addEventListener('cr-open', () => {
    combinedModelPicker?.closeDropdown?.();
    void loadNewChatLocationGroups();
  });
  locationPicker?.addEventListener('cr-favorite-toggle', (event) => {
    toggleNewChatLocationFavorite(event.detail?.value);
    syncNewChatLocationPicker();
  });
  locationPicker?.addEventListener('cr-clear', () => {
    const folderSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById('chat-new-folder-select'));
    const fallback = resolveDefaultNewChatLocation();
    if (!fallback || newChatModalState.chatCreateInFlight || !folderSelect) return;
    newChatModalState.newChatLocationUserTouched = true;
    try { localStorage.removeItem(LAST_NEW_CHAT_LOCATION_KEY); } catch { /* storage unavailable */ }
    newChatModalState.newChatWorktreeTarget = { todoId: '', workspaceFolder: fallback.folder };
    folderSelect.value = fallback.folder;
    chatRuntime.selectedWorkspaceFolder = fallback.folder;
    void syncNewChatWorktreeRow();
  });
  locationPicker?.addEventListener('cr-change', (event) => {
    const choice = decodeNewChatLocation(event.detail?.value);
    const option = locationPicker.options.find((row) => row.value === event.detail?.value);
    const folderSelect = document.getElementById('chat-new-folder-select');
    if (!choice || !option || option.disabled || newChatModalState.chatCreateInFlight || !folderSelect) return;
    newChatModalState.newChatLocationUserTouched = true;
    writeLocalStorageSafe(LAST_NEW_CHAT_LOCATION_KEY, JSON.stringify(choice), 'newChatLastLocation');
    newChatModalState.newChatWorktreeTarget = { todoId: choice.todoId, workspaceFolder: choice.folder };
    folderSelect.value = choice.folder;
    chatRuntime.selectedWorkspaceFolder = choice.folder;
    void syncNewChatWorktreeRow();
  });
  // The worktree list belongs to the chosen folder; a different folder starts
  // from "no worktree" because the active chat's worktree no longer applies.
  document.getElementById('chat-new-folder-select')?.addEventListener('change', (event) => {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (value) chatRuntime.selectedWorkspaceFolder = value;
    void syncNewChatWorktreeRow();
  });
  api.getSettings().then((data) => {
    if (!data?.ok) return;
    applyHarnessOrder(data.harnessOrder);
    applyEnabledHarnesses(data.enabledHarnesses);
    if (chatRuntime.sharedSdkModeBar) chatRuntime.sharedSdkModeBar.enabledHarnesses = getEnabledHarnessIds();
    for (const meta of listHarnessUiMeta()) {
      applyEnabledModelsForHarness(meta.id, data[meta.enabledModelsSettingsKey] || []);
    }
    chatRuntime.serverSettingsWorkspaceFolder = typeof data.workspaceFolder === 'string'
      ? data.workspaceFolder.trim()
      : '';
    const ctx = getWorkspaceContextForChat();
    const folder = ctx?.workspaceFolder || chatRuntime.serverSettingsWorkspaceFolder;
    if (folder && !chatRuntime.selectedWorkspaceFolder) chatRuntime.selectedWorkspaceFolder = folder;
  }).catch(() => {});
}
