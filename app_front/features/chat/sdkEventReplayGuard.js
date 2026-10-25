const SERVER_AUTHORED_HISTORY_META = new Set(['delegation', 'mailbox', 'relatedChat']);

/**
 * History cards written outside the agent event stream have no roomEventSeq.
 *
 * @param {Record<string, unknown> | null | undefined} rec
 * @returns {boolean}
 */
export function isServerAuthoredHistoryMeta(rec) {
  if (!rec || rec.kind !== 'meta') return false;
  return SERVER_AUTHORED_HISTORY_META.has(String(rec.variant || ''));
}

/**
 * @param {object | null | undefined} chat
 * @param {Record<string, unknown> | null | undefined} message
 * @returns {{ streamId: string, seq: number }}
 */
function resolveSdkRoomEventRef(chat, message) {
  const seq = Number(message?.roomEventSeq);
  const fromMessage =
    typeof message?.eventStreamId === 'string' ? message.eventStreamId.trim() : '';
  const fromChat =
    typeof chat?._sdkEventStreamId === 'string' ? chat._sdkEventStreamId.trim() : '';
  return {
    streamId: fromMessage || fromChat,
    seq: Number.isSafeInteger(seq) && seq > 0 ? seq : 0,
  };
}

/**
 * @param {object | null | undefined} chat
 * @returns {Record<string, number[]>}
 */
function cloneUnrenderedRoomEventSeqs(chat) {
  const source = chat?._sdkUnrenderedRoomEventSeqsByStream;
  if (!source || typeof source !== 'object') return {};
  /** @type {Record<string, number[]>} */
  const next = {};
  for (const [streamId, seqs] of Object.entries(source)) {
    if (!Array.isArray(seqs)) continue;
    const cleaned = seqs
      .map((value) => Number(value))
      .filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    if (cleaned.length > 0) next[streamId] = cleaned;
  }
  return next;
}

/**
 * @param {object} chat
 * @param {Record<string, number[]>} next
 */
function writeUnrenderedRoomEventSeqs(chat, next) {
  const cleaned = {};
  for (const [streamId, seqs] of Object.entries(next)) {
    if (Array.isArray(seqs) && seqs.length > 0) cleaned[streamId] = seqs;
  }
  if (Object.keys(cleaned).length === 0) {
    delete chat._sdkUnrenderedRoomEventSeqsByStream;
    return;
  }
  chat._sdkUnrenderedRoomEventSeqsByStream = cleaned;
}

/**
 * True when this room seq was accepted on the WS path but never landed in the
 * view. A later seq must not cover that hole.
 *
 * @param {object | null | undefined} chat
 * @param {string} streamId
 * @param {number} seq
 * @returns {boolean}
 */
export function hasUnrenderedSdkRoomEventSeq(chat, streamId, seq) {
  if (!chat || typeof chat !== 'object' || !streamId) return false;
  if (!Number.isSafeInteger(seq) || seq < 1) return false;
  const seqs = chat._sdkUnrenderedRoomEventSeqsByStream?.[streamId];
  return Array.isArray(seqs) && seqs.includes(seq);
}

/**
 * Remembers a room seq whose apply/render threw. Rollback of the high-water
 * mark alone cannot keep this hole if a later seq is then applied.
 *
 * @param {object | null | undefined} chat
 * @param {Record<string, unknown> | null | undefined} message
 */
export function rememberUnrenderedSdkRoomEvent(chat, message) {
  if (!chat || typeof chat !== 'object') return;
  const { streamId, seq } = resolveSdkRoomEventRef(chat, message);
  if (!streamId || seq < 1) return;
  const byStream = cloneUnrenderedRoomEventSeqs(chat);
  const seqs = byStream[streamId] ? [...byStream[streamId]] : [];
  if (!seqs.includes(seq)) seqs.push(seq);
  byStream[streamId] = seqs;
  writeUnrenderedRoomEventSeqs(chat, byStream);
}

/**
 * Clears a hole after the current view actually rendered that room seq.
 *
 * @param {object | null | undefined} chat
 * @param {Record<string, unknown> | null | undefined} message
 */
export function noteRenderedSdkRoomEvent(chat, message) {
  if (!chat || typeof chat !== 'object') return;
  const { streamId, seq } = resolveSdkRoomEventRef(chat, message);
  if (!streamId || seq < 1) return;
  const byStream = cloneUnrenderedRoomEventSeqs(chat);
  const seqs = byStream[streamId];
  if (!Array.isArray(seqs) || seqs.length === 0) return;
  const remaining = seqs.filter((value) => value !== seq);
  if (remaining.length === seqs.length) return;
  if (remaining.length === 0) delete byStream[streamId];
  else byStream[streamId] = remaining;
  writeUnrenderedRoomEventSeqs(chat, byStream);
}

/**
 * Drops hole memory with the pane. Store ACK stays.
 *
 * @param {object | null | undefined} chat
 */
export function clearUnrenderedSdkRoomEvents(chat) {
  if (!chat || typeof chat !== 'object') return;
  delete chat._sdkUnrenderedRoomEventSeqsByStream;
}

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
  const { streamId, seq } = resolveSdkRoomEventRef(chat, message);
  if (seq < 1) return true;
  if (hasUnrenderedSdkRoomEventSeq(chat, streamId, seq)) return true;

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
  const generation = Number(chat._sdkViewApplyGeneration);
  chat._sdkHistoryHydrationGeneration =
    Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
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
 * True when this hydration was started for the given view generation.
 * An older convergence must not finish a newer pane's hydration.
 *
 * @param {object | null | undefined} chat
 * @param {unknown} generation
 * @returns {boolean}
 */
