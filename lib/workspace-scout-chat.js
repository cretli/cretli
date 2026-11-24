/**
 * Leaf helper that identifies a Scout chat from trusted host state and holds
 * the shared read-only wording/protocol check.
 *
 * Kept dependency-light (only the chat store) so both the MCP client and the
 * host read-only policy can ask the same question without dragging the tool
 * catalog or the SDK guard into a module cycle.
 */

import { getChatByIdAsync } from './persist/chats-persist.js';
import { isScoutChatIdRegistered, isScoutReadOnlyRow } from './scout-chat-registry.js';
import { MCP_PLAN_MODE_OPEN_TOOLS, resolveCretliBuiltinToolName } from './mcp/mcp-tool-names.js';

/** Readable, user-facing reason attached to every Scout read-only denial. */
export const SCOUT_READ_ONLY_MESSAGE =
  'Scout is read-only: only reads and its own findings submit are allowed. '
  + 'Editing files, running mutating shell, delegations and configuration changes are blocked.';

/** The scan's own submit channel; `list` and `submit` are the only safe actions. */
export const SCOUT_PROTOCOL_TOOL = 'scout_findings';
export const SCOUT_PROTOCOL_ACTIONS = Object.freeze(['list', 'submit']);

/**
 * A Scout or feedback triage chat carries a host-owned `pickPurpose`. The chat store
 * is host-owned state, never a model-supplied argument, so this cannot be
 * spoofed by a profile, prompt or tool argument.
 *
 * @param {unknown} chat
 * @returns {boolean}
 */
export function isScoutReadOnlyChat(chat) {
  return isScoutReadOnlyRow(chat);
}

export function isFeedbackTriageReadOnlyChat(chat) {
  return String(chat?.pickPurpose || '').trim() === 'feedback_triage';
}

/**
 * Synchronous answer for permission paths that cannot await (tool guards, stream handlers). A chat is a Scout chat when
 * the facade has handed out or created its row in this process (`scout-chat-registry.js`; every run reads its row
 * first). An injected `loadChats` (tests) supplies the rows instead; there is no synchronous store read.
 *
 * @param {unknown} chatId
 * @param {{ loadChats?: () => unknown[] }} [options]
 * @returns {boolean}
 */
export function isScoutReadOnlyChatId(chatId, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  if (isScoutChatIdRegistered(id)) return true;
  try {
    if (typeof options.loadChats === 'function') {
      const chats = options.loadChats();
      return isScoutReadOnlyChat((/** @type {any[]} */ (Array.isArray(chats) ? chats : [])).find((row) => row && row.id === id));
    }
    return false;
  } catch {
    // An unreadable injected source must never widen Scout
    // permissions beyond what the registry knows.
    return false;
  }
}

/**
 * Authoritative asynchronous variant for callers that can await.
 *
 * @param {unknown} chatId
 * @param {{ loadChats?: () => unknown[] | Promise<unknown[]> }} [options]
 * @returns {Promise<boolean>}
 */
export async function isScoutReadOnlyChatIdAsync(chatId, options = {}) {
  const id = String(chatId || '').trim();
  if (!id) return false;
  if (isScoutChatIdRegistered(id)) return true;
  try {
    if (typeof options.loadChats === 'function') {
      const chats = await options.loadChats();
      return isScoutReadOnlyChat((/** @type {any[]} */ (Array.isArray(chats) ? chats : [])).find((row) => row && row.id === id));
    }
    return isScoutReadOnlyChat(await getChatByIdAsync(id));
  } catch {
    return false;
  }
}

/**
 * True for the scan's `scout_findings` read/submit protocol, under any
 * MCP name shape (`scout_findings`, `mcp__...__scout_findings`, and the
 * legacy `watcher_scout_findings` alias).
 *
 * Ownership is checked, not just the resolved basename: a foreign server that
 * exposes `watcher_scout_findings` (`mcp__github__watcher_scout_findings`)
 * resolves to nothing and is never treated as the scan protocol. When the
 * caller knows the real server (`identity`), that identity is authoritative.
 *
 * @param {unknown} toolName
 * @param {unknown} args
 * @param {import('./mcp/mcp-tool-names.js').McpServerIdentity} [identity]
 * @returns {boolean}
 */
export function isScoutProtocolToolCall(toolName, args, identity) {
  const name = String(toolName || '').trim().toLowerCase();
  if (!name) return false;
  const canonical = resolveCretliBuiltinToolName(name, identity);
  if (canonical === null) return false;
  // `cretli_feedback` is open to every mode by name (create-only report store).
  if (MCP_PLAN_MODE_OPEN_TOOLS.includes(canonical.toLowerCase())) return true;
  if (canonical.toLowerCase() !== SCOUT_PROTOCOL_TOOL) {
    return false;
  }
  const action = String(args && typeof args === 'object' ? args.action || 'list' : 'list')
    .trim()
    .toLowerCase() || 'list';
  return SCOUT_PROTOCOL_ACTIONS.includes(action);
}
