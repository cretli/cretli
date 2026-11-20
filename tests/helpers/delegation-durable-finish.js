import { randomUUID } from 'node:crypto';
import { getDelegationById } from '../../lib/persist/delegations-persist.js';
import { appendChatHistoryEvents } from '../../lib/persist/chat-history-service.js';
import { createHistoryFlusher } from '../../lib/persist/history-room-flusher.js';
import { mapWsPayloadToHistoryRecord } from '../../lib/agent-harness/room-kernel.ts';
import { noteDelegationRoomEvent } from '../../lib/delegation-run-bridge.js';

/** Build the production terminal mapping and flusher around an isolated test room. */
export function createDurableFinishRoom(row, options = {}) {
  const current = getDelegationById(row.id);
  const payload = { type: 'sdkRunFinished', status: 'completed', runId: current.runId, roomEventSeq: 1 };
  const room = {
    chatId: current.childChatId,
    sessionKey: `oc-${current.childChatId}`,
    delegationId: current.id,
    delegationAttemptId: current.attemptId,
    delegationAssignment: current.assignment,
    serverHold: true,
    _runId: current.runId,
    eventStreamId: randomUUID(),
    _currentRunAssistantText: `TASK: ${current.assignment}\nVERDICT: PASS\nCompleted with durable terminal history.`,
    _persistBuf: [],
  };
  room._persistBuf.push({ rec: mapWsPayloadToHistoryRecord(payload.type, payload, {
    eventStreamId: room.eventStreamId, roomEventSeq: payload.roomEventSeq, harness: 'opencode',
  }).rec });
  const flusher = createHistoryFlusher({
    append: options.append || ((target, items) => appendChatHistoryEvents(target.chatId, `oc-${target.chatId}`, items)),
    warn: () => {},
    // Retained failures are deliberately retried only by the test, never by a timer.
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  room._flushHistory = () => flusher.flush(room);
  return { room, payload };
}

/** Confirm a fixture's finish through the real bridge, mapping and history flusher. */
export async function confirmDurableFinish(row) {
  const { room, payload } = createDurableFinishRoom(row);
  await noteDelegationRoomEvent(room, payload);
  return getDelegationById(row.id);
}
