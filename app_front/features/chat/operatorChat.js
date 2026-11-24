/**
 * Internal operator owner thread (client side).
 *
 * The server keeps ONE thread (`chat.operatorChat === true`) that only shows
 * notices and the owner's own messages; the operator's runs happen in hidden
 * chats. This module is the UI contract for that thread: how to recognise it,
 * the state chip, the pinned sidebar row, the (absent) archive/delete actions
 * and sending an owner message. Everything user-facing goes through `t()`.
 *
 * Server side: `lib/routes/operator-internal-routes.js` (human-only routes).
 */

import { t } from '../../i18n/index.js';

export const OPERATOR_STATUS_URL = '/api/operator/internal/status';
export const OPERATOR_MESSAGE_URL = '/api/operator/internal/message';
export const OPERATOR_STATUS_STALE_MS = 20_000;
/** Chip states, most to least "alive"; the same keys exist as `operatorChat.state.*` in i18n. */
export const OPERATOR_STATES = Object.freeze(['running', 'queued', 'idle', 'paused', 'budget', 'off']);

/** @param {unknown} chat @returns {boolean} */
export function isOperatorChat(chat) {
  return Boolean(chat && typeof chat === 'object' && /** @type {any} */ (chat).operatorChat === true);
}

/**
 * The owner thread has no archive and no delete action (the server also
 * answers 409 `operator_chat_pinned` to an archive request).
 *
 * @param {unknown} chat
 * @returns {{ archive: boolean, remove: boolean }}
 */
export function operatorChatActions(chat) {
  const pinned = isOperatorChat(chat);
  return { archive: !pinned, remove: !pinned };
}

/**
 * @param {unknown[]} chats
 * @returns {Record<string, any> | null} the owner thread when it is in the list
 */
export function findOperatorChat(chats) {
  return /** @type {any} */ ((Array.isArray(chats) ? chats : []).find((chat) => isOperatorChat(chat) && !/** @type {any} */ (chat).archivedAt) || null);
}

/**
 * @param {Record<string, any> | null | undefined} status server read model
 * @param {(key: string, params?: Record<string, unknown>) => string} [translate]
 * @returns {{ state: string, label: string }}
 */
export function operatorChipModel(status, translate = t) {
  const state = OPERATOR_STATES.includes(String(status?.state)) ? String(status?.state) : 'idle';
  const queued = Number(status?.queued) || 0;
  const label = state === 'queued'
    ? translate('operatorChat.state.queued', { count: queued })
    : translate(`operatorChat.state.${state}`);
  return { state, label };
}

/**
 * Pinned sidebar section of the owner thread. The row reuses the watcher's
 * `.sidebar-pinned-chat` markup so the delegated click handler opens it; it
 * carries no archive or delete control.
 *
 * @param {{ chat: Record<string, any> | null, status?: Record<string, any> | null, activeChatId?: string,
 *   escapeHtml: (value: unknown) => string, translate?: typeof t }} input
 * @returns {string} empty when there is no thread
 */
export function renderOperatorSectionHtml(input) {
  const { chat, escapeHtml } = input;
  const translate = input.translate || t;
  if (!chat || !chat.id) return '';
  const active = chat.id === input.activeChatId;
  const chip = operatorChipModel(input.status, translate);
  const title = translate('operatorChat.title');
  return (
    '<div class="sidebar-pinned-section sidebar-operator-section" aria-label="' + escapeHtml(title) + '">' +
    '<ul class="sidebar-pinned-chats" role="listbox">' +
    '<li class="sidebar-pinned-chat sidebar-operator-chat' + (active ? ' is-active' : '') +
    '" role="option" aria-selected="' + (active ? 'true' : 'false') +
    '" data-pinned-chat-id="' + escapeHtml(chat.id) + '" tabindex="' + (active ? '0' : '-1') +
    '" title="' + escapeHtml(translate('operatorChat.pinnedTitle')) + '">' +
    '<span class="mdi mdi-account-tie-hat-outline sidebar-pinned-chat-icon" aria-hidden="true"></span>' +
    '<span class="sidebar-pinned-chat-main">' +
    '<span class="sidebar-pinned-chat-title">' + escapeHtml(title) +
    ' <span class="sidebar-operator-badge">' + escapeHtml(translate('operatorChat.badge')) + '</span></span>' +
    '</span>' +
    '<span class="sidebar-operator-chip" data-operator-state="' + escapeHtml(chip.state) + '">' + escapeHtml(chip.label) + '</span>' +
    '</li></ul></div>'
  );
}

// ---- Status store ---------------------------------------------------------

/** @type {Record<string, any> | null} */
let lastStatus = null;
let lastStatusAt = 0;
let inFlight = false;
/** @type {Set<() => void>} */
const listeners = new Set();

/** @returns {Record<string, any> | null} */
export function getOperatorStatus() { return lastStatus; }

/** @param {() => void} listener @returns {() => void} unsubscribe */
export function onOperatorStatusChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook. */
export function resetOperatorStatusForTests() { lastStatus = null; lastStatusAt = 0; inFlight = false; listeners.clear(); }

/** @returns {Promise<(url: string, init?: Record<string, any>, label?: string) => Promise<any>>} */
async function defaultFetchJson() {
  const runtime = await import('../../core/api/runtime.js');
  return runtime.apiFetchJson;
}

/**
 * Refresh the chip data when it is older than {@link OPERATOR_STATUS_STALE_MS}.
 * A refused or failed read keeps the last value (the chip is cosmetic).
 *
 * @param {{ now?: number, fetchJson?: (url: string, init?: Record<string, any>, label?: string) => Promise<any>, force?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function refreshOperatorStatus(options = {}) {
  const now = options.now ?? Date.now();
  if (inFlight || (!options.force && now - lastStatusAt < OPERATOR_STATUS_STALE_MS)) return;
  inFlight = true;
  lastStatusAt = now;
  try {
    const fetchJson = options.fetchJson || await defaultFetchJson();
    const next = await fetchJson(OPERATOR_STATUS_URL, undefined, 'operator-status');
    if (next && next.ok === true && JSON.stringify(next) !== JSON.stringify(lastStatus)) {
      lastStatus = next;
      for (const listener of [...listeners]) listener();
    }
  } catch { /* keep the last chip */ } finally { inFlight = false; }
}

/**
 * Send an owner message. Never starts an agent run from the composer: the
 * server queues an `owner_message` event and the operator answers in the thread.
 *
 * @param {Record<string, any>} chat the owner thread (its rich view receives error notices)
 * @param {string} text
 * @param {{ fetchJson?: (url: string, init?: Record<string, any>, label?: string) => Promise<any>, translate?: typeof t }} [options]
 * @returns {Promise<boolean>} true when the server accepted the message
 */
export async function handleOperatorOwnerSend(chat, text, options = {}) {
  const translate = options.translate || t;
  const message = String(text ?? '').trim();
  if (!message) return false;
  try {
    const fetchJson = options.fetchJson || await defaultFetchJson();
    const result = await fetchJson(OPERATOR_MESSAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, source: 'ui' }),
    }, 'operator-message');
    if (result?.ok === true) {
      void refreshOperatorStatus({ force: true, fetchJson: options.fetchJson });
      return true;
    }
    const key = result?.error === 'operator_disabled' ? 'operatorChat.disabled' : 'operatorChat.sendFailed';
    chat?._sdkRichView?.appendMetaNotice?.(translate(key));
  } catch {
    chat?._sdkRichView?.appendMetaNotice?.(translate('operatorChat.sendFailed'));
  }
  return false;
}
