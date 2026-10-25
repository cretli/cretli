/**
 * Worktree select of the new-chat modal.
 */
import { t } from '../../../i18n/index.js';
import {
  fetchNewChatLocationWorktrees,
  newChatLocationWorktrees,
  syncNewChatLocationPicker,
} from '../services/newChatLocation.js';
import { chatRuntime } from '../state/chatRuntimeState.js';
import { newChatModalState } from '../state/newChatModalState.js';


/**
 * Fill the worktree select for the folder the modal targets. The active
 * chat's worktree is preselected; "no worktree" stays the first option.
 */
export async function syncNewChatWorktreeRow({ keepSelection = false } = {}) {
  const row = document.getElementById('chat-new-worktree-row');
  const select = document.getElementById('chat-new-worktree-select');
  if (!row || !(select instanceof HTMLSelectElement)) return;
  const folder = String(chatRuntime.selectedWorkspaceFolder || '').trim();
  const seq = ++newChatModalState.newChatWorktreeLoadSeq;
  const previous = keepSelection && !row.hidden ? select.value : null;
  newChatModalState.newChatWorktreeScope = folder;
  row.hidden = true;
  select.replaceChildren();
  syncNewChatLocationPicker();
  if (!folder) return;
  let data = null;
  try {
    data = newChatLocationWorktrees.has(folder)
      ? { ok: true, worktrees: newChatLocationWorktrees.get(folder) }
      : await fetchNewChatLocationWorktrees(folder);
  } catch (_) {
    return;
  }
  if (seq !== newChatModalState.newChatWorktreeLoadSeq || !data?.ok) return;
  const rows = Array.isArray(data.worktrees) ? data.worktrees : [];
  if (!rows.length) return;
  const none = document.createElement('option');
  none.value = '';
  none.textContent = t('chat.newWorktreeNone');
  select.appendChild(none);
  for (const item of rows) {
    const option = document.createElement('option');
    option.value = item.todoId;
    option.textContent = item.title ? `${item.branch} — ${item.title}` : item.branch;
    option.title = item.worktreePath || '';
    select.appendChild(option);
  }
  const preferred = previous ?? (newChatModalState.newChatWorktreeTarget?.todoId || '');
  select.value = rows.some((item) => item.todoId === preferred) ? preferred : '';
  row.hidden = false;
  syncNewChatLocationPicker();
}
