/**
 * Auto-title dispatcher (MVP, mode 'first'): one server-side hook called when a harness run finishes.
 * Wired into the shared room kernel (claude/codex/opencode/openrouter/deepseek/qwen/codebuddy)
 * and the Cursor SDK room — not per harness and not on every history append.
 *
 * Triggers only for a successfully finished run of a chat whose title is still the placeholder
 * (titleSource === 'default'). Once the server (or the user) sets a title the chat is never
 * picked up again, so the dispatcher is idempotent.
 */

import { loadChats } from './persist/chats-persist.js';
import { getAutoTitleSettings } from './persist/settings.js';
import { normalizeSdkRunStatus } from './sdk/sdk-run-outcome.js';
import { getChatTitleService } from './chat-title-service.js';

/**
 * @param {object | null | undefined} chat
 * @returns {string} reason this chat is not auto-titled, or '' when eligible
 */
export function getAutoTitleSkipReason(chat) {
  if (!chat) return 'not_found';
  if (chat.isTemporary === true || chat.forkKind === 'title' || chat.forkKind === 'summary') return 'temporary';
  if (chat.delegationId || chat.delegationParentChatId) return 'delegation';
  if (chat.archivedAt) return 'archived';
  if (chat.titleSource !== 'default') return 'not_default';
  return '';
}

/**
 * @param {{
 *   service?: { requestTitle: Function },
 *   loadChat?: (id: string) => object | null,
 *   getSettings?: () => { mode: string },
 *   defer?: (fn: () => void) => void,
 *   log?: (msg: string) => void,
 * }} [deps]
 */
export function createChatTitleDispatcher(deps = {}) {
  const getService = () => deps.service || getChatTitleService();
  const loadChat = deps.loadChat || ((id) => loadChats().find((c) => c.id === id) || null);
  const getSettings = deps.getSettings || (() => getAutoTitleSettings());
  // History is flushed on the same tick as the run-finished event; run after it.
  const defer = deps.defer || ((fn) => setTimeout(fn, 0));
  const log = deps.log || ((m) => console.warn(`[chat-title] ${m}`));

  return {
    /**
     * @param {string} chatId
     * @param {Record<string, unknown>} [payload] sdkRunFinished payload
     * @returns {boolean} whether a title job was scheduled
     */
    noteRunFinished(chatId, payload = {}) {
      const id = String(chatId || '').trim();
      if (!id) return false;
      if (normalizeSdkRunStatus(payload?.status) !== 'completed') return false;
      try {
        // 'continuous' (periodic refresh) is a later task; today it behaves like 'first'.
        // source 'agent': the agent names the chat itself via MCP chat_set_title; no server job.
        const settings = getSettings();
        if (settings.mode === 'off' || settings.source === 'agent') return false;
        if (getAutoTitleSkipReason(loadChat(id))) return false;
        defer(() => {
          // Re-check at run time: a rename may have happened in between.
          if (getAutoTitleSkipReason(loadChat(id))) return;
          Promise.resolve(getService().requestTitle(id, { reason: 'first' })).catch((err) => {
            log(`dispatch failed chatId=${id}: ${err?.message || err}`);
          });
        });
        return true;
      } catch (err) {
        log(`dispatch error chatId=${id}: ${err?.message || err}`);
        return false;
      }
    },
  };
}

const defaultDispatcher = createChatTitleDispatcher();

/**
 * Hook for rooms: `room.chatId` + the broadcast payload. Never throws.
 *
 * @param {{ chatId?: string } | null | undefined} room
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {boolean}
 */
export function noteRoomRunFinishedForAutoTitle(room, payload) {
  if (!room?.chatId || !payload || payload.type !== 'sdkRunFinished') return false;
  return defaultDispatcher.noteRunFinished(room.chatId, payload);
}
