/** Wires the in-chat auto-archive notice to the chat list, the sidebar countdown and the API. */
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { chatRuntime, chats } from '../state/chatRuntimeState.js';
import { createChatArchiveNoticeController } from '../chatArchiveNotice.js';
import { resolveChatFamilyArchiveCountdown } from '../../sidebar/sidebarChatRowVisualPatch.js';
import { getSidebarChatStateMeta } from './chatSidebarHooks.js';

/** @type {ReturnType<typeof createChatArchiveNoticeController> | null} */
let controller = null;

function getController() {
  if (!controller) {
    controller = createChatArchiveNoticeController({
      t,
      getHost: (chat) => chat?._archiveNoticeHost || null,
      resolveCountdown: (chat) => resolveChatFamilyArchiveCountdown(chat, getSidebarChatStateMeta),
      postpone: async (chat) => {
        // Optimistic: the notice and the sidebar chip go away at once; the server
        // `read` frame then confirms the stamp (and carries it to other devices).
        const previous = chat.autoArchivePostponedAt;
        chat.autoArchivePostponedAt = new Date().toISOString();
        const result = await api.postChatArchivePostpone(chat.id).catch((err) => ({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        if (result?.ok) {
          if (result.autoArchivePostponedAt) chat.autoArchivePostponedAt = result.autoArchivePostponedAt;
          return { ok: true };
        }
        if (previous) chat.autoArchivePostponedAt = previous;
        else delete chat.autoArchivePostponedAt;
        return { ok: false, error: String(result?.error || '') };
      },
    });
  }
  return controller;
}

/**
 * Repaint the notice of the open chat. Called from the coalesced sidebar status
 * refresh, so it follows the same 30 s countdown clock and status changes.
 */
export function syncActiveChatArchiveNotice() {
  const id = chatRuntime.activeChatId;
  if (!id) return;
  const chat = chats.find((entry) => entry?.id === id);
  if (!chat?._archiveNoticeHost) return;
  getController().sync(chat);
}
