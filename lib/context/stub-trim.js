/**
 * Deterministic stub-trimming of old, large tool results for a NEW session's
 * first prompt.
 *
 * Scope guarantee — read before use:
 * - The output is ONLY the first prompt of a brand-new session. It is never
 *   written back into a live session's history or store, and no persisted event
 *   is modified. Cretli cannot rewrite the history of any harness session (the
 *   session is opaque: sdk, claude resume, codex thread, qwen/opencode/deepseek/
 *   codebuddy internal stores), so this module seeds a NEW session instead.
 * - The function is pure: no I/O, no LLM, no clock of its own, and it never
 *   mutates its input. The result is bounded (`maxEvents`, `maxPromptChars`).
 * - Native deterministic trimming is configured per harness elsewhere
 *   (see `docs/context-cost.md`). This module is the Cretli-side lever for
 *   sdk/claude/codex, which expose no rewritable history.
 *
 * Stub shape (the pointer is the contract):
 *   [trimmed tool result: <tool> · <chars> chars omitted]
 *   cretli-ref chat=<chat-uuid> seq=<seq>
 * The second line is a valid `cretli-ref` pointer that an agent can load with
 * MCP `chat_event({ chat, seq, field: "text" })`.
 */

import { formatChatMessageRef, parseChatMessageRef } from '../chat-message-ref.js';
import { extractAssistantPlainText, truncateTextForAgentPrompt } from '../context-compression.js';
import { CACHE_STATE, estimateCacheState } from '../usage/cache-state.js';

/** Marks the only place the trimmed output may be used. */
export const STUB_TRIM_TARGET = 'new_session_first_prompt';

/**
 * Shipped bounds for one stub-trimmed prompt.
 *
 * - `largeResultChars`: a tool result strictly larger than this is large enough
 *   to replace with a pointer stub.
 * - `keepRecentToolResults`: the newest N tool results are always kept verbatim
 *   so the new session still sees the freshest command output.
 * - `maxEvents`: hard cap on returned events; the newest are kept.
 * - `maxPromptChars`: hard cap on the rendered prompt text (head + tail kept,
 *   with a 200-character floor).
 *
 * These are safety bounds, not tuning knobs persisted in settings.
 */
export const STUB_TRIM_LIMITS = Object.freeze({
  largeResultChars: 2000,
  keepRecentToolResults: 3,
  maxEvents: 500,
  maxPromptChars: 24000,
});

/** Configured threshold used when the caller does not pass one (tokens). */
export const STUB_TRIM_DEFAULT_CONTEXT_TOKEN_THRESHOLD = 200_000;

/** Stable gate reasons so callers can group without parsing text. */
export const STUB_TRIM_GATE_REASON = Object.freeze({
  CACHE_COLD: 'cache_cold',
  CONTEXT_OVER_THRESHOLD: 'context_over_threshold',
  CACHE_WARM: 'cache_warm',
  CONTEXT_BELOW_THRESHOLD: 'context_below_threshold',
});

const TOOL_NAME_MAX_CHARS = 40;
const REF_ANYWHERE_RE = /cretli-ref\s+chat=[0-9a-f-]{36}\s+seq=\d+/i;

/**
 * `truncateTextForAgentPrompt` keeps a head and a tail around a marker, so it
 * refuses to cut below this size. A caller asking for less still gets a bounded
 * (tiny) prompt, never an unbounded one.
 */
const MIN_PROMPT_CHARS = 200;

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} state
 * @returns {string}
 */
function normalizeCacheState(state) {
  const value = asText(state).toLowerCase();
  if (value === CACHE_STATE.WARM || value === CACHE_STATE.COLD || value === CACHE_STATE.UNKNOWN) {
    return value;
  }
  return CACHE_STATE.UNKNOWN;
}

/**
 * Deterministic text for any tool result payload. Never throws.
 *
 * @param {unknown} result
 * @returns {string}
 */
function readResultText(result) {
  if (typeof result === 'string') return result;
  if (result == null) return '';
  try {
    const json = JSON.stringify(result);
    return typeof json === 'string' ? json : String(result);
  } catch {
    return String(result);
  }
}

/**
 * @param {unknown} blocks
 * @returns {string}
 */
function readTextBlocks(blocks) {
  let out = '';
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (typeof block === 'string') {
      out += block;
      continue;
    }
    const rec = asRecord(block);
    if (rec && typeof rec.text === 'string') out += rec.text;
  }
  return out;
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function readSdkUserText(event) {
  const rec = asRecord(event);
  if (!rec) return '';
  if (typeof rec.text === 'string') return rec.text;
  const message = asRecord(rec.message);
  if (message && typeof message.text === 'string') return message.text;
  const content = Array.isArray(rec.content)
    ? rec.content
    : message && Array.isArray(message.content)
      ? message.content
      : [];
  return readTextBlocks(content);
}

