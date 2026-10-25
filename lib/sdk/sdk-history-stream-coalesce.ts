/**
 * Coalesce consecutive assistant/thinking SDK history records into one snapshot.
 * DeepSeek (and similar) persist every token as its own event; after a tail-page
 * reload those fragments render as separate Answer blocks.
 *
 * Merge mode (`streamTextMode` on SDK-shaped assistant events):
 * - **delta** — OpenCode/DeepSeek/Codex/CodeBuddy token chunks; always append.
 * - **snapshot** — Cursor SDK, OpenRouter, Qwen/Claude absorbed stream, OpenCode
 *   full-text updates; prefix replace/grow (see mergeSdkHistoryStreamText).
 */

export type SdkHistoryStreamTextMode = 'delta' | 'snapshot';

function asRecord(rec: unknown): Record<string, unknown> | null {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  return rec as Record<string, unknown>;
}

export function readSdkHistoryStreamKind(rec: unknown): 'assistant' | 'thinking' | '' {
  const row = asRecord(rec);
  if (!row || row.kind !== 'sdk') return '';
  const event = asRecord(row.event);
  if (!event) return '';
  const type = typeof event.type === 'string' ? event.type.toLowerCase() : '';
  if (type === 'assistant' || type === 'thinking') return type;
  return '';
}

export function readSdkHistoryStreamText(rec: unknown): string {
  const kind = readSdkHistoryStreamKind(rec);
  const row = asRecord(rec);
  const event = row ? asRecord(row.event) : null;
  if (!kind || !event) return '';
  if (kind === 'thinking') {
    return typeof event.text === 'string' ? event.text : '';
  }
  const message = asRecord(event.message);
  const content = message && Array.isArray(message.content) ? message.content : [];
  let out = '';
  for (const block of content) {
    const item = asRecord(block);
    if (item && item.type === 'text' && typeof item.text === 'string') out += item.text;
  }
  return out;
}

export function readAssistantStreamTextMode(event: unknown): SdkHistoryStreamTextMode {
  if (!event || typeof event !== 'object') return 'snapshot';
  const rec = event as Record<string, unknown>;
  const mode = rec.streamTextMode ?? rec.assistantStreamTextMode;
  if (mode === 'delta' || mode === 'snapshot') return mode;
  return 'snapshot';
}

export function readSdkHistoryStreamTextMode(rec: unknown): SdkHistoryStreamTextMode {
  const row = asRecord(rec);
  const event = row ? asRecord(row.event) : null;
  if (!event) return 'snapshot';
  return readAssistantStreamTextMode(event);
}

export function mergeSdkHistoryStreamText(
  prev: string,
  next: string,
  mode: SdkHistoryStreamTextMode = 'snapshot',
): string {
  const previous = String(prev || '');
  const incoming = String(next || '');
  if (!previous) return incoming;
  if (!incoming) return previous;
  if (mode === 'delta') return previous + incoming;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming) && incoming.length < previous.length) return previous;
  return previous + incoming;
}

export function withSdkHistoryStreamText(rec: Record<string, unknown>, text: string): Record<string, unknown> {
  const event = asRecord(rec.event) || {};
  const kind = readSdkHistoryStreamKind(rec);
  if (kind === 'thinking') {
    return { ...rec, event: { ...event, type: 'thinking', text } };
  }
  const message = asRecord(event.message) || {};
  return {
    ...rec,
    event: {
      ...event,
      type: 'assistant',
      message: {
        ...message,
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    },
  };
}

export function coalesceSdkHistoryItems(
  items: Array<{ rec?: unknown; clientSeq?: number }>,
): Array<{ rec: unknown; clientSeq?: number }> {
  const list = Array.isArray(items) ? items : [];
  const out: Array<{ rec: Record<string, unknown>; clientSeq?: number }> = [];
  for (const item of list) {
    const rec = asRecord(item?.rec);
    if (!rec) continue;
    const kind = readSdkHistoryStreamKind(rec);
    const prev = out[out.length - 1];
    const prevKind = prev ? readSdkHistoryStreamKind(prev.rec) : '';
    if (!kind || kind !== prevKind) {
      out.push({ ...item, rec });
      continue;
    }
    const mergeMode = readSdkHistoryStreamTextMode(rec);
    const mergedText = mergeSdkHistoryStreamText(
      readSdkHistoryStreamText(prev.rec),
      readSdkHistoryStreamText(rec),
      mergeMode,
    );
    prev.rec = withSdkHistoryStreamText(prev.rec, mergedText);
  }
  return out;
}

/**
 * Walks an event pool backward so a tail page does not start mid-assistant/thinking stream.
 */
export function extendHistorySliceToStreamBoundary(
  pool: Array<{ seq: number; rec: unknown }>,
  slice: Array<{ seq: number; rec: unknown }>,
  maxLen: number,
): Array<{ seq: number; rec: unknown }> {
  if (!Array.isArray(pool) || pool.length === 0) return Array.isArray(slice) ? slice : [];
  if (!Array.isArray(slice) || slice.length === 0) return slice;
  const startIdx = pool.length - slice.length;
  if (startIdx < 0) return slice;
  const kind = readSdkHistoryStreamKind(pool[startIdx]?.rec);
  if (!kind) return slice;
  const cap = Math.max(slice.length, Number(maxLen) || slice.length);
  let idx = startIdx;
  while (idx > 0 && pool.length - (idx - 1) <= cap) {
    if (readSdkHistoryStreamKind(pool[idx - 1]?.rec) !== kind) break;
    idx -= 1;
  }
  return pool.slice(idx);
}
