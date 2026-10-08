/**
 * Shared "agent finished" web-push for every harness.
 *
 * Historically only the Cursor SDK WebSocket path (lib/ws/ws-router.js
 * `onRunFinished`) broadcast this push. Harnesses backed by
 * lib/agent-harness/room-kernel.js (OpenCode, Qwen, Claude, DeepSeek,
 * OpenRouter, CodeBuddy, Codex, local plugins) finish a run in
 * `broadcastRoom` instead, so they need the exact same notification. Both
 * call `notifyAgentFinished`; the per-room `_agentFinishedPushNotified` flag
 * (reset in `beginHarnessRun`) guarantees one push per run even if two finish
 * paths observe the same run.
 *
 * The function is fire-and-forget: it never throws into a run loop, it skips
 * cancelled plan-guard runs, and it bails out before loading chat history when
 * push is unavailable or when no device is subscribed.
 */

import { broadcastPush, isPushAvailable, hasPushSubscriptions } from './push.js';
import { buildAgentFinishedPushData } from './push-inbox-logic.js';
import { loadChatHistory } from './persist/chat-history-persist.js';
import { extractLatestAssistantTextFromHistoryStore } from './todo-plan-sync.js';

/** Run statuses that are not a real "agent finished" moment. */
export const AGENT_FINISHED_SKIPPED_STATUSES = Object.freeze(['plan_guard_cancelled']);

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isSkippedAgentFinishedStatus(status) {
  return AGENT_FINISHED_SKIPPED_STATUSES.includes(String(status || '').trim());
}

/**
 * Title from the room when present, otherwise from the persisted chat list.
 * Lazy `loadChats` keeps this module out of the chats-persist import cycle
 * (chats-persist -> chat-history-persist -> chat-history-notify).
 *
 * @param {string} chatId
 * @param {string} roomTitle
 * @returns {Promise<string>}
 */
async function defaultResolveChatTitle(chatId, roomTitle) {
  const direct = String(roomTitle || '').trim();
  if (direct) return direct;
  if (!chatId) return '';
  try {
    const { loadChats } = await import('./persist/chats-persist.js');
    const chat = loadChats().find((row) => row?.id === chatId) || null;
    return String(chat?.title || '').trim();
  } catch {
    return '';
  }
}

/**
 * @typedef {{
 *   chatId?: unknown,
 *   chatTitle?: unknown,
 *   status?: unknown,
 *   runId?: unknown,
 *   room?: object | null,
 * }} NotifyAgentFinishedInput
 */

/**
 * @typedef {{
 *   isPushAvailable?: () => boolean,
 *   hasPushSubscriptions?: () => boolean,
 *   broadcastPush?: (payload: object) => Promise<unknown>,
 *   loadChatHistory?: (chatId: string) => object | null,
 *   extractLatestAssistantText?: (history: object) => string,
 *   resolveChatTitle?: (chatId: string, roomTitle: string) => Promise<string>,
 * }} NotifyAgentFinishedDeps
 */

/**
 * Fire-and-forget "agent finished" push for one chat run.
 *
 * @param {NotifyAgentFinishedInput} [input]
 * @param {NotifyAgentFinishedDeps} [deps] - test seams; production callers omit.
 * @returns {boolean} whether a push was scheduled.
 */
export function notifyAgentFinished(input = {}, deps = {}) {
  const room = input?.room && typeof input.room === 'object' ? input.room : null;
  const pushAvailable = typeof deps.isPushAvailable === 'function' ? deps.isPushAvailable : isPushAvailable;
  if (!pushAvailable()) return false;
  const status = String(input?.status || '').trim();
  if (isSkippedAgentFinishedStatus(status)) return false;
  const hasSubscriptions = typeof deps.hasPushSubscriptions === 'function'
    ? deps.hasPushSubscriptions
    : hasPushSubscriptions;
  // No subscriber: do not touch chat history at all.
  if (!hasSubscriptions()) return false;
  // One run, one push. The flag is reset by `beginHarnessRun` on the next run.
  if (room && room._agentFinishedPushNotified === true) return false;
  if (room) room._agentFinishedPushNotified = true;

  const chatId = String(input?.chatId ?? room?.chatId ?? '').trim();
  const roomTitle = String(input?.chatTitle ?? room?.chatTitle ?? '').trim();
  const runId = input?.runId ?? room?.runId;
  const loadHistory = typeof deps.loadChatHistory === 'function' ? deps.loadChatHistory : loadChatHistory;
  const extractSnippet = typeof deps.extractLatestAssistantText === 'function'
    ? deps.extractLatestAssistantText
    : extractLatestAssistantTextFromHistoryStore;
  const broadcast = typeof deps.broadcastPush === 'function' ? deps.broadcastPush : broadcastPush;
  const resolveTitle = typeof deps.resolveChatTitle === 'function'
    ? deps.resolveChatTitle
    : defaultResolveChatTitle;

  const url = chatId
    ? `/?source=pwa&panel=chat&chat=${encodeURIComponent(chatId)}`
    : '/?source=pwa&panel=chat';

  void (async () => {
    try {
      const chatTitle = await resolveTitle(chatId, roomTitle);
      const history = chatId ? loadHistory(chatId) : null;
      const headSeq = history && Number.isFinite(history.headSeq) ? history.headSeq : 0;
      const snippet = history ? extractSnippet(history) : '';
      await broadcast({
        title: 'Cretli — agent finished',
        body: `Chat "${chatTitle || chatId || '?'}" — agent run ended (${status || 'done'}).`,
        tag: `cretli-${chatId || 'agent'}`,
        data: buildAgentFinishedPushData({
          chatId,
          chatTitle,
          status,
          runId,
          headSeq,
          snippet,
          url,
        }),
      });
    } catch {
      // A push notification must never break the run that triggered it.
    }
  })();
  return true;
}
