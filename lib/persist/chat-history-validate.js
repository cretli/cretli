/**
 * Chat history record validation — shared between the server and the frontend.
 * Schema: { kind: 'sdk' | 'localUser' | 'meta', ... }
 */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} rec
 * @returns {boolean}
 */
export function isValidSdkHistoryRecord(rec) {
  if (!isPlainObject(rec)) return false;
  if ('createdAt' in rec && typeof rec.createdAt !== 'string') return false;
  const kind = rec.kind;
  if (kind === 'sdk') {
    if ('harness' in rec && rec.harness != null && typeof rec.harness !== 'string') return false;
    return isPlainObject(rec.event);
  }
  if (kind === 'localUser') {
    return typeof rec.text === 'string';
  }
  if (kind === 'meta') {
    const v = rec.variant;
    const ok =
      v === 'banner' ||
      v === 'runFinished' ||
      v === 'busy' ||
      v === 'queued' ||
      v === 'queueRemoved' ||
      v === 'mode' ||
      v === 'error' ||
      v === 'notice' ||
      v === 'contextSeed' ||
      v === 'delegation' ||
      v === 'mailbox' ||
      v === 'relatedChat';
    return ok && (rec.payload == null || typeof rec.payload === 'string');
  }
  return false;
}

/**
 * JSON-safe copy of an event, matching what goes over the WS wire.
 * @param {unknown} event
 * @returns {Record<string, unknown> | null}
 */
export function cloneSerializableSdkEvent(event) {
  if (!isPlainObject(event)) return null;
  try {
    return /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(event)));
  } catch {
    return null;
  }
}
