/**
 * Worktree row of the sidebar workspace bar.
 *
 * Shown while the active chat runs in a live task worktree: a label with the
 * worktree branch plus a toggle that limits the chat list to that worktree.
 * The branch label comes from the execution badge's last Git info, so no extra
 * request is made here. Clicking the label lists the other live worktrees of
 * the workspace folder and jumps to the newest chat of the picked one.
 */

import { initDropdown } from '../../lib/dropdown.js';
import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { getGitContextBadgeSnapshot } from '../../gitContextBadge.js';
import {
  chatWorktreeTodoId,
  readSidebarOnlyWorktreeFlag,
  writeSidebarOnlyWorktreeFlag,
} from '../../features/sidebar/sidebarOnlyActiveFilter.js';
import { syncWorkspaceBarVisibility } from './workspaceBranchBadge.js';

/**
 * @param {{
 *   getActiveChat?: () => object | null,
 *   getChats?: () => object[],
 *   onSelectChat?: (chatId: string) => void,
 *   onFilterChanged?: () => void,
 * }} [deps]
 * @returns {{ refresh: () => void }}
 */
export function initWorkspaceWorktreeBar(deps = {}) {
  const row = document.getElementById('sidebar-worktree-row');
  const label = document.getElementById('sidebar-worktree-label');
  const button = document.getElementById('sidebar-only-worktree-btn');
  if (!row || !label || !button) return { refresh() {} };
  const getActiveChat = typeof deps.getActiveChat === 'function' ? deps.getActiveChat : () => null;
  const getChats = typeof deps.getChats === 'function' ? deps.getChats : () => [];
  const popover = document.getElementById('sidebar-worktree-popover');
  const list = document.getElementById('sidebar-worktree-items');
  const dropdown = initDropdown({
    triggerEl: label,
    floatingEl: popover,
    compact: true,
    placement: 'bottom-start',
    offsetPx: 6,
    viewportPadding: 8,
    minWidthPx: 240,
    maxHeightPx: 360,
  });

  /** Newest non-archived chat that belongs to the worktree root todo. */
  function newestChatOfWorktree(todoId) {
    const rows = getChats().filter((chat) =>
      chat && !chat.archivedAt && String(chat.todoId || '').trim() === todoId);
    rows.sort((a, b) => String(b.updatedAt || b.createdAt || '')
      .localeCompare(String(a.updatedAt || a.createdAt || '')));
    return rows[0] || null;
  }

  function renderWorktreeItems(items, currentTodoId) {
    list.innerHTML = '';
    for (const item of items) {
      const target = newestChatOfWorktree(item.todoId);
      const row = document.createElement('li');
      row.className = 'chat-list-item';
      row.setAttribute('role', 'option');
      row.tabIndex = -1;
      const isCurrent = item.todoId === currentTodoId;
      if (isCurrent) row.setAttribute('aria-selected', 'true');
      row.textContent = item.title ? `${item.branch} — ${item.title}` : item.branch;
      row.title = target ? item.worktreePath || '' : t('workspace.worktreeNoChats');
      if (!target) row.setAttribute('aria-disabled', 'true');
      row.addEventListener('click', () => {
        if (!target || isCurrent) return;
        dropdown.close();
        if (typeof deps.onSelectChat === 'function') deps.onSelectChat(target.id);
      });
      list.appendChild(row);
    }
  }

  label.addEventListener('click', async () => {
    if (dropdown.isOpen()) {
      dropdown.close();
      return;
    }
    const chat = getActiveChat();
    const todoId = chatWorktreeTodoId(chat);
    if (!todoId || !chat.workspaceFolder) return;
    let data = null;
    try {
      data = await api.getWorktrees(chat.workspaceFolder);
    } catch (_) {
      return;
    }
    const items = Array.isArray(data?.worktrees) ? data.worktrees : [];
    // Nothing to pick from: the active worktree is the only one.
    if (!data?.ok || !items.some((item) => item.todoId !== todoId)) return;
    renderWorktreeItems(items, todoId);
    dropdown.open();
  });

  function refresh() {
    const chat = getActiveChat();
    const todoId = chatWorktreeTodoId(chat);
    if (!todoId) {
      row.hidden = true;
      syncWorkspaceBarVisibility();
      return;
    }
    const info = getGitContextBadgeSnapshot().info;
    const branch = String(info?.worktree?.branch || '').trim();
    const text = branch || t('workspace.worktreeLabel');
    if (label.textContent !== text) label.textContent = text;
    label.title = info?.worktree?.worktreePath || text;
    const on = readSidebarOnlyWorktreeFlag();
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.classList.toggle('is-active', on);
    row.hidden = false;
    syncWorkspaceBarVisibility();
  }

  button.addEventListener('click', () => {
    writeSidebarOnlyWorktreeFlag(!readSidebarOnlyWorktreeFlag());
    refresh();
    if (typeof deps.onFilterChanged === 'function') deps.onFilterChanged();
  });
  window.addEventListener('cr-lang-changed', refresh);
  return { refresh };
}
