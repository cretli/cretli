/**
 * PWA web-push when a harness is waiting on the user (question or permission).
 * Reuses the VAPID subscriptions stored for agent-finished notifications.
 */

import { broadcastPush, isPushAvailable } from './push.js';

const BODY_MAX = 140;
const TITLE_MAX = 60;

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function clipText(value, max = BODY_MAX) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function readAgentNeedsInputDetail(event) {
  if (!event || typeof event !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (event);
  const type = String(record.type || '');
  if (type === 'opencode_permission') {
    const action = String(record.action || '').trim();
    const metadata = record.metadata && typeof record.metadata === 'object'
      ? /** @type {Record<string, unknown>} */ (record.metadata)
      : null;
    const command = typeof metadata?.command === 'string' ? metadata.command.trim() : '';
    const resource = Array.isArray(record.resources)
      ? String(record.resources[0] || '').trim()
      : '';
    const extra = command || resource;
    if (action && extra) return `${action}: ${extra}`;
    return action || extra;
  }
  if (type === 'opencode_question') {
    const first = Array.isArray(record.questions) ? record.questions[0] : null;
    if (!first || typeof first !== 'object') return '';
    const row = /** @type {Record<string, unknown>} */ (first);
    const question = typeof row.question === 'string' ? row.question.trim() : '';
    const header = typeof row.header === 'string' ? row.header.trim() : '';
    return question || header;
  }
  return '';
}

/**
 * @param {{
 *   chatId?: unknown,
 *   chatTitle?: unknown,
 *   kind?: unknown,
 *   requestId?: unknown,
 *   detail?: unknown,
 * }} input
 * @returns {{ title: string, body: string, tag: string, data: object } | null}
 */
export function buildAgentNeedsInputPushPayload(input) {
  const kind = input?.kind === 'permission' ? 'permission' : input?.kind === 'question' ? 'question' : '';
  if (!kind) return null;
  const chatId = String(input?.chatId || '').trim();
  const chatTitle = clipText(String(input?.chatTitle || '').trim() || chatId || '?', TITLE_MAX);
  const requestId = String(input?.requestId || '').trim();
  const detail = clipText(input?.detail || '');
  const chatLabel = `"${chatTitle}"`;
  const url = chatId
    ? `/?source=pwa&panel=chat&chat=${encodeURIComponent(chatId)}`
    : '/?source=pwa&panel=chat';
  if (kind === 'permission') {
    return {
      title: 'Cretli — agent needs permission',
      body: detail
        ? `Chat ${chatLabel} is waiting: ${detail}`
        : `Chat ${chatLabel} is waiting for a permission.`,
      tag: `cretli-ask-${chatId || 'agent'}-${requestId || 'permission'}`,
      data: { type: 'agent-needs-input', kind, chatId, url },
    };
  }
  return {
    title: 'Cretli — agent asked a question',
    body: detail
      ? `Chat ${chatLabel}: ${detail}`
      : `Chat ${chatLabel} is waiting for an answer.`,
    tag: `cretli-ask-${chatId || 'agent'}-${requestId || 'question'}`,
    data: { type: 'agent-needs-input', kind, chatId, url },
  };
}

/**
 * Fire-and-forget push for a pending question or permission SDK event.
 * @param {{ room?: { chatId?: unknown, chatTitle?: unknown } | null, event?: unknown }} input
 * @returns {void}
 */
export function notifyAgentNeedsInput(input) {
  if (!isPushAvailable()) return;
  const event = input?.event;
  if (!event || typeof event !== 'object') return;
  const type = String(/** @type {Record<string, unknown>} */ (event).type || '');
  const kind = type === 'opencode_permission'
    ? 'permission'
    : type === 'opencode_question'
      ? 'question'
      : '';
  if (!kind) return;
  const room = input?.room || null;
  const payload = buildAgentNeedsInputPushPayload({
    chatId: room?.chatId,
    chatTitle: room?.chatTitle,
    kind,
    requestId: /** @type {Record<string, unknown>} */ (event).requestId,
    detail: readAgentNeedsInputDetail(event),
  });
  if (!payload) return;
  void broadcastPush(payload).catch(() => {});
}
