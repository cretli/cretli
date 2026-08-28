/**
 * Maps OpenCode SSE events to SDK-shaped chat events for rich view + history.
 */

import {
  buildAssistantDeltaEvent,
  buildAssistantFullEvent,
  buildToolCallEvent,
} from './event-normalizer.js';

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function textsOverlap(a, b) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const sample = Math.min(left.length, right.length, 120);
  if (sample < 24) return left === right;
  return left.slice(0, sample) === right.slice(0, sample)
    || left.includes(right)
    || right.includes(left);
}

/**
 * @param {{
 *   partTextAcc?: Map<string, string>,
 *   assistantTextByMessageId?: Map<string, string>,
 *   thinkingTextByMessageId?: Map<string, string>,
 * }} context
 */
function ensureStreamContext(context) {
  if (!context.partTextAcc) context.partTextAcc = new Map();
  if (!context.assistantTextByMessageId) context.assistantTextByMessageId = new Map();
  if (!context.thinkingTextByMessageId) context.thinkingTextByMessageId = new Map();
}

/**
 * @param {Record<string, unknown>} context
 * @param {string} messageId
 * @param {string} chunk
 */
function noteAssistantText(context, messageId, chunk) {
  if (!messageId || !chunk) return;
  ensureStreamContext(context);
  const prev = context.assistantTextByMessageId.get(messageId) || '';
  context.assistantTextByMessageId.set(messageId, prev + chunk);
}

/**
 * @param {Record<string, unknown>} part
 * @param {Record<string, unknown>} properties
 * @param {Record<string, unknown>} context
 * @returns {Array<Record<string, unknown>>}
 */
function emitAssistantTextFromPart(part, properties, context) {
  const messageId = typeof part.messageID === 'string' ? part.messageID : '';
  const partId = typeof part.id === 'string' ? part.id : messageId;
  const delta = typeof properties.delta === 'string' ? properties.delta : '';
  const fullText = typeof part.text === 'string' ? part.text : '';
  const lastPrompt = String(context.lastUserPromptText || '').trim();
  ensureStreamContext(context);
  const thinkingText = messageId ? (context.thinkingTextByMessageId.get(messageId) || '') : '';
  const accKey = partId || messageId;
  const prev = accKey ? (context.partTextAcc.get(accKey) || '') : '';
  if (delta) {
    const next = prev + delta;
    if (lastPrompt && next.trim() === lastPrompt) return [];
    if (thinkingText && textsOverlap(thinkingText, next)) return [];
    if (accKey) context.partTextAcc.set(accKey, next);
    noteAssistantText(context, messageId, delta);
    return [buildAssistantDeltaEvent(delta)];
  }
  if (!fullText) return [];
  if (lastPrompt && fullText.trim() === lastPrompt) return [];
  if (fullText === prev) return [];
  if (thinkingText && textsOverlap(thinkingText, fullText)) return [];
  if (fullText.startsWith(prev)) {
    const slice = fullText.slice(prev.length);
    if (accKey) context.partTextAcc.set(accKey, fullText);
    if (!slice) return [];
    if (thinkingText && textsOverlap(thinkingText, fullText)) return [];
    noteAssistantText(context, messageId, slice);
    return [buildAssistantDeltaEvent(slice)];
  }
  if (accKey) context.partTextAcc.set(accKey, fullText);
  noteAssistantText(context, messageId, fullText);
  return [buildAssistantFullEvent(fullText)];
}

/**
 * @param {Record<string, unknown>} part
 * @param {Record<string, unknown>} context
 * @returns {Array<Record<string, unknown>>}
 */
function emitReasoningFromPart(part, context) {
  const messageId = typeof part.messageID === 'string' ? part.messageID : '';
  const fullText = typeof part.text === 'string' ? part.text : '';
  if (!fullText) return [];
  ensureStreamContext(context);
  const assistantText = messageId ? (context.assistantTextByMessageId.get(messageId) || '') : '';
  if (textsOverlap(assistantText, fullText)) return [];
  if (messageId) context.thinkingTextByMessageId.set(messageId, fullText);
  return [{ type: 'thinking', text: fullText }];
}

/**
 * @param {string} modelValue
 * @returns {{ providerID: string, modelID: string } | null}
 */
