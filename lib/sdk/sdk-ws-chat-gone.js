/** Permanent: the chat row for this WS session no longer exists. */

export const SDK_ERROR_CHAT_NOT_FOUND = 'chat_not_found';

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isSdkChatGoneErrorCode(code) {
  return String(code || '') === SDK_ERROR_CHAT_NOT_FOUND;
}

/**
 * @param {string} [message]
 * @returns {{ type: string, code: string, message: string }}
 */
export function buildSdkChatNotFoundPayload(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  return {
    type: 'sdkError',
    code: SDK_ERROR_CHAT_NOT_FOUND,
    message: text || 'Chat not found for this session.',
  };
}

/**
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {string} [message]
 */
export function sendSdkChatNotFoundAndClose(ws, message) {
  if (!ws) return;
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(buildSdkChatNotFoundPayload(message)));
    } catch {
      // ignore
    }
  }
  try {
    ws.close();
  } catch {
    // ignore
  }
}

/**
 * @param {Iterable<import('ws').WebSocket> | null | undefined} clients
 * @param {string} [message]
 */
export function notifySdkClientsChatGone(clients, message) {
  if (!clients) return;
  for (const ws of clients) {
    sendSdkChatNotFoundAndClose(ws, message);
  }
}
