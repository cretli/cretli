/**
 * Cheap-model summary of older chat history, with a seq pointer per item.
 *
 * Scope guarantee — read before use:
 * - This module is PURE: no I/O, no network, no LLM call at import time and no
 *   clock of its own. The concrete model call is injected as `summarize(prompt,
 *   { signal })` (see `history-summary-provider.js` for the cheap default).
 * - The summary is always built FROM THE ORIGINAL SAVED EVENTS. A previous
 *   summary (a `cretli-history-summary` artifact, a parsed summary or a saved
 *   `contextSeed` meta event) is never summarized again: passing it throws.
 * - The rendered seed prompt is ONLY the first prompt of a brand-new session
 *   (`SUMMARY_TARGET`). It is never persisted and never written into a live
 *   session, so it cannot be re-derived per turn (which would break the prompt
 *   cache). Native harness compaction keeps its own summarizer; a Cretli
 *   summary must not be stacked on top of it without an epoch reset — the epoch
 *   guard below rejects a summary whose `contextEpoch` is stale.
 *
 * Rewriting history invalidates the whole prompt-cache prefix, so compression
 * only pays off when the cache is already cold (or the window is nearly full).
 * `shouldSummarize` therefore reuses the stub-trim gate semantics from
 * `stub-trim.js`: cold OR over the token threshold, never warm-and-cheap.
 *
 * Item contract (the pointer is the contract):
 *   - Reused the title provider seam because it is already cheap.
 *     cretli-ref chat=<full-uuid> seq=<n>
 * The pointer is a valid `cretli-ref` that an agent loads with MCP
 * `chat_event({ chat, seq, field: "text" })`.
 */

import { isChatIdUuid, parseChatMessageRef } from '../chat-message-ref.js';
import { extractAssistantPlainText, truncateTextForAgentPrompt } from '../context-compression.js';
import { CACHE_STATE, estimateCacheState } from '../usage/cache-state.js';
import {
  STUB_TRIM_DEFAULT_CONTEXT_TOKEN_THRESHOLD,
  STUB_TRIM_GATE_REASON,
  STUB_TRIM_TARGET,
  assertNewSessionOnlyStubTrim,
  resolveStubTrimGate,
} from './stub-trim.js';

/** Only place a history summary may be used: the first prompt of a new session. */
export const SUMMARY_TARGET = 'new_session_first_prompt';

/** Marker that identifies a Cretli summary artifact (never an original event). */
export const SUMMARY_KIND = 'cretli-history-summary';

/**
 * Fixed summary structure. The order is the rendered order and the parser
 * accepts these headings (case-insensitive, optional `#`/`**`/trailing `:`).
 */
export const SUMMARY_SECTIONS = Object.freeze({
  GOAL: 'Goal',
  DECISIONS: 'Decisions (with rationale)',
  FILE_STATE_CHANGES: 'File/State changes',
  OPEN_ITEMS: 'Open items',
  EXACT_IDENTIFIERS: 'Exact identifiers',
});

/** Canonical section order — rendering, parsing and durable-fact extraction. */
export const SUMMARY_SECTION_ORDER = Object.freeze([
  'goal',
  'decisions',
  'fileStateChanges',
  'openItems',
  'exactIdentifiers',
]);

/**
 * Archive access hint injected into the seed prompt. Kept verbatim so the UI
 * and tests can rely on one string.
 */
export const ARCHIVE_ACCESS_HINT =
  'If exact paths, error messages or decision rationale are needed, call chat_event / chat_search (cretli-ref chat=<uuid> seq=<n>) instead of guessing.';

/** Per-turn cap on archive (chat_event / chat_search) calls the seed asks for. */
export const ARCHIVE_CALL_CAP_PER_TURN = 3;

/** Tokens above which a summary is authorized even with a warm cache. */
export const SUMMARY_DEFAULT_CONTEXT_TOKEN_THRESHOLD = STUB_TRIM_DEFAULT_CONTEXT_TOKEN_THRESHOLD;

/** Gate reasons are the stub-trim reasons; re-exported for callers. */
export const SUMMARY_GATE_REASON = STUB_TRIM_GATE_REASON;

/** Bounds used when building prompts; safety limits, not persisted settings. */
export const SUMMARY_LIMITS = Object.freeze({
  /** Turns kept verbatim at the end of the seed (excluded from the summary). */
  defaultKeepsLastN: 3,
  /** Per-event character clip inside the summarizer transcript. */
  maxEventChars: 2000,
  /** Hard cap on the summarizer transcript before it is truncated. */
  maxTranscriptChars: 48_000,
  /** Hard cap on the assembled new-session seed prompt. */
  maxSeedChars: 200_000,
});

