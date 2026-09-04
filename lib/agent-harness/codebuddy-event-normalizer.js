/**
 * Maps CodeBuddy Agent SDK messages to SDK-shaped chat events.
 */

import { buildAssistantDeltaEvent, buildToolCallEvent } from './event-normalizer.js';

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object') return null;
  return /** @type {Record<string, unknown>} */ (value);
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
export function normalizeCodeBuddyMessage(message) {
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
    return [{
      kind: 'result',
      status: success && subtype !== 'error' ? 'completed' : 'error',
      durationMs: Number.isFinite(Number(rec.duration_ms)) ? Number(rec.duration_ms) : null,
      totalCostUsd: Number.isFinite(Number(rec.total_cost_usd)) ? Number(rec.total_cost_usd) : null,
      sessionId,
      resultText: typeof rec.result === 'string' ? rec.result : '',
      errorMessage: typeof rec.errors === 'string'
        ? rec.errors
        : (typeof rec.error === 'string' ? rec.error : ''),
    }];
  }
  return [];
}
