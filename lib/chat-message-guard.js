import { getChatByCursorSessionIdAsync } from './persist/chats-persist.js';
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
 * Check the persisted row rather than the room's possibly stale chat snapshot; it is read through the active chats runtime.
 * @param {Record<string, any>} room
 * @param {(room: Record<string, any>, payload: Record<string, any>) => void} broadcast
 * @returns {Promise<boolean>}
 */
export async function rejectArchivedRoomPromptAsync(room, broadcast) {
  const chat = await getChatByCursorSessionIdAsync(room.sessionKey);
  return rejectArchivedRow(() => chat, room, broadcast);
}

/**
 * @param {() => Record<string, any> | null | undefined} readChat
 * @param {Record<string, any>} room
 * @param {(room: Record<string, any>, payload: Record<string, any>) => void} broadcast
 * @returns {boolean}
 */
function rejectArchivedRow(readChat, room, broadcast) {
  try {
    assertChatNotArchived(readChat());
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
  // The archive check is async now. Once a prompt frame is waiting for it, every later frame of this socket queues
  // behind it so a cancel or history request can never overtake the prompt it follows.
  let queue = Promise.resolve();
  let pending = 0;
  /** @type {(event: string, args: any[]) => Promise<void>} */
  const dispatch = async (event, args) => {
    let message = null;
    try {
      message = JSON.parse(String(args[0]));
    } catch {
      // not JSON: forwarded untouched below
    }
    if (message?.type === 'send' || message?.type === 'queueForceSend') {
      const blocked = await rejectArchivedRoomPromptAsync({ sessionKey }, (_room, payload) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(payload));
      });
      if (blocked) return;
    }
    originalEmit.call(ws, event, ...args);
  };
  /** Resolves when every frame queued behind an archive check has been dispatched (tests, shutdown). */
  /** @type {any} */ (ws).whenArchiveGuardIdle = () => queue;
  ws.emit = function emitWithArchiveGuard(event, ...args) {
    if (event !== 'message') return originalEmit.call(this, event, ...args);
    let message = null;
    try {
      message = JSON.parse(String(args[0]));
    } catch {
      // not JSON
    }
    const isPrompt = message?.type === 'send' || message?.type === 'queueForceSend';
    if (!isPrompt && pending === 0) return originalEmit.call(this, event, ...args);
    pending += 1;
    queue = queue
      .then(() => dispatch(event, args))
      .catch(() => {})
      .finally(() => { pending -= 1; });
    return true;
  };
}