const SUMMARY_TRANSCRIPT_OPEN = '<history>';
const SUMMARY_TRANSCRIPT_CLOSE = '</history>';
const POINTER_RE =
  /cretli-ref\s+chat=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+seq=(\d+)/gi;

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
 * @returns {number | null}
 */
function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function eventSeq(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @param {unknown} chatId
 * @returns {string}
 */
function normalizeChatId(chatId) {
  const value = asText(chatId).trim().toLowerCase();
  return isChatIdUuid(value) ? value : '';
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clipText(text, max) {
  const value = asText(text);
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [${value.length - max} chars clipped]`;
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
 * @param {unknown} entry
 * @returns {boolean}
 */
function isUserTurn(entry) {
  const rec = asRecord(entry?.rec);
  if (!rec) return false;
  if (rec.kind === 'localUser') return true;
  const event = asRecord(rec.event);
  return rec.kind === 'sdk' && asText(event?.type).toLowerCase() === 'user';
}

/**
 * A saved `contextSeed` meta event is already a compressed summary, so it is
 * never re-summarized; it is also excluded from the "original" transcript.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
function isContextSeedEvent(entry) {
  const rec = asRecord(entry?.rec);
  if (!rec || rec.kind !== 'meta') return false;
  return asText(rec.variant) === 'contextSeed';
}

/**
 * Detects anything that is a Cretli summary artifact (built or parsed summary,
 * or a seed). Original saved events never match.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isSummaryArtifact(value) {
  const rec = asRecord(value);
  if (!rec) return false;
  if (rec.kind === SUMMARY_KIND) return true;
  if (rec.target === SUMMARY_TARGET && (rec.prompt || rec.parsed)) return true;
  const parsed = asRecord(rec.parsed);
  if (parsed && parsed.kind === SUMMARY_KIND) return true;
  const sections = asRecord(rec.sections);
  if (sections && ('goal' in sections || 'decisions' in sections) && Array.isArray(rec.items)) {
    return true;
  }
  return false;
}

/**
 * Rejects a summary being fed back in as if it were original history.
 *
 * @param {unknown} events
 * @returns {void}
 * @throws {TypeError} when `events` is not an array or contains a summary.
 */
function assertOriginalEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError('history events must be an array of original saved events');
  }
  if (isSummaryArtifact(events)) {
    throw new TypeError('a summary is not original history: never summarize a summary');
  }
  for (const entry of events) {
    const rec = asRecord(entry);
    if (isSummaryArtifact(entry) || (rec && isSummaryArtifact(rec.rec))) {
      throw new TypeError('a summary is not original history: never summarize a summary');
    }
  }
}

/**
 * Renders one saved event as a single `[seq=N] …` line for the summarizer.
 *
 * @param {{ seq?: unknown, rec?: unknown }} entry
 * @param {number} maxEventChars
 * @returns {string}
 */
function renderEventWithSeq(entry, maxEventChars) {
  const seq = eventSeq(entry?.seq);
  const rec = asRecord(entry?.rec);
  if (!rec) return `[seq=${seq}] (unrecognized event)`;
  if (rec.kind === 'localUser') {
    return `[seq=${seq}] user: ${clipText(rec.text, maxEventChars)}`;
  }
  if (rec.kind === 'sdk') {
    const event = asRecord(rec.event);
    if (!event) return `[seq=${seq}] (empty sdk event)`;
    const type = asText(event.type).toLowerCase();
    if (type === 'user') return `[seq=${seq}] user: ${clipText(readSdkUserText(event), maxEventChars)}`;
    if (type === 'assistant') {
      return `[seq=${seq}] assistant: ${clipText(extractAssistantPlainText(event), maxEventChars)}`;
    }
    if (type === 'tool_call' || type === 'tool_use' || type === 'tool_result') {
      const name = asText(event.name) || 'tool';
      const status = asText(event.status);
      const result = event.result !== undefined ? event.result : event.content;
      return `[seq=${seq}] tool ${name}${status ? ` (${status})` : ''}: ${clipText(readResultText(result), maxEventChars)}`;
    }
    if (type === 'thinking') return `[seq=${seq}] thinking: ${clipText(event.text, maxEventChars)}`;
    return `[seq=${seq}] sdk ${type || 'event'}`;
  }
  if (rec.kind === 'meta') return `[seq=${seq}] meta ${asText(rec.variant) || 'event'}`;
  return `[seq=${seq}] ${asText(rec.kind) || 'event'}`;
}

/**
 * @param {Array<{ seq?: unknown, rec?: unknown }>} entries
 * @param {{ maxEventChars?: number }} [options]
 * @returns {string}
 */
function renderEventsWithSeq(entries, options = {}) {
  const maxEventChars = nonNegativeInt(options.maxEventChars, SUMMARY_LIMITS.maxEventChars);
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => renderEventWithSeq(entry, maxEventChars))
    .join('\n');
}

/**
 * Splits events into the older part to summarize and the last N turns kept
 * verbatim. A turn starts at a user message; everything from the start of the
 * N-th-from-last user turn onward is kept.
 *
 * @param {Array<{ seq?: unknown, rec?: unknown }>} originals
 * @param {number} keepsLastN
 * @returns {{ summarized: Array<object>, kept: Array<object> }}
 */
function splitTurns(originals, keepsLastN) {
  const starts = [];
  originals.forEach((entry, index) => {
    if (isUserTurn(entry)) starts.push(index);
  });
  const keepFrom =
    starts.length > keepsLastN && keepsLastN > 0 ? starts[starts.length - keepsLastN] : 0;
  return {
    summarized: originals.slice(0, keepFrom),
    kept: originals.slice(keepFrom),
  };
}

/**
 * Fixed-structure instructions shared by the summarizer prompt.
 *
 * @returns {string}
 */
function summaryStructureInstructions() {
  return [
    'Reply with exactly these five markdown sections, in this order, and nothing else:',
    `## ${SUMMARY_SECTIONS.GOAL}`,
    `## ${SUMMARY_SECTIONS.DECISIONS}`,
    `## ${SUMMARY_SECTIONS.FILE_STATE_CHANGES}`,
    `## ${SUMMARY_SECTIONS.OPEN_ITEMS}`,
    `## ${SUMMARY_SECTIONS.EXACT_IDENTIFIERS}`,
  ].join('\n');
}

/**
 * Builds the cheap-model prompt from ORIGINAL saved events only.
 *
 * The last `keepsLastN` turns are excluded (they stay verbatim in the new
 * session); the returned object records which seqs were summarized and which
 * were kept so a caller can build the seed. Passing a summary instead of
 * original events throws.
 *
 * @param {Array<{ seq?: unknown, rec?: unknown }>} events Saved history rows.
 * @param {{ chatId?: unknown, keepsLastN?: unknown }} [options] `chatId` is a
 *   full UUID and is required for valid `cretli-ref` pointers.
 * @returns {{
 *   kind: string,
 *   target: string,
 *   chatId: string,
 *   keepsLastN: number,
 *   prompt: string,
 *   summarizedSeqs: number[],
 *   keptSeqs: number[],
 *   stats: Record<string, number>,
 * }}
 */
export function buildSummaryPromptFromHistory(events, options = {}) {
  assertOriginalEvents(events);
  const chatId = normalizeChatId(options.chatId);
  const keepsLastN = Math.max(0, nonNegativeInt(options.keepsLastN, SUMMARY_LIMITS.defaultKeepsLastN));
  const originals = [...events]
    .sort((a, b) => eventSeq(a?.seq) - eventSeq(b?.seq))
    .filter((entry) => !isContextSeedEvent(entry));
  const { summarized, kept } = splitTurns(originals, keepsLastN);
  const refTemplate = chatId ? `cretli-ref chat=${chatId} seq=<n>` : 'cretli-ref chat=<uuid> seq=<n>';
  const transcript = truncateTextForAgentPrompt(
    renderEventsWithSeq(summarized, { maxEventChars: SUMMARY_LIMITS.maxEventChars }),
    SUMMARY_LIMITS.maxTranscriptChars,
  );
  const instructions = [
    'You compress an older part of a coding-agent chat so a NEW session can continue.',
    'Summarize ONLY the original history events provided below.',
    'Never summarize a previous summary: no compressed context is included.',
    'The newest turns are intentionally omitted and stay verbatim elsewhere.',
    '',
    summaryStructureInstructions(),
    '',
    'Rules:',
    `- Every item MUST carry one pointer line in exactly this format: ${refTemplate}`,
    '- Use the `[seq=N]` markers in the history to choose the correct N for each item.',
    '- The pointer must reference the original event the item is based on.',
    '- Goal: one or two sentences; include a pointer.',
    '- Decisions (with rationale): bullets, each a decision plus why, with a pointer.',
    '- File/State changes: bullets with exact paths, functions, symbols or state changes, one pointer each.',
    '- Open items: bullets with unresolved bugs/tasks, one pointer each.',
    '- Exact identifiers: bullets with exact paths, symbols, commands, ids and error strings, one pointer each.',
    '- Preserve exact paths, identifiers and error strings verbatim. Do not invent; write "unknown" if unsure.',
    '- Do NOT add any preamble, prose outside the sections, or code fences.',
    '',
    `${SUMMARY_TRANSCRIPT_OPEN}`,
    transcript,
    `${SUMMARY_TRANSCRIPT_CLOSE}`,
  ];
  const prompt = instructions.join('\n').trim();
  return Object.freeze({
    kind: SUMMARY_KIND,
    target: SUMMARY_TARGET,
    chatId,
    keepsLastN,
    prompt,
    summarizedSeqs: Object.freeze(summarized.map((entry) => eventSeq(entry?.seq))),
    keptSeqs: Object.freeze(kept.map((entry) => eventSeq(entry?.seq))),
    stats: Object.freeze({
      originalEvents: originals.length,
      summarizedEvents: summarized.length,
      keptEvents: kept.length,
      transcriptChars: transcript.length,
      promptChars: prompt.length,
    }),
  });
}

/**
 * @param {string} raw
 * @returns {string}
 */
function stripCodeFences(raw) {
  return raw.replace(/^[ \t]*```[^\n]*$/gm, '');
}

/**
 * Matches a section heading in any common markdown shape.
 *
 * @param {string} line
 * @returns {string | null}
 */
function matchSection(line) {
  const clean = line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/[:*_`]+\s*$/, '')
    .trim()
    .toLowerCase();
  if (!clean) return null;
  // Match the heading names exactly so an inline "Goal: ..." sentence is not
  // mistaken for a new section.
  if (clean === 'goal') return 'goal';
  if (/^decisions(\s*\(with rationale\))?$/.test(clean)) return 'decisions';
  if (/^(files?\s*(\/|&|and)?\s*(state\s*)?changes?|state\s*changes?)$/.test(clean)) {
    return 'fileStateChanges';
  }
  if (/^open\s*(items|tasks|issues)$/.test(clean)) return 'openItems';
  if (/^(exact\s*)?identifiers$/.test(clean)) return 'exactIdentifiers';
  return null;
}

