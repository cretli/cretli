import { createHash } from 'node:crypto';

const originals = new Map();
const MAX_ENTRIES = 128;

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function collapseWhitespace(text) {
  return text.split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n');
}

export function dedupeRepeatedLines(text) {
  let previous;
  let count = 0;
  const result = [];
  const flush = () => {
    if (count > 0) result.push(previous);
    if (count > 1) result.push(`[previous line repeated ${count - 1} times]`);
  };
  for (const line of text.split('\n')) {
    if (line === previous) count++;
    else { flush(); previous = line; count = 1; }
  }
  flush();
  return result.join('\n');
}

export function minifyJson(text) {
  try { return JSON.stringify(JSON.parse(text)); } catch { return text; }
}

export function headTail(text, limit = 6000) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n[elided ${text.length - limit} characters]\n${text.slice(-half)}`;
}

export function recoverToolResult(id) {
  const value = originals.get(id);
  if (value === undefined) return undefined;
  originals.delete(id);
  originals.set(id, value);
  return value;
}

export function compressToolResult(original, { enabled = false, limit = 6000 } = {}) {
  if (!enabled || typeof original !== 'string') return original;
  let compressed = minifyJson(collapseWhitespace(stripAnsi(original)));
  compressed = headTail(dedupeRepeatedLines(compressed), limit);
  if (compressed.length >= original.length) return original;
  const id = createHash('sha256').update(original).digest('hex');
  originals.delete(id);
  originals.set(id, original);
  while (originals.size > MAX_ENTRIES) originals.delete(originals.keys().next().value);
  const withReference = `[full tool result: ${id}; call result_full with id and optional offset/length]\n${compressed}`;
  if (withReference.length >= original.length) return original;
  return withReference;
}
