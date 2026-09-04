import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingEndSession } from '../app_front/features/voice/voiceEndSession.js';

test('stops on finish after the spoken reply', () => {
  let actualStops = 0;
  /** @type {Array<() => void>} */
  const queued = [];
  const gate = createPendingEndSession({
    stop: () => {
      actualStops += 1;
    },
    delayMs: 40,
    schedule: (fn) => {
      queued.push(fn);
      return queued.length;
    },
    clearTimer: () => {},
  });
  gate.request({ skipCompletions: 1 });
  gate.onComplete();
  assert.equal(actualStops, 0);
  gate.onComplete();
  assert.equal(actualStops, 1);
});

test('stops on the fallback timer when no completion arrives', () => {
  let actualStops = 0;
  /** @type {Array<() => void>} */
  const queued = [];
  const gate = createPendingEndSession({
    stop: () => {
      actualStops += 1;
    },
    delayMs: 40,
    schedule: (fn) => {
      queued.push(fn);
      return 1;
    },
    clearTimer: () => {},
  });
  gate.request();
  assert.equal(actualStops, 0);
  queued[0]();
  assert.equal(actualStops, 1);
});

test('reset cancels a pending end', () => {
  let actualStops = 0;
  const gate = createPendingEndSession({
    stop: () => {
      actualStops += 1;
    },
    delayMs: 40,
    schedule: (fn) => fn,
    clearTimer: () => {},
  });
  gate.request();
  gate.reset();
  gate.onComplete();
  assert.equal(actualStops, 0);
});