/**
 * Finds every `cretli-ref chat=<uuid> seq=<n>` pointer in an item.
 *
 * @param {string} text
 * @returns {Array<{ chatId: string, seq: number }>}
 */
function findPointers(text) {
  const source = asText(text);
  POINTER_RE.lastIndex = 0;
  /** @type {Array<{ chatId: string, seq: number }>} */
  const found = [];
  let match;
  while ((match = POINTER_RE.exec(source)) !== null) {
    const ref = parseChatMessageRef(`cretli-ref chat=${match[1]} seq=${match[2]}`);
    if (ref && !found.some((row) => row.chatId === ref.chatId && row.seq === ref.seq)) {
      found.push(ref);
    }
  }
  return found;
}

/**
 * @param {string} text
 * @returns {string}
 */
function itemLabel(text) {
  return asText(text)
    .replace(POINTER_RE, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits one section body into items (bullets, numbered lines or paragraphs)
 * and attaches the extracted pointers.
 *
 * @param {string} sectionKey
 * @param {string} sectionText
 * @returns {Array<Record<string, unknown>>}
 */
function extractItemsFromSection(sectionKey, sectionText) {
  /** @type {Array<{ text: string }>} */
  const rawItems = [];
  let current = null;
  const flush = () => {
    if (current && current.text.trim()) rawItems.push(current);
    current = null;
  };
  for (const rawLine of asText(sectionText).split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) {
      if (current) current.text += '\n';
      continue;
    }
    if (/^([-*+]|\d+[.)])\s+/.test(trimmed)) {
      flush();
      current = { text: trimmed };
    } else if (current) {
      current.text += `\n${trimmed}`;
    } else {
      current = { text: trimmed };
    }
  }
  flush();
  return rawItems.map((item) => {
    const pointers = findPointers(item.text);
    return {
      section: sectionKey,
      text: item.text,
      label: itemLabel(item.text),
      ref: pointers[0] || null,
      pointers,
      missingPointer: pointers.length === 0,
    };
  });
}

