/**
 * Maps DeepSeek Harness SDK notifications / session events to SDK-shaped chat events.
 */

import { buildAssistantDeltaEvent, buildToolCallEvent } from './event-normalizer.js';

const SUBAGENT_TOOL_NAME = 'subagent';
const DEEPSEEK_SUBAGENT_MODELS_HINT = 'deepseek-flash, deepseek-v4-pro';

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
 * DSH carries token accounting only on the assembled `assistant/message`
 * (`data.usage`), never on a dedicated usage event.
 * @param {unknown} event
 * @returns {Record<string, unknown> | null}
 */
function readSessionEventUsage(event) {
  const raw = asRecord(event);
  if (!raw) return null;
  return asRecord(unwrapEventPayload(raw).usage);
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
  // Assembled surface message duplicates text-delta. Skip its text so the UI
  // does not append the same reply two extra times (takeStreamDelta
  // concatenates non-prefix text). Its `usage` is the only token accounting
  // DSH reports (there is no separate usage record), so surface it as a
  // synthetic usage event for the room telemetry hook.
  if (type === 'assistant/message' || type === 'assistant') {
    const usage = asRecord(rec.usage);
    return usage ? [{ type: 'usage', usage }] : [];
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
 * @param {unknown} value
 * @returns {string}
 */
function readTrimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @typedef {{
 *   rootSessionId?: string,
 *   childSessionIds?: Set<string> | string[],
 *   childDiagnostics?: Map<string, string>,
 * }} DeepSeekNotificationScope
 */

/**
 * @param {unknown} sessionId
 * @param {DeepSeekNotificationScope} [scope]
 * @returns {boolean}
 */
export function isDeepSeekChildSessionId(sessionId, scope = {}) {
  const id = readTrimmed(sessionId);
  if (!id) return false;
  const children = scope.childSessionIds;
  if (children instanceof Set && children.has(id)) return true;
  if (Array.isArray(children) && children.includes(id)) return true;
  const root = readTrimmed(scope.rootSessionId);
  return Boolean(root && id !== root);
}

/**
 * @param {string} sessionId
 * @param {DeepSeekNotificationScope} [scope]
 */
function rememberChildSessionId(sessionId, scope = {}) {
  const id = readTrimmed(sessionId);
  if (!id) return;
  const children = scope.childSessionIds;
  if (children instanceof Set) children.add(id);
}

/**
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
function readSubagentCallId(params) {
  return readTrimmed(params.childSessionId)
    || readTrimmed(params.agentId)
    || readSessionId(params);
}

/**
 * DSH `lastAssistantMessage` is `ContentBlock[]` on the wire. Never use
 * `String(object)` — that becomes `[object Object]`.
 * @param {unknown} raw
 * @returns {string}
 */
export function flattenDeepSeekAssistantMessage(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  if (Array.isArray(raw)) {
    return raw.map(flattenDeepSeekAssistantMessage).filter(Boolean).join('\n');
  }
  const rec = asRecord(raw);
  if (!rec) return '';
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (type === 'reasoning' || type === 'tool-call' || type === 'tool_call' || type === 'image') {
    return '';
  }
  if (typeof rec.text === 'string' && rec.text.trim()) return rec.text.trim();
  if (rec.content !== undefined) return flattenDeepSeekAssistantMessage(rec.content);
  return '';
}

/**
 * Error text from a child `session.event` finish / turn-end. Empty for
 * ordinary child streaming so it is never treated as a parent answer.
 * @param {unknown} event
 * @returns {string}
 */
export function readDeepSeekChildErrorText(event) {
  const raw = asRecord(event);
  if (!raw) return '';
  const rec = unwrapEventPayload(raw);
  const type = readEventType(raw).toLowerCase();
  if (type === 'assistant/chunk' || type.includes('chunk')) {
    const chunk = asRecord(rec.chunk) || rec;
    if (String(chunk.type || '') !== 'finish') return '';
    const reason = asRecord(chunk.reason);
    const kind = typeof reason?.kind === 'string' ? reason.kind : '';
    if (kind !== 'error' && kind !== 'aborted') return '';
    const failure = asRecord(reason.failure) || asRecord(reason.error);
    if (failure && typeof failure.message === 'string' && failure.message.trim()) {
      return failure.message.trim();
    }
    return '';
  }
  if (type !== 'turn/end' && !type.endsWith('turn/end')) return '';
  const reason = asRecord(rec.reason);
  if (!reason) return '';
  const kind = typeof reason.kind === 'string' ? reason.kind : '';
  if (kind !== 'error' && kind !== 'aborted') return '';
  const failure = asRecord(reason.failure) || asRecord(reason.error);
  if (failure && typeof failure.message === 'string' && failure.message.trim()) {
    return failure.message.trim();
  }
  if (typeof reason.message === 'string' && reason.message.trim()) return reason.message.trim();
  return '';
}

/**
 * @param {string} sessionId
 * @param {string} text
 * @param {DeepSeekNotificationScope} [scope]
 */
function storeChildDiagnostic(sessionId, text, scope = {}) {
  const id = readTrimmed(sessionId);
  const diagnostic = readTrimmed(text);
  if (!id || !diagnostic) return;
  const map = scope.childDiagnostics;
  if (map instanceof Map) map.set(id, diagnostic);
}

/**
 * @param {string} sessionId
 * @param {DeepSeekNotificationScope} [scope]
 * @returns {string}
 */
function takeStoredChildDiagnostic(sessionId, scope = {}) {
  const id = readTrimmed(sessionId);
  const map = scope.childDiagnostics;
  if (!id || !(map instanceof Map)) return '';
  const diagnostic = readTrimmed(map.get(id));
  map.delete(id);
  return diagnostic;
}

/**
 * @param {unknown} raw
 * @returns {{ isError: boolean, text: string }}
 */
export function describeDeepSeekSubagentResult(raw) {
  const text = flattenDeepSeekAssistantMessage(raw);
  const adapter = text.match(/no adapter registered for provider ["']([^"']+)["']/i);
  if (adapter) {
    return {
      isError: true,
      text: `DeepSeek cannot run provider "${adapter[1]}" as a subagent. Use Cretli delegation_start with a Settings-enabled model for that harness.`,
    };
  }
  if (/supported API model names are/i.test(text) || /but you passed /i.test(text)) {
    return {
      isError: true,
      text: `DeepSeek subagents only accept DeepSeek API models (${DEEPSEEK_SUBAGENT_MODELS_HINT}). Use Cretli delegation_start with a Settings-enabled model for another harness.`,
    };
  }
  return { isError: false, text };
}

/**
 * @param {Record<string, unknown>} params
 * @returns {boolean}
 */
function isFailedSubagentStatus(params) {
  const status = readTrimmed(params.status).toLowerCase();
  const stopRec = asRecord(params.stopReason);
  const stop = (readTrimmed(params.stopReason) || readTrimmed(stopRec?.kind)).toLowerCase();
  return status === 'error' || status === 'failed' || status === 'aborted' || status === 'cancelled'
    || stop === 'error' || stop === 'failed' || stop === 'aborted' || stop === 'cancelled';
}

/**
 * @param {Record<string, unknown>} params
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeSubagentStarted(params) {
  const callId = readSubagentCallId(params);
  if (!callId) return [];
  /** @type {Record<string, string>} */
  const args = {};
  const provider = readTrimmed(params.provider);
  const model = readTrimmed(params.model);
  const parentSessionId = readTrimmed(params.parentSessionId);
  if (provider) args.provider = provider;
  if (model) args.model = model;
  if (parentSessionId) args.parentSessionId = parentSessionId;
  return [buildToolCallEvent({
    callId,
    name: SUBAGENT_TOOL_NAME,
    status: 'running',
    args,
  })];
}

/**
 * @param {Record<string, unknown>} params
 * @param {DeepSeekNotificationScope} [scope]
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeSubagentFinished(params, scope = {}) {
  const callId = readSubagentCallId(params);
  if (!callId) return [];
  rememberChildSessionId(callId, scope);
  const fromMessage = flattenDeepSeekAssistantMessage(params.lastAssistantMessage);
  const storedDiagnostic = takeStoredChildDiagnostic(callId, scope);
  const status = readTrimmed(params.status).toLowerCase();
  const stop = readTrimmed(asRecord(params.stopReason)?.kind || params.stopReason).toLowerCase();
  const explicitlyCompleted = status === 'ok' || status === 'completed' || stop === 'completed';
  const described = describeDeepSeekSubagentResult(
    fromMessage || (!explicitlyCompleted ? storedDiagnostic : ''),
  );
  const failed = described.isError || isFailedSubagentStatus(params);
  return [buildToolCallEvent({
    callId,
    name: SUBAGENT_TOOL_NAME,
    status: failed ? 'error' : 'completed',
    result: described.text || (failed ? 'DeepSeek subagent failed.' : ''),
  })];
}

/**
 * @param {unknown} notification
 * @param {DeepSeekNotificationScope} [scope]
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeDeepSeekNotification(notification, scope = {}) {
  const rec = asRecord(notification);
  if (!rec) return [];
  const method = typeof rec.method === 'string' ? rec.method.trim() : '';
  const params = asRecord(rec.params) || rec;
  const sessionId = readSessionId(rec) || readSessionId(params);
  if (method === 'session.status' || (!method && typeof params.status === 'string' && !params.event)) {
    const status = typeof params.status === 'string' ? params.status.trim() : '';
    if (status !== 'idle' && status !== 'running') return [];
    const child = isDeepSeekChildSessionId(sessionId, scope);
    if (child) rememberChildSessionId(sessionId, scope);
    return [{ kind: 'status', status, sessionId, ...(child ? { child: true } : {}) }];
  }
  if (method === 'session.event' || asRecord(params.event) || (!method && rec.type)) {
    const event = method === 'session.event' ? params.event : (params.event || rec);
    if (isDeepSeekChildSessionId(sessionId, scope)) {
      rememberChildSessionId(sessionId, scope);
      storeChildDiagnostic(sessionId, readDeepSeekChildErrorText(event), scope);
      // In-process subagent usage is real token spend; forward it (attributed to
      // the parent room) while still suppressing the child's text/tool surface.
      const childUsage = readSessionEventUsage(event);
      if (childUsage) return [{ type: 'usage', usage: childUsage }];
      return sessionId ? [{ kind: 'session', sessionId, child: true }] : [];
    }
    const events = normalizeSessionEvent(event);
    if (sessionId && events.length === 0) {
      return [{ kind: 'session', sessionId }];
    }
    return events;
  }
  if (method === 'subagent.started') {
    rememberChildSessionId(readSubagentCallId(params), scope);
    return normalizeSubagentStarted(params);
  }
  if (method === 'subagent.finished') return normalizeSubagentFinished(params, scope);
  return normalizeSessionEvent(rec);
}
