import { getChatByCursorSessionId } from './persist/chats-persist.js';
import { isChatArchived } from './chat-tree.js';

/**
 * @param {object | null | undefined} chat
 * @returns {void}
 */
export function assertChatCanReceiveMessages(chat) {
  if (chat?.archived !== true && !isChatArchived(chat)) return;
  const error = new Error('Restore the chat from the archive before sending a message.');
  error.code = 'chat_archived';
  error.status = 409;
  throw error;
}

/**
 * Check the persisted row rather than the room's possibly stale chat snapshot.
 * @param {object} room
 * @param {(room: object, payload: object) => void} broadcast
 * @returns {boolean}
 */
export function rejectArchivedRoomPrompt(room, broadcast) {
  try {
    assertChatCanReceiveMessages(getChatByCursorSessionId(room.sessionKey));
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