/**
 * Parses and validates a model answer against the fixed structure. Extracts the
 * pointer per item and flags items that have none.
 *
 * Passing a summary artifact throws (never summarize/parse a summary as source).
 *
 * @param {unknown} text
 * @returns {{
 *   kind: string,
 *   valid: boolean,
 *   raw: string,
 *   sections: Record<string, string>,
 *   items: Array<Record<string, unknown>>,
 *   pointers: Array<Record<string, unknown>>,
 *   missingPointerItems: Array<{ section: string, label: string }>,
 *   missingSections: string[],
 *   itemCount: number,
 *   pointerCount: number,
 * }}
 */
export function parseSummaryResult(text) {
  if (isSummaryArtifact(text)) {
    throw new TypeError('parseSummaryResult expects model text, not a summary artifact');
  }
  if (typeof text !== 'string') {
    throw new TypeError('parseSummaryResult expects a string');
  }
  const normalized = stripCodeFences(text).trim();
  /** @type {Record<string, string>} */
  const sections = {
    goal: '',
    decisions: '',
    fileStateChanges: '',
    openItems: '',
    exactIdentifiers: '',
  };
  /** @type {Record<string, string[]>} */
  const buffers = {
    goal: [],
    decisions: [],
    fileStateChanges: [],
    openItems: [],
    exactIdentifiers: [],
  };
  let current = null;
  for (const line of normalized.split('\n')) {
    const key = matchSection(line);
    if (key) {
      current = key;
      continue;
    }
    if (current) buffers[current].push(line);
  }
  for (const key of SUMMARY_SECTION_ORDER) sections[key] = buffers[key].join('\n').trim();
  /** @type {Array<Record<string, unknown>>} */
  const items = [];
  for (const key of SUMMARY_SECTION_ORDER) {
    items.push(...extractItemsFromSection(key, sections[key]));
  }
  const missingSections = SUMMARY_SECTION_ORDER.filter((key) => !sections[key]);
  const missingPointerItems = items
    .filter((item) => item.missingPointer)
    .map((item) => ({ section: String(item.section), label: String(item.label) }));
  const pointers = items.flatMap((item) =>
    item.pointers.map((ref) => ({
      section: item.section,
      label: item.label,
      chatId: ref.chatId,
      seq: ref.seq,
    })),
  );
  const valid = missingSections.length === 0 && items.length > 0 && missingPointerItems.length === 0;
  return Object.freeze({
    kind: SUMMARY_KIND,
    valid,
    raw: normalized,
    sections: Object.freeze(sections),
    items: Object.freeze(items),
    pointers: Object.freeze(pointers),
    missingPointerItems: Object.freeze(missingPointerItems),
    missingSections: Object.freeze(missingSections),
    itemCount: items.length,
    pointerCount: pointers.length,
  });
}

