export const ROOM_STATE_HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Builds a lightweight room snapshot for reconnect sync without full replay.
 *
 * @param {{
 *   eventStreamId?: string,
 *   eventSeq?: number,
 *   busy?: boolean,
 *   currentRun?: { id?: string } | null,
 *   lastRunId?: string | null,
 *   pendingPrompts?: Array<unknown>,
 *   clients?: Set<unknown>,
 * }} room
 * @returns {Record<string, unknown>}
 */
export function buildSdkRoomStatePayload(room) {
  const eventStreamId =
    typeof room?.eventStreamId === 'string' ? room.eventStreamId.trim() : '';
  const lastRoomEventSeq = Number.isFinite(room?.eventSeq) ? Number(room.eventSeq) : 0;
  const queuedCount = Array.isArray(room?.pendingPrompts) ? room.pendingPrompts.length : 0;
  const currentRunId =
    room?.currentRun &&
    typeof room.currentRun === 'object' &&
    typeof room.currentRun.id === 'string'
      ? room.currentRun.id.trim()
      : '';
  const lastRunId = typeof room?.lastRunId === 'string' ? room.lastRunId.trim() : '';
  const lastRunStatus =
    typeof room?.lastRunStatus === 'string' ? room.lastRunStatus.trim() : '';
  const lastErrorCode =
    typeof room?.lastErrorCode === 'string' ? room.lastErrorCode.trim() : '';
  const lastErrorMessage =
    typeof room?.lastErrorMessage === 'string' ? room.lastErrorMessage.trim() : '';
  const pendingQuestionCount =
    room?._pendingOpenCodeQuestions instanceof Map ? room._pendingOpenCodeQuestions.size : 0;
  const pendingPermissionCount =
    room?._pendingOpenCodePermissions instanceof Map ? room._pendingOpenCodePermissions.size : 0;
  const lastEventAt = Number.isFinite(room?.lastEventAt) ? Number(room.lastEventAt) : null;
  const transport = typeof room?.transport === 'string' ? room.transport.trim() : '';
  return {
    type: 'sdkRoomState',
    eventStreamId,
    busy: !!room?.busy,
    hasCurrentRun: !!room?.currentRun,
    runId: currentRunId || lastRunId || null,
    lastRunId: lastRunId || null,
    lastRunStatus: lastRunStatus || null,
    lastErrorCode: lastErrorCode || null,
    lastErrorMessage: lastErrorMessage || null,
    lastRoomEventSeq,
    queuedCount,
    clientCount: room?.clients?.size || 0,
    pendingQuestionCount,
    pendingPermissionCount,
    lastEventAt,
    transport: transport || null,
    at: Date.now(),
  };
}

/**
 * Returns true when the client should pull HTTP history to close a seq gap.
 *
 * @param {{ _sdkLastRoomEventSeq?: number, _sdkHistoryHydrating?: boolean }} chat
 * @param {Record<string, unknown>} message
 * @returns {boolean}
 */
export function shouldSyncHistoryFromRoomState(chat, message) {
  if (!chat || chat._sdkHistoryHydrating === true) return false;
  if (!message || message.type !== 'sdkRoomState') return false;
  const serverSeq = Number(message.lastRoomEventSeq);
  if (!Number.isSafeInteger(serverSeq) || serverSeq < 1) return false;
  const clientSeq = Number(chat._sdkLastRoomEventSeq);
  if (!Number.isSafeInteger(clientSeq) || clientSeq < 1) return true;
  return serverSeq > clientSeq;
}

/**
 * @param {'idle' | 'active' | 'disconnected'} prev
 * @param {Record<string, unknown>} message
 * @returns {'idle' | 'active' | 'disconnected' | null}
 */
export function resolveAgentStateFromRoomState(prev, message) {
  if (!message || message.type !== 'sdkRoomState') return null;
  if (message.busy === true) return 'active';
  const queuedCount = Number(message.queuedCount);
  if (Number.isSafeInteger(queuedCount) && queuedCount > 0) return 'active';
  const pendingQuestionCount = Number(message.pendingQuestionCount);
  if (Number.isSafeInteger(pendingQuestionCount) && pendingQuestionCount > 0) return 'active';
  const pendingPermissionCount = Number(message.pendingPermissionCount);
  if (Number.isSafeInteger(pendingPermissionCount) && pendingPermissionCount > 0) return 'active';
  if (prev === 'disconnected') return null;
  return 'idle';
}

/**
 * @param {unknown} clientSeq
 * @param {unknown} serverSeq
 * @returns {number | null}
 */
export function computeRoomEventSeqGap(clientSeq, serverSeq) {
  const server = Number(serverSeq);
  if (!Number.isSafeInteger(server) || server < 0) return null;
  const client = Number(clientSeq);
  if (!Number.isSafeInteger(client) || client < 1) return server;
  return Math.max(0, server - client);
}

/**
 * @param {unknown} clientSeq
 * @param {unknown} serverSeq
 * @returns {{
 *   clientSeq: number | null,
 *   serverSeq: number | null,
 *   gap: number | null,
 *   gapLabel: string,
 *   isSynced: boolean,
 * }}
 */
export function formatRoomEventSeqDiag(clientSeq, serverSeq) {
  const normalizedClient =
    Number.isSafeInteger(Number(clientSeq)) && Number(clientSeq) > 0 ? Number(clientSeq) : null;
  const normalizedServer =
    Number.isSafeInteger(Number(serverSeq)) && Number(serverSeq) > 0 ? Number(serverSeq) : null;
  const gap = computeRoomEventSeqGap(normalizedClient, normalizedServer);
  if (gap == null) {
    return {
      clientSeq: normalizedClient,
      serverSeq: normalizedServer,
      gap: null,
      gapLabel: '—',
      isSynced: false,
    };
  }
  if (gap === 0) {
    return {
      clientSeq: normalizedClient,
      serverSeq: normalizedServer,
      gap: 0,
      gapLabel: '0 (synced)',
      isSynced: true,
    };
  }
  return {
    clientSeq: normalizedClient,
    serverSeq: normalizedServer,
    gap,
    gapLabel: String(gap),
    isSynced: false,
  };
}
