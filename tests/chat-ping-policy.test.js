import assert from 'node:assert/strict';
import {
  CHAT_RESUME_PROBE_PONG_DESKTOP_MS,
  CHAT_RESUME_PROBE_PONG_MOBILE_MS,
  CHAT_RESUME_PROBE_PONG_MS,
  CHAT_STALE_PONG_MS,
  recordPingSent,
  recordPongReceived,
  resolveResumeProbePongTimeoutMs,
  resolveUnackedPingAt,
  shouldCloseSocketForResumeProbeTimeout,
  shouldCloseSocketForStalePong,
  shouldMarkResumeSocketHealthy,
  listChatsNeedingPing,
  CHAT_PING_LOOP_INTERVAL_MS,
} from '../app_front/features/chat/chatPingPolicy.js';

const firstPing = recordPingSent({ sentAt: 1000, lastPingAt: 0, lastPongAt: 0 });
assert.equal(firstPing.lastPingAt, 1000);
assert.equal(firstPing.unackedPingAt, 1000);

const laterPing = recordPingSent({
  sentAt: 26000,
  lastPingAt: firstPing.lastPingAt,
  lastPongAt: 0,
  unackedPingAt: firstPing.unackedPingAt,
});
assert.equal(laterPing.lastPingAt, 26000);
assert.equal(laterPing.unackedPingAt, 1000, 'Later pings must not move the first unacked ping');

assert.equal(
  shouldCloseSocketForStalePong({
    unackedPingAt: laterPing.unackedPingAt,
    lastPingAt: laterPing.lastPingAt,
    lastPongAt: 0,
    now: 1000 + CHAT_STALE_PONG_MS,
    staleMs: CHAT_STALE_PONG_MS,
  }),
  false,
  'Equal to the limit is not yet stale'
);
assert.equal(
  shouldCloseSocketForStalePong({
    unackedPingAt: laterPing.unackedPingAt,
    lastPingAt: laterPing.lastPingAt,
    lastPongAt: 0,
    now: 1000 + CHAT_STALE_PONG_MS + 1,
    staleMs: CHAT_STALE_PONG_MS,
  }),
  true,
  'Stale timeout is measured from the first unacked ping'
);

const pong = recordPongReceived(27000);
assert.equal(pong.unackedPingAt, 0);
assert.equal(pong.awaitingResumeProbePong, false);
assert.equal(resolveUnackedPingAt({ lastPingAt: 26000, lastPongAt: 27000, unackedPingAt: 1000 }), 0);

assert.equal(shouldMarkResumeSocketHealthy({ awaitingResumeProbePong: true }), false);
assert.equal(shouldMarkResumeSocketHealthy({ awaitingResumeProbePong: false }), true);

assert.equal(CHAT_RESUME_PROBE_PONG_MS, 20000, 'The long/default probe timeout is unchanged');
assert.equal(CHAT_RESUME_PROBE_PONG_MOBILE_MS, 2000);
assert.equal(CHAT_RESUME_PROBE_PONG_DESKTOP_MS, 4000);
assert.equal(resolveResumeProbePongTimeoutMs(true), CHAT_RESUME_PROBE_PONG_MOBILE_MS);
assert.equal(resolveResumeProbePongTimeoutMs(false), CHAT_RESUME_PROBE_PONG_DESKTOP_MS);
assert.equal(resolveResumeProbePongTimeoutMs(undefined), CHAT_RESUME_PROBE_PONG_DESKTOP_MS);
assert.equal(
  shouldCloseSocketForResumeProbeTimeout({
    awaitingResumeProbePong: true,
    resumeProbeAt: 10,
    now: 10 + CHAT_RESUME_PROBE_PONG_MOBILE_MS + 1,
    probeTimeoutMs: resolveResumeProbePongTimeoutMs(true),
    socketGeneration: 1,
    probeGeneration: 1,
  }),
  true,
  'A mobile resume probe closes the socket after ~2s'
);

assert.equal(
  shouldCloseSocketForResumeProbeTimeout({
    awaitingResumeProbePong: true,
    resumeProbeAt: 10,
    now: 10 + CHAT_RESUME_PROBE_PONG_MS + 1,
    socketGeneration: 2,
    probeGeneration: 1,
  }),
  false,
  'Stale probe callbacks must ignore a replaced socket'
);
assert.equal(
  shouldCloseSocketForResumeProbeTimeout({
    awaitingResumeProbePong: true,
    resumeProbeAt: 10,
    now: 10 + CHAT_RESUME_PROBE_PONG_MS + 1,
    socketGeneration: 3,
    probeGeneration: 3,
  }),
  true
);

assert.equal(CHAT_PING_LOOP_INTERVAL_MS, 5000);
const dueChat = { id: 'a', ws: { readyState: 1 }, _lastPingAt: 0 };
assert.deepEqual(listChatsNeedingPing([dueChat], 26000, 25000), [dueChat]);
assert.deepEqual(
  listChatsNeedingPing([{ id: 'a', ws: { readyState: 0 }, _lastPingAt: 0 }], 26000, 25000),
  []
);
assert.deepEqual(
  listChatsNeedingPing([{ id: 'a', ws: { readyState: 1 }, _lastPingAt: 2000 }], 26000, 25000),
  []
);

console.log('All chat-ping-policy tests passed.');
