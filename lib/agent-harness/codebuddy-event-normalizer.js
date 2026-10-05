/**
 * Maps CodeBuddy Agent SDK messages to SDK-shaped chat events.
 */

import { buildAssistantDeltaEvent, buildToolCallEvent } from './event-normalizer.js';

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return /** @type {Record<string, unknown>} */ (value);
}

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** One state per prompt, shared by partial and completed message snapshots. */
export function createCodeBuddyUsageState() {
  return { messages: new Map(), aliases: new Map(), activeMessageId: '', total: {} };
}

function readUsageDelta(state, usage, messageId) {
  if (!state) return usage;
  const previous = state.messages.get(messageId) || {};
  const current = { ...previous };
  const delta = {};
  for (const key of USAGE_KEYS) {
    const count = Number(usage[key]);
    if (!Number.isFinite(count) || count < 0) continue;
    current[key] = Math.max(previous[key] || 0, Math.round(count));
    delta[key] = current[key] - (previous[key] || 0);
    state.total[key] = (state.total[key] || 0) + delta[key];
  }
  state.messages.set(messageId, current);
  return Object.values(delta).some((count) => count > 0) ? delta : null;
}

function readMessageUsage(rec, state) {
  const event = asRecord(rec.event);
  const message = asRecord(rec.message) || asRecord(event?.message);
  const messageId = typeof message?.id === 'string' ? message.id : '';
  if (state && event?.type === 'message_start') state.activeMessageId = messageId;
  const usage = asRecord(message?.usage) || asRecord(event?.usage) || asRecord(rec.usage);
  // CodeBuddy gives the full assistant message a different id from message_start.
  if (state && rec.type === 'assistant' && messageId && state.activeMessageId) {
    state.aliases.set(messageId, state.activeMessageId);
  }
  const id = (rec.type === 'assistant' ? state?.activeMessageId : '')
    || state?.aliases.get(messageId) || messageId || state?.activeMessageId
    || (typeof rec.uuid === 'string' ? rec.uuid : '');
  if (!usage || !id) return null;
  const delta = readUsageDelta(state, usage, id);
  if (state && rec.type === 'assistant') state.activeMessageId = '';
  return delta;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function readSessionId(value) {
  const rec = asRecord(value);
  if (!rec) return '';
  if (typeof rec.session_id === 'string' && rec.session_id.trim()) return rec.session_id.trim();
  if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) return rec.sessionId.trim();
  const data = asRecord(rec.data);
  if (data && typeof data.session_id === 'string' && data.session_id.trim()) {
    return data.session_id.trim();
  }
  return '';
}

/**
 * @param {unknown} block
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeContentBlock(block) {
  const rec = asRecord(block);
  if (!rec) return [];
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (type === 'text' && typeof rec.text === 'string' && rec.text) {
    return [buildAssistantDeltaEvent(rec.text)];
  }
  if (type === 'tool_use') {
    const callId = typeof rec.id === 'string' ? rec.id : '';
    const name = typeof rec.name === 'string' ? rec.name : 'tool';
    const args = asRecord(rec.input) || {};
    return [buildToolCallEvent({
      callId,
      name,
      status: 'running',
      args,
    })];
  }
  if (type === 'tool_result') {
    const callId = typeof rec.tool_use_id === 'string'
      ? rec.tool_use_id
      : (typeof rec.id === 'string' ? rec.id : '');
    const name = typeof rec.name === 'string' ? rec.name : 'tool';
    return [buildToolCallEvent({
      callId,
      name,
      status: 'completed',
      result: rec.content,
    })];
  }
  return [];
}

/**
 * @param {unknown} message
 * @param {ReturnType<typeof createCodeBuddyUsageState>} [usageState]
 * @returns {unknown[]}
 */
function readContentBlocks(message) {
  const rec = asRecord(message);
  if (!rec) return [];
  const nested = asRecord(rec.message);
  if (nested && Array.isArray(nested.content)) return nested.content;
  if (Array.isArray(rec.content)) return rec.content;
  const event = asRecord(rec.event);
  const delta = asRecord(event?.delta) || asRecord(rec.delta);
  if (delta && typeof delta.text === 'string' && delta.text) {
    return [{ type: 'text', text: delta.text }];
  }
  return [];
}

/**
 * @param {unknown} message
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeCodeBuddyMessage(message, usageState) {
  const rec = asRecord(message);
  if (!rec) return [];
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (type === 'system') {
    const sessionId = readSessionId(rec);
    if (!sessionId) return [];
    return [{ kind: 'session', sessionId }];
  }
  if (type === 'assistant' || type === 'partial' || type === 'stream_event') {
    const events = [];
    for (const block of readContentBlocks(rec)) {
      events.push(...normalizeContentBlock(block));
    }
    const usage = readMessageUsage(rec, usageState);
    if (usage) events.push({ kind: 'usage', usage });
    return events;
  }
  if (type === 'user') {
    const events = [];
    for (const block of readContentBlocks(rec)) {
      events.push(...normalizeContentBlock(block));
    }
    return events.filter((event) => event.type === 'tool_call');
  }
  if (type === 'result') {
    const subtype = typeof rec.subtype === 'string' ? rec.subtype.trim() : '';
    const success = subtype === 'success' || subtype === '';
    const sessionId = readSessionId(rec);
    /** @type {Array<Record<string, unknown>>} */
    const events = [];
    // The CLI result uses session.usage, which may cover earlier prompts.
    // Prefer measured message usage; only fall back to result when none arrived.
    const hasMessageUsage = usageState && Object.values(usageState.total).some((count) => count > 0);
    const usage = hasMessageUsage ? null : asRecord(rec.usage);
    if (usage) {
      const usageEvent = { kind: 'usage', usage };
      if (Number.isFinite(Number(rec.total_cost_usd))) usageEvent.totalCostUsd = Number(rec.total_cost_usd);
      if (Number.isFinite(Number(rec.duration_ms))) usageEvent.durationMs = Number(rec.duration_ms);
      events.push(usageEvent);
    }
    events.push({
      kind: 'result',
      status: success && subtype !== 'error' ? 'completed' : 'error',
      durationMs: Number.isFinite(Number(rec.duration_ms)) ? Number(rec.duration_ms) : null,
      totalCostUsd: Number.isFinite(Number(rec.total_cost_usd)) ? Number(rec.total_cost_usd) : null,
      sessionId,
      resultText: typeof rec.result === 'string' ? rec.result : '',
      errorMessage: typeof rec.errors === 'string'
        ? rec.errors
        : (typeof rec.error === 'string' ? rec.error : ''),
    });
    return events;
  }
  return [];
}
