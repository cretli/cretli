/**
 * UI-side classification of `harnessState` on a persisted local chat.
 *
 * The server appends `harnessState` (see lib/agent-harness/persisted-local-chat-state.ts)
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

import { getChatAgentTransport, isCoreAgentTransport, parseKnownAgentTransport } from '../../../lib/agent-transport.js';

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

/**
 * A `plugin_disabled` chat whose transport is a known built-in id belongs to a
 * repo plugin that is switched off (a local plugin id is never a known
 * transport). Its message names the plugin, so it needs its own key.
 */
export const OPTIONAL_PLUGIN_DISABLED_MESSAGE_KEY = 'chat.optionalPluginDisabled';

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
  const code = resolveRawPersistedLocalChatStateCode(chat);
  return code === 'plugin_disabled' && isOptionalPluginTransport(chat) ? '' : code;
}

/**
 * The blocking code as the server sent it, including the read-only optional-plugin case.
 *
 * @param {{ harnessState?: { code?: unknown } | null } | null | undefined} chat
 * @returns {'' | 'plugin_unavailable' | 'plugin_disabled' | 'plugin_capability' | 'host_incompatible'}
 */
function resolveRawPersistedLocalChatStateCode(chat) {
  const state = chat && typeof chat === 'object' ? chat.harnessState : null;
  if (!state || typeof state !== 'object') return '';
  const code = typeof state.code === 'string' ? state.code.trim() : '';
  return BLOCKING_STATE_CODE_SET.has(code) ? /** @type {any} */ (code) : '';
}

/**
 * @param {{ agentTransport?: unknown } | null | undefined} chat
 * @returns {boolean} true when the saved transport is a known non-core id, i.e. a repo plugin
 */
function isOptionalPluginTransport(chat) {
  const raw = chat && typeof chat.agentTransport === 'string' ? chat.agentTransport.trim() : '';
  const id = parseKnownAgentTransport(raw);
  return id !== '' && !isCoreAgentTransport(id);
}

/**
 * A chat of a known optional plugin that is switched off. Unlike the other blocking states it
 * opens read-only: history loads through the normal path and only sending is disabled.
 *
 * @param {{ agentTransport?: unknown, harnessState?: { code?: unknown } | null } | null | undefined} chat
 * @returns {boolean}
 */
export function isReadOnlyOptionalPluginChat(chat) {
  return resolveRawPersistedLocalChatStateCode(chat) === 'plugin_disabled' && isOptionalPluginTransport(chat);
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
  const code = resolveRawPersistedLocalChatStateCode(chat);
  if (!code) return EMPTY_DISPLAY;
  const raw = chat && typeof chat.agentTransport === 'string' ? chat.agentTransport.trim() : '';
  const optionalPlugin = code === 'plugin_disabled' && isOptionalPluginTransport(chat);
  return Object.freeze({
    blocked: true,
    code,
    transportId: raw.toLowerCase(),
    label: raw || 'Local',
    messageKey: optionalPlugin
      ? OPTIONAL_PLUGIN_DISABLED_MESSAGE_KEY
      : PERSISTED_LOCAL_CHAT_STATE_MESSAGE_KEYS[code] || '',
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

/**
 * Localized explanation for a blocked chat, `''` when it is not blocked. The
 * disabled-plugin message names the plugin (server label, else the transport id).
 *
 * @param {{ agentTransport?: unknown, harnessState?: { code?: unknown, plugin?: { label?: unknown } | null } | null } | null | undefined} chat
 * @param {(key: string, params?: Record<string, string>) => string} translate
 * @returns {string}
 */
export function resolvePersistedLocalChatUnavailableMessage(chat, translate) {
  const display = resolvePersistedLocalChatHarnessDisplay(chat);
  if (!display.messageKey) return '';
  if (display.messageKey !== OPTIONAL_PLUGIN_DISABLED_MESSAGE_KEY) return translate(display.messageKey);
  const plugin = chat?.harnessState?.plugin;
  const label = typeof plugin?.label === 'string' && plugin.label.trim() ? plugin.label.trim() : display.label;
  return translate(display.messageKey, { plugin: label });
}
