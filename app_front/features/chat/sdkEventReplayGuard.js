/**
 * Resets the event watermark after a new SDK room is created on the server.
 *
 * @param {object} chat
 * @param {unknown} streamId
 */
export function syncSdkEventStream(chat, streamId) {
  if (!chat || typeof chat !== 'object') return;
  const normalized = typeof streamId === 'string' ? streamId.trim() : '';
  if (!normalized || chat._sdkEventStreamId === normalized) return;
  chat._sdkEventStreamId = normalized;
  delete chat._sdkLastRoomEventSeq;
  const hydratedSeq = Number(chat._sdkHydratedRoomEventSeqByStream?.[normalized]);
  if (Number.isSafeInteger(hydratedSeq) && hydratedSeq > 0) {
    chat._sdkLastRoomEventSeq = hydratedSeq;
  }
}

/**
 * Drops events replayed again after reconnecting to the same room.
 * Older servers that do not send roomEventSeq stay compatible.
 *
 * @param {object} chat
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
export function shouldApplySdkRoomEvent(chat, message) {
  if (!chat || typeof chat !== 'object') return true;
  const seq = Number(message?.roomEventSeq);
  if (!Number.isSafeInteger(seq) || seq < 1) return true;

  const streamId =
    typeof message.eventStreamId === 'string' && message.eventStreamId.trim()
      ? message.eventStreamId.trim()
      : typeof chat._sdkEventStreamId === 'string'
        ? chat._sdkEventStreamId.trim()
        : '';
  if (streamId) {
    const hydratedByStream = { ...(chat._sdkHydratedRoomEventSeqByStream || {}) };
    const lastForStream = Number(hydratedByStream[streamId]) || 0;
    if (seq <= lastForStream) return false;
    hydratedByStream[streamId] = seq;
    chat._sdkHydratedRoomEventSeqByStream = hydratedByStream;
    if (streamId === (typeof chat._sdkEventStreamId === 'string' ? chat._sdkEventStreamId.trim() : '')) {
      chat._sdkLastRoomEventSeq = seq;
    }
    return true;
  }

  const lastSeq = Number(chat._sdkLastRoomEventSeq);
  if (Number.isSafeInteger(lastSeq) && seq <= lastSeq) return false;

  chat._sdkLastRoomEventSeq = seq;
  return true;
}

/**
 * Holds back the WS replay until the authoritative HTTP history is restored.
 *
 * @param {object} chat
 */
export function beginSdkHistoryHydration(chat) {
  if (!chat || typeof chat !== 'object') return;
  chat._sdkHistoryHydrating = true;
  chat._sdkLiveDuringHydration = false;
  chat._sdkPendingRoomEvents = [];
}

/**
 * Marks hydration owned by openTerminal (fresh load / chat select), not PWA resume.
 *
 * @param {object} chat
 */
export function beginSdkOpenTerminalHydration(chat) {
  if (!chat || typeof chat !== 'object') return;
  beginSdkHistoryHydration(chat);
  chat._sdkOpenTerminalHydrating = true;
}

/**
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function isSdkOpenTerminalHydrating(chat) {
  return chat?._sdkOpenTerminalHydrating === true;
}

/**
 * @param {object} chat
 */
export function clearSdkOpenTerminalHydrating(chat) {
  if (!chat || typeof chat !== 'object') return;
  delete chat._sdkOpenTerminalHydrating;
}

/**
 * After a new prompt is sent the incoming WS frames are live and must not wait
 * for the slower HTTP history pull.
 *
 * @param {object} chat
 */
export function allowSdkLiveEventsDuringHydration(chat) {
  if (!chat || typeof chat !== 'object' || chat._sdkHistoryHydrating !== true) return;
  chat._sdkLiveDuringHydration = true;
}

/**
 * @param {object} chat
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
export function bufferSdkRoomEventDuringHydration(chat, message) {
  if (!chat || typeof chat !== 'object' || chat._sdkHistoryHydrating !== true) return false;
  if (chat._sdkReplayTagged === true && message?.replay !== true) return false;
  if (chat._sdkLiveDuringHydration === true) return false;
  if (!Array.isArray(chat._sdkPendingRoomEvents)) chat._sdkPendingRoomEvents = [];
  chat._sdkPendingRoomEvents.push(message);
  return true;
}

/**
 * Ends hydration and sets the room watermark from the records already restored
 * from the server. Returns the WS events that arrived during the pull.
 *
 * @param {object} chat
 * @param {unknown[]} records
 * @returns {Array<Record<string, unknown>>}
 */
