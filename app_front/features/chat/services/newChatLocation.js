/** New-chat modal: worktree / location picker data. */
import { chatWorktreeTodoId } from '../../sidebar/sidebarOnlyActiveFilter.js';
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import {
  buildNewChatLocationOptions,
  readNewChatLocationFavorites,
  encodeNewChatLocation,
} from '../newChatLocationOptions.js';
import { newChatModalState } from '../state/newChatModalState.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { chatHost } from './chatHost.js';

export const newChatLocationWorktrees = new Map();

export const newChatLocationRequests = new Map();

/** Share worktree reads between the selected folder and the grouped location dropdown. */
export async function fetchNewChatLocationWorktrees(folder) {
  if (newChatLocationWorktrees.has(folder)) return { ok: true, worktrees: newChatLocationWorktrees.get(folder) };
  if (newChatLocationRequests.has(folder)) return newChatLocationRequests.get(folder);
  const generation = newChatModalState.newChatLocationGeneration;
  const request = api.getWorktrees(folder).then((data) => {
    if (generation === newChatModalState.newChatLocationGeneration && data?.ok) {
      newChatLocationWorktrees.set(folder, Array.isArray(data.worktrees) ? data.worktrees : []);
      syncNewChatLocationPicker();
    }
    return data;
  }).catch(() => null).finally(() => {
    if (newChatLocationRequests.get(folder) === request) newChatLocationRequests.delete(folder);
  });
  newChatLocationRequests.set(folder, request);
  return request;
}

/** Default new-chat location: the current workspace folder with no worktree. */
export function resolveDefaultNewChatLocation() {
  const folder = chatHost.getWorkspaceContextForChat()?.workspaceFolder || '';
  return folder ? { folder, todoId: '' } : null;
}

/** Synchronize the combined location control without changing native backing fields. */
export function syncNewChatLocationPicker() {
  const picker = /** @type {import('./components/ui/cr-searchable-select.js').CrSearchableSelect | null} */ (
    document.getElementById('chat-new-location')
  );
  const folderSelect = document.getElementById('chat-new-folder-select');
  const worktreeSelect = document.getElementById('chat-new-worktree-select');
  if (!picker || !(folderSelect instanceof HTMLSelectElement)) return;
  if (folderSelect.value !== newChatModalState.newChatWorktreeScope) {
    const row = document.getElementById('chat-new-worktree-row');
    if (row) row.hidden = true;
    if (worktreeSelect) worktreeSelect.value = '';
  }
  const folders = Array.from(folderSelect.options, (option) => ({ value: option.value, label: option.textContent }));
  picker.options = buildNewChatLocationOptions(folders, newChatLocationWorktrees, readNewChatLocationFavorites(), t,
    document.documentElement.lang || undefined);
  const todoId = resolveNewChatWorktreeTodoId();
  picker.value = encodeNewChatLocation(folderSelect.value, todoId);
  const selected = picker.options.find((row) => row.value === picker.value);
  const folderLabel = folders.find((row) => row.value === folderSelect.value)?.label || folderSelect.value;
  picker.displayLabel = todoId ? `${folderLabel} · ${selected?.label || worktreeSelect?.selectedOptions[0]?.textContent || ''}` : folderLabel;
  picker.displayDescription = selected?.description || folderSelect.value;
  picker.placeholder = t('chat.newLocationLabel');
  const defaultLocation = resolveDefaultNewChatLocation();
  picker.clearable = Boolean(defaultLocation) &&
    (normalizeFolderForCompare(folderSelect.value) !== normalizeFolderForCompare(defaultLocation.folder) || Boolean(todoId));
  picker.clearLabel = t('chat.newLocationReset');
  picker.searchPlaceholder = t('chat.newSearchLocations');
  picker.emptyLabel = t('common.searchDropdownEmpty');
  picker.favoritesEnabled = true;
  picker.favoritesFilterEnabled = true;
  picker.worktreeFilterEnabled = true;
  picker.worktreeOptionsLabel = t('chat.newLocationsWithWorktree');
  picker.plainOptionsLabel = t('chat.newLocationsWithoutWorktree');
  picker.allOptionsLabel = t('chat.newAllLocations');
  picker.favoriteOptionsLabel = t('chat.newFavoriteModels');
  picker.emptyFavoritesLabel = t('chat.newEmptyFavoriteLocations');
  picker.addFavoriteLabel = t('chat.newAddFavoriteLocation');
  picker.removeFavoriteLabel = t('chat.newRemoveFavoriteLocation');
}

/** Fetch worktrees for the visible folder groups only when the dropdown is opened. */
export async function loadNewChatLocationGroups() {
  const generation = newChatModalState.newChatLocationGeneration;
  const queue = Array.from(document.getElementById('chat-new-folder-select')?.options || [], (option) => option.value);
  async function loadNext() {
    while (queue.length && generation === newChatModalState.newChatLocationGeneration && chatHost.isNewChatModalOpen()) {
      await fetchNewChatLocationWorktrees(queue.shift());
    }
  }
  await Promise.allSettled(Array.from({ length: 3 }, loadNext));
}

export function normalizeFolderForCompare(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
}

/** Active chat that runs in a live worktree, or null. */
export function findActiveWorktreeChat() {
  const chat = chats.find((entry) => entry.id === chatRuntime.activeChatId);
  return chatWorktreeTodoId(chat) && chat.workspaceFolder ? chat : null;
}

/** todoId of the worktree picked in the modal, or '' for the project folder. */
export function resolveNewChatWorktreeTodoId() {
  const row = document.getElementById('chat-new-worktree-row');
  const select = document.getElementById('chat-new-worktree-select');
  if (!row || row.hidden || !(select instanceof HTMLSelectElement)) return '';
  return select.value || '';
}