export function ownsSdkHistoryHydration(chat, generation) {
  if (!chat || chat._sdkHistoryHydrating !== true) return false;
  const owned = Number(chat._sdkHistoryHydrationGeneration);
  const expected = Number(generation);
  const ownedGeneration = Number.isSafeInteger(owned) && owned > 0 ? owned : 0;
  const expectedGeneration = Number.isSafeInteger(expected) && expected > 0 ? expected : 0;
  return ownedGeneration === expectedGeneration;
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
  delete chat._sdkHistoryHydrationGeneration;
  return pending;
}

/**
 * True when this chat already applied SDK room events that carry stream seqs.
 * Local IndexedDB snapshots often omit eventStreamId, so an empty watermark
 * means a later server pull must replace the view instead of appending.
 *
 * @param {object | null | undefined} chat
 * @returns {boolean}
 */
export function hasSdkHistoryRoomWatermarks(chat) {
  if (!chat || typeof chat !== 'object') return false;
  const lastSeq = Number(chat._sdkLastRoomEventSeq);
  if (Number.isSafeInteger(lastSeq) && lastSeq > 0) return true;
  const byStream = chat._sdkHydratedRoomEventSeqByStream;
  if (!byStream || typeof byStream !== 'object') return false;
  return Object.values(byStream).some((seq) => {
    const value = Number(seq);
    return Number.isSafeInteger(value) && value > 0;
  });
}

/**
 * @param {object} chat
 * @param {unknown[]} records
 * @param {boolean} commit
 * @returns {unknown[]}
 */
function collectMissingSdkHistoryRecords(chat, records, commit) {
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
    if (isServerAuthoredHistoryMeta(rec) || rec.kind === 'localUser') {
      missing.push(record);
      continue;
    }
    const streamId = typeof rec.eventStreamId === 'string' ? rec.eventStreamId.trim() : '';
    const seq = Number(rec.roomEventSeq);
    if (!streamId || !Number.isSafeInteger(seq) || seq < 1) {
      const historySeq = Number(rec.historySeq);
      if (rec.kind === 'sdk' && Number.isSafeInteger(historySeq) && historySeq > 0) {
        missing.push(record);
      }
      continue;
    }
    if (hasUnrenderedSdkRoomEventSeq(chat, streamId, seq)) {
      missing.push(record);
      continue;
    }
    if (seq <= (hydratedByStream[streamId] || 0)) continue;
    hydratedByStream[streamId] = seq;
    missing.push(record);
  }

  if (commit !== true) return missing;
  chat._sdkHydratedRoomEventSeqByStream = hydratedByStream;
  if (currentStreamId && hydratedByStream[currentStreamId] > 0) {
    chat._sdkLastRoomEventSeq = hydratedByStream[currentStreamId];
  }
  for (const record of missing) {
    noteRenderedSdkRoomEvent(chat, /** @type {Record<string, unknown>} */ (record));
  }
  return missing;
}

/**
 * Returns history records already proven in the current view by the room
 * watermark. That watermark moves only on the render path (live apply or
 * successful catch-up), never from buffered receive alone. A later seq or
 * status frame does not cover a seq remembered as unrendered after apply
 * failed. Catch-up uses this to fill historySeq coverage for live/replay
 * events without re-rendering them.
 *
 * @param {object} chat
 * @param {unknown[]} records
 * @returns {unknown[]}
 */
export function selectRoomCoveredSdkHistoryRecords(chat, records) {
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
  const covered = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const rec = /** @type {Record<string, unknown>} */ (record);
    const streamId = typeof rec.eventStreamId === 'string' ? rec.eventStreamId.trim() : '';
    const seq = Number(rec.roomEventSeq);
    if (!streamId || !Number.isSafeInteger(seq) || seq < 1) continue;
    if (hasUnrenderedSdkRoomEventSeq(chat, streamId, seq)) continue;
    if (seq <= (hydratedByStream[streamId] || 0)) covered.push(record);
  }
  return covered;
}

/**
 * Same selection as takeMissingSdkHistoryRecords without moving watermarks.
 * Use this before an async render; commit with takeMissing after success.
 *
 * @param {object} chat
 * @param {unknown[]} records
 * @returns {unknown[]}
 */
export function selectMissingSdkHistoryRecords(chat, records) {
  return collectMissingSdkHistoryRecords(chat, records, false);
}

/**
 * Returns the history records from a given SDK stream that the client has not
 * applied yet. Watermarks are advanced so a concurrent WS replay cannot render
 * the same events a second time.
 *
 * Server-authored history cards (delegation, mailbox, relatedChat) have no
 * room stream ids. Their renderers upsert by id, so they can safely be
 * reapplied on catch-up. localUser rows and SDK records that only have a
 * durable historySeq are included so a prompt from another client is not
 * dropped. Ephemeral meta (banner, busy, runFinished) stays skipped.
 *
 * @param {object} chat
 * @param {unknown[]} records
 * @returns {unknown[]}
 */
export function takeMissingSdkHistoryRecords(chat, records) {
  return collectMissingSdkHistoryRecords(chat, records, true);
}

/**
 * Advances room-event watermarks from WS frames without touching the DOM.
 * Production catch-up must not use this as a substitute for rendering: a
 * receive watermark is not proof the current view holds the event.
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
