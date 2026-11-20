/**
 * Helpers for stable catch-up replay in xterm.
 * Pure functions (no DOM) so they stay easy to test.
 */

export function buildCatchUpSignature(data) {
  const s = typeof data === 'string' ? data : String(data || '');
  if (!s) return '0::';

  const head = s.slice(0, 140);
  const midStart = Math.max(0, Math.floor(s.length / 2) - 70);
  const middle = s.slice(midStart, midStart + 140);
  const tail = s.slice(-140);

  return `${s.length}:${head}:${middle}:${tail}`;
}

export function enqueueCatchUpOutputChunk(chat, data, maxChunks) {
  if (!chat) return;
  if (!Array.isArray(chat._pendingOutputChunks)) {
    chat._pendingOutputChunks = [];
  }
  const safeMax = Math.max(1, Number(maxChunks) || 1);
  if (chat._pendingOutputChunks.length >= safeMax) {
    chat._pendingOutputChunks.shift();
  }
  chat._pendingOutputChunks.push(data);
}

export function drainCatchUpOutputChunks(chat, onChunk) {
  if (!chat || !Array.isArray(chat._pendingOutputChunks) || chat._pendingOutputChunks.length === 0) {
    return 0;
  }
  const chunks = chat._pendingOutputChunks;
  chat._pendingOutputChunks = [];
  let processed = 0;
  for (const chunk of chunks) {
    processed += 1;
    if (typeof onChunk === 'function') onChunk(chunk);
  }
  return processed;
}
