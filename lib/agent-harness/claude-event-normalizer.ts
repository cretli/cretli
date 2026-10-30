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
} from './event-normalizer.ts';

/**
 * Friendly server-side (EN) messages for `SDKAssistantMessageError` codes.
 * The UI shows the message; `errorType` keeps the raw code for diagnostics.
 */
export const CLAUDE_ASSISTANT_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
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

export function resolveClaudeAssistantErrorMessage(code: unknown): string {
  const key = typeof code === 'string' ? code.trim() : '';
  if (key && Object.prototype.hasOwnProperty.call(CLAUDE_ASSISTANT_ERROR_MESSAGES, key)) {
    return CLAUDE_ASSISTANT_ERROR_MESSAGES[key];
  }
  return key ? `Claude run failed (${key}).` : 'Claude run failed.';
}


function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return (value as Record<string, unknown>);
}

function toTokenCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

export interface ClaudeUsageBag {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

/**
 * Normalizes one raw Anthropic `BetaUsage` bag into the camelCase token bag the
 * frontend understands. `inputTokens` includes cache reads/writes, matching
 * `estimateEffectiveUsageInputTokens` in `lib/sdk/sdk-context-advisory.ts`.
 *
 * The `cache_creation.ephemeral_5m/1h_input_tokens` breakdown is a
 * sub-breakdown of `cacheWriteTokens` (Anthropic bills both TTLs as cache
 * writes), so it is reported as diagnostic fields and never added again.
 */
export function resolveClaudeUsageBag(rawUsage: unknown): ClaudeUsageBag | null {
  const usage = asRecord(rawUsage);
  if (!usage) return null;
  const cacheReadTokens = toTokenCount(
    usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? usage.cacheReadInputTokens,
  );
  const cacheWriteTokens = toTokenCount(
    usage.cache_creation_input_tokens
      ?? usage.cache_creation_tokens
      ?? usage.cacheCreationInputTokens,
  );
  const cacheCreation = asRecord(usage.cache_creation) || {};
  const cacheWrite5mTokens = toTokenCount(cacheCreation.ephemeral_5m_input_tokens);
  const cacheWrite1hTokens = toTokenCount(cacheCreation.ephemeral_1h_input_tokens);
  const inputTokens = toTokenCount(usage.input_tokens ?? usage.inputTokens)
    + cacheReadTokens
    + cacheWriteTokens;
  const outputTokens = toTokenCount(usage.output_tokens ?? usage.outputTokens);
  if (inputTokens === 0 && outputTokens === 0) return null;
  const resolved: ClaudeUsageBag = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
  if (cacheWrite5mTokens) resolved.cacheWrite5mTokens = cacheWrite5mTokens;
  if (cacheWrite1hTokens) resolved.cacheWrite1hTokens = cacheWrite1hTokens;
  return resolved;
}

/**
 * Normalizes SDK `result.usage` (`BetaUsage`) into the camelCase token bag the
 * frontend understands. `inputTokens` includes cache reads/writes, matching
 * `estimateEffectiveUsageInputTokens` in `lib/sdk/sdk-context-advisory.ts`.
 */
export function resolveClaudeResultUsage(message: unknown): ReturnType<typeof resolveClaudeUsageBag> {
  const rec = asRecord(message);
  if (!rec) return null;
  return resolveClaudeUsageBag(rec.usage);
}

/**
 * Normalizes the per-API-call usage carried by an `assistant` message (nested
 * under `message.usage`) or a partial stream `message_start`. The Anthropic
 * `result.usage` is the run-level total; this per-message bag is what makes the
 * first API call of a run observable (a warm cache reads, a cold one writes).
 */
export function resolveClaudeAssistantMessageUsage(message: unknown): ReturnType<typeof resolveClaudeUsageBag> {
  const rec = asRecord(message);
  if (!rec) return null;
  const nested = asRecord(rec.message);
  const fromMessage = resolveClaudeUsageBag(nested?.usage);
  if (fromMessage) return fromMessage;
  // A partial stream `message_start` carries the same usage under `event.message`.
  const event = asRecord(rec.event);
  const eventMessage = asRecord(event?.message);
  return resolveClaudeUsageBag(eventMessage?.usage ?? rec.usage);
}

function readClaudeAssistantModel(rec: Record<string, unknown>): string | null {
  const message = asRecord(rec.message);
  const model = typeof message?.model === 'string' ? message.model.trim() : '';
  // SDK-synthesised messages (for example API errors) use a `<...>` placeholder.
  return model && !model.startsWith('<') ? model : null;
}

/**
 * @param rec `assistant` or `stream_event` wrapper
 */
function readClaudeCallMessageId(rec: Record<string, unknown>): string {
  const message = asRecord(rec.message) || asRecord(asRecord(rec.event)?.message);
  return typeof message?.id === 'string' ? message.id.trim() : '';
}

/**
 * Context window the SDK reports for a model in `result.modelUsage`. It is the
 * only authoritative source: the same model id runs on a 200K or a 1M window
 * depending on the account, so a static per-model table can be off by 5x.
 */
export function readClaudeModelContextWindow(modelUsage: unknown, model: unknown): number | null {
  const key = typeof model === 'string' ? model.trim() : '';
  const row = key ? asRecord(asRecord(modelUsage)?.[key]) : null;
  const windowTokens = toTokenCount(row?.contextWindow);
  return windowTokens > 0 ? windowTokens : null;
}

/**
 * `rate_limit_event` → advisory notice (never sets the run error).
 */
export function buildClaudeRateLimitNotice(message: unknown): Record<string, unknown> | null {
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
  const notice: Record<string, unknown> = { kind: 'notice', noticeType: 'rate_limit', message: text };
  if (status) notice.status = status;
  if (resetsAt) notice.resetsAt = resetsAt;
  // SDK utilization is a fraction; the shared plan contract uses percent.
  const rateLimitType = typeof info.rateLimitType === 'string' ? info.rateLimitType.trim() : '';
  if (rateLimitType) notice.rateLimitType = rateLimitType;
  // Only a real number (or a numeric string) is a reading: null, '', booleans
  // and junk stay unknown instead of becoming 0%. The unit is unconfirmed (see
  // docs/claude/sdk-limits-context-contract.md §10); this is the single x100
  // site on the notice path and the notice then carries percent.
  const rawUtilization = typeof info.utilization === 'number'
    ? info.utilization
    : (typeof info.utilization === 'string' && info.utilization.trim() !== '' ? Number(info.utilization) : NaN);
  if (Number.isFinite(rawUtilization)) notice.utilization = rawUtilization * 100;
  const overageStatus = typeof info.overageStatus === 'string' ? info.overageStatus.trim() : '';
  if (overageStatus) notice.overageStatus = overageStatus;
  if (info.isUsingOverage === true) notice.isUsingOverage = true;
  return notice;
}

/**
 * `system`/`compact_boundary` → advisory notice.
 */
function buildClaudeCompactNotice(rec: Record<string, unknown>): Record<string, unknown> {
  const meta = asRecord(rec.compact_metadata) || {};
  const trigger = typeof meta.trigger === 'string' ? meta.trigger.trim() : '';
  const notice: Record<string, unknown> = {
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
 */
function buildClaudeSystemNotices(rec: Record<string, unknown>): Array<Record<string, unknown>> {
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
 */
export function collectClaudeIdleNotices(message: unknown): Array<Record<string, unknown>> {
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

function readClaudeOriginKind(rec: Record<string, unknown>): string {
  const origin = asRecord(rec.origin);
  return origin && typeof origin.kind === 'string' ? origin.kind : '';
}

function readClaudeResultUserMessageUuids(rec: Record<string, unknown>): string[] | null {
  if (!Array.isArray(rec.user_message_uuids)) return null;
  return rec.user_message_uuids.filter((id) => typeof id === 'string' && id);
}

/**
 * True for a normalized `result`/`usage` item of a task-notification turn that
 * does not answer `userMessageUuid`. On resume the CLI reports a task stopped
 * by the previous process as an empty turn (`num_turns: 0`) right before the
 * user's prompt; settling on that result would end the run before it started.
 */
export function isForeignClaudeResultItem(item: unknown, userMessageUuid: unknown): boolean {
  const rec = asRecord(item);
  if (!rec || rec.originKind !== 'task-notification') return false;
  const covered = Array.isArray(rec.userMessageUuids) ? rec.userMessageUuids : [];
  return !userMessageUuid || !covered.includes(userMessageUuid);
}

/** True for model output of the main thread, not of a subagent. */
export function isClaudeMainThreadContent(message: unknown): boolean {
  const rec = asRecord(message);
  if (!rec || (rec.type !== 'assistant' && rec.type !== 'stream_event')) return false;
  return !readParentToolUseId(rec);
}

function absorbStreamText(previous: string, incoming: string): string {
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
 */
function readParentToolUseId(message: unknown): string {
  const rec = asRecord(message);
  if (!rec) return '';
  const raw = rec.parent_tool_use_id;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return '';
}

function tagParentToolUse(event: Record<string, unknown>, parentToolUseId: string): Record<string, unknown> {
  if (!parentToolUseId) return event;
  return { ...event, parentToolUseId };
}

function readSessionId(value: unknown): string {
  const rec = asRecord(value);
  if (!rec) return '';
  if (typeof rec.session_id === 'string' && rec.session_id.trim()) return rec.session_id.trim();
  if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) return rec.sessionId.trim();
  return '';
}

export function stringifyClaudeToolResult(content: unknown): string {
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

function normalizeContentBlock(block: unknown, options: { includeText?: boolean, toolCalls?: Map<string, { name: string, args: Record<string, unknown> }> } = {}): Array<Record<string, unknown>> {
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

function readContentBlocks(message: unknown): unknown[] {
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

function readStreamEventType(message: unknown): string {
  const rec = asRecord(message);
  const event = asRecord(rec?.event);
  return typeof event?.type === 'string' ? event.type : '';
}

function readThinkingDelta(message: unknown): string {
  const rec = asRecord(message);
  const event = asRecord(rec?.event);
  const delta = asRecord(event?.delta) || asRecord(rec?.delta);
  if (!delta) return '';
  if (typeof delta.thinking === 'string' && delta.thinking) return delta.thinking;
  return '';
}

/**
 * Stateful mapper for one Claude `query()` stream.
 */
export function createClaudeEventNormalizer(): { normalize: (message: unknown) => Array<Record<string, unknown>>, reset: () => void } {
  let assistantAcc = '';
  let thinkingAcc = '';
  const toolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  /**
   * A `tool_use` may appear both in a partial stream event and in the final
   * `assistant` message. Emit exactly one `running` tool_call per call_id.
   */
  const announcedToolCalls = new Set<string>();
  /**
   * Usage of the first main-thread API call in the current turn (a run starts
   * cold, later calls read the prompt cache), captured so callers can tell a
   * warm cache from a cold one. Reset on `result` / `reset`, never on a
   * tool-loop continuation.
   */
  let firstApiCallUsage: ClaudeUsageBag | null = null;
  /**
   * Usage and model of the newest main-thread API call. Its prompt plus output
   * is the context the next call starts from; the run-level `result.usage` is a
   * sum over all calls and says nothing about the current window.
   */
  let lastCallUsage: ClaudeUsageBag | null = null;
  let lastCallModel: string | null = null;
  /** `message.id` of that call; one call arrives as several messages. */
  let lastCallMessageId = '';

  function emitAbsorbedAssistant(incoming: string): Record<string, unknown> | null {
    const next = absorbStreamText(assistantAcc, incoming);
    if (!next || next === assistantAcc) return null;
    assistantAcc = next;
    thinkingAcc = '';
    return buildAssistantSnapshotEvent(assistantAcc);
  }

  function emitAbsorbedThinking(incoming: string): Record<string, unknown> | null {
    const next = absorbStreamText(thinkingAcc, incoming);
    if (!next || next === thinkingAcc) return null;
    thinkingAcc = next;
    return { type: 'thinking', text: thinkingAcc };
  }

  function resetAssistantTurn(): void {
    assistantAcc = '';
    thinkingAcc = '';
  }

  function clearLastCall(): void {
    lastCallUsage = null;
    lastCallModel = null;
    lastCallMessageId = '';
  }

  /**
   * Records the usage of a main-thread API call and returns the meter event,
   * or null when nothing changed. A call is reported several times: its
   * `message_start` and every per-block `assistant` message carry the output
   * count from the start of the stream, only `message_delta` has the final one,
   * so the largest output seen for one `message.id` wins.
   */
  function noteCallUsage(usage: ClaudeUsageBag, model: string | null, messageId: string): Record<string, unknown> | null {
    const sameCall = Boolean(messageId) && messageId === lastCallMessageId;
    let next = usage;
    if (sameCall && lastCallUsage && lastCallUsage.outputTokens > next.outputTokens) {
      next = {
        ...next,
        outputTokens: lastCallUsage.outputTokens,
        totalTokens: next.inputTokens + lastCallUsage.outputTokens,
      };
    }
    const nextModel = model || (sameCall ? lastCallModel : null);
    const changed = !lastCallUsage
      || lastCallUsage.totalTokens !== next.totalTokens
      || lastCallModel !== nextModel;
    lastCallUsage = next;
    lastCallModel = nextModel;
    lastCallMessageId = messageId;
    return changed ? { kind: 'context_usage', usage: next, model: nextModel } : null;
  }

  /**
   * Meter events of a main-thread `message_start` / `message_delta`. The start
   * already carries the prompt size, tool results of the previous step
   * included, so the meter moves when a call begins instead of when its first
   * content block ends.
   */
  function noteStreamCallUsage(rec: Record<string, unknown>, streamType: string): Array<Record<string, unknown>> {
    if (streamType === 'message_start') {
      const usage = resolveClaudeAssistantMessageUsage(rec);
      if (!usage) return [];
      const event = noteCallUsage(
        usage,
        readClaudeAssistantModel(asRecord(rec.event) || {}),
        readClaudeCallMessageId(rec),
      );
      return event ? [event] : [];
    }
    if (!lastCallUsage) return [];
    const outputTokens = toTokenCount(asRecord(asRecord(rec.event)?.usage)?.output_tokens);
    if (outputTokens <= lastCallUsage.outputTokens) return [];
    const event = noteCallUsage(
      { ...lastCallUsage, outputTokens, totalTokens: lastCallUsage.inputTokens + outputTokens },
      lastCallModel,
      lastCallMessageId,
    );
    return event ? [event] : [];
  }

  function mapBlock(block: unknown, blockOptions: { includeText?: boolean } = {}): Array<Record<string, unknown>> {
    const mapped = normalizeContentBlock(block, { ...blockOptions, toolCalls });
    const out: Array<Record<string, unknown>> = [];
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

  function normalize(message: unknown): Array<Record<string, unknown>> {
    const rec = asRecord(message);
    if (!rec) return [];
    const type = typeof rec.type === 'string' ? rec.type : '';
    if (type === 'system') {
      const events: Array<Record<string, unknown>> = [];
      const sessionId = readSessionId(rec);
      if (sessionId) events.push({ kind: 'session', sessionId });
      // A compacted transcript is smaller than the context of the last call.
      if (rec.subtype === 'compact_boundary') clearLastCall();
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
      if (streamType === 'message_start' || streamType === 'message_delta') {
        return noteStreamCallUsage(rec, streamType);
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
      // Main-thread calls only: a subagent (Task) call is its own API call and
      // must not stand in for the run's first call or its current context.
      if (!parentToolUseId) {
        const callUsage = resolveClaudeAssistantMessageUsage(rec);
        if (callUsage) {
          const contextEvent = noteCallUsage(
            callUsage,
            readClaudeAssistantModel(rec),
            readClaudeCallMessageId(rec),
          );
          if (contextEvent) events.push(contextEvent);
          if (!firstApiCallUsage) {
            firstApiCallUsage = callUsage;
            events.push({ kind: 'api_call_usage', usage: callUsage, first: true });
          }
        }
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
      // Who this result answers. A background task's notification runs as its
      // own CLI turn, so its result must not settle a user turn (see
      // `isForeignClaudeResultItem`).
      const originKind = readClaudeOriginKind(rec);
      const userMessageUuids = readClaudeResultUserMessageUuids(rec);
      const events: Array<Record<string, unknown>> = [];
      const usage = resolveClaudeResultUsage(rec);
      if (usage) {
        // `result.usage` is the final, run-level usage report for the whole
        // query, so the telemetry layer may treat it as coverage proof.
        const usageEvent: Record<string, unknown> = { kind: 'usage', usage, final: true };
        if (originKind) usageEvent.originKind = originKind;
        if (userMessageUuids) usageEvent.userMessageUuids = userMessageUuids;
        if (Number.isFinite(Number(rec.total_cost_usd))) {
          usageEvent.totalCostUsd = Number(rec.total_cost_usd);
        }
        if (Number.isFinite(Number(rec.duration_ms))) {
          usageEvent.durationMs = Number(rec.duration_ms);
        }
        const modelUsage = asRecord(rec.modelUsage);
        if (modelUsage) usageEvent.modelUsage = modelUsage;
        // Carry the first API call's per-call usage on the run report so a
        // consumer can distinguish a warm first call (cache reads) from a cold
        // one (cache writes) without re-deriving it from the run totals.
        if (firstApiCallUsage) usageEvent.firstApiCallUsage = firstApiCallUsage;
        if (lastCallUsage) {
          usageEvent.lastCallUsage = lastCallUsage;
          if (lastCallModel) usageEvent.lastCallModel = lastCallModel;
          const lastCallWindow = readClaudeModelContextWindow(modelUsage, lastCallModel);
          if (lastCallWindow) usageEvent.lastCallContextWindowTokens = lastCallWindow;
        }
        events.push(usageEvent);
      }
      firstApiCallUsage = null;
      clearLastCall();
      const resultItem: Record<string, unknown> = {
        kind: 'result',
        status: isError ? 'error' : 'completed',
        durationMs: Number.isFinite(Number(rec.duration_ms)) ? Number(rec.duration_ms) : null,
        totalCostUsd: Number.isFinite(Number(rec.total_cost_usd)) ? Number(rec.total_cost_usd) : null,
        sessionId,
        resultText,
        errorMessage,
      };
      // Steering accounting. Both fields are optional in the SDK result and
      // absent on older CLIs; leave the keys out so consumers can tell.
      if (userMessageUuids) resultItem.userMessageUuids = userMessageUuids;
      if (originKind) resultItem.originKind = originKind;
      if (rec.queued_turn_count != null && Number.isFinite(Number(rec.queued_turn_count))) {
        resultItem.queuedTurnCount = Math.max(0, Number(rec.queued_turn_count));
      }
      events.push(resultItem);
      return events;
    }
    return [];
  }

  return {
    normalize,
    reset: () => {
      resetAssistantTurn();
      firstApiCallUsage = null;
      clearLastCall();
      toolCalls.clear();
      announcedToolCalls.clear();
    },
  };
}

export function normalizeClaudeMessage(message: unknown): Array<Record<string, unknown>> {
  return createClaudeEventNormalizer().normalize(message);
}