/**
 * Detects a completed/errored tool result on a normalized history event. A
 * running `tool_call` with no result returns null, so it is never stubbed.
 *
 * @param {unknown} event
 * @returns {{ name: string, status: string, result: unknown } | null}
 */
function readToolResult(event) {
  const rec = asRecord(event);
  if (!rec) return null;
  const type = asText(rec.type).toLowerCase();
  if (type === 'tool_result') {
    const result = rec.result !== undefined ? rec.result : rec.content;
    return { name: asText(rec.name) || 'tool', status: asText(rec.status), result };
  }
  if (type === 'tool_call' || type === 'tool_use') {
    if (rec.result === undefined) return null;
    return { name: asText(rec.name) || 'tool', status: asText(rec.status), result: rec.result };
  }
  return null;
}

/**
 * Classifies one `{ seq, rec }` history row without copying it.
 *
 * @param {{ seq?: unknown, rec?: unknown } | null | undefined} entry
 * @returns {Record<string, unknown>}
 */
function classifyHistoryEntry(entry) {
  const seq = Number(entry?.seq);
  const rec = asRecord(entry?.rec);
  if (!rec) return { seq, kind: 'other' };
  if (rec.kind === 'localUser' && typeof rec.text === 'string') {
    return { seq, kind: 'user', text: rec.text, rec };
  }
  if (rec.kind === 'meta') {
    return {
      seq,
      kind: 'meta',
      variant: asText(rec.variant),
      payload: typeof rec.payload === 'string' ? rec.payload : '',
      rec,
    };
  }
  if (rec.kind !== 'sdk') return { seq, kind: 'other', rec };
  const event = asRecord(rec.event);
  if (!event) return { seq, kind: 'other', rec };
  const type = asText(event.type).toLowerCase();
  if (type === 'user') {
    return { seq, kind: 'user', text: readSdkUserText(event), rec, event };
  }
  if (type === 'assistant') {
    return { seq, kind: 'assistant', text: extractAssistantPlainText(event).trim(), rec, event };
  }
  const tool = readToolResult(event);
  if (tool) return { seq, kind: 'tool', tool, rec, event };
  if (type === 'tool_call' || type === 'tool_use') {
    return {
      seq,
      kind: 'tool_meta',
      name: asText(event.name) || 'tool',
      status: asText(event.status),
      rec,
      event,
    };
  }
  return { seq, kind: 'other', rec };
}

/**
 * Builds the short replacement string. The reference is always on its own line
 * so `readStubTrimPointer` (and MCP `chat_event` callers) can parse it.
 *
 * @param {{ name: string, status: string }} tool
 * @param {number} originalChars
 * @param {string} ref
 * @returns {string}
 */
function buildToolResultStub(tool, originalChars, ref) {
  const name = asText(tool.name).slice(0, TOOL_NAME_MAX_CHARS) || 'tool';
  const status = asText(tool.status);
  const statusPart = status ? ` · ${status}` : '';
  return `[trimmed tool result: ${name}${statusPart} · ${originalChars} chars omitted]\n${ref}`;
}

/**
 * Returns a copy of the event whose tool-result payload is replaced by the
 * stub. Every known payload field is overwritten so a large original cannot
 * survive inside the bounded output.
 *
 * @param {Record<string, unknown>} event
 * @param {string} stub
 * @returns {Record<string, unknown>}
 */
function applyStubToEvent(event, stub) {
  const next = { ...event, result: stub };
  if (Object.prototype.hasOwnProperty.call(event, 'content')) next.content = stub;
  if (Object.prototype.hasOwnProperty.call(event, 'output')) next.output = stub;
  const message = asRecord(event.message);
  if (message && Object.prototype.hasOwnProperty.call(message, 'content')) {
    next.message = { ...message, content: stub };
  }
  return next;
}

/**
 * Renders the trimmed history to plain text. Assistant snapshots/deltas are
 * de-duplicated by prefix (same rule as `formatChatHistoryEventsToText`) so a
 * streaming answer does not balloon the prompt.
 *
 * @param {Array<Record<string, unknown>>} records
 * @returns {string}
 */
