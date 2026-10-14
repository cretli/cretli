/** Numeric-only estimates of text recorded in the root CLI session. */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { estimateTokensFromText } from '../sdk/sdk-context-advisory.js';

const READ_BUDGET_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_READERS = 50;
const readers = new Map();
const KNOWN_CATEGORIES = ['messages', 'instructions', 'skills', 'memory', 'systemPrompt', 'toolCalls', 'toolResults', 'reasoning'];
const UNKNOWN_CATEGORIES = ['systemTools', 'mcpTools', 'mcpInstructions', 'agents', 'compactBuffer', 'deferredTools'];

/** Create an accumulator that never retains prompt text or tool arguments. */
export function createCodexBreakdownState() {
  return { counts: Object.fromEntries(KNOWN_CATEGORIES.map((id) => [id, { tokens: 0, count: 0 }])), baseTokens: null, afterCompaction: false, complete: true };
}

function addText(state, category, text) {
  if (typeof text !== 'string' || !text) return;
  state.counts[category].tokens += estimateTokensFromText(text);
  state.counts[category].count += 1;
}

/** Recognizable standalone instruction blocks; ordinary user messages stay messages. */
function classifyMessage(item, text) {
  if (item.role === 'system') return 'systemPrompt';
  if (/^# AGENTS\.md instructions for /i.test(text)) return 'memory';
  if (/^\s*<(?:skill|skills|skills_instructions)>/.test(text)) return 'skills';
  if (item.role === 'developer') return 'instructions';
  if (/^\[AVAILABLE AGENT SKILLS\]/.test(text) || /^\[WORKSPACE CURSOR RULES\]/.test(text) || /^\[SHARED CURSOR RULES\]/.test(text)) return 'instructions';
  return 'messages';
}

/** Image/audio payloads are not text tokens; never count their encoded bytes. */
function readToolOutputText(output) {
  if (typeof output === 'string') return /^data:(?:image|audio)\//.test(output) ? '' : output;
  if (Array.isArray(output)) return output.map(readToolOutputText).filter(Boolean).join('\n');
  if (!output || typeof output !== 'object') return '';
  if (Array.isArray(output.content)) return readToolOutputText(output.content);
  if (output.type === 'text' || output.type === 'output_text' || output.type === 'input_text') return typeof output.text === 'string' ? output.text : '';
  return '';
}

/** Count recorded visible text; encrypted reasoning and images have no text estimate. */
function addItem(state, item) {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'message') {
    for (const block of Array.isArray(item.content) ? item.content : []) {
      if (typeof block?.text !== 'string') continue;
      // A Cretli catalog can share a user message with rules and the request.
      // Only split the catalog when an explicit next-block marker bounds it.
      const nextBlock = block.text.search(/\n\[(?:WORKSPACE|SHARED) CURSOR RULES\]/);
      if (block.text.startsWith('[AVAILABLE AGENT SKILLS]') && nextBlock > 0) {
        addText(state, 'skills', block.text.slice(0, nextBlock));
        addText(state, 'instructions', block.text.slice(nextBlock));
      } else addText(state, classifyMessage(item, block.text), block.text);
    }
  } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    addText(state, 'toolCalls', typeof item.arguments === 'string' ? item.arguments : item.input);
  } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    addText(state, 'toolResults', readToolOutputText(item.output));
  } else if (item.type === 'reasoning') {
    const text = (Array.isArray(item.summary) ? item.summary : []).map((block) => block?.text || '').join('\n');
    addText(state, 'reasoning', text);
  }
}

/** Compaction replaces history; unknown replacement history marks the estimates incomplete. */
export function applyCodexBreakdownRecord(state, record) {
  if (record?.type === 'session_meta') {
    const text = typeof record.payload?.base_instructions === 'string'
      ? record.payload.base_instructions : record.payload?.base_instructions?.text;
    if (typeof text === 'string') {
      state.baseTokens = estimateTokensFromText(text);
      state.counts.systemPrompt = { tokens: state.baseTokens, count: 1 };
    }
  } else if (record?.type === 'response_item') {
    addItem(state, record.payload);
  } else if (record?.type === 'compacted') {
    const replacement = record.payload?.replacement_history;
    state.counts = createCodexBreakdownState().counts;
    if (state.baseTokens != null) state.counts.systemPrompt = { tokens: state.baseTokens, count: 1 };
    state.afterCompaction = true;
    state.complete = Array.isArray(replacement);
    if (Array.isArray(replacement)) replacement.forEach((item) => addItem(state, item));
    else addText(state, 'messages', record.payload?.message);
  }
}

/** The estimates are not a partition of measured context and must never be added to it. */
export function buildCodexContextBreakdown(state, { caughtUp = true, observedAt = null } = {}) {
  return {
    version: 1, source: 'codex-session-text', scope: 'recorded-context',
    estimated: true, complete: state.complete && caughtUp, caughtUp, observedAt,
    rows: [
      ...KNOWN_CATEGORIES.map((id) => ({ id, tokens: state.counts[id].count ? state.counts[id].tokens : null, count: state.counts[id].count || null, estimated: true })),
      ...UNKNOWN_CATEGORIES.map((id) => ({ id, tokens: null, count: null, estimated: false })),
    ],
  };
}

/** Incremental bounded reads avoid rescanning the complete log on every context update. */
export function readCodexContextBreakdown(filePath, observedAt = null) {
  if (!filePath) return null;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    let reader = readers.get(filePath);
    if (!reader || reader.offset > stat.size || reader.inode !== stat.ino) {
      reader = { offset: 0, inode: stat.ino, partial: '', decoder: new StringDecoder('utf8'), skippingLine: false, state: createCodexBreakdownState() };
      readers.set(filePath, reader);
      if (readers.size > MAX_READERS) readers.delete(readers.keys().next().value);
    }
    const length = Math.min(READ_BUDGET_BYTES, stat.size - reader.offset);
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, reader.offset);
    reader.offset += bytes;
    const text = reader.partial + reader.decoder.write(buffer.subarray(0, bytes));
    const lines = text.split('\n');
    reader.partial = lines.pop();
    for (const line of lines) {
      if (reader.skippingLine) { reader.skippingLine = false; continue; }
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { reader.state.complete = false; continue; }
      try { applyCodexBreakdownRecord(reader.state, JSON.parse(line)); } catch { if (line.trim()) reader.state.complete = false; }
    }
    if (Buffer.byteLength(reader.partial) > MAX_LINE_BYTES) {
      reader.partial = '';
      reader.skippingLine = true;
      reader.state.complete = false;
    }
    return buildCodexContextBreakdown(reader.state, { caughtUp: reader.offset === stat.size && !reader.partial, observedAt });
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
