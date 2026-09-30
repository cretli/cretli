/**
 * UI-side classification of `harnessState` on a persisted local chat.
 *
 * The server appends `harnessState` (see lib/agent-harness/persisted-local-chat-state.js)
 * only to chats whose saved `agentTransport` is a local harness id. This module is the
 * single place the client decides whether that state blocks opening the chat.
 *
 * Only four codes block: the plugin is missing, disabled, not chat-capable, or the host
 * is too old. `not_loaded` means "discovery did not import the plugin during this list
 * read" — it is not a loss, so it is treated as available. A missing `harnessState` is a
 * legacy/built-in row and stays on the pre-plugin path.
 *
 * The module is deliberately pure (no DOM, no network, no i18n): the same decisions feed
 * list hydration, `openTerminal`, the transport reconnect guards, and the sidebar. It never
 * mutates the raw transport; when (and only when) a blocking state is present the exact
 * saved transport string is preserved so the client never displays or routes it as SDK.
 */

import { getChatAgentTransport } from '../../../lib/agent-transport.js';

/** `harnessState.code` values that make a persisted local chat unusable. */
export const BLOCKING_PERSISTED_LOCAL_CHAT_STATE_CODES = Object.freeze([
  'plugin_unavailable',
  'plugin_disabled',
  'plugin_capability',
  'host_incompatible',
]);

const BLOCKING_STATE_CODE_SET = new Set(BLOCKING_PERSISTED_LOCAL_CHAT_STATE_CODES);

/** i18n key explaining each blocking state (one string per code in en.js/pl.js). */
export const PERSISTED_LOCAL_CHAT_STATE_MESSAGE_KEYS = Object.freeze({
  plugin_unavailable: 'chat.localHarnessStateUnavailable',
  plugin_disabled: 'chat.localHarnessStateDisabled',
  plugin_capability: 'chat.localHarnessStateCapability',
  host_incompatible: 'chat.localHarnessStateHostIncompatible',
});

const EMPTY_DISPLAY = Object.freeze({
  blocked: false,
  code: '',
  transportId: '',
  label: '',
  messageKey: '',
});

/**
 * The blocking state code on a chat/row, or `''` when the row is not blocked.
 *
 * Accepts either a runtime chat (`harnessState` copied during hydration) or a raw
 * `GET /api/chats` row. `not_loaded`, unknown codes, and a missing state all return `''`.
 *
 * @param {{ harnessState?: { code?: unknown } | null } | null | undefined} chat
 * @returns {'' | 'plugin_unavailable' | 'plugin_disabled' | 'plugin_capability' | 'host_incompatible'}
 */
export function resolveBlockingPersistedLocalChatStateCode(chat) {
  const state = chat && typeof chat === 'object' ? chat.harnessState : null;
  if (!state || typeof state !== 'object') return '';
  const code = typeof state.code === 'string' ? state.code.trim() : '';
  return BLOCKING_STATE_CODE_SET.has(code) ? code : '';
}

/**
 * Whether a persisted local chat must stay out of the SDK view/socket/reconnect path.
 *
 * @param {{ harnessState?: { code?: unknown } | null } | null | undefined} chat
 * @returns {boolean}
 */
export function isBlockingPersistedLocalChatHarnessState(chat) {
  return resolveBlockingPersistedLocalChatStateCode(chat) !== '';
}

/**
 * Resolve the transport to store on a runtime chat while hydrating a list row.
 *
 * For a blocking local state the exact saved `agentTransport` string is preserved so the
 * id is never rewritten to `sdk`; for every other row (including `not_loaded`, no state,
 * built-ins, and legacy `cursor`) this is the pre-existing `getChatAgentTransport`
 * normalization. The input is never mutated.
 *
 * @param {{ agentTransport?: unknown, harnessState?: { code?: unknown } | null } | null | undefined} serverChat
 * @returns {string}
 */
export function resolvePersistedLocalChatTransport(serverChat) {
  if (resolveBlockingPersistedLocalChatStateCode(serverChat)) {
    const raw = serverChat && typeof serverChat.agentTransport === 'string'
      ? serverChat.agentTransport
      : '';
    if (raw.trim()) return raw;
  }
  return getChatAgentTransport(serverChat);
}

/**
 * Display metadata for a persisted local chat's harness badge.
 *
 * For a blocking state `label` is the raw plugin transport id (never "Cursor"/"Cursor
 * SDK"), `transportId` is its lowercased form, and `messageKey` points at the localized
 * reason. Non-blocking rows return `blocked: false` and empty fields so callers keep their
 * existing built-in labels.
 *
 * @param {{ agentTransport?: unknown, harnessState?: { code?: unknown } | null } | null | undefined} chat
 * @returns {{ blocked: boolean, code: string, transportId: string, label: string, messageKey: string }}
 */
export function resolvePersistedLocalChatHarnessDisplay(chat) {
  const code = resolveBlockingPersistedLocalChatStateCode(chat);
  if (!code) return EMPTY_DISPLAY;
  const raw = chat && typeof chat.agentTransport === 'string' ? chat.agentTransport.trim() : '';
  return Object.freeze({
    blocked: true,
    code,
    transportId: raw.toLowerCase(),
    label: raw || 'Local',
    messageKey: PERSISTED_LOCAL_CHAT_STATE_MESSAGE_KEYS[code] || '',
  });
}

/**
 * Localized i18n key for a blocked chat, or `''` when the chat is not blocked.
 *
 * @param {{ harnessState?: { code?: unknown } | null } | null | undefined} chat
 * @returns {string}
 */
export function resolvePersistedLocalChatUnavailableMessageKey(chat) {
  return resolvePersistedLocalChatHarnessDisplay(chat).messageKey;
}
