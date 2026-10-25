import { getChatByCursorSessionId } from './persist/chats-persist.js';
import { isChatArchived } from './chat-tree.js';
import { getChatAgentTransport } from './agent-transport.js';
import { HARNESS_PLUGIN_DISABLED_CODE, describeDisabledOptionalHarness, getDisabledOptionalHarness } from './agent-harness/disabled-optional-harness.ts';

/**
 * @param {Record<string, any> | null | undefined} chat
 * @returns {void}
 */
export function assertChatCanReceiveMessages(chat) {
  assertChatPluginEnabled(chat);
  assertChatNotArchived(chat);
}

/**
 * Refuses a chat whose harness plugin is switched off (known id, not loaded).
 * @param {Record<string, any> | null | undefined} chat
 * @returns {void}
 */
export function assertChatPluginEnabled(chat) {
  const disabledPlugin = chat ? getDisabledOptionalHarness(getChatAgentTransport(chat)) : null;
  if (disabledPlugin) {
    throw Object.assign(new Error(describeDisabledOptionalHarness(disabledPlugin)), {
      code: HARNESS_PLUGIN_DISABLED_CODE,
      status: 409,
    });
  }
}

/**
 * Archive-only check: the archive socket guard must not see plugin errors, those
 * are answered by the plugin-specific socket handler.
 * @param {Record<string, any> | null | undefined} chat
 * @returns {void}
 */
export function assertChatNotArchived(chat) {
  if (chat?.archived !== true && !isChatArchived(chat)) return;
  const error = /** @type {Error & { code?: string, status?: number }} */ (
    new Error('Restore the chat from the archive before sending a message.')
  );
  error.code = 'chat_archived';
  error.status = 409;
  throw error;
}

/**
 * Check the persisted row rather than the room's possibly stale chat snapshot.
 * @param {Record<string, any>} room
 * @param {(room: Record<string, any>, payload: Record<string, any>) => void} broadcast
 * @returns {boolean}
 */
export function rejectArchivedRoomPrompt(room, broadcast) {
  try {
    assertChatNotArchived(getChatByCursorSessionId(room.sessionKey));
    return false;
  } catch (error) {
    if (error.code !== 'chat_archived') throw error;
    broadcast(room, { type: 'sdkError', code: error.code, message: error.message });
    return true;
  }
}

/**
 * Filter prompt frames before any built-in or plugin message listener sees
 * them. EventEmitter listeners cannot stop propagation after `message` emits.
 * History, ping and cancellation remain available on an archived chat.
 * @param {import('ws').WebSocket} ws
 * @param {string} sessionKey
 * @returns {void}
 */
export function guardArchivedChatSocket(ws, sessionKey) {
  const originalEmit = ws.emit;
  ws.emit = function emitWithArchiveGuard(event, ...args) {
    if (event === 'message') {
      let message;
      try {
        message = JSON.parse(String(args[0]));
      } catch {
        return originalEmit.call(this, event, ...args);
      }
      if (message?.type === 'send' || message?.type === 'queueForceSend') {
        const blocked = rejectArchivedRoomPrompt({ sessionKey }, (_room, payload) => {
          if (this.readyState === 1) this.send(JSON.stringify(payload));
        });
        if (blocked) return true;
      }
    }
    return originalEmit.call(this, event, ...args);
  };
}