export function finishSdkHistoryHydration(chat, records) {
  if (!chat || typeof chat !== 'object') return [];

  const currentStreamId =
    typeof chat._sdkEventStreamId === 'string' ? chat._sdkEventStreamId.trim() : '';
  const hasIncomingRecords = Array.isArray(records) && records.length > 0;
  /** @type {Record<string, number>} */
  const hydratedSeqByStream = hasIncomingRecords
    ? {}
    : { ...(chat._sdkHydratedRoomEventSeqByStream || {}) };
  if (hasIncomingRecords) {
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const rec = /** @type {Record<string, unknown>} */ (record);
      const streamId = typeof rec.eventStreamId === 'string' ? rec.eventStreamId.trim() : '';
      if (!streamId) continue;
      const seq = Number(rec.roomEventSeq);
      if (!Number.isSafeInteger(seq) || seq < 1) continue;
      hydratedSeqByStream[streamId] = Math.max(hydratedSeqByStream[streamId] || 0, seq);
    }
  }
  chat._sdkHydratedRoomEventSeqByStream = hydratedSeqByStream;
  const lastSeq = hydratedSeqByStream[currentStreamId] || 0;
  if (lastSeq > 0) chat._sdkLastRoomEventSeq = lastSeq;

  const pending = Array.isArray(chat._sdkPendingRoomEvents)
    ? chat._sdkPendingRoomEvents.splice(0)
    : [];
  chat._sdkHistoryHydrating = false;
  delete chat._sdkLiveDuringHydration;
  delete chat._sdkPendingRoomEvents;
  return pending;
}

/**
 * Returns the history records from a given SDK stream that the client has not
 * applied yet. Watermarks are advanced so a concurrent WS replay cannot render
 * the same events a second time.
 *
 * Records without a stream id are skipped during incremental catch-up: there is
 * no safe way to tell them apart from entries that are already visible.
 *
 * @param {object} chat
 * @param {unknown[]} records
 * @returns {unknown[]}
 */
export function takeMissingSdkHistoryRecords(chat, records) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(records)) return [];

  const currentStreamId =
    typeof chat._sdkEventStreamId === 'string' ? chat._sdkEventStreamId.trim() : '';
  const hydratedByStream = {
    ...(chat._sdkHydratedRoomEventSeqByStream || {}),
  };
  if (currentStreamId) {
    const currentSeq = Number(chat._sdkLastRoomEventSeq);
    if (Number.isSafeInteger(currentSeq) && currentSeq > 0) {
      hydratedByStream[currentStreamId] = Math.max(
        hydratedByStream[currentStreamId] || 0,
        currentSeq
      );
    }
  }

  const missing = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const rec = /** @type {Record<string, unknown>} */ (record);
    const streamId = typeof rec.eventStreamId === 'string' ? rec.eventStreamId.trim() : '';
    const seq = Number(rec.roomEventSeq);
    if (!streamId || !Number.isSafeInteger(seq) || seq < 1) continue;
    if (seq <= (hydratedByStream[streamId] || 0)) continue;
    hydratedByStream[streamId] = seq;
    missing.push(record);
  }

  chat._sdkHydratedRoomEventSeqByStream = hydratedByStream;
  if (currentStreamId && hydratedByStream[currentStreamId] > 0) {
    chat._sdkLastRoomEventSeq = hydratedByStream[currentStreamId];
  }
  return missing;
}

/**
 * Advances room-event watermarks from WS replay frames without touching the DOM.
 * Used when the rich view already shows cached history after PWA resume.
 *
 * @param {object} chat
 * @param {unknown[]} messages
 */
export function advanceSdkRoomEventWatermarksFromMessages(chat, messages) {
  if (!chat || typeof chat !== 'object' || !Array.isArray(messages) || messages.length === 0) {
    return;
  }
  const currentStreamId =
    typeof chat._sdkEventStreamId === 'string' ? chat._sdkEventStreamId.trim() : '';
  const hydratedByStream = { ...(chat._sdkHydratedRoomEventSeqByStream || {}) };
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const msg = /** @type {Record<string, unknown>} */ (message);
    const streamId =
      typeof msg.eventStreamId === 'string' && msg.eventStreamId.trim()
        ? msg.eventStreamId.trim()
        : currentStreamId;
    const seq = Number(msg.roomEventSeq);
    if (!streamId || !Number.isSafeInteger(seq) || seq < 1) continue;
    hydratedByStream[streamId] = Math.max(hydratedByStream[streamId] || 0, seq);
  }
  chat._sdkHydratedRoomEventSeqByStream = hydratedByStream;
  if (currentStreamId && hydratedByStream[currentStreamId] > 0) {
    chat._sdkLastRoomEventSeq = hydratedByStream[currentStreamId];
  }
}
