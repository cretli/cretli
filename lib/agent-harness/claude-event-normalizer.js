/**
 * Maps Claude Agent SDK messages to SDK-shaped chat events.
 *
 * The SDK emits Anthropic Messages API shapes:
 * - `system` / subtype `init` — session metadata (session_id)
 * - `stream_event` — raw Messages stream events (with includePartialMessages)
 * - `assistant` — a full assistant message with text / thinking / tool_use blocks
 * - `user` — tool_result blocks
 * - `result` — end of turn, success or error
 *
 * Text deltas are absorbed into a growing snapshot so the UI takeStreamDelta
 * path does not concatenate a later full reply on top of tokens.
 */

import { buildAssistantDeltaEvent, buildToolCallEvent } from './event-normalizer.js';

/**
 * Friendly server-side (EN) messages for `SDKAssistantMessageError` codes.
 * The UI shows the message; `errorType` keeps the raw code for diagnostics.
 * @type {Readonly<Record<string, string>>}
 */
export const CLAUDE_ASSISTANT_ERROR_MESSAGES = Object.freeze({
  authentication_failed:
    'Claude authentication failed. Run claude login or claude setup-token, or check the API key.',
  oauth_org_not_allowed:
    'This Claude organization is not allowed to use Claude Code. Contact your organization admin.',
  account_on_hold: 'This Claude account is on hold. Contact Anthropic support.',
  verification_required: 'Claude requires account verification. Finish verification, then retry.',
  billing_error: 'Claude billing failed. Check your plan or payment method.',
  rate_limit: 'Claude rate limit reached. Try again later.',
  overloaded: 'Claude is temporarily overloaded. Try again later.',
  invalid_request: 'Claude rejected the request as invalid. Check the prompt and model settings.',
  model_not_found: 'The selected Claude model was not found. Choose a different model.',
  server_error: 'Claude server error. Try again later.',
  unknown: 'Claude run failed for an unknown reason.',
  max_output_tokens: 'Claude stopped because it reached the maximum output tokens.',
  cloud_credential_error:
    'Claude cloud credentials are invalid. Sign in again with claude login or claude setup-token.',
});

/**
 * @param {unknown} code
 * @returns {string}
 */
export function resolveClaudeAssistantErrorMessage(code) {
  const key = typeof code === 'string' ? code.trim() : '';
  if (key && Object.prototype.hasOwnProperty.call(CLAUDE_ASSISTANT_ERROR_MESSAGES, key)) {
    return CLAUDE_ASSISTANT_ERROR_MESSAGES[key];
  }
  return key ? `Claude run failed (${key}).` : 'Claude run failed.';
}


/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
 * `parent_tool_use_id` marks messages produced by a subagent (Task tool).
 * They must not leak into the main assistant answer.
 *
 * @param {unknown} message
 * @returns {string}
 */
function readParentToolUseId(message) {
  const rec = asRecord(message);
  if (!rec) return '';
  const raw = rec.parent_tool_use_id;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return '';
}

/**
 * @param {Record<string, unknown>} event
 * @param {string} parentToolUseId
 * @returns {Record<string, unknown>}
 */
function tagParentToolUse(event, parentToolUseId) {
  if (!parentToolUseId) return event;
  return { ...event, parentToolUseId };
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
  return '';
}

/**
 * @param {unknown} content
 * @returns {string}
 */
export function stringifyClaudeToolResult(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        const rec = asRecord(block);
        if (rec && typeof rec.text === 'string') return rec.text;
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .filter(Boolean)
      .join('\n');
  }
  const rec = asRecord(content);
  if (rec && typeof rec.text === 'string') return rec.text;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * @param {unknown} block
 * @param {{ includeText?: boolean, toolCalls?: Map<string, { name: string, args: Record<string, unknown> }> }} [options]
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
    const name = rawName || remembered?.name || 'tool';
    const args = asRecord(remembered?.args) || {};
    const result = stringifyClaudeToolResult(rec.content);
    const failed = rec.is_error === true || rec.isError === true;
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
  if (contentBlock && typeof contentBlock.type === 'string') return [contentBlock];
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
 * Stateful mapper for one Claude `query()` stream.
 * @returns {{ normalize: (message: unknown) => Array<Record<string, unknown>>, reset: () => void }}
 */
