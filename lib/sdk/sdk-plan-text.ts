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
} from './sdk-history-stream-coalesce.ts';

export { readAssistantStreamTextMode } from './sdk-history-stream-coalesce.ts';

type StreamTextMode = ReturnType<typeof readAssistantStreamTextMode>;

type RunAssistantStreamCapture = {
  items: Map<string, string>;
  order: string[];
  activeKey: string;
  anonymousSeq: number;
  forceNewItem: boolean;
};

type RoomLike = {
  _runAssistantStreamCapture?: RunAssistantStreamCapture;
  _currentRunAssistantText?: string;
};

type HistoryEventEntry = { seq?: number; rec?: unknown };

export function accumulateStreamText(previous: string, next: string, mode?: StreamTextMode): string {
  return mergeSdkHistoryStreamText(previous, next, mode);
}

export function readAssistantStreamItemKey(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const rec = (event as Record<string, unknown>);
  const message = rec.message && typeof rec.message === 'object'
    ? (rec.message as Record<string, unknown>)
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

export function createRunAssistantStreamCapture(): RunAssistantStreamCapture {
  return {
    items: new Map(),
    order: [],
    activeKey: '',
    anonymousSeq: 0,
    forceNewItem: false,
  };
}

export function resetRunAssistantStreamCapture(state: RunAssistantStreamCapture): void {
  if (!state) return;
  state.items.clear();
  state.order = [];
  state.activeKey = '';
  state.anonymousSeq = 0;
  state.forceNewItem = false;
}

export function readRunAssistantStreamCombinedText(state: RunAssistantStreamCapture): string {
  if (!state) return '';
  const parts: string[] = [];
  for (const key of state.order) {
    const text = String(state.items.get(key) || '').trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function ensureCaptureItem(state: RunAssistantStreamCapture, key: string): void {
  if (!key || state.items.has(key)) return;
  state.items.set(key, '');
  state.order.push(key);
}

function allocateAnonymousCaptureKey(state: RunAssistantStreamCapture): string {
  state.anonymousSeq += 1;
  return `anon:${state.anonymousSeq}`;
}

function isSameAssistantStreamItem(previous: string, incoming: string): boolean {
  const prev = String(previous || '');
  const next = String(incoming || '');
  if (!prev || !next) return true;
  if (next.startsWith(prev)) return true;
  if (prev.startsWith(next)) return true;
  return false;
}

/**
 * Snapshot events that are not prefix-related start a new assistant item.
 */
function shouldSplitAssistantItem(previous: string, incoming: string, mode: StreamTextMode): boolean {
  if (mode === 'delta') return false;
  const prev = String(previous || '');
  const next = String(incoming || '');
  if (!prev || !next) return false;
  if (next.startsWith(prev) || prev.startsWith(next)) return false;
  return true;
}

/**
 * @returns Combined assistant text for the run after this event.
 */
export function noteRunAssistantStreamEvent(state: RunAssistantStreamCapture, event: unknown): string {
  if (!state || !event || typeof event !== 'object') {
    return readRunAssistantStreamCombinedText(state);
  }
  const rec = (event as Record<string, unknown>);
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

export function getRoomRunAssistantStreamCapture(room: RoomLike | null | undefined): RunAssistantStreamCapture {
  if (!room) return createRunAssistantStreamCapture();
  if (!room._runAssistantStreamCapture) {
    room._runAssistantStreamCapture = createRunAssistantStreamCapture();
  }
  return room._runAssistantStreamCapture;
}

export function resetRoomRunAssistantStreamCapture(room: RoomLike | null | undefined): void {
  if (!room) return;
  if (!room._runAssistantStreamCapture) {
    room._runAssistantStreamCapture = createRunAssistantStreamCapture();
    return;
  }
  resetRunAssistantStreamCapture(room._runAssistantStreamCapture);
  room._currentRunAssistantText = '';
}

export function noteRoomRunAssistantStreamEvent(room: RoomLike | null | undefined, event: unknown): string {
  const combined = noteRunAssistantStreamEvent(getRoomRunAssistantStreamCapture(room), event);
  if (room) room._currentRunAssistantText = combined;
  return combined;
}

export function extractPlanTextFromSdkEvent(event: unknown): string {
  if (!event || typeof event !== 'object') return '';
  const rec = (event as Record<string, unknown>);
  const args = rec.args && typeof rec.args === 'object'
    ? (rec.args as Record<string, unknown>)
    : null;
  if (args && typeof args.plan === 'string' && args.plan.trim()) return args.plan.trim();
  const result = rec.result;
  if (result && typeof result === 'object') {
    const row = (result as Record<string, unknown>);
    if (typeof row.plan === 'string' && row.plan.trim()) return row.plan.trim();
    if (row.success && typeof row.success === 'object') {
      const success = (row.success as Record<string, unknown>);
      if (typeof success.plan === 'string' && success.plan.trim()) return success.plan.trim();
    }
  }
  return '';
}

export function rebuildAssistantTextFromHistoryEvents(state: RunAssistantStreamCapture, events: HistoryEventEntry[]): string {
  resetRunAssistantStreamCapture(state);
  if (!Array.isArray(events) || events.length === 0) return '';
  const sorted = [...events].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  for (const entry of sorted) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = (rec as Record<string, unknown>);
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
 */
export function extractLatestPlanMarkdownFromEvents(events: HistoryEventEntry[]): string {
  if (!Array.isArray(events) || events.length === 0) return '';
  const sorted = [...events].sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0));
  let lastCompletePlan = '';
  let turnPlan = '';
  const turnCapture = createRunAssistantStreamCapture();
  for (const entry of sorted) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    const record = (rec as Record<string, unknown>);
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
    const event = (record.event as Record<string, unknown>);
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

function commitTurnPlan(previousComplete: string, turnPlan: string, assistantText: string): string {
  const turnText = pickRicherPlanMarkdown(turnPlan, assistantText);
  if (isCompletePlanMarkdown(turnText)) return turnText;
  return previousComplete;
}
