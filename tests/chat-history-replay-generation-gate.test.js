/**
 * Replay generation gate: frames merge, and a new replay drops only stale replay work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatHistoryReplayGenerationGate } from '../app_front/lib/chatHistoryReplayGenerationGate.js';

function manualFrames() {
  /** @type {Array<() => void>} */
  const queue = [];
  return {
    schedule: (cb) => {
      queue.push(cb);
    },
    flush() {
      const pending = queue.splice(0);
      for (const cb of pending) cb();
    },
    get size() {
      return queue.length;
    },
  };
}

test('work queued in one frame shares a single scheduled frame', () => {
  const gate = createChatHistoryReplayGenerationGate();
  const frames = manualFrames();
  const ran = [];
  gate.scheduleMergedFrameWork(0, () => ran.push('a'), frames.schedule);
  gate.scheduleMergedFrameWork(0, () => ran.push('b'), frames.schedule);
  assert.equal(frames.size, 1);
  frames.flush();
  assert.deepEqual(ran, ['a', 'b']);
});

test('starting a replay keeps queued live work and drops the previous replay', () => {
  const gate = createChatHistoryReplayGenerationGate();
  const frames = manualFrames();
  const ran = [];
  gate.activate(1);
  gate.scheduleGuardedScroll(1, () => ran.push('replay-1'), frames.schedule);
  gate.scheduleMergedFrameWork(0, () => ran.push('live-reset'), frames.schedule);
  gate.activate(2);
  frames.flush();
  assert.deepEqual(ran, ['live-reset']);
  // The gate is usable again after the frame ran.
  gate.scheduleMergedFrameWork(0, () => ran.push('next'), frames.schedule);
  frames.flush();
  assert.deepEqual(ran, ['live-reset', 'next']);
});