/**
 * @param {unknown} value
 * @returns {ReturnType<typeof parseSummaryResult> | null}
 */
function coerceParsedSummary(value) {
  if (typeof value === 'string') return parseSummaryResult(value);
  const rec = asRecord(value);
  if (!rec) return null;
  const parsed = asRecord(rec.parsed);
  if (parsed && parsed.kind === SUMMARY_KIND && asRecord(parsed.sections)) {
    return /** @type {ReturnType<typeof parseSummaryResult>} */ (parsed);
  }
  if (rec.kind === SUMMARY_KIND && asRecord(rec.sections)) {
    return /** @type {ReturnType<typeof parseSummaryResult>} */ (rec);
  }
  return null;
}

/**
 * Re-renders a parsed/whole summary deterministically for the seed prompt.
 *
 * @param {unknown} summary
 * @returns {string}
 */
function renderSummaryForSeed(summary) {
  if (summary == null) return '';
  if (typeof summary === 'string') return summary.trim();
  const parsed = coerceParsedSummary(summary);
  if (!parsed) return '';
  /** @type {string[]} */
  const parts = [];
  for (const key of SUMMARY_SECTION_ORDER) {
    parts.push(`## ${SUMMARY_SECTIONS[summarySectionKey(key)]}`);
    parts.push(parsed.sections[key] || '(none)');
    parts.push('');
  }
  return parts.join('\n').trim();
}

/**
 * Maps a section key to its canonical constant name.
 *
 * @param {string} key
 * @returns {keyof typeof SUMMARY_SECTIONS}
 */
