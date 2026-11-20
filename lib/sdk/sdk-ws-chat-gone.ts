/** Permanent: the chat row for this WS session no longer exists. */

export const SDK_ERROR_CHAT_NOT_FOUND = 'chat_not_found';

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isSdkChatGoneErrorCode(code: unknown): boolean {
  return String(code || '') === SDK_ERROR_CHAT_NOT_FOUND;
}

/**
 * @param {string} [message]
 * @returns {{ type: string, code: string, message: string }}
 */
export function buildSdkChatNotFoundPayload(message?: string): { type: string; code: string; message: string } {
  const text = typeof message === 'string' ? message.trim() : '';
  return {
    type: 'sdkError',
    code: SDK_ERROR_CHAT_NOT_FOUND,
    message: text || 'Chat not found for this session.',
  };
}

/**
 * Structural socket type: importing `ws` types here would pull @types/node into the front
 * typecheck, because the front reaches this module.
 */
export interface SocketLike {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
}

/**
 * @param {SocketLike | null | undefined} ws
 * @param {string} [message]
 */
export function sendSdkChatNotFoundAndClose(ws: SocketLike | null | undefined, message?: string): void {
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
 * @param {Iterable<SocketLike> | null | undefined} clients
 * @param {string} [message]
 */
export function notifySdkClientsChatGone(clients: Iterable<SocketLike> | null | undefined, message?: string): void {
  if (!clients) return;
  for (const ws of clients) {
    sendSdkChatNotFoundAndClose(ws, message);
  }
}
