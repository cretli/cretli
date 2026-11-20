/**
 * In-place sidebar row status patch (shared by chat.js and Lit row hosts).
 */

import { resolveChatListDotState } from '../chat/chatStatusMeta.js';
import { getChatAutoArchiveConfig, isChatAutoArchiveFavorite } from '../chat/chatAutoArchiveConfig.js';
import {
  chatListVisualKey,
  shouldSkipChatListItemWrite,
} from '../chat/chatListStateRefresh.js';
import { writeIfChanged } from '../../lib/domWriteIfChanged.js';
import { applySidebarChatStatusEl } from './sidebarChatStatus.js';
import { chats as allChats } from '../chat/state/chatRuntimeState.js';
import {
  ARCHIVE_COUNTDOWN_IMMINENT_TONE,
  ARCHIVE_COUNTDOWN_SOON_TONE,
  collectChatForkDescendants,
  resolveChatArchiveCountdown,
} from './sidebarChatArchiveCountdown.js';

/**
 * Auto-archive countdown of a chat judged together with its fork subtree, the
 * way the server sweeps it (shared by the sidebar chip and the in-chat notice).
 *
 * @param {Record<string, any>} chat
 * @param {((chat: any) => { tone: string }) | null} getMeta
 * @param {{ now?: number }} [options]
 * @returns {ReturnType<typeof resolveChatArchiveCountdown>}
 */
export function resolveChatFamilyArchiveCountdown(chat, getMeta, options = {}) {
  if (!chat) return null;
  const stateOf = (/** @type {any} */ row) => (getMeta ? resolveChatListDotState(getMeta(row).tone) : 'disconnected');
  const countdownOptions = {
    now: Number.isFinite(options.now) ? Number(options.now) : Date.now(),
    config: getChatAutoArchiveConfig(),
    state: stateOf(chat),
    isFavorite: isChatAutoArchiveFavorite(chat.id),
  };
  // The server sweeps a fork family as a whole, so an active child keeps its
  // parent's deadline off. Descendants can only hide the chip or push the
  // deadline later, so the subtree walk runs only when the row alone would show.
  if (!resolveChatArchiveCountdown(chat, countdownOptions)) return null;
  return resolveChatArchiveCountdown(chat, {
    ...countdownOptions,
    descendants: collectChatForkDescendants(chat.id || '', allChats).map((child) => ({
      chat: child,
      state: stateOf(child),
      isFavorite: isChatAutoArchiveFavorite(child.id),
    })),
  });
}

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
  const countdown = chat ? resolveChatFamilyArchiveCountdown(chat, getMeta) : null;
  const statusMeta = countdown
    ? { tone: countdown.tone, label: countdown.label }
    : meta;
  const nextKey = chatListVisualKey(state, statusMeta.tone, statusMeta.label);
  const dataset = li.dataset || {};
  if (shouldSkipChatListItemWrite(dataset.visualKey, nextKey)) return;
  dataset.visualKey = nextKey;
  if (li.classList && typeof li.classList.toggle === 'function') {
    li.classList.toggle('has-activity-status', meta.tone === 'active');
    // The row's own archive button blinks while the countdown runs.
    li.classList.toggle('is-archive-soon', countdown?.tone === ARCHIVE_COUNTDOWN_SOON_TONE);
    li.classList.toggle('is-archive-imminent', countdown?.tone === ARCHIVE_COUNTDOWN_IMMINENT_TONE);
  }
  const indicator = li.querySelector('.sidebar-chat-item-state');
  if (indicator) {
    writeIfChanged(indicator, 'className', 'sidebar-chat-item-state sidebar-chat-item-state--' + state);
    writeIfChanged(indicator, 'title', meta.label, true);
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
