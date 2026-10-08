/**
 * In-place sidebar row status patch (shared by chat.js and Lit row hosts).
 */

import { resolveChatListDotState } from '../chat/chatStatusMeta.js';
import { getChatAutoArchiveConfig } from '../chat/chatAutoArchiveConfig.js';
import {
  chatListVisualKey,
  shouldSkipChatListItemWrite,
} from '../chat/chatListStateRefresh.js';
import { applySidebarChatStatusEl } from './sidebarChatStatus.js';
import { resolveChatArchiveCountdown } from './sidebarChatArchiveCountdown.js';

/**
 * @param {Element} li
 * @param {object | null | undefined} chat
 * @param {{ t: (key: string, params?: object) => string, escapeHtml?: (v: unknown) => string }} ctx
 */
export function patchSidebarChatRowVisualState(li, chat, ctx) {
  if (!li || typeof li.querySelector !== 'function') return;
  const t = ctx.t;
  const escapeHtml = typeof ctx.escapeHtml === 'function'
    ? ctx.escapeHtml
    : (value) => String(value ?? '');
  const disconnectedMeta = { tone: 'disconnected', label: t('status.disconnected') };
  const getMeta = typeof ctx.getSidebarChatStateMeta === 'function'
    ? ctx.getSidebarChatStateMeta
    : typeof ctx.getTerminalStateMeta === 'function'
      ? ctx.getTerminalStateMeta
      : null;
  const meta = chat && getMeta ? getMeta(chat) : disconnectedMeta;
  const state = chat ? resolveChatListDotState(meta.tone) : 'disconnected';
  // The countdown only replaces an idle-looking status chip; a live run, a
  // queued turn or a pending question keeps priority (and the server sweeps
  // only confirmed-idle chats anyway).
  const countdown = chat
    ? resolveChatArchiveCountdown(chat, {
      now: Date.now(),
      config: getChatAutoArchiveConfig(),
      state,
    })
    : null;
  const statusMeta = countdown
    ? { tone: countdown.tone, label: countdown.label }
    : meta;
  const nextKey = chatListVisualKey(state, statusMeta.tone, statusMeta.label);
  const dataset = li.dataset || {};
  if (shouldSkipChatListItemWrite(dataset.visualKey, nextKey)) return;
  dataset.visualKey = nextKey;
  if (li.classList && typeof li.classList.toggle === 'function') {
    li.classList.toggle('has-activity-status', meta.tone === 'active');
  }
  const indicator = li.querySelector('.sidebar-chat-item-state');
  if (indicator) {
    indicator.className = 'sidebar-chat-item-state sidebar-chat-item-state--' + state;
    indicator.setAttribute('title', meta.label);
  }
  const awaitingEl = li.querySelector('.sidebar-chat-item-awaiting');
  if (awaitingEl) {
    applySidebarChatStatusEl(awaitingEl, statusMeta, {
      escapeHtml,
      title: countdown
        ? t('sidebar.archiveCountdownTitle', { time: countdown.label })
        : t('sidebar.stateTitle', { label: meta.label }),
    });
  }
}
