import assert from 'node:assert/strict';
import {
  RECONNECT_BREAKER_ATTEMPTS,
  RECONNECT_STABLE_MS,
  baseReconnectDelayMs,
  createReconnectState,
  noteReconnectAttempt,
  reconnectsPerMinute,
  recordReconnectFailure,
  recordReconnectOpen,
} from '../app_front/features/chat/chatReconnectScheduler.js';

// Schedule: 1 s, 2 s, 4 s ... up to the ceiling.
assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(baseReconnectDelayMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);

// Jitter stays within ±25% and never below 1 s.
{
  const lo = createReconnectState();
  const hi = createReconnectState();
  for (let i = 1; i <= 5; i += 1) {
    const base = baseReconnectDelayMs(i);
    const a = recordReconnectFailure(lo, 0, () => 0).delayMs;
    const b = recordReconnectFailure(hi, 0, () => 0.999999).delayMs;
    assert.ok(a >= Math.max(1000, base * 0.75 - 1) && a <= base * 1.25, `low ${i}`);
    assert.ok(b <= base * 1.25 + 1 && b >= base * 0.75, `high ${i}`);
  }
}

// Breaker opens at the 8th failed attempt, notifies once, pauses longer.
{
  const s = createReconnectState();
  const rnd = () => 0.5;
  let notifies = 0;
  let last;
  for (let i = 1; i <= RECONNECT_BREAKER_ATTEMPTS + 3; i += 1) {
    last = recordReconnectFailure(s, 0, rnd);
    if (last.notifyBreaker) notifies += 1;
    assert.equal(last.breakerOpen, i >= RECONNECT_BREAKER_ATTEMPTS);
  }
  assert.equal(notifies, 1);
  assert.ok(last.delayMs >= 60_000);
}

// Reset after a connection that lasted >= 30 s; a short one does not reset.
{
  const s = createReconnectState();
  recordReconnectFailure(s, 0, () => 0.5);
  recordReconnectFailure(s, 0, () => 0.5);
  recordReconnectOpen(s, 1000);
  assert.equal(recordReconnectFailure(s, 1000 + RECONNECT_STABLE_MS - 1, () => 0.5).attempt, 3);
  recordReconnectOpen(s, 100_000);
  const r = recordReconnectFailure(s, 100_000 + RECONNECT_STABLE_MS, () => 0.5);
  assert.equal(r.attempt, 1);
  assert.equal(r.breakerOpen, false);
}

// Simulation: server closes immediately after every open for 5 minutes.
{
  const s = createReconnectState();
  let now = 0;
  let attempts = 0;
  let messages = 0;
  const end = 5 * 60_000;
  while (now < end) {
    attempts += 1;
    noteReconnectAttempt(s, now);
    recordReconnectOpen(s, now);
    const r = recordReconnectFailure(s, now, Math.random);
    if (r.notifyBreaker) messages += 1;
    now += r.delayMs;
  }
  assert.ok(attempts <= 30, `attempts ${attempts}`);
  assert.ok(messages <= 1, `messages ${messages}`);
  assert.ok(reconnectsPerMinute(s, now) <= attempts);
}

// Metric window drops old entries.
{
  const s = createReconnectState();
  noteReconnectAttempt(s, 0);
  noteReconnectAttempt(s, 30_000);
  assert.equal(reconnectsPerMinute(s, 59_000), 2);
  assert.equal(reconnectsPerMinute(s, 61_000), 1);
}

console.log('chat-reconnect-scheduler.test.js: ok');
