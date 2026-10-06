/**
 * Extract CreatePlan / assistant Markdown from SDK stream events.
 *
 * Harness stream semantics (SDK-shaped events after normalization):
 * - **Cursor SDK / cursor-agent**: each `assistant` event is usually a full message
 *   snapshot; `message.id` identifies the item when present.
 * - **OpenCode / DeepSeek / Codex / CodeBuddy**: `streamTextMode: 'delta'` on
 *   normalized events (token/chunk increments).
 * - **OpenRouter / Qwen / Claude absorbed stream**: `streamTextMode: 'snapshot'`
 *   with growing full text per event.
 * - **Snapshots** replace or grow the current item (`mergeSdkHistoryStreamText` snapshot).
 * - **Deltas** always append on the current item until a stream boundary.
 * - **Stream boundaries** (start a new item): `user` / `localUser`, `tool_call`,
 *   `thinking`, a new `message.id`, or an unrelated snapshot (no prefix relation).
 */

import { isCompletePlanMarkdown, pickRicherPlanMarkdown } from '../chat-plan-markdown.js';
import { extractAssistantPlainText } from '../context-compression.js';
import {
  mergeSdkHistoryStreamText,
  readAssistantStreamTextMode,
} from './sdk-history-stream-coalesce.js';

export { readAssistantStreamTextMode } from './sdk-history-stream-coalesce.js';

/**
 * @param {unknown} previous
 * @param {unknown} next
 * @returns {string}
 */