function renderStubTrimmedPrompt(records) {
  /** @type {string[]} */
  const parts = [];
  let lastAssistantIndex = -1;
  let lastAssistantText = '';
  for (const record of records) {
    const kind = record.kind;
    if (kind === 'user') {
      const text = asText(record.text).trim();
      lastAssistantIndex = -1;
      lastAssistantText = '';
      if (text) parts.push(`> ${text}\n`);
      continue;
    }
    if (kind === 'assistant') {
      const text = asText(record.text).trim();
      if (!text) continue;
      if (lastAssistantText && text.startsWith(lastAssistantText)) {
        if (text.length <= lastAssistantText.length) continue;
        if (lastAssistantIndex >= 0) parts[lastAssistantIndex] = `${text}\n\n`;
        lastAssistantText = text;
        continue;
      }
      if (lastAssistantText && lastAssistantText.startsWith(text)) continue;
      lastAssistantIndex = parts.length;
      lastAssistantText = text;
      parts.push(`${text}\n\n`);
      continue;
    }
    lastAssistantIndex = -1;
    lastAssistantText = '';
    if (kind === 'tool') {
      if (typeof record.stub === 'string' && record.stub) {
        parts.push(`${record.stub}\n\n`);
      } else {
        const resultText = readResultText(record.tool?.result);
        if (resultText) {
          const tool = record.tool || {};
          parts.push(`[tool ${asText(tool.name)} · ${asText(tool.status)}] ${resultText}\n`);
        }
      }
      continue;
    }
    if (kind === 'tool_meta') {
      parts.push(`[tool ${asText(record.name)} · ${asText(record.status) || 'running'}]\n`);
      continue;
    }
    if (kind === 'meta' && record.variant === 'contextSeed' && asText(record.payload).trim()) {
      parts.push(
        `[PRIOR COMPRESSED CONTEXT]\n${asText(record.payload).trim()}\n[/PRIOR COMPRESSED CONTEXT]\n`,
      );
    }
  }
  return parts.join('').trim();
}

/**
 * Builds a deterministic, bounded, stub-trimmed history for the FIRST prompt of
 * a NEW session.
 *
 * User messages and assistant answers are always kept. Old, large tool results
 * are replaced by a short stub that points at the original event; small or
 * recent tool results stay verbatim. The input is never mutated.
 *
 * @param {Array<{ seq?: unknown, rec?: unknown }>} events Saved history rows.
 * @param {{
 *   chatId: string,
 *   largeResultChars?: number,
 *   keepRecentToolResults?: number,
 *   maxEvents?: number,
 *   maxPromptChars?: number,
 * }} options `chatId` is required for the `cretli-ref` pointer.
 * @returns {{
 *   chatId: string,
 *   target: string,
 *   persisted: boolean,
 *   sourceMutated: boolean,
 *   events: Array<{ seq?: unknown, rec?: unknown }>,
 *   promptText: string,
 *   stats: Record<string, number | boolean>,
 * }}
 */
export function buildStubTrimmedHistory(events, options = {}) {
  const chatId = asText(options.chatId).trim().toLowerCase();
  const largeResultChars = positiveInt(options.largeResultChars, STUB_TRIM_LIMITS.largeResultChars);
  const keepRecentToolResults = positiveInt(
    options.keepRecentToolResults,
    STUB_TRIM_LIMITS.keepRecentToolResults,
  );
  const maxEvents = positiveInt(options.maxEvents, STUB_TRIM_LIMITS.maxEvents);
  const maxPromptChars = Math.max(
    MIN_PROMPT_CHARS,
    positiveInt(options.maxPromptChars, STUB_TRIM_LIMITS.maxPromptChars),
  );
  const list = Array.isArray(events) ? events : [];
  const classified = list.map((entry) => classifyHistoryEntry(entry));

  // Tool-result ordinals in chronological order decide what counts as "old".
  /** @type {number[]} */
  const toolIndexes = [];
  classified.forEach((entry, index) => {
    if (entry.kind === 'tool') toolIndexes.push(index);
  });
  const recentStart = Math.max(0, toolIndexes.length - keepRecentToolResults);
  /** @type {Map<number, { stub: string, omittedChars: number }>} */
  const stubs = new Map();
  toolIndexes.forEach((entryIndex, ordinal) => {
    const entry = classified[entryIndex];
    const resultText = readResultText(entry.tool.result);
    if (ordinal >= recentStart) return;
    if (resultText.length <= largeResultChars) return;
    const ref = formatChatMessageRef({ chatId, seq: entry.seq });
    if (!ref) return;
    stubs.set(entryIndex, {
      stub: buildToolResultStub(entry.tool, resultText.length, ref),
      omittedChars: resultText.length,
    });
  });

  const records = classified.map((entry, index) => {
    const stubInfo = stubs.get(index);
    if (!stubInfo) return entry;
    const rec = /** @type {Record<string, unknown>} */ (entry.rec);
    const event = /** @type {Record<string, unknown>} */ (entry.event);
    return {
      ...entry,
      rec: { ...rec, event: applyStubToEvent(event, stubInfo.stub) },
      stub: stubInfo.stub,
      omittedChars: stubInfo.omittedChars,
    };
  });

  const eventsTruncated = records.length > maxEvents;
  const bounded = eventsTruncated ? records.slice(records.length - maxEvents) : records;
  const outputEvents = bounded.map((record) => ({ seq: record.seq, rec: record.rec }));

  const rendered = renderStubTrimmedPrompt(bounded);
  const promptText = truncateTextForAgentPrompt(rendered, maxPromptChars);
  let stubbedToolResults = 0;
  let omittedChars = 0;
  let toolResults = 0;
  for (const record of bounded) {
    if (record.kind !== 'tool') continue;
    toolResults += 1;
    if (typeof record.stub === 'string') {
      stubbedToolResults += 1;
      omittedChars += Number(record.omittedChars) || 0;
    }
  }
  const stats = Object.freeze({
    inputEvents: list.length,
    outputEvents: outputEvents.length,
    toolResults,
    stubbedToolResults,
    keptToolResults: toolResults - stubbedToolResults,
    omittedChars,
    promptChars: promptText.length,
    truncated: eventsTruncated || rendered.length > promptText.length,
  });

  return Object.freeze({
    chatId,
    target: STUB_TRIM_TARGET,
    persisted: false,
    sourceMutated: false,
    events: outputEvents,
    promptText,
    stats,
  });
}

