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

import {
  buildAssistantDeltaEvent,
  buildAssistantSnapshotEvent,
  buildToolCallEvent,
} from './event-normalizer.js';

/**
 * Friendly server-side (EN) messages for `SDKAssistantMessageError` codes.
 * The UI shows the message; `errorType` keeps the raw code for diagnostics.
 * @type {Readonly<Record<string, string>>}
 */
export const CLAUDE_ASSISTANT_ERROR_MESSAGES = Object.freeze({
  authentication_failed:
    'Claude authentication failed. Check your Anthropic API key or supported cloud provider credentials.',
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
    'Claude cloud credentials are invalid. Check your credentials with the configured cloud provider.',
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
 * @param {unknown} value
 * @returns {number}
 */
function toTokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * Normalizes SDK `result.usage` (`BetaUsage`) into the camelCase token bag the
 * frontend understands. `inputTokens` includes cache reads/writes, matching
 * `estimateEffectiveUsageInputTokens` in `lib/sdk/sdk-context-advisory.js`.
 *
 * @param {unknown} message
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number, cacheReadTokens: number, cacheWriteTokens: number } | null}
 */
export function resolveClaudeResultUsage(message) {
  const rec = asRecord(message);
  if (!rec) return null;
  const usage = asRecord(rec.usage);
  if (!usage) return null;
  const cacheReadTokens = toTokenCount(
    usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? usage.cacheReadInputTokens,
  );
  const cacheWriteTokens = toTokenCount(
    usage.cache_creation_input_tokens
      ?? usage.cache_creation_tokens
      ?? usage.cacheCreationInputTokens,
  );
  const inputTokens = toTokenCount(usage.input_tokens ?? usage.inputTokens)
    + cacheReadTokens
    + cacheWriteTokens;
  const outputTokens = toTokenCount(usage.output_tokens ?? usage.outputTokens);
  if (inputTokens === 0 && outputTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * `rate_limit_event` → advisory notice (never sets the run error).
 *
 * @param {unknown} message
 * @returns {Record<string, unknown> | null}
 */
export function buildClaudeRateLimitNotice(message) {
  const rec = asRecord(message);
  const info = asRecord(rec?.rate_limit_info);
  if (!info) return null;
  const status = typeof info.status === 'string' ? info.status.trim() : '';
  const resetsAt = Number.isFinite(Number(info.resetsAt)) ? Number(info.resetsAt) : null;
  let text = 'Claude rate limit update.';
  if (status === 'rejected') text = 'Claude rate limit reached.';
  else if (status === 'allowed_warning') text = 'Claude is nearing its rate limit.';
  else if (status === 'allowed') text = 'Claude rate limit is OK.';
  if (resetsAt) {
    // Anthropic reports epoch seconds; accept epoch ms too.
    const date = new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt);
    if (!Number.isNaN(date.getTime())) text += ` Resets at ${date.toISOString()}.`;
  }
  const notice = { kind: 'notice', noticeType: 'rate_limit', message: text };
  if (status) notice.status = status;
  if (resetsAt) notice.resetsAt = resetsAt;
  // SDK utilization is a fraction; the shared plan contract uses percent.
  const rateLimitType = typeof info.rateLimitType === 'string' ? info.rateLimitType.trim() : '';
  if (rateLimitType) notice.rateLimitType = rateLimitType;
  if (info.utilization != null && info.utilization !== '' && Number.isFinite(Number(info.utilization))) {
    notice.utilization = Number(info.utilization) * 100;
  }
  const overageStatus = typeof info.overageStatus === 'string' ? info.overageStatus.trim() : '';
  if (overageStatus) notice.overageStatus = overageStatus;
  if (info.isUsingOverage === true) notice.isUsingOverage = true;
  return notice;
}

/**
 * `system`/`compact_boundary` → advisory notice.
 *
 * @param {Record<string, unknown>} rec
 * @returns {Record<string, unknown>}
 */
function buildClaudeCompactNotice(rec) {
  const meta = asRecord(rec.compact_metadata) || {};
  const trigger = typeof meta.trigger === 'string' ? meta.trigger.trim() : '';
  const notice = {
    kind: 'notice',
    noticeType: 'compact',
    message: trigger === 'auto'
      ? 'Claude compacted the conversation context automatically.'
      : 'Claude compacted the conversation context.',
  };
  if (trigger) notice.trigger = trigger;
  const preTokens = toTokenCount(meta.pre_tokens);
  if (preTokens) notice.preTokens = preTokens;
  const postTokens = toTokenCount(meta.post_tokens);
  if (postTokens) notice.postTokens = postTokens;
  return notice;
}

/**
 * Notices carried by a `system` message.
 *
 * @param {Record<string, unknown>} rec
 * @returns {Array<Record<string, unknown>>}
 */
function buildClaudeSystemNotices(rec) {
  const subtype = typeof rec.subtype === 'string' ? rec.subtype : '';
  if (subtype === 'permission_denied') {
    // Advisory only: a denied tool call must not fail the whole run.
    const toolName = typeof rec.tool_name === 'string' ? rec.tool_name.trim() : '';
    const reason = typeof rec.decision_reason === 'string' ? rec.decision_reason.trim() : '';
    return [{
      kind: 'notice',
      noticeType: 'permission_denied',
      message: reason || (toolName
        ? `Permission denied for tool ${toolName}`
        : 'Claude denied a tool call'),
      toolName,
      errorType: 'permission_denied',
    }];
  }
  if (subtype === 'api_retry') {
    // The SDK retries on its own; surface it as progress, not as an error.
    return [{
      kind: 'notice',
      noticeType: 'api_retry',
      message: 'Claude API request failed and will be retried.',
      attempt: Number.isFinite(Number(rec.attempt)) ? Number(rec.attempt) : 0,
      max_retries: Number.isFinite(Number(rec.max_retries)) ? Number(rec.max_retries) : 0,
      retry_delay_ms: Number.isFinite(Number(rec.retry_delay_ms)) ? Number(rec.retry_delay_ms) : 0,
      error: typeof rec.error === 'string' ? rec.error : '',
    }];
  }
  if (subtype === 'compact_boundary') return [buildClaudeCompactNotice(rec)];
  return [];
}

/**
 * Notices safe to broadcast outside an active turn: a between-turn message
 * must never attach answer content to the next turn, only its session id and
 * these advisories.
 *
 * @param {unknown} message
 * @returns {Array<Record<string, unknown>>}
 */
export function collectClaudeIdleNotices(message) {
  const rec = asRecord(message);
  if (!rec) return [];
  const type = typeof rec.type === 'string' ? rec.type : '';
  if (type === 'rate_limit_event') {
    const notice = buildClaudeRateLimitNotice(rec);
    return notice ? [notice] : [];
  }
  if (type === 'system') return buildClaudeSystemNotices(rec);
  return [];
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
      events.push(...buildClaudeSystemNotices(rec));
      return events;
    }
    if (type === 'rate_limit_event') {
      const notice = buildClaudeRateLimitNotice(rec);
      return notice ? [notice] : [];
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
      /** @type {Array<Record<string, unknown>>} */
      const events = [];
      const usage = resolveClaudeResultUsage(rec);
      if (usage) {
        /** @type {Record<string, unknown>} */
        const usageEvent = { kind: 'usage', usage };
        if (Number.isFinite(Number(rec.total_cost_usd))) {
          usageEvent.totalCostUsd = Number(rec.total_cost_usd);
        }
        if (Number.isFinite(Number(rec.duration_ms))) {
          usageEvent.durationMs = Number(rec.duration_ms);
        }
        const modelUsage = asRecord(rec.modelUsage);
        if (modelUsage) usageEvent.modelUsage = modelUsage;
        events.push(usageEvent);
      }
      events.push({
        kind: 'result',
        status: isError ? 'error' : 'completed',
        durationMs: Number.isFinite(Number(rec.duration_ms)) ? Number(rec.duration_ms) : null,
        totalCostUsd: Number.isFinite(Number(rec.total_cost_usd)) ? Number(rec.total_cost_usd) : null,
        sessionId,
        resultText,
        errorMessage,
      });
      return events;
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
