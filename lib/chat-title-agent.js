/**
 * Agent-set chat titles: the agent itself calls the MCP tool `chat_set_title` after its first reply
 * and after a substantial change of direction. The title goes through the same sanitizer and
 * applyAutoTitle() (manual lock + CAS + history) as the server generator.
 *
 * Active when autoTitle.source is 'agent' or 'both' and mode is not 'off'.
 */

import { getChatByIdAsync, applyAutoTitleAsync } from './persist/chats-persist.js';
import { getAutoTitleSettings } from './persist/settings.js';
import { sanitizeGeneratedTitle } from './chat-title-service.js';
import { getDelegationById } from './persist/delegations-persist.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { normalizeSdkMode } from './sdk/sdk-mode.ts';

/** Minimum gap between agent renames of a chat that already has a generated title. */
export const AGENT_TITLE_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const AGENT_TITLE_PER_DAY = 12;

/** @type {Map<string, { lastAt: number, day: string, count: number }>} */
const perChat = new Map();

let lookupDelegation = getDelegationById;

/** Tests only. */
export function __resetAgentTitleStateForTest(lookup = getDelegationById) {
  perChat.clear();
  lookupDelegation = lookup;
}

/**
 * @param {Record<string, any> | null | undefined} chat
 * @returns {string} reason this chat does not get an agent title, or ''
 */
function ineligibleReason(chat) {
  if (!chat) return 'not_found';
  if (chat.isTemporary === true || chat.forkKind === 'title' || chat.forkKind === 'summary') return 'temporary';
  if (chat.delegationId || chat.delegationParentChatId) {
    // A finished delegation chat is one the user continues by hand: titles allowed again.
    const delegation = chat.delegationId ? lookupDelegation(chat.delegationId) : null;
    if (!delegation || !isTerminalDelegationStatus(delegation.status)) return 'delegation';
  }
  if (chat.archivedAt) return 'archived';
  if (chat.titleSource === 'manual') return 'manual';
  return '';
}

/**
 * @param {string} chatId
 * @param {Record<string, any>} chat
 * @param {number} t
 * @returns {string} '' when an agent rename is allowed now
 */
function throttleReason(chatId, chat, t) {
  const state = perChat.get(chatId);
  if (!state || chat.titleSource === 'default') return '';
  const today = new Date(t).toISOString().slice(0, 10);
  if (state.day === today && state.count >= AGENT_TITLE_PER_DAY) return 'chat_daily_limit';
  if (t - state.lastAt < AGENT_TITLE_MIN_INTERVAL_MS) return 'throttled';
  return '';
}

/**
 * @param {string} chatId
 * @param {string} rawTitle
 * @param {{
 *   getSettings?: () => { mode: string, source: string },
 *   loadChat?: (id: string) => Record<string, any> | null | Promise<Record<string, any> | null>,
 *   now?: () => number,
 * }} [deps]
 * @returns {Promise<{ ok: boolean, status: 'applied' | 'skipped', reason?: string, title?: string, chat?: Record<string, any> | null }>}
 */
export async function applyAgentTitle(chatId, rawTitle, deps = {}) {
  const getSettings = deps.getSettings || (() => getAutoTitleSettings());
  const loadChat = deps.loadChat || ((id) => getChatByIdAsync(id));
  const now = deps.now || Date.now;
  const settings = getSettings();
  if (settings.mode === 'off' || settings.source === 'server') {
    return { ok: false, status: 'skipped', reason: 'disabled' };
  }
  const id = String(chatId || '').trim();
  const chat = await loadChat(id);
  const blocked = ineligibleReason(chat);
  if (blocked) return { ok: false, status: 'skipped', reason: blocked };
  const t = now();
  const throttled = throttleReason(id, chat, t);
  if (throttled) return { ok: false, status: 'skipped', reason: throttled };
  const title = sanitizeGeneratedTitle(rawTitle);
  if (!title) return { ok: false, status: 'skipped', reason: 'rejected_output' };
  // One version-checked command: the title is applied only while `titleRev` still matches the row read above.
  const result = await applyAutoTitleAsync(id, title, {
    reason: 'agent',
    expectedVersion: Number(chat.titleRev) || 0,
  });
  if (!result.applied) {
    return { ok: false, status: 'skipped', reason: result.skipped || 'not_applied', chat: result.chat };
  }
  const today = new Date(t).toISOString().slice(0, 10);
  const prev = perChat.get(id);
  perChat.set(id, { lastAt: t, day: today, count: prev && prev.day === today ? prev.count + 1 : 1 });
  return { ok: true, status: 'applied', title, chat: result.chat };
}