export function accumulateStreamText(previous, next, mode) {
  return mergeSdkHistoryStreamText(previous, next, mode);
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function readAssistantStreamItemKey(event) {
  if (!event || typeof event !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (event);
  const message = rec.message && typeof rec.message === 'object'
    ? /** @type {Record<string, unknown>} */ (rec.message)
    : null;
  if (message) {
    const id = typeof message.id === 'string' ? message.id.trim() : '';
    if (id) return `msg:${id}`;
  }
  const callId = typeof rec.call_id === 'string' ? rec.call_id.trim()
    : typeof rec.callId === 'string' ? rec.callId.trim() : '';
  if (callId) return `call:${callId}`;
  return '';
}

/**
 * @returns {{
 *   items: Map<string, string>,
 *   order: string[],
 *   activeKey: string,
 *   anonymousSeq: number,
 *   forceNewItem: boolean,
 * }}
 */
export function createRunAssistantStreamCapture() {
  return {
    items: new Map(),
    order: [],
    activeKey: '',
    anonymousSeq: 0,
    forceNewItem: false,
  };
}

/**
 * @param {ReturnType<typeof createRunAssistantStreamCapture>} state
 * @returns {void}
 */
export function resetRunAssistantStreamCapture(state) {
  if (!state) return;
  state.items.clear();
  state.order = [];
  state.activeKey = '';
  state.anonymousSeq = 0;
  state.forceNewItem = false;
}

/**
 * @param {ReturnType<typeof createRunAssistantStreamCapture>} state
 * @returns {string}
 */
export function readRunAssistantStreamCombinedText(state) {
  if (!state) return '';
  /** @type {string[]} */
  const parts = [];
  for (const key of state.order) {
    const text = String(state.items.get(key) || '').trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * @param {ReturnType<typeof createRunAssistantStreamCapture>} state
 * @param {string} key
 * @returns {void}
 */
function ensureCaptureItem(state, key) {
  if (!key || state.items.has(key)) return;
  state.items.set(key, '');
  state.order.push(key);
}

/**
 * @param {ReturnType<typeof createRunAssistantStreamCapture>} state
 * @returns {string}
 */
function allocateAnonymousCaptureKey(state) {
  state.anonymousSeq += 1;
  return `anon:${state.anonymousSeq}`;
}

/**
 * @param {string} previous
 * @param {string} incoming
 * @returns {boolean}
 */
function isSameAssistantStreamItem(previous, incoming) {
  const prev = String(previous || '');
  const next = String(incoming || '');
  if (!prev || !next) return true;
  if (next.startsWith(prev)) return true;
  if (prev.startsWith(next)) return true;
  return false;
}

/**
 * Snapshot events that are not prefix-related start a new assistant item.
 *
 * @param {string} previous
 * @param {string} incoming
 * @param {'delta' | 'snapshot'} mode
 * @returns {boolean}
 */
function shouldSplitAssistantItem(previous, incoming, mode) {
  if (mode === 'delta') return false;
  const prev = String(previous || '');
  const next = String(incoming || '');
  if (!prev || !next) return false;
  if (next.startsWith(prev) || prev.startsWith(next)) return false;
  return true;
}

/**
 * @param {ReturnType<typeof createRunAssistantStreamCapture>} state
 * @param {unknown} event
 * @returns {string} Combined assistant text for the run after this event.
 */
export function noteRunAssistantStreamEvent(state, event) {
  if (!state || !event || typeof event !== 'object') {
    return readRunAssistantStreamCombinedText(state);
  }
  const rec = /** @type {Record<string, unknown>} */ (event);
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (type === 'tool_call' || type === 'thinking' || type === 'user') {
    state.activeKey = '';
    state.forceNewItem = true;
    return readRunAssistantStreamCombinedText(state);
  }
  if (type !== 'assistant') return readRunAssistantStreamCombinedText(state);
  const incoming = extractAssistantPlainText(event);
  if (!incoming.trim()) return readRunAssistantStreamCombinedText(state);
  const streamTextMode = readAssistantStreamTextMode(event);
  const explicitKey = readAssistantStreamItemKey(event);
  let key = explicitKey;
  if (key && state.activeKey && key !== state.activeKey && !state.forceNewItem) {
    const activeText = state.items.get(state.activeKey) || '';
    if (!isSameAssistantStreamItem(activeText, incoming)) {
      state.forceNewItem = false;
    }
  }
  if (state.forceNewItem || !state.activeKey) {
    key = explicitKey || allocateAnonymousCaptureKey(state);
    state.forceNewItem = false;
    state.activeKey = key;
    ensureCaptureItem(state, key);
    state.items.set(key, mergeSdkHistoryStreamText('', incoming, streamTextMode));
    return readRunAssistantStreamCombinedText(state);
  }
  if (explicitKey && explicitKey !== state.activeKey) {
    const activeText = state.items.get(state.activeKey) || '';
    if (!isSameAssistantStreamItem(activeText, incoming)) {
      state.activeKey = explicitKey;
      ensureCaptureItem(state, explicitKey);
      state.items.set(
        explicitKey,
        mergeSdkHistoryStreamText(
          state.items.get(explicitKey) || '',
          incoming,
          streamTextMode,
        ),
      );
      return readRunAssistantStreamCombinedText(state);
    }
  }
  key = state.activeKey;
  ensureCaptureItem(state, key);
  const prev = state.items.get(key) || '';
  if (shouldSplitAssistantItem(prev, incoming, streamTextMode)) {
    key = explicitKey || allocateAnonymousCaptureKey(state);
    state.activeKey = key;
    ensureCaptureItem(state, key);
    state.items.set(key, mergeSdkHistoryStreamText('', incoming, streamTextMode));
    return readRunAssistantStreamCombinedText(state);
  }
  state.items.set(key, mergeSdkHistoryStreamText(prev, incoming, streamTextMode));
  return readRunAssistantStreamCombinedText(state);
}

/**
 * @param {any} room
 * @returns {ReturnType<typeof createRunAssistantStreamCapture>}
 */
export function getRoomRunAssistantStreamCapture(room) {
  if (!room) return createRunAssistantStreamCapture();
  if (!room._runAssistantStreamCapture) {
    room._runAssistantStreamCapture = createRunAssistantStreamCapture();
  }
  return room._runAssistantStreamCapture;
}

/**
 * @param {any} room
 * @returns {void}
 */
export function resetRoomRunAssistantStreamCapture(room) {
  if (!room) return;
  if (!room._runAssistantStreamCapture) {
    room._runAssistantStreamCapture = createRunAssistantStreamCapture();
    return;
  }
  resetRunAssistantStreamCapture(room._runAssistantStreamCapture);
  room._currentRunAssistantText = '';
}

/**
 * @param {any} room
 * @param {unknown} event
 * @returns {string}
 */
export function noteRoomRunAssistantStreamEvent(room, event) {
  const combined = noteRunAssistantStreamEvent(getRoomRunAssistantStreamCapture(room), event);
  if (room) room._currentRunAssistantText = combined;
  return combined;
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function extractPlanTextFromSdkEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (event);
  const args = rec.args && typeof rec.args === 'object'
    ? /** @type {Record<string, unknown>} */ (rec.args)
    : null;
  if (args && typeof args.plan === 'string' && args.plan.trim()) return args.plan.trim();
  const result = rec.result;
  if (result && typeof result === 'object') {
    const row = /** @type {Record<string, unknown>} */ (result);
    if (typeof row.plan === 'string' && row.plan.trim()) return row.plan.trim();
    if (row.success && typeof row.success === 'object') {
      const success = /** @type {Record<string, unknown>} */ (row.success);
      if (typeof success.plan === 'string' && success.plan.trim()) return success.plan.trim();
    }
  }
  return '';
}

/**
 * @param {ReturnType<typeof createRunAssistantStreamCapture>} state
 * @param {Array<{ seq?: number, rec?: unknown }>} events
 * @returns {string}
 */
export function rebuildAssistantTextFromHistoryEvents(state, events) {
  resetRunAssistantStreamCapture(state);
  if (!Array.isArray(events) || events.length === 0) return '';
  const sorted = [...events].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  for (const entry of sorted) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (rec);
    if (record.kind === 'localUser') {
      resetRunAssistantStreamCapture(state);
      continue;
    }
    if (record.kind !== 'sdk' || !record.event || typeof record.event !== 'object') continue;
    noteRunAssistantStreamEvent(state, record.event);
  }
  return readRunAssistantStreamCombinedText(state);
}

/**
 * Rebuild the latest CreatePlan Markdown (or last assistant turn) from persisted SDK events.
 *
 * @param {Array<{ seq?: number, rec?: unknown }>} events
 * @returns {string}
 */
export function extractLatestPlanMarkdownFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return '';
  const sorted = [...events].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  let lastCompletePlan = '';
  let turnPlan = '';
  const turnCapture = createRunAssistantStreamCapture();
  for (const entry of sorted) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (rec);
    if (record.kind === 'localUser') {
      lastCompletePlan = commitTurnPlan(
        lastCompletePlan,
        turnPlan,
        readRunAssistantStreamCombinedText(turnCapture),
      );
      turnPlan = '';
      resetRunAssistantStreamCapture(turnCapture);
      continue;
    }
    if (record.kind !== 'sdk' || !record.event || typeof record.event !== 'object') continue;
    const event = /** @type {Record<string, unknown>} */ (record.event);
    if (event.type === 'user') {
      lastCompletePlan = commitTurnPlan(
        lastCompletePlan,
        turnPlan,
        readRunAssistantStreamCombinedText(turnCapture),
      );
      turnPlan = '';
      resetRunAssistantStreamCapture(turnCapture);
      continue;
    }
    const fromTool = extractPlanTextFromSdkEvent(event);
    if (fromTool) turnPlan = pickRicherPlanMarkdown(turnPlan, fromTool);
    noteRunAssistantStreamEvent(turnCapture, event);
  }
  return commitTurnPlan(
    lastCompletePlan,
    turnPlan,
    readRunAssistantStreamCombinedText(turnCapture),
  );
}

/**
 * @param {string} previousComplete
 * @param {string} turnPlan
 * @param {string} assistantText
 * @returns {string}
 */
function commitTurnPlan(previousComplete, turnPlan, assistantText) {
  const turnText = pickRicherPlanMarkdown(turnPlan, assistantText);
  if (isCompletePlanMarkdown(turnText)) return turnText;
  return previousComplete;
}
