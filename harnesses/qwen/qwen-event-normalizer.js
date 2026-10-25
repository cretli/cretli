/**
 * Maps Qwen Code SDK messages to SDK-shaped chat events.
 * With includePartialMessages, text comes from `stream_event` text_delta (and legacy
 * `partial`). Deltas are absorbed into a growing snapshot so the UI takeStreamDelta
 * path does not concatenate a later full reply on top of tokens. Final `assistant`
 * text is skipped when that snapshot already has the answer.
 */

import {
  buildAssistantDeltaEvent,
  buildAssistantSnapshotEvent,
  buildToolCallEvent,
} from '../../lib/agent-harness/event-normalizer.ts';
import { isFailedQwenToolResult, stringifyQwenToolResult } from './qwen-tool-result.js';
import { readQwenApiErrorFromMessage } from './qwen-api-error.js';
import {
  formatToolSearchResult,
  isFailedToolSearchResult,
  isToolSearchName,
} from '../../lib/agent-harness/tool-search-display.ts';

/**
 * @param {unknown} value
 * @returns {number}
 */
function toTokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * A `result` record carries its failure either as `errors`/`error` strings or
 * as an OpenAI-style `error: { message }` object. All three must reach the run
 * error, or a provider quota statement never gets classified as a usage limit.
 *
 * @param {Record<string, unknown>} rec
 * @returns {string}
 */