function summarySectionKey(key) {
  switch (key) {
    case 'goal':
      return 'GOAL';
    case 'decisions':
      return 'DECISIONS';
    case 'fileStateChanges':
      return 'FILE_STATE_CHANGES';
    case 'openItems':
      return 'OPEN_ITEMS';
    default:
      return 'EXACT_IDENTIFIERS';
  }
}

/**
 * @param {unknown} lastTurns
 * @param {number} maxEventChars
 * @returns {string}
 */
function renderLastTurns(lastTurns, maxEventChars) {
  if (typeof lastTurns === 'string') return lastTurns.trim();
  if (!Array.isArray(lastTurns)) return '';
  return renderEventsWithSeq(lastTurns, { maxEventChars }).trim();
}

/**
 * Deterministically assembles the FIRST prompt of a NEW session.
 *
 * Layout: frozen summary (with pointers) + deterministic stub-trimmed history
 * (leaf 88b9cd24) + the archive access hint and per-turn cap + the last turns
 * verbatim + the durable-facts instruction. A `stubTrimmed` object is validated
 * with `assertNewSessionOnlyStubTrim`, so live-session output cannot be used.
 *
 * @param {{
 *   summary?: unknown,
 *   stubTrimmed?: unknown,
 *   lastTurns?: unknown,
 *   chatId?: unknown,
 *   contextEpoch?: unknown,
 * }} [input]
 * @returns {{
 *   kind: string,
 *   target: string,
 *   persisted: boolean,
 *   chatId: string,
 *   contextEpoch: number | null,
 *   archiveCallCap: number,
 *   prompt: string,
 *   stats: Record<string, number>,
 * }}
 */
export function buildNewSessionSeedPrompt(input = {}) {
  const chatId = normalizeChatId(input.chatId);
  const summaryText = renderSummaryForSeed(input.summary);
  let stubText = '';
  if (input.stubTrimmed != null) {
    if (typeof input.stubTrimmed === 'string') {
      stubText = input.stubTrimmed.trim();
    } else {
      assertNewSessionOnlyStubTrim(input.stubTrimmed);
      stubText = asText(/** @type {Record<string, unknown>} */ (input.stubTrimmed).promptText).trim();
    }
  }
  const lastTurnsText = renderLastTurns(input.lastTurns, SUMMARY_LIMITS.maxEventChars);
  const refExample = chatId ? `cretli-ref chat=${chatId} seq=<n>` : 'cretli-ref chat=<uuid> seq=<n>';
  /** @type {string[]} */
  const parts = [
    '# Resumed session (compressed history)',
    'This is the FIRST prompt of a NEW session. The summary below was produced once from the original chat history and is frozen: do not re-summarize it and do not re-derive it per turn.',
    '',
    '## Durable summary',
    summaryText || '(no summary provided)',
  ];
  if (stubText) parts.push('', '## Trimmed history (deterministic stubs)', stubText);
  parts.push(
    '',
    '## Archive access',
    ARCHIVE_ACCESS_HINT,
    `Cap archive calls (chat_event / chat_search) at ${ARCHIVE_CALL_CAP_PER_TURN} per turn.`,
    `Items above point at their source with ${refExample}; load the original instead of guessing.`,
    '',
    '## Durable facts',
    'Persist durable decisions/facts outside the chat with the TODO tool or wmem_add; never treat this summary as the only copy.',
  );
  if (lastTurnsText) parts.push('', '## Last turns (verbatim)', lastTurnsText);
  const prompt = truncateTextForAgentPrompt(parts.join('\n').trim(), SUMMARY_LIMITS.maxSeedChars);
  return Object.freeze({
    kind: SUMMARY_KIND,
    target: SUMMARY_TARGET,
    persisted: false,
    chatId,
    contextEpoch: finiteNumber(input.contextEpoch),
    archiveCallCap: ARCHIVE_CALL_CAP_PER_TURN,
    prompt,
    stats: Object.freeze({
      summaryChars: summaryText.length,
      stubTrimChars: stubText.length,
      lastTurnsChars: lastTurnsText.length,
      promptChars: prompt.length,
    }),
  });
}

/**
 * Extracts durable facts (decisions, open items, exact identifiers) from a
 * parsed summary. Pure: the caller decides where to persist them (todo /
 * wmem_add); this module never writes anything.
 *
 * @param {unknown} summary Parsed summary, summary artifact or raw text.
 * @returns {Array<{ type: 'decision' | 'open_item' | 'identifier', text: string, ref: { chatId: string, seq: number } | null, seq: number | null }>}
 */
