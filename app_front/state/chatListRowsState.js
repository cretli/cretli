/**
 * Slim chat-row store for the sidebar. Holds one small record per chat (only the
 * fields a row paints) plus a per-row field signature, so consumers can redraw
 * just the rows whose signature changed instead of rebuilding the whole list.
 * DOM-free so it can be unit tested in Node. Docs: docs/shared-state.md.
 */
import { signal } from '@lit-labs/signals';

/**
 * Every chat field the sidebar row render reads (sidebarChatRowModel.js, its
 * harness-icon/state helpers and the action buttons). Anything missing here would
 * let the changed-rows-only fast path leave a stale row, so keep this in sync with
 * those readers; volatile fields the row never paints (timestamps, run state)
 * are deliberately excluded to keep the signature stable.
 * @param {Record<string, any>} chat
 */
export function slimChatRow(chat) {
  const preview = chat?._pushPreview && typeof chat._pushPreview.text === 'string'
    ? chat._pushPreview.text.trim()
    : '';
  const harnessState = chat?.harnessState && typeof chat.harnessState === 'object' ? chat.harnessState : null;
  return {
    id: String(chat?.id || ''),
    title: String(chat?.title || ''),
    workspace: String(chat?.workspaceFile || chat?.workspaceKey || ''),
    forkParentChatId: String(chat?.forkParentChatId || ''),
    todoId: String(chat?.todoId || ''),
    onWorktree: chat?.onWorktree ? 1 : 0,
    widgetPinnedUrl: String(chat?.widgetPinnedUrl || ''),
    archived: chat?.archived || chat?.archivedAt ? 1 : 0,
    agentTransport: String(chat?.agentTransport || ''),
    isTemporary: chat?.isTemporary ? 1 : 0,
    pushPreview: preview,
    harnessStateCode: String(harnessState?.code || ''),
    harnessPluginLabel: String(harnessState?.plugin?.label || ''),
  };
}

/** Stable signature of a slim row (field order is fixed by `slimChatRow`). */
export function chatRowSignature(row) {
  return JSON.stringify(Object.values(row));
}

export function createChatListRowsState() {
  /** @type {Map<string, { row: object, sig: string }>} */
  let entries = new Map();
  const revision = signal(0);

  return {
    revision,
    /**
     * Replaces the rows; bumps `revision` only when something changed.
     * @param {Array<Record<string, any>>} chats
     * @returns {{ changed: string[], removed: string[] }} ids to redraw / drop
     */
    setChats(chats) {
      const next = new Map();
      const changed = [];
      for (const chat of chats || []) {
        const row = slimChatRow(chat);
        if (!row.id) continue;
        const sig = chatRowSignature(row);
        const prev = entries.get(row.id);
        // Reuse the previous record so unchanged rows keep identity.
        next.set(row.id, prev && prev.sig === sig ? prev : { row, sig });
        if (!prev || prev.sig !== sig) changed.push(row.id);
      }
      const removed = [...entries.keys()].filter((id) => !next.has(id));
      entries = next;
      if (changed.length || removed.length) revision.set(revision.get() + 1);
      return { changed, removed };
    },
    getRow(id) {
      return entries.get(id)?.row || null;
    },
    getSignature(id) {
      return entries.get(id)?.sig || '';
    },
    get size() {
      return entries.size;
    },
  };
}
