import assert from 'node:assert/strict';
import test from 'node:test';
import { watchVoiceAgentRun } from '../app_front/features/voice/voiceAgentRunWatch.js';

test('waits for the agent to become busy, then reports idle', () => {
  const inputBusy = [false, true, true, false];
  let index = 0;
  let clock = 0;
  /** @type {Array<() => void>} */
  const queued = [];
  /** @type {string[]} */
  const actualPhases = [];
  let actualIdle = null;
  watchVoiceAgentRun({
    isBusy: () => inputBusy[Math.min(index, inputBusy.length - 1)] === true,
    now: () => clock,
    intervalMs: 10,
    startGraceMs: 50,
    timeoutMs: 1000,
    schedule: (fn) => {
      queued.push(fn);
    },
    onBusy: (phase) => actualPhases.push(phase),
    onIdle: (info) => {
      actualIdle = info;
    },
  });
  while (queued.length > 0 && !actualIdle) {
    const next = queued.shift();
    clock += 10;
    index += 1;
    next();
  }
  assert.equal(actualIdle?.timedOut, false);
  assert.ok(actualPhases.includes('working'));
});

test('reports awaiting while the agent waits for the user', () => {
  let clock = 0;
  /** @type {Array<() => void>} */
  const queued = [];
  /** @type {string[]} */
  const actualPhases = [];
  watchVoiceAgentRun({
    isBusy: () => false,
    isAwaiting: () => true,
    now: () => clock,
    intervalMs: 10,
    startGraceMs: 50,
    timeoutMs: 1000,
    schedule: (fn) => {
      queued.push(fn);
    },
    onBusy: (phase) => actualPhases.push(phase),
    onIdle: () => {},
  });
  const next = queued.shift();
  clock += 10;
  next();
  assert.ok(actualPhases.includes('awaiting'));
});