function readResultErrorMessage(rec) {
  if (typeof rec.errors === 'string') return rec.errors;
  if (typeof rec.error === 'string') return rec.error;
  const errorObject = asRecord(rec.error);
  if (errorObject && typeof errorObject.message === 'string') return errorObject.message;
  return '';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object') return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * A Qwen `system`/`compact_boundary` message carries `compact_metadata`
 * (`{ trigger, pre_tokens }`). The normalizer must surface it so the room can
 * bump its context epoch — a compaction rewrites the prompt prefix and
 * destroys the ephemeral prompt cache.
 *
 * @param {Record<string, unknown>} rec
 * @returns {Record<string, unknown>}
 */
function buildQwenCompactNotice(rec) {
  const meta = asRecord(rec.compact_metadata)
    || asRecord(asRecord(rec.data)?.compact_metadata)
    || {};
  const trigger = typeof meta.trigger === 'string' ? meta.trigger.trim() : '';
  const notice = {
    kind: 'notice',
    noticeType: 'compact',
    message: trigger === 'auto'
      ? 'Qwen compacted the conversation context automatically.'
      : 'Qwen compacted the conversation context.',
  };
  if (trigger) notice.trigger = trigger;
  const preTokens = toTokenCount(meta.pre_tokens);
  if (preTokens) notice.preTokens = preTokens;
  const postTokens = toTokenCount(meta.post_tokens);
  if (postTokens) notice.postTokens = postTokens;
  return notice;
}

/**
 * Qwen reports per-assistant-message `Usage`; the run-level `result.usage` may
 * only cover the last API call, so a tool loop would otherwise undercount.
 *
 * @param {unknown} usage
 * @returns {boolean}
 */
function hasQwenUsageCounts(usage) {
  const rec = asRecord(usage);
  if (!rec) return false;
  return ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
    .some((key) => toTokenCount(rec[key]) > 0);
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
    // The tool_search miss heuristic ("missing") is meaningful only for
    // tool_search results; applying it to every tool turned successful
    // MCP/run_shell/read_file outputs that merely mention "missing" into errors.
    const failed = markedError
      || isFailedQwenToolResult(result)
      || (isToolSearchName(name) && isFailedToolSearchResult(result));
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
 * @returns {{ normalize: (message: unknown) => Array<Record<string, unknown>>, reset: () => void, flushPendingUsage: () => Record<string, unknown> | null }}
 */
export function createQwenEventNormalizer() {
  let assistantAcc = '';
  let thinkingAcc = '';
  /**
   * True once this turn emitted a per-assistant-message usage event. The
   * `result.usage` is then only a fallback, so the same API call is never
   * counted twice, while a tool loop is still fully counted.
   * @type {boolean}
   */
  let sawAssistantUsage = false;
  /**
   * Latest usage seen on stream events (`message_start` / `message_delta`) of
   * the assistant message in flight. It lets an aborted or failed run flush the
   * tokens it already consumed; a complete assistant message supersedes it.
   * @type {Record<string, number> | null}
   */
  let pendingStreamUsage = null;
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
    return buildAssistantSnapshotEvent(assistantAcc);
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
   * Keeps the largest counter seen per key: stream usage is cumulative.
   * @param {Record<string, unknown>} rec
   * @returns {void}
   */
  function absorbStreamUsage(rec) {
    const event = asRecord(rec.event);
    const usage = asRecord(asRecord(event?.message)?.usage) || asRecord(event?.usage);
    if (!hasQwenUsageCounts(usage)) return;
    const merged = { ...(pendingStreamUsage || {}) };
    for (const [key, value] of Object.entries(usage)) {
      const count = toTokenCount(value);
      if (typeof value === 'number' && count >= (merged[key] || 0)) merged[key] = count;
    }
    pendingStreamUsage = merged;
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
      const subtype = typeof rec.subtype === 'string' ? rec.subtype.trim() : '';
      const compactMetadata = asRecord(rec.compact_metadata)
        || asRecord(asRecord(rec.data)?.compact_metadata);
      if (compactMetadata || subtype === 'compact_boundary') {
        events.push(buildQwenCompactNotice(rec));
      }
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
        pendingStreamUsage = null;
      }
      absorbStreamUsage(rec);
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
      // One API call per assistant message: emit each call's usage so a tool
      // loop is fully counted. `sawAssistantUsage` then keeps the run-level
      // `result.usage` from double counting the same calls below.
      const reported = asRecord(asRecord(rec.message)?.usage) || asRecord(rec.usage);
      const assistantUsage = hasQwenUsageCounts(reported) ? reported : pendingStreamUsage;
      pendingStreamUsage = null;
      if (hasQwenUsageCounts(assistantUsage)) {
        sawAssistantUsage = true;
        events.push({ kind: 'usage', usage: assistantUsage });
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
      /** @type {Array<Record<string, unknown>>} */
      const events = [];
      const usage = asRecord(rec.usage);
      const streamUsage = pendingStreamUsage;
      pendingStreamUsage = null;
      // `result.usage` is a fallback only: when the assistant messages already
      // reported their per-call usage, adding the result total would double
      // count. Qwen exposes no cost field (neither `cost_usd` nor
      // `total_cost_usd` in the SDK type), so no USD is derived here.
      if (usage && !sawAssistantUsage && hasQwenUsageCounts(usage)) {
        const usageEvent = { kind: 'usage', usage };
        if (Number.isFinite(Number(rec.duration_ms))) usageEvent.durationMs = Number(rec.duration_ms);
        if (rec.modelUsage && typeof rec.modelUsage === 'object') usageEvent.modelUsage = rec.modelUsage;
        events.push(usageEvent);
      } else if (!sawAssistantUsage && hasQwenUsageCounts(streamUsage)) {
        events.push({ kind: 'usage', usage: streamUsage });
      }
      sawAssistantUsage = false;
      events.push({
        kind: 'result',
        status: success && subtype !== 'error' ? 'completed' : 'error',
        durationMs: Number.isFinite(Number(rec.duration_ms)) ? Number(rec.duration_ms) : null,
        sessionId,
        resultText: typeof rec.result === 'string' ? rec.result : '',
        errorMessage: readResultErrorMessage(rec),
      });
      return events;
    }
    return [];
  }

  return {
    normalize,
    /**
     * Usage of an assistant message that never completed (abort/error), or
     * null. Consumes it, so a second call returns null.
     * @returns {Record<string, unknown> | null}
     */
    flushPendingUsage: () => {
      const usage = pendingStreamUsage;
      pendingStreamUsage = null;
      return hasQwenUsageCounts(usage) ? { kind: 'usage', usage } : null;
    },
    reset: () => {
      pendingStreamUsage = null;
      resetAssistantTurn();
      sawAssistantUsage = false;
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
