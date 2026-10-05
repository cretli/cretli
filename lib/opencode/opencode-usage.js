/**
 * Maps OpenCode SSE payloads to SDK-shaped usage events for the usage ledger.
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object') return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * OpenCode v2 may wrap domain events in `{ type: 'sync', syncEvent: { … data } }`.
 *
 * @param {unknown} event
 * @returns {Record<string, unknown> | null}
 */
export function unwrapOpenCodeStreamEvent(event) {
  const rec = asRecord(event);
  if (!rec) return null;
  if (rec.type !== 'sync') return rec;
  const syncEvent = asRecord(rec.syncEvent);
  if (!syncEvent) return rec;
  const rawType = typeof syncEvent.type === 'string' ? syncEvent.type.trim() : '';
  if (!rawType) return rec;
  const data = asRecord(syncEvent.data);
  if (!data) return rec;
  const type = rawType.endsWith('.1') ? rawType.slice(0, -2) : rawType;
  return { ...rec, type, properties: data };
}

/**
 * @param {unknown} tokens
 * @returns {{ input: number, output: number, reasoning: number, cacheRead: number } | null}
 */
export function readOpenCodeTokenSnapshot(tokens) {
  const rec = asRecord(tokens);
  if (!rec) return null;
  const cache = asRecord(rec.cache);
  return {
    input: Math.max(0, Number(rec.input) || 0),
    output: Math.max(0, Number(rec.output) || 0),
    reasoning: Math.max(0, Number(rec.reasoning) || 0),
    cacheRead: Math.max(0, Number(cache?.read) || 0),
  };
}

/**
 * @param {{ input: number, output: number, reasoning: number, cacheRead: number }} prev
 * @param {{ input: number, output: number, reasoning: number, cacheRead: number }} curr
 * @returns {{ input: number, output: number, reasoning: number, cacheRead: number }}
 */
function diffOpenCodeTokenSnapshots(prev, curr) {
  return {
    input: Math.max(0, curr.input - prev.input),
    output: Math.max(0, curr.output - prev.output),
    reasoning: Math.max(0, curr.reasoning - prev.reasoning),
    cacheRead: Math.max(0, curr.cacheRead - prev.cacheRead),
  };
}

/**
 * @param {{ input: number, output: number, reasoning: number, cacheRead: number }} delta
 * @returns {boolean}
 */
function hasOpenCodeTokenDelta(delta) {
  return delta.input > 0 || delta.output > 0 || delta.reasoning > 0 || delta.cacheRead > 0;
}

/**
 * @param {{ input: number, output: number, reasoning: number, cacheRead: number }} delta
 * @returns {{ type: 'usage', usage: { tokens: { input: number, output: number, reasoning: number, cache: { read: number, write: number } } } }}
 */
export function buildOpenCodeUsageSdkEvent(delta) {
  return {
    type: 'usage',
    usage: {
      tokens: {
        input: delta.input,
        output: delta.output,
        reasoning: delta.reasoning,
        cache: { read: delta.cacheRead, write: 0 },
      },
    },
  };
}

/**
 * @param {Map<string, { input: number, output: number, reasoning: number, cacheRead: number }>} tokensByMessageId
 * @param {string} messageId
 * @param {{ input: number, output: number, reasoning: number, cacheRead: number }} curr
 * @returns {{ input: number, output: number, reasoning: number, cacheRead: number } | null}
 */
export function noteOpenCodeMessageTokenDelta(tokensByMessageId, messageId, curr) {
  const msgId = String(messageId || '').trim();
  if (!msgId || !curr) return null;
  const prev = tokensByMessageId.get(msgId) || { input: 0, output: 0, reasoning: 0, cacheRead: 0 };
  const delta = diffOpenCodeTokenSnapshots(prev, curr);
  tokensByMessageId.set(msgId, curr);
  if (!hasOpenCodeTokenDelta(delta)) return null;
  return delta;
}

/**
 * @param {unknown} event
 * @param {Map<string, { input: number, output: number, reasoning: number, cacheRead: number }>} tokensByMessageId
 * @returns {{ messageId: string, delta: { input: number, output: number, reasoning: number, cacheRead: number }, sdkEvent: ReturnType<typeof buildOpenCodeUsageSdkEvent> } | null}
 */
export function resolveOpenCodeUsageFromStreamEvent(event, tokensByMessageId) {
  const rec = unwrapOpenCodeStreamEvent(event);
  if (!rec || typeof rec.type !== 'string') return null;
  const type = rec.type;
  const properties = asRecord(rec.properties);
  if (!properties) return null;
  if (type === 'message.updated') {
    const info = asRecord(properties.info);
    if (!info || info.role !== 'assistant') return null;
    const snapshot = readOpenCodeTokenSnapshot(info.tokens);
    if (!snapshot) return null;
    const messageId = typeof info.id === 'string' ? info.id.trim() : '';
    const delta = noteOpenCodeMessageTokenDelta(tokensByMessageId, messageId, snapshot);
    if (!delta) return null;
    return { messageId, delta, sdkEvent: buildOpenCodeUsageSdkEvent(delta) };
  }
  if (type === 'session.next.step.ended') {
    const snapshot = readOpenCodeTokenSnapshot(properties.tokens);
    if (!snapshot) return null;
    const messageId = typeof properties.assistantMessageID === 'string'
      ? properties.assistantMessageID.trim()
      : '';
    const delta = noteOpenCodeMessageTokenDelta(tokensByMessageId, messageId, snapshot);
    if (!delta) return null;
    return { messageId, delta, sdkEvent: buildOpenCodeUsageSdkEvent(delta) };
  }
  return null;
}
