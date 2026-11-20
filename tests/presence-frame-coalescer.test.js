import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPresenceFrameCoalescer } from '../app_front/features/chat/presenceFrameCoalescer.js';

function manualFrames() {
  const cbs = [];
  return { requestFrame: (cb) => { cbs.push(cb); return cbs.length; }, cancelFrame: () => { cbs.length = 0; }, cbs };
}

test('many frames in one burst flush once, in arrival order', () => {
  const f = manualFrames();
  const batches = [];
  const c = createPresenceFrameCoalescer({ onFlush: (b) => batches.push(b), ...f });
  for (let i = 0; i < 50; i += 1) c.push({ seq: i });
  assert.equal(f.cbs.length, 1);
  f.cbs[0]();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((m) => m.seq), [...Array(50).keys()]);
  c.dispose();
});

test('dispose drops pending frames and ignores later pushes', () => {
  const f = manualFrames();
  const batches = [];
  const c = createPresenceFrameCoalescer({ onFlush: (b) => batches.push(b), ...f });
  c.push({ seq: 1 });
  c.dispose();
  c.push({ seq: 2 });
  c.flush();
  assert.equal(batches.length, 0);
});

test('timer fallback flushes when rAF never fires', async () => {
  const batches = [];
  const c = createPresenceFrameCoalescer({ onFlush: (b) => batches.push(b), requestFrame: () => 1, cancelFrame: () => {} });
  c.push({ seq: 1 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(batches.length, 1);
});