export function extractDurableFacts(summary) {
  const parsed = coerceParsedSummary(summary);
  if (!parsed) return [];
  const bySection = {
    decisions: 'decision',
    openItems: 'open_item',
    exactIdentifiers: 'identifier',
  };
  /** @type {Array<{ type: 'decision' | 'open_item' | 'identifier', text: string, ref: { chatId: string, seq: number } | null, seq: number | null }>} */
  const facts = [];
  for (const item of parsed.items) {
    const type = bySection[String(item.section)];
    if (!type) continue;
    const ref = item.ref && typeof item.ref === 'object' ? /** @type {{chatId:string,seq:number}} */ (item.ref) : null;
    facts.push({
      type,
      text: String(item.label || '').trim(),
      ref,
      seq: ref ? ref.seq : null,
    });
  }
  return facts;
}

/**
 * @param {unknown} cacheState
 * @returns {unknown}
 */
function normalizeGateCacheState(cacheState) {
  if (typeof cacheState === 'string') return { state: cacheState };
  return cacheState;
}

/**
 * Rich gate result for "summarize + start a new session".
 *
 * Reuses leaf 88b9cd24's `resolveStubTrimGate`: allowed when the cache is COLD
 * or the estimated context is at/over the token threshold. Warm below the
 * threshold is blocked, and an UNKNOWN cache state is never treated as cold.
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
 * @returns {ReturnType<typeof resolveStubTrimGate>}
 */
export function resolveSummaryGate(input = {}) {
  return resolveStubTrimGate({
    ...input,
    cacheState: normalizeGateCacheState(input.cacheState),
    contextTokenThreshold: input.contextTokenThreshold ?? SUMMARY_DEFAULT_CONTEXT_TOKEN_THRESHOLD,
  });
}

/**
 * Boolean convenience wrapper around `resolveSummaryGate`.
 *
 * @param {Parameters<typeof resolveSummaryGate>[0]} [input]
 * @returns {boolean}
 */
export function shouldSummarize(input = {}) {
  return resolveSummaryGate(input).allowed;
}

/**
 * Epoch guard: a summary produced at a different (older) `contextEpoch` than
 * the current room is stale, because a native compaction rewrote the prefix.
 * Re-summarize from the original events instead of stacking the stale summary.
 *
 * An unknown epoch on either side is not treated as stale (there is nothing to
 * compare), so callers stay conservative instead of failing open.
 *
 * @param {{
 *   summaryContextEpoch?: unknown,
 *   currentContextEpoch?: unknown,
 *   summary?: unknown,
 * }} [input]
 * @returns {{
 *   ok: boolean,
 *   stale: boolean,
 *   reason: 'epoch_match' | 'epoch_unknown' | 'context_epoch_changed',
 *   summaryContextEpoch: number | null,
 *   currentContextEpoch: number | null,
 * }}
 */
export function resolveSummaryEpochGuard(input = {}) {
  const fromSummary = asRecord(input.summary)?.contextEpoch;
  const summaryEpoch = finiteNumber(input.summaryContextEpoch ?? fromSummary);
  const currentEpoch = finiteNumber(input.currentContextEpoch);
  if (summaryEpoch == null || currentEpoch == null) {
    return Object.freeze({
      ok: true,
      stale: false,
      reason: 'epoch_unknown',
      summaryContextEpoch: summaryEpoch,
      currentContextEpoch: currentEpoch,
    });
  }
  if (summaryEpoch === currentEpoch) {
    return Object.freeze({
      ok: true,
      stale: false,
      reason: 'epoch_match',
      summaryContextEpoch: summaryEpoch,
      currentContextEpoch: currentEpoch,
    });
  }
  return Object.freeze({
    ok: false,
    stale: true,
    reason: 'context_epoch_changed',
    summaryContextEpoch: summaryEpoch,
    currentContextEpoch: currentEpoch,
  });
}

/**
 * Throws when a summary belongs to a stale context epoch, forcing the caller to
 * re-summarize from the originals.
 *
 * @param {unknown} summary Summary artifact (or `{ contextEpoch }`).
 * @param {{ currentContextEpoch?: unknown }} [input]
 * @returns {ReturnType<typeof resolveSummaryEpochGuard>}
 * @throws {TypeError} when the summary context epoch is stale.
 */
