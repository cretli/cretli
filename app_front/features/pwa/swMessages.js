/**
 * PWA service-worker -> app messages.
 *
 * public/sw.js cannot switch SPA views itself, so notificationclick posts
 * { type: 'open-chat', chatId, url } to the focused window. This module parses
 * that message and routes it through the normal chat selection without a reload.
 */

export const SW_OPEN_CHAT_MESSAGE = 'open-chat';

/**
 * @param {unknown} data
 * @returns {{ chatId: string, url: string } | null}
 */
export function parseServiceWorkerOpenChatMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (data);
  if (record.type !== SW_OPEN_CHAT_MESSAGE) return null;
  const chatId = String(record.chatId || '').trim();
  if (!chatId) return null;
  return {
    chatId,
    url: typeof record.url === 'string' ? record.url : '',
  };
}

/**
 * Full-reload notification clicks (no window was open) land on a URL with
 * ?source=pwa&chat=<id>. Identify that so the resume log can tell it apart from
 * a normal unlock.
 *
 * @param {string} search
 * @returns {{ notification: true, chatId: string } | null}
 */
export function readNotificationBootInfo(search) {
  let params;
  try {
    params = new URLSearchParams(String(search || ''));
  } catch (_) {
    return null;
  }
  if (params.get('source') !== 'pwa') return null;
  return {
    notification: true,
    chatId: String(params.get('chat') || '').trim(),
  };
}

/**
 * @param {{
 *   onOpenChat: (message: { chatId: string, url: string }) => void,
 *   logger?: { log?: (tag: string, message: string, payload?: object) => void },
 * }} deps
 * @returns {() => void} unbind
 */
export function initServiceWorkerMessages(deps) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {};
  }
  const handler = (event) => {
    const message = parseServiceWorkerOpenChatMessage(event?.data);
    if (!message) return;
    try {
      deps?.onOpenChat?.(message);
    } catch (error) {
      deps?.logger?.log?.('page-resume', 'service worker open-chat failed', {
        error: String(error),
      });
    }
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
