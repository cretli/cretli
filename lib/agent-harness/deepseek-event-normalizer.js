/**
 * Maps DeepSeek Harness SDK notifications / session events to SDK-shaped chat events.
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
 * DSH puts the id on `callId` (tool/call) or `message.source.callId` (tool/result).
 * @param {Record<string, unknown>} rec
 * @returns {string}
 */
function readToolCallId(rec) {
  if (typeof rec.callId === 'string' && rec.callId.trim()) return rec.callId.trim();
  if (typeof rec.call_id === 'string' && rec.call_id.trim()) return rec.call_id.trim();
  if (typeof rec.tool_use_id === 'string' && rec.tool_use_id.trim()) return rec.tool_use_id.trim();
  if (typeof rec.toolCallId === 'string' && rec.toolCallId.trim()) return rec.toolCallId.trim();
  if (typeof rec.id === 'string' && rec.id.trim()) return rec.id.trim();
  const message = asRecord(rec.message);
  if (!message) return '';
  const source = asRecord(message.source);
  if (source && typeof source.callId === 'string' && source.callId.trim()) {
    return source.callId.trim();
  }
  if (typeof message.callId === 'string' && message.callId.trim()) return message.callId.trim();
  return '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function flattenToolResultText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(flattenToolResultText).filter(Boolean).join('\n');
  }
  const rec = asRecord(value);
  if (!rec) return '';
  if (typeof rec.text === 'string' && rec.text) return rec.text;
  if (rec.content !== undefined) return flattenToolResultText(rec.content);
  if (typeof rec.output === 'string') return rec.output;
  return '';
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {unknown}
 */
function readToolResultPayload(rec) {
  const message = asRecord(rec.message);
  const raw = message?.content ?? rec.content ?? rec.result ?? rec.output;
  const text = flattenToolResultText(raw);
  return text || raw;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function readSessionId(value) {
  const rec = asRecord(value);
  if (!rec) return '';
  if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) return rec.sessionId.trim();
  if (typeof rec.session_id === 'string' && rec.session_id.trim()) return rec.session_id.trim();
  const params = asRecord(rec.params);
  if (params && typeof params.sessionId === 'string' && params.sessionId.trim()) {
    return params.sessionId.trim();
  }
  return '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function readEventType(value) {
  const rec = asRecord(value);
  if (!rec) return '';
  if (typeof rec.type === 'string' && rec.type.trim()) return rec.type.trim();
  if (typeof rec.kind === 'string' && rec.kind.trim()) return rec.kind.trim();
  if (typeof rec.name === 'string' && rec.name.trim()) return rec.name.trim();
  return '';
}

/**
 * @param {unknown} block
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeContentBlock(block) {
  if (typeof block === 'string' && block) {
    return [buildAssistantDeltaEvent(block)];
  }
  const rec = asRecord(block);
  if (!rec) return [];
  const type = typeof rec.type === 'string' ? rec.type : '';
  if ((type === 'text' || type === 'output_text' || !type) && typeof rec.text === 'string' && rec.text) {
    return [buildAssistantDeltaEvent(rec.text)];
  }
  if (type === 'tool_use' || type === 'tool_call' || type === 'function_call') {
    const callId = readToolCallId(rec);
    const name = typeof rec.name === 'string' && rec.name.trim()
      ? rec.name.trim()
      : (typeof rec.tool === 'string' && rec.tool.trim() ? rec.tool.trim() : 'tool');
    const args = asRecord(rec.input) || asRecord(rec.args) || asRecord(rec.arguments) || {};
    return [buildToolCallEvent({
      callId,
      name,
      status: 'running',
      args,
    })];
  }
  if (type === 'tool_result' || type === 'tool_call_result' || type === 'function_call_output') {
    const callId = readToolCallId(rec);
    if (!callId) return [];
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : '';
    const message = asRecord(rec.message);
    const firstBlock = Array.isArray(message?.content) ? asRecord(message.content[0]) : null;
    const isError = Boolean(rec.error || rec.isError || firstBlock?.isError);
    return [buildToolCallEvent({
      callId,
      name: name || 'tool',
      status: isError ? 'error' : 'completed',
      result: readToolResultPayload(rec),
    })];
  }
  return [];
}

/**
 * @param {unknown} event
 * @returns {unknown[]}
 */