export function parseOpenCodeModel(modelValue) {
  const raw = String(modelValue || '').trim();
  if (!raw) return null;
  const slashIndex = raw.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= raw.length - 1) return null;
  return {
    providerID: raw.slice(0, slashIndex),
    modelID: raw.slice(slashIndex + 1),
  };
}

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string, messageRegistry?: import('./opencode-message-registry.js').OpenCodeMessageRegistry, lastUserPromptText?: string, partTextAcc?: Map<string, string>, assistantTextByMessageId?: Map<string, string>, thinkingTextByMessageId?: Map<string, string> }} [context]
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeOpenCodeEvent(event, context = {}) {
  if (!event || typeof event !== 'object') return [];
  const type = typeof event.type === 'string' ? event.type : '';
  const sessionId = context.opencodeSessionId ? String(context.opencodeSessionId) : '';
  const properties = event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!properties) return [];
  if (sessionId) {
    const eventSessionId = typeof properties.sessionID === 'string'
      ? properties.sessionID
      : typeof properties.sessionId === 'string'
        ? properties.sessionId
        : '';
    if (eventSessionId && eventSessionId !== sessionId) return [];
  }
  const registry = context.messageRegistry || null;
  if (type === 'message.updated') {
    return [];
  }
  if (type === 'message.part.delta') {
    const messageId = typeof properties.messageID === 'string' ? properties.messageID : '';
    const partId = typeof properties.partID === 'string' ? properties.partID : messageId;
    const field = typeof properties.field === 'string' ? properties.field : '';
    const delta = typeof properties.delta === 'string' ? properties.delta : '';
    if (!delta || field !== 'text') return [];
    if (registry && messageId && registry.getRole(messageId) !== 'assistant') return [];
    ensureStreamContext(context);
    const thinkingText = messageId ? (context.thinkingTextByMessageId.get(messageId) || '') : '';
    const assistantText = messageId ? (context.assistantTextByMessageId.get(messageId) || '') : '';
    const next = assistantText + delta;
    if (thinkingText && textsOverlap(thinkingText, next)) return [];
    const accKey = partId || messageId;
    if (accKey) {
      const prevPart = context.partTextAcc.get(accKey) || '';
      context.partTextAcc.set(accKey, prevPart + delta);
    }
    noteAssistantText(context, messageId, delta);
    return [buildAssistantDeltaEvent(delta)];
  }
  if (type === 'message.part.updated') {
    const part = properties.part && typeof properties.part === 'object' ? properties.part : null;
    if (!part) return [];
    if (registry) {
      if (registry.isUserPart(part)) return [];
      if (!registry.isAssistantPart(part)) return [];
    }
    if (part.type === 'text') {
      return emitAssistantTextFromPart(part, properties, context);
    }
    if (part.type === 'reasoning') {
      return emitReasoningFromPart(part, context);
    }
    if (part.type === 'tool') {
      const callId = typeof part.callID === 'string' ? part.callID : part.id;
      const toolName = typeof part.tool === 'string' ? part.tool : 'tool';
      const state = part.state && typeof part.state === 'object' ? part.state : {};
      const statusRaw = typeof state.status === 'string' ? state.status : 'running';
      const status = statusRaw === 'completed'
        ? 'completed'
        : statusRaw === 'error'
          ? 'error'
          : statusRaw === 'pending'
            ? 'pending'
            : 'running';
      return [buildToolCallEvent({
        callId: String(callId || toolName),
        name: toolName,
        status,
        args: state.input && typeof state.input === 'object'
          ? /** @type {Record<string, unknown>} */ (state.input)
          : undefined,
        result: status === 'completed' && typeof state.output === 'string' ? state.output : undefined,
      })];
    }
    return [];
  }
  if (type === 'permission.updated') {
    const title = typeof properties.title === 'string' ? properties.title.trim() : 'Permission required';
    return [{
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `[OpenCode] ${title} — approve in OpenCode terminal if prompted.` }],
      },
    }];
  }
  if (type === 'session.error') {
    const message = formatOpenCodeSessionError(properties.error);
    return [{
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `[OpenCode error] ${message}` }],
      },
    }];
  }
  return [];
}

/**
 * @param {unknown} error
 * @returns {string}
 */
export function formatOpenCodeSessionError(error) {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (!error || typeof error !== 'object') return 'OpenCode session error';
  const record = /** @type {Record<string, unknown>} */ (error);
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  const data = record.data && typeof record.data === 'object'
    ? /** @type {Record<string, unknown>} */ (record.data)
    : null;
  if (data && typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof record.name === 'string' && record.name.trim()) return record.name.trim();
  return 'OpenCode session error';
}

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {'busy' | 'idle' | null}
 */
export function resolveOpenCodeSessionActivity(event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  const type = typeof event.type === 'string' ? event.type : '';
  const sessionId = context.opencodeSessionId ? String(context.opencodeSessionId) : '';
  const properties = event.properties && typeof event.properties === 'object'
    ? event.properties
    : null;
  if (!properties) return null;
  const eventSessionId = typeof properties.sessionID === 'string' ? properties.sessionID : '';
  if (sessionId && eventSessionId && eventSessionId !== sessionId) return null;
  if (type === 'session.idle') return 'idle';
  if (type === 'session.status') {
    const status = properties.status && typeof properties.status === 'object' ? properties.status : null;
    if (!status || typeof status.type !== 'string') return null;
    if (status.type === 'busy') return 'busy';
    if (status.type === 'idle') return 'idle';
  }
  return null;
}

/**
 * Simulates WS stream handling for tests (registry + normalize).
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string, messageRegistry?: import('./opencode-message-registry.js').OpenCodeMessageRegistry, lastUserPromptText?: string, partTextAcc?: Map<string, string>, assistantTextByMessageId?: Map<string, string>, thinkingTextByMessageId?: Map<string, string> }} context
 * @returns {Array<Record<string, unknown>>}
 */
export function processOpenCodeStreamEventForHarness(event, context) {
  const registry = context.messageRegistry;
  if (registry && event && typeof event === 'object' && event.type === 'message.updated') {
    const properties = event.properties && typeof event.properties === 'object' ? event.properties : null;
    if (properties?.info) registry.noteMessageUpdated(properties.info);
  }
  return normalizeOpenCodeEvent(event, context);
}