export function createClaudeEventNormalizer() {
  let assistantAcc = '';
  let thinkingAcc = '';
  /** @type {Map<string, { name: string, args: Record<string, unknown> }>} */
  const toolCalls = new Map();
  /**
   * A `tool_use` may appear both in a partial stream event and in the final
   * `assistant` message. Emit exactly one `running` tool_call per call_id.
   * @type {Set<string>}
   */
  const announcedToolCalls = new Set();

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
    const mapped = normalizeContentBlock(block, { ...blockOptions, toolCalls });
    /** @type {Array<Record<string, unknown>>} */
    const out = [];
    for (const event of mapped) {
      if (event.type === 'tool_call' && event.status === 'running') {
        const callId = typeof event.call_id === 'string' ? event.call_id : '';
        if (callId) {
          if (announcedToolCalls.has(callId)) continue;
          announcedToolCalls.add(callId);
        }
      }
      out.push(event);
    }
    return out;
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
      const subtype = typeof rec.subtype === 'string' ? rec.subtype : '';
      if (subtype === 'permission_denied') {
        // Advisory only: a denied tool call must not fail the whole run.
        const toolName = typeof rec.tool_name === 'string' ? rec.tool_name.trim() : '';
        const reason = typeof rec.decision_reason === 'string' ? rec.decision_reason.trim() : '';
        events.push({
          kind: 'notice',
          noticeType: 'permission_denied',
          message: reason || (toolName
            ? `Permission denied for tool ${toolName}`
            : 'Claude denied a tool call'),
          toolName,
          errorType: 'permission_denied',
        });
      } else if (subtype === 'api_retry') {
        // The SDK retries on its own; surface it as progress, not as an error.
        events.push({
          kind: 'notice',
          noticeType: 'api_retry',
          message: 'Claude API request failed and will be retried.',
          attempt: Number.isFinite(Number(rec.attempt)) ? Number(rec.attempt) : 0,
          max_retries: Number.isFinite(Number(rec.max_retries)) ? Number(rec.max_retries) : 0,
          retry_delay_ms: Number.isFinite(Number(rec.retry_delay_ms)) ? Number(rec.retry_delay_ms) : 0,
          error: typeof rec.error === 'string' ? rec.error : '',
        });
      }
      return events;
    }
    if (type === 'stream_event') {
      const parentToolUseId = readParentToolUseId(rec);
      // Subagent stream chunks never touch the main answer (text/thinking
      // accumulators stay untouched) and are dropped here.
      if (parentToolUseId) return [];
      const streamType = readStreamEventType(rec);
      if (streamType === 'message_start') resetAssistantTurn();
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
        // `tool_use` is announced only by the full `assistant` message. A
        // stream `content_block_start` carries an empty input that would let
        // the plan guard misclassify a mutating call as read-only.
        if (blockRec && blockRec.type === 'tool_use') {
          resetAssistantTurn();
          continue;
        }
        const mapped = mapBlock(block, { includeText: false });
        if (mapped.some((event) => event.type === 'tool_call')) resetAssistantTurn();
        events.push(...mapped);
      }
      const delta = asRecord(asRecord(rec.event)?.delta) || asRecord(rec.delta);
      if (events.length === 0 && delta && typeof delta.text === 'string' && delta.text) {
        const assistantEvent = emitAbsorbedAssistant(delta.text);
        if (assistantEvent) events.push(assistantEvent);
      }
      return events;
    }
    if (type === 'assistant') {
      const parentToolUseId = readParentToolUseId(rec);
      const events = [];
      if (typeof rec.error === 'string' && rec.error) {
        const errorType = rec.error.trim();
        events.push({
          kind: 'api_error',
          message: resolveClaudeAssistantErrorMessage(errorType),
          errorType,
          statusCode: null,
        });
      }
      for (const block of readContentBlocks(rec)) {
        const blockRec = asRecord(block);
        if (blockRec && blockRec.type === 'text' && typeof blockRec.text === 'string' && blockRec.text) {
          if (parentToolUseId) continue;
          if (!assistantAcc) {
            const assistantEvent = emitAbsorbedAssistant(blockRec.text);
            if (assistantEvent) events.push(assistantEvent);
          } else {
            assistantAcc = absorbStreamText(assistantAcc, blockRec.text);
          }
          continue;
        }
        const mapped = mapBlock(block, { includeText: false });
        if (mapped.some((event) => event.type === 'tool_call') && !parentToolUseId) {
          resetAssistantTurn();
        }
        events.push(...mapped.map((event) => tagParentToolUse(event, parentToolUseId)));
      }
      return events;
    }
    if (type === 'user') {
      const parentToolUseId = readParentToolUseId(rec);
      if (!parentToolUseId) resetAssistantTurn();
      const events = [];
      for (const block of readContentBlocks(rec)) {
        events.push(...mapBlock(block).map((event) => tagParentToolUse(event, parentToolUseId)));
      }
      return events.filter((event) => event.type === 'tool_call');
    }
    if (type === 'result') {
      resetAssistantTurn();
      const subtype = typeof rec.subtype === 'string' ? rec.subtype.trim() : '';
      const isError = rec.is_error === true || subtype.startsWith('error') || subtype === 'error';
      const sessionId = readSessionId(rec);
      const errors = Array.isArray(rec.errors)
        ? rec.errors.map((entry) => String(entry || '')).filter(Boolean).join('\n')
        : '';
      const resultText = typeof rec.result === 'string' ? rec.result : '';
      let errorMessage = '';
      if (isError) errorMessage = errors || resultText || 'Claude run failed';
      return [{
        kind: 'result',
        status: isError ? 'error' : 'completed',
        durationMs: Number.isFinite(Number(rec.duration_ms)) ? Number(rec.duration_ms) : null,
        totalCostUsd: Number.isFinite(Number(rec.total_cost_usd)) ? Number(rec.total_cost_usd) : null,
        sessionId,
        resultText,
        errorMessage,
      }];
    }
    return [];
  }

  return {
    normalize,
    reset: () => {
      resetAssistantTurn();
      toolCalls.clear();
      announcedToolCalls.clear();
    },
  };
}

/**
 * @param {unknown} message
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeClaudeMessage(message) {
  return createClaudeEventNormalizer().normalize(message);
}