function readContentBlocks(event) {
  const rec = asRecord(event);
  if (!rec) return [];
  if (Array.isArray(rec.content)) return rec.content;
  const message = asRecord(rec.message);
  if (message && Array.isArray(message.content)) return message.content;
  if (typeof rec.text === 'string' && rec.text) return [{ type: 'text', text: rec.text }];
  const payload = asRecord(rec.payload);
  if (payload && Array.isArray(payload.content)) return payload.content;
  if (payload && typeof payload.text === 'string' && payload.text) {
    return [{ type: 'text', text: payload.text }];
  }
  return [];
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {Record<string, unknown>}
 */
function unwrapEventPayload(rec) {
  const data = asRecord(rec.data);
  if (!data) return rec;
  return { ...rec, ...data };
}

/**
 * @param {unknown} chunk
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeAssistantChunk(chunk) {
  const rec = asRecord(chunk);
  if (!rec) return [];
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (type === 'text-delta' && typeof rec.text === 'string' && rec.text) {
    return [buildAssistantDeltaEvent(rec.text)];
  }
  if (type === 'reasoning-delta' && typeof rec.text === 'string' && rec.text) {
    return [{ type: 'thinking', text: rec.text }];
  }
  if (type === 'finish') {
    const reason = asRecord(rec.reason);
    const kind = typeof reason?.kind === 'string' ? reason.kind : '';
    if (kind !== 'error' && kind !== 'aborted') return [];
    const failure = asRecord(reason.failure);
    const message = typeof failure?.message === 'string' && failure.message.trim()
      ? failure.message.trim()
      : 'DeepSeek request failed';
    return [buildAssistantDeltaEvent(message)];
  }
  // block-end repeats the assembled ContentBlock already streamed via text-delta.
  return [];
}

/**
 * @param {unknown} event
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeSessionEvent(event) {
  const raw = asRecord(event);
  if (!raw) return [];
  const rec = unwrapEventPayload(raw);
  const type = readEventType(raw).toLowerCase();
  if (
    type.includes('inbox')
    || type.includes('spliced')
    || type === 'user/message'
    || type === 'user'
  ) {
    return [];
  }
  if (type === 'assistant/chunk' || type.includes('chunk')) {
    return normalizeAssistantChunk(rec.chunk);
  }
  // Assembled surface message duplicates text-delta. Skip it so the UI does not
  // append the same reply two extra times (takeStreamDelta concatenates non-prefix text).
  if (type === 'assistant/message' || type === 'assistant') {
    return [];
  }
  if (type.includes('tool') && (type.includes('result') || type.includes('output'))) {
    return normalizeContentBlock({
      ...rec,
      type: 'tool_result',
    });
  }
  if (type.includes('tool') && (type.includes('call') || type.includes('use') || type.includes('start'))) {
    let args = asRecord(rec.input) || asRecord(rec.args) || asRecord(rec.arguments);
    if (!args && typeof rec.arguments === 'string' && rec.arguments.trim()) {
      try {
        const parsed = JSON.parse(rec.arguments);
        args = asRecord(parsed) || {};
      } catch {
        args = { arguments: rec.arguments };
      }
    }
    return normalizeContentBlock({
      ...rec,
      id: rec.callId || rec.id,
      input: args || {},
      type: 'tool_use',
    });
  }
  const fromBlocks = [];
  for (const block of readContentBlocks(rec)) {
    fromBlocks.push(...normalizeContentBlock(block));
  }
  if (fromBlocks.length > 0) return fromBlocks;
  if (typeof rec.text === 'string' && rec.text.trim()) {
    return [buildAssistantDeltaEvent(rec.text)];
  }
  return [];
}

/**
 * @param {unknown} notification
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeDeepSeekNotification(notification) {
  const rec = asRecord(notification);
  if (!rec) return [];
  const method = typeof rec.method === 'string' ? rec.method.trim() : '';
  const params = asRecord(rec.params) || rec;
  const sessionId = readSessionId(rec) || readSessionId(params);
  if (method === 'session.status' || (!method && typeof params.status === 'string' && !params.event)) {
    const status = typeof params.status === 'string' ? params.status.trim() : '';
    if (status !== 'idle' && status !== 'running') return [];
    return [{ kind: 'status', status, sessionId }];
  }
  if (method === 'session.event' || asRecord(params.event) || (!method && rec.type)) {
    const event = method === 'session.event' ? params.event : (params.event || rec);
    const events = normalizeSessionEvent(event);
    if (sessionId && events.length === 0) {
      return [{ kind: 'session', sessionId }];
    }
    return events;
  }
  if (method === 'subagent.started') {
    return [buildAssistantDeltaEvent('\n[subagent started]\n')];
  }
  if (method === 'subagent.finished') {
    const last = params.lastAssistantMessage;
    if (typeof last === 'string' && last.trim()) {
      return [buildAssistantDeltaEvent(last)];
    }
    return [buildAssistantDeltaEvent('\n[subagent finished]\n')];
  }
  return normalizeSessionEvent(rec);
}