export function assertSummaryEpochFresh(summary, input = {}) {
  const guard = resolveSummaryEpochGuard({
    summaryContextEpoch: asRecord(summary)?.contextEpoch,
    currentContextEpoch: input.currentContextEpoch,
  });
  if (guard.stale) {
    throw new TypeError(
      `history summary contextEpoch ${guard.summaryContextEpoch} is stale vs current ${guard.currentContextEpoch}; re-summarize from the original events`,
    );
  }
  return guard;
}

/**
 * Explicit safeguard: refuses any summary/seed that was not produced for the
 * first prompt of a new session, so a caller cannot feed it into a live session
 * or persist it.
 *
 * @param {unknown} output
 * @returns {void}
 * @throws {TypeError} when the output is not a new-session summary.
 */
export function assertNewSessionOnlySummary(output) {
  const rec = asRecord(output);
  if (!rec || rec.target !== SUMMARY_TARGET || rec.persisted !== false) {
    throw new TypeError(
      'history summary is only valid as the first prompt of a new session; it must not be persisted or written into a live session',
    );
  }
}

/**
 * Runs the injected `summarize` seam over the original events and returns the
 * parsed summary artifact. No provider is imported or called here: tests pass a
 * fake `summarize`, production passes the cheap provider from
 * `history-summary-provider.js`.
 *
 * @param {{
 *   events?: Array<{ seq?: unknown, rec?: unknown }>,
 *   chatId?: unknown,
 *   keepsLastN?: unknown,
 *   contextEpoch?: unknown,
 *   signal?: AbortSignal,
 *   summarize?: (prompt: string, options: { signal?: AbortSignal }) => Promise<string> | string,
 * }} [input]
 * @returns {Promise<{
 *   kind: string,
 *   target: string,
 *   persisted: boolean,
 *   ok: boolean,
 *   reason?: string,
 *   chatId: string,
 *   contextEpoch: number | null,
 *   raw: string,
 *   parsed: ReturnType<typeof parseSummaryResult> | null,
 *   promptMeta?: Record<string, unknown>,
 * }>}
 */
export async function summarizeHistoryFromOriginals(input = {}) {
  const summarize = input.summarize;
  if (typeof summarize !== 'function') {
    throw new TypeError(
      'summarizeHistoryFromOriginals requires an injected summarize(prompt, { signal }) function',
    );
  }
  const built = buildSummaryPromptFromHistory(input.events, {
    chatId: input.chatId,
    keepsLastN: input.keepsLastN,
  });
  const contextEpoch = finiteNumber(input.contextEpoch);
  if (built.summarizedSeqs.length === 0) {
    return Object.freeze({
      kind: SUMMARY_KIND,
      target: SUMMARY_TARGET,
      persisted: false,
      ok: false,
      reason: 'nothing_to_summarize',
      chatId: built.chatId,
      contextEpoch,
      raw: '',
      parsed: null,
      promptMeta: built,
    });
  }
  const raw = await summarize(built.prompt, { signal: input.signal });
  const parsed = parseSummaryResult(typeof raw === 'string' ? raw : '');
  return Object.freeze({
    kind: SUMMARY_KIND,
    target: SUMMARY_TARGET,
    persisted: false,
    ok: parsed.valid,
    chatId: built.chatId,
    contextEpoch,
    raw: typeof raw === 'string' ? raw : '',
    parsed,
    promptMeta: built,
  });
}

/**
 * Factory that binds an injected `summarize` seam, so callers cannot forget it
 * and tests never touch the network.
 *
 * @param {{
 *   summarize: (prompt: string, options: { signal?: AbortSignal }) => Promise<string> | string,
 *   defaults?: { chatId?: string, keepsLastN?: number, contextEpoch?: number },
 * }} deps
 * @returns {{ summarizeHistory: (input?: object) => Promise<object>, shouldSummarize: typeof shouldSummarize }}
 */
export function createHistorySummarizer(deps = {}) {
  if (typeof deps.summarize !== 'function') {
    throw new TypeError('createHistorySummarizer requires a summarize(prompt, { signal }) function');
  }
  const defaults = asRecord(deps.defaults) || {};
  return {
    summarizeHistory: (input = {}) =>
      summarizeHistoryFromOriginals({ ...defaults, ...input, summarize: deps.summarize }),
    shouldSummarize,
  };
}

/**
 * Warm/cold vocabulary re-exported for callers that build a gate input.
 */
export { CACHE_STATE, estimateCacheState, STUB_TRIM_TARGET };
