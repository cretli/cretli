/**
 * Shared "agent finished" web-push for every harness.
 *
 * Historically only the Cursor SDK WebSocket path (lib/ws/ws-router.ts
 * `onRunFinished`) broadcast this push. Harnesses backed by
 * lib/agent-harness/room-kernel.ts (OpenCode, Qwen, Claude, DeepSeek,
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
import { loadChatHistory } from './persist/chat-history-service.js';
import { extractLatestAssistantTextFromHistoryStore } from './todo-plan-sync.js';
import { publishAgentFinishedNotification } from './notifications/notification-producers.ts';

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
 * Stamps `lastFinishedAt` so the sidebar can show "finished, not read yet".
 * Cancelled runs are not a result worth reading. Lazy import keeps this module out
 * of the chats-persist import cycle; failures never reach the run loop.
 *
 * @param {string} chatId
 * @param {string} status
 * @param {{ markChatFinished?: (chatId: string) => void }} deps
 * @returns {void}
 */
function recordChatFinished(chatId, status, deps) {
  if (!chatId || status === 'cancelled') return;
  if (typeof deps.markChatFinished === 'function') {
    deps.markChatFinished(chatId);
    return;
  }
  void import('./persist/chats-persist.js')
    .then((mod) => mod.markChatReadState(chatId, { finishedAt: new Date().toISOString() }))
    .catch(() => {});
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
 *   loadChatHistory?: (chatId: string) => object | null | Promise<object | null>,
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
  const status = String(input?.status || '').trim();
  if (!isSkippedAgentFinishedStatus(status)) {
    const earlyChatId = String(input?.chatId ?? room?.chatId ?? '').trim();
    recordChatFinished(earlyChatId, status, deps);
    const earlyTitle = String(input?.chatTitle ?? room?.chatTitle ?? '').trim();
    const earlyRunId = input?.runId ?? room?.runId;
    // `room._runId` is the durable per-run id minted by `beginHarnessRun` (or the
    // local socket watcher). It is the fingerprint discriminator when a harness
    // event arrives without its own `runId`, so a second finish of the same run
    // cannot resurrect a dismissed in-app notice while a new run still shows.
    const earlyRoomRunId = room?._runId;
    void publishAgentFinishedNotification({
      chatId: earlyChatId,
      chatTitle: earlyTitle,
      status,
      runId: earlyRunId,
      roomRunId: earlyRoomRunId,
      room,
    }).catch((err) => {
      console.warn(
        '[notifications] agent-finished publish failed:',
        err instanceof Error ? err.message : String(err),
      );
    });
  }
  const pushAvailable = typeof deps.isPushAvailable === 'function' ? deps.isPushAvailable : isPushAvailable;
  if (!pushAvailable()) return false;
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
      // The push describes the stored transcript: it waits for the run's buffered records to be acknowledged by
      // the history backend. Records that cannot commit now suppress the push (the room keeps retrying them)
      // instead of announcing a snippet/headSeq the store does not have yet.
      if (room && typeof room._flushHistory === 'function') {
        const flushed = await room._flushHistory();
        if (flushed && flushed.ok === false) {
          room._agentFinishedPushNotified = false;
          console.warn(`[agent-finished-push] suppressed for ${chatId || 'chat'}: ${flushed.pending} history record(s) not durable yet`);
          return;
        }
      }
      const history = chatId ? await loadHistory(chatId) : null;
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