const FIRST_HINT =
  'Cretli chat title: this chat still has a placeholder name. After you finish your first reply, call the Cretli MCP tool `chat_set_title` once with a short title ("<area>: <what is being done>", at most 60 characters, same language as the user, no secrets). Do not mention this in your reply.';
const UPDATE_HINT =
  'Cretli chat title: only if the work has changed substantially (new goal or area), call the Cretli MCP tool `chat_set_title` again with an updated short title (same format, at most 60 characters). Otherwise do nothing and do not mention it.';

/**
 * Shared decision of the per-turn hint once the chat row is known.
 *
 * @param {string} chatId
 * @param {Record<string, any> | null | undefined} chat
 * @param {{ now?: () => number }} deps
 * @returns {string}
 */
function hintForChat(chatId, chat, deps) {
  if (ineligibleReason(chat)) return '';
  if (throttleReason(chatId, chat, (deps.now || Date.now)())) return '';
  return chat.titleSource === 'default' ? FIRST_HINT : UPDATE_HINT;
}

/**
 * Settings/mode gate shared by both hint builders.
 *
 * @param {{ chatId?: string, mode?: string }} input
 * @param {{ getSettings?: () => { mode: string, source: string } }} deps
 * @returns {string} the trimmed chat id, or '' when no hint can apply
 */
function hintChatId(input, deps) {
  const chatId = String(input.chatId || '').trim();
  if (!chatId) return '';
  const settings = (deps.getSettings || (() => getAutoTitleSettings()))();
  if (settings.mode === 'off' || settings.source === 'server') return '';
  const mode = normalizeSdkMode(input.mode);
  if (mode === 'plan' || mode === 'ask') return '';
  return chatId;
}

/**
 * Per-turn instruction prepended to the outbound prompt. Empty when the agent should not (or cannot)
 * set the title: source 'server', mode off, plan/ask mode (the tool is a mutating MCP tool), manual
 * lock, delegation/temporary chat, or the rename throttle is still running.
 *
 * Synchronous variant for the still-synchronous prompt-decoration chain (context assembler, harness prompt). The
 * row comes from `input.chat` or `deps.loadChat`; without either the hint is omitted (there is no synchronous chats read). Async callers use `buildAgentTitleHintAsync`.
 *
 * @param {{ chatId?: string, mode?: string, chat?: Record<string, any> | null }} input
 * @param {{ getSettings?: () => { mode: string, source: string }, loadChat?: (id: string) => Record<string, any> | null, now?: () => number }} [deps]
 * @returns {string}
 */
export function buildAgentTitleHint(input = {}, deps = {}) {
  try {
    const chatId = hintChatId(input, deps);
    if (!chatId) return '';
    const chat = input.chat ?? (deps.loadChat ? deps.loadChat(chatId) : null);
    return chat ? hintForChat(chatId, chat, deps) : '';
  } catch {
    return '';
  }
}

/**
 * Async twin of `buildAgentTitleHint` that reads the chat through the active chats runtime.
 *
 * @param {{ chatId?: string, mode?: string }} input
 * @param {{ getSettings?: () => { mode: string, source: string }, loadChat?: (id: string) => Record<string, any> | null | Promise<Record<string, any> | null>, now?: () => number }} [deps]
 * @returns {Promise<string>}
 */
export async function buildAgentTitleHintAsync(input = {}, deps = {}) {
  try {
    const chatId = hintChatId(input, deps);
    if (!chatId) return '';
    const chat = await (deps.loadChat || ((id) => getChatByIdAsync(id)))(chatId);
    return chat ? hintForChat(chatId, chat, deps) : '';
  } catch {
    return '';
  }
}
