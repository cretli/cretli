/**
 * Shared "new chat created" web-push.
 *
 * Fired by the single chat-creation chokepoint (`addChat` in
 * lib/persist/chats-persist.js), so every path that creates a chat — a user
 * starting one, a delegation child, a todo/Scout chat, the watcher cycle — gets
 * the same notification. Temporary fork chats used internally for titles and
 * summaries opt out at the call site.
 *
 * The function is fire-and-forget: it never throws into chat persistence, bails
 * out before doing any work when push is unavailable or no device is
 * subscribed, and respects the per-endpoint event filter in `broadcastPush`
 * (`events.newChat`).
 */

import { broadcastPush, hasPushSubscriptions, isPushAvailable } from './push.js';
import { buildChatCreatedPushData } from './push-inbox-logic.js';

/**
 * @typedef {{
 *   chatId?: unknown,
 *   chatTitle?: unknown,
 * }} NotifyChatCreatedInput
 */

/**
 * @typedef {{
 *   isPushAvailable?: () => boolean,
 *   hasPushSubscriptions?: () => boolean,
 *   broadcastPush?: (payload: object) => Promise<unknown>,
 * }} NotifyChatCreatedDeps
 */

/**
 * Fire-and-forget "new chat created" push for one chat.
 *
 * @param {NotifyChatCreatedInput} [input]
 * @param {NotifyChatCreatedDeps} [deps] - test seams; production callers omit.
 * @returns {boolean} whether a push was scheduled.
 */
export function notifyChatCreated(input = {}, deps = {}) {
  const chatId = String(input?.chatId || '').trim();
  if (!chatId) return false;
  const pushAvailable = typeof deps.isPushAvailable === 'function' ? deps.isPushAvailable : isPushAvailable;
  if (!pushAvailable()) return false;
  const hasSubscriptions = typeof deps.hasPushSubscriptions === 'function'
    ? deps.hasPushSubscriptions
    : hasPushSubscriptions;
  if (!hasSubscriptions()) return false;
  const broadcast = typeof deps.broadcastPush === 'function' ? deps.broadcastPush : broadcastPush;
  const chatTitle = String(input?.chatTitle || '').trim();
  const url = `/?source=pwa&panel=chat&chat=${encodeURIComponent(chatId)}`;

  void (async () => {
    try {
      const data = buildChatCreatedPushData({ chatId, chatTitle, url });
      await broadcast({
        title: 'Cretli — new chat',
        body: `New chat "${chatTitle || chatId}" created.`,
        tag: `cretli-new-chat-${chatId}`,
        data,
      });
    } catch {
      // A push notification must never break chat creation.
    }
  })();
  return true;
}
