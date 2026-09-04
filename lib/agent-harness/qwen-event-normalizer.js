/**
 * Maps Qwen Code SDK messages to SDK-shaped chat events.
 * With includePartialMessages, text comes from `stream_event` text_delta (and legacy
 * `partial`). Deltas are absorbed into a growing snapshot so the UI takeStreamDelta
 * path does not concatenate a later full reply on top of tokens. Final `assistant`
 * text is skipped when that snapshot already has the answer.
 */

import { buildAssistantDeltaEvent, buildToolCallEvent } from './event-normalizer.js';
import { isFailedQwenToolResult, stringifyQwenToolResult } from '../qwen/qwen-question.js';
import { readQwenApiErrorFromMessage } from '../qwen/qwen-api-error.js';
import {
  formatToolSearchResult,
  isFailedToolSearchResult,
  isToolSearchName,
} from './tool-search-display.js';

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object') return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {string} previous
 * @param {string} incoming
 * @returns {string}
 */
function absorbStreamText(previous, incoming) {
  const prev = String(previous || '');
  const next = String(incoming || '');
  if (!next) return prev;
  if (!prev) return next;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next) && next.length < prev.length) return prev;
  return prev + next;
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
 * @param {{ includeText?: boolean }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeContentBlock(block, options = {}) {
  const rec = asRecord(block);
  if (!rec) return [];
  const type = typeof rec.type === 'string' ? rec.type : '';
  const includeText = options.includeText !== false;
  const toolCalls = options.toolCalls instanceof Map ? options.toolCalls : null;
  if (includeText && type === 'text' && typeof rec.text === 'string' && rec.text) {
    return [buildAssistantDeltaEvent(rec.text)];
  }
  if (type === 'tool_use') {
    const callId = typeof rec.id === 'string' ? rec.id : '';
    const name = typeof rec.name === 'string' ? rec.name : 'tool';
    const args = asRecord(rec.input) || {};
    if (toolCalls && callId) toolCalls.set(callId, { name, args });
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
    const remembered = callId && toolCalls ? toolCalls.get(callId) : null;
    const rawName = typeof rec.name === 'string' ? rec.name.trim() : '';
    const genericName = !rawName || rawName.toLowerCase() === 'tool';
    const name = genericName && remembered?.name ? remembered.name : (rawName || remembered?.name || 'tool');
    const args = asRecord(remembered?.args) || {};
    let result = stringifyQwenToolResult(rec.content);
    if (isToolSearchName(name)) {
      result = formatToolSearchResult(args, result);
    }
    const markedError = rec.is_error === true || rec.isError === true;
    const failed = markedError || isFailedQwenToolResult(result) || isFailedToolSearchResult(result);
    return [buildToolCallEvent({
      callId,
      name,
      status: failed ? 'error' : 'completed',
      args: Object.keys(args).length > 0 ? args : undefined,
      result,
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
  const contentBlock = asRecord(event?.content_block);
  if (contentBlock && typeof contentBlock.text === 'string' && contentBlock.text) {
    return [{ type: 'text', text: contentBlock.text }];
  }
  return [];
}

/**
 * @param {unknown} message
 * @returns {string}
 */
function readStreamEventType(message) {
  const rec = asRecord(message);
  const event = asRecord(rec?.event);
  return typeof event?.type === 'string' ? event.type : '';
}

/**
 * @param {unknown} message
 * @returns {string}
 */
function readThinkingDelta(message) {
  const rec = asRecord(message);
  const event = asRecord(rec?.event);
  const delta = asRecord(event?.delta) || asRecord(rec?.delta);
  if (!delta) return '';
  if (typeof delta.thinking === 'string' && delta.thinking) return delta.thinking;
  return '';
}

/**
 * Stateful mapper for one Qwen `query()` stream.
 * @returns {{ normalize: (message: unknown) => Array<Record<string, unknown>>, reset: () => void }}
 */
export function createQwenEventNormalizer() {
  let assistantAcc = '';
  let thinkingAcc = '';
  /** @type {Map<string, { name: string, args: Record<string, unknown> }>} */
  const toolCalls = new Map();

  /**
   * @param {string} incoming
   * @returns {Record<string, unknown> | null}
   */
  function emitAbsorbedAssistant(incoming) {
    const next = absorbStreamText(assistantAcc, incoming);
    if (!next || next === assistantAcc) return null;
    assistantAcc = next;
    thinkingAcc = '';
    return buildAssistantDeltaEvent(assistantAcc);
  }

  /**
   * @param {string} incoming
   * @returns {Record<string, unknown> | null}
   */
  function emitAbsorbedThinking(incoming) {
    const next = absorbStreamText(thinkingAcc, incoming);
    if (!next || next === thinkingAcc) return null;
    thinkingAcc = next;
    return { type: 'thinking', text: thinkingAcc };
  }

  /**
   * @returns {void}
   */
  function resetAssistantTurn() {
    assistantAcc = '';
    thinkingAcc = '';
  }

  /**
   * @param {unknown} block
   * @param {{ includeText?: boolean }} [blockOptions]
   * @returns {Array<Record<string, unknown>>}
   */
  function mapBlock(block, blockOptions = {}) {
    return normalizeContentBlock(block, { ...blockOptions, toolCalls });
  }

  /**
   * @param {unknown} message
   * @returns {Array<Record<string, unknown>>}
   */
  function normalize(message) {
    const rec = asRecord(message);
    if (!rec) return [];
    const type = typeof rec.type === 'string' ? rec.type : '';
    if (type === 'system') {
      /** @type {Array<Record<string, unknown>>} */
      const events = [];
      const sessionId = readSessionId(rec);
      if (sessionId) events.push({ kind: 'session', sessionId });
      const apiError = readQwenApiErrorFromMessage(rec);
      if (apiError) {
        events.push({
          kind: 'api_error',
          message: apiError.message,
          errorType: apiError.errorType,
          statusCode: apiError.statusCode,
        });
      }
      return events;
    }
    if (type === 'partial' || type === 'stream_event') {
      const streamType = readStreamEventType(rec);
      if (streamType === 'message_start') {
        resetAssistantTurn();
      }
      const thinkingDelta = readThinkingDelta(rec);
      if (thinkingDelta) {
        const thinkingEvent = emitAbsorbedThinking(thinkingDelta);
        return thinkingEvent ? [thinkingEvent] : [];
      }
      const events = [];
      for (const block of readContentBlocks(rec)) {
        const blockRec = asRecord(block);
        if (blockRec && blockRec.type === 'text' && typeof blockRec.text === 'string') {
          const assistantEvent = emitAbsorbedAssistant(blockRec.text);
          if (assistantEvent) events.push(assistantEvent);
          continue;
        }
        const mapped = mapBlock(block, { includeText: false });
        if (mapped.some((event) => event.type === 'tool_call')) {
          resetAssistantTurn();
        }
        events.push(...mapped);
      }
      return events;
    }
    if (type === 'assistant') {
      const events = [];
      for (const block of readContentBlocks(rec)) {
        const blockRec = asRecord(block);
        if (blockRec && blockRec.type === 'text' && typeof blockRec.text === 'string' && blockRec.text) {
          if (!assistantAcc) {
            const assistantEvent = emitAbsorbedAssistant(blockRec.text);
            if (assistantEvent) events.push(assistantEvent);
          } else {
            assistantAcc = absorbStreamText(assistantAcc, blockRec.text);
          }
          continue;
        }
        const mapped = mapBlock(block, { includeText: false });
        if (mapped.some((event) => event.type === 'tool_call')) {
          resetAssistantTurn();
        }
        events.push(...mapped);
      }
      return events;
    }
    if (type === 'user') {
      resetAssistantTurn();
      const events = [];
      for (const block of readContentBlocks(rec)) {
        events.push(...mapBlock(block));
      }
      return events.filter((event) => event.type === 'tool_call');
    }
    if (type === 'result') {
      resetAssistantTurn();
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

  return {
    normalize,
    reset: () => {
      resetAssistantTurn();
      toolCalls.clear();
    },
  };
}

/**
 * @param {unknown} message
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeQwenMessage(message) {
  return createQwenEventNormalizer().normalize(message);
}