/**
 * @param {unknown} stub
 * @returns {{ chatId: string, seq: number } | null}
 */
export function readStubTrimPointer(stub) {
  const text = asText(stub);
  const match = REF_ANYWHERE_RE.exec(text);
  if (!match) return null;
  return parseChatMessageRef(match[0]);
}

/**
 * Gating predicate for "trim + start a NEW session".
 *
 * Allowed when the prompt cache is COLD or when the estimated context passes
 * the configured token threshold. Blocked for a warm cache below the threshold.
 * The gate deliberately accepts no elapsed-time input: time only influences the
 * decision through `estimateCacheState`, which owns the TTL logic, so a long
 * pause alone never authorizes a restart.
 *
 * `cacheState` may be a precomputed `estimateCacheState` result, or a `chatId`
 * (plus estimate options) may be passed and the estimate is reused here.
 *
 * @param {{
 *   chatId?: unknown,
 *   cacheState?: unknown,
 *   harness?: unknown,
 *   model?: unknown,
 *   provider?: unknown,
 *   retention?: unknown,
 *   contextEpoch?: unknown,
 *   now?: unknown,
 *   estimatedContextTokens?: unknown,
 *   contextTokenThreshold?: unknown,
 * }} [input]
 * @returns {{
 *   allowed: boolean,
 *   reason: string,
 *   state: string,
 *   estimatedContextTokens: number | null,
 *   contextTokenThreshold: number,
 *   cache: Record<string, unknown> | null,
 * }}
 */
export function resolveStubTrimGate(input = {}) {
  const threshold = positiveInt(
    input.contextTokenThreshold,
    STUB_TRIM_DEFAULT_CONTEXT_TOKEN_THRESHOLD,
  );
  const tokens = finiteNumber(input.estimatedContextTokens);
  let cache = asRecord(input.cacheState);
  if (!cache && input.chatId != null && asText(input.chatId).trim()) {
    cache = estimateCacheState(input.chatId, input);
  }
  const state = normalizeCacheState(cache?.state);
  const cold = state === CACHE_STATE.COLD;
  const overThreshold = tokens != null && tokens > 0 && tokens >= threshold;
  const allowed = cold || overThreshold;
  const reason = cold
    ? STUB_TRIM_GATE_REASON.CACHE_COLD
    : overThreshold
      ? STUB_TRIM_GATE_REASON.CONTEXT_OVER_THRESHOLD
      : state === CACHE_STATE.WARM
        ? STUB_TRIM_GATE_REASON.CACHE_WARM
        : STUB_TRIM_GATE_REASON.CONTEXT_BELOW_THRESHOLD;
  return Object.freeze({
    allowed,
    reason,
    state,
    estimatedContextTokens: tokens,
    contextTokenThreshold: threshold,
    cache,
  });
}

/**
 * Boolean convenience wrapper around `resolveStubTrimGate`.
 *
 * @param {Parameters<typeof resolveStubTrimGate>[0]} [input]
 * @returns {boolean}
 */
export function shouldStubTrimForNewSession(input = {}) {
  return resolveStubTrimGate(input).allowed;
}

/**
 * Explicit safeguard: refuses any trimmed output that was not produced for the
 * first prompt of a new session, so a caller cannot feed it back into a live
 * session or persist it.
 *
 * @param {unknown} output
 * @returns {void}
 * @throws {TypeError} when the output is not a new-session stub-trim result.
 */
export function assertNewSessionOnlyStubTrim(output) {
  const rec = asRecord(output);
  if (!rec || rec.target !== STUB_TRIM_TARGET || rec.persisted !== false) {
    throw new TypeError(
      'stub-trim output is only valid as the first prompt of a new session; it must not be persisted or written into a live session',
    );
  }
}
