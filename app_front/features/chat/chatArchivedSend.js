/**
 * Sending from an archived chat: the composer stays editable and the send asks to restore
 * the chat first. The draft stays in the send bar until the resend accepts it.
 */

const SOCKET_WAIT_MS = 8000;
const SOCKET_POLL_MS = 100;
const SOCKET_OPEN = 1;

/** @type {Set<string>} One dialog per chat, however often Send is pressed. */
const pendingChatIds = new Set();

/**
 * @param {any} chat
 * @param {{
 *   confirmRestore: () => Promise<boolean>,
 *   restoreChat: (chatId: string) => Promise<boolean>,
 *   ensureConnection: (chat: any) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   socketWaitMs?: number,
 * }} deps
 * @returns {Promise<boolean>} true once the draft was handed back to the send bar
 */
export async function restoreChatAndResend(chat, deps) {
  if (!chat?.id || pendingChatIds.has(chat.id)) return false;
  pendingChatIds.add(chat.id);
  try {
    if (!(await deps.confirmRestore())) return false;
    if (!(await deps.restoreChat(chat.id))) return false;
    deps.ensureConnection(chat);
    const sleep = deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
    const socketWaitMs = deps.socketWaitMs ?? SOCKET_WAIT_MS;
    // A socket that never opens falls through to the normal send, which keeps the
    // draft and reports the lost connection.
    for (let waited = 0; chat.ws?.readyState !== SOCKET_OPEN && waited < socketWaitMs; waited += SOCKET_POLL_MS) {
      await sleep(SOCKET_POLL_MS);
    }
    chat.pane?._sendBar?.submit();
    return true;
  } finally {
    pendingChatIds.delete(chat.id);
  }
}
