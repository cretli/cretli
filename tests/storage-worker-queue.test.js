import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFairQueue,
  DEFAULT_AGING_MS,
  DEFAULT_BYPASS_EVERY,
  percentile,
  STORAGE_PRIORITIES,
} from '../lib/storage/fair-queue.js';
import { StorageError } from '../lib/storage/errors.js';

/**
 * Fake monotonic clock.
 */
function createClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

let nextId = 0;

/**
 * @param {string} priority
 * @param {Record<string, unknown>} [extra]
 */
function req(priority, extra = {}) {
  nextId += 1;
  return { id: `r${nextId}`, priority, sizeBytes: 10, ...extra };
}

describe('fair queue ordering', () => {
  it('serves classes by priority when enqueued together', () => {
    const clock = createClock();
    const queue = createFairQueue({ now: clock.now });
    const order = ['normal', 'final', 'intent', 'claim', 'stop'];
    for (const p of order) queue.push(req(p, { tag: p }));
    const served = [];
    for (let entry = queue.shift(); entry; entry = queue.shift()) served.push(entry.tag);
    assert.deepEqual(served, STORAGE_PRIORITIES);
  });

  it('is FIFO inside one class', () => {
    const clock = createClock();
    const queue = createFairQueue({ now: clock.now });
    for (let i = 0; i < 5; i += 1) {
      queue.push(req('claim', { tag: i }));
      clock.advance(1);
    }
    const served = [];
    for (let entry = queue.shift(); entry; entry = queue.shift()) served.push(entry.tag);
    assert.deepEqual(served, [0, 1, 2, 3, 4]);
  });

  it('dispatches a Stop queued behind 200 aged normal writes after at most one bypass', () => {
    const clock = createClock(0);
    const queue = createFairQueue({ now: clock.now, maxDepth: 1000 });
    const serviceMs = 6.5;
    for (let i = 0; i < 200; i += 1) queue.push(req('normal', { tag: `n${i}` }));
    // Single worker: one request in flight at a time, each takes serviceMs.
    let inFlightUntil = 0;
    let stop = null;
    let stopDispatchedAt = null;
    let dispatchesBeforeStop = 0;
    while (stopDispatchedAt === null) {
      if (stop === null && clock.now() + serviceMs > 305) {
        // Stop arrives at t=305 ms while a normal write is in flight.
        clock.advance(305 - clock.now());
        stop = queue.push(req('stop', { tag: 'stop' }));
        clock.advance(inFlightUntil - clock.now());
      }
      const entry = queue.shift();
      if (stop !== null && entry.tag !== 'stop') dispatchesBeforeStop += 1;
      if (entry.tag === 'stop') stopDispatchedAt = clock.now();
      inFlightUntil = clock.now() + serviceMs;
      clock.advance(serviceMs);
    }
    const waited = stopDispatchedAt - stop.enqueuedAt;
    assert.ok(dispatchesBeforeStop <= 1, `stop waited behind ${dispatchesBeforeStop} dispatches`);
    // In-flight remainder + at most one bypassed transaction.
    assert.ok(waited <= 2 * serviceMs, `stop waited ${waited} ms`);
    assert.ok(waited < 500);
  });

  it('keeps every Stop within one bypass while aged normal work is pending', () => {
    const clock = createClock(0);
    const queue = createFairQueue({ now: clock.now, maxDepth: 100000 });
    for (let i = 0; i < 50; i += 1) queue.push(req('normal'));
    clock.advance(DEFAULT_AGING_MS + 1);
    // Two stops arrive per dispatch, one dispatch per ms: stop overload.
    let maxOtherDispatchesBeforeStop = 0;
    let othersSinceStopHead = 0;
    for (let step = 0; step < 400; step += 1) {
      queue.push(req('stop', { tag: 'stop' }));
      queue.push(req('stop', { tag: 'stop' }));
      const entry = queue.shift();
      if (entry.tag === 'stop') {
        othersSinceStopHead = 0;
      } else {
        othersSinceStopHead += 1;
        maxOtherDispatchesBeforeStop = Math.max(maxOtherDispatchesBeforeStop, othersSinceStopHead);
      }
      clock.advance(1);
    }
    assert.equal(maxOtherDispatchesBeforeStop, 1, 'more than one bypass in a row ahead of stop');
    const counters = queue.metrics().counters;
    // At most one bypass per K strict dispatches.
    assert.ok(counters.bypassed <= Math.ceil(counters.dispatched / (DEFAULT_BYPASS_EVERY + 1)));
    assert.ok(counters.bypassed > 0, 'aged normal work never got a bypass slot');
  });

  it('still serves a normal request under a continuous stop burst, well before maxAge', () => {
    const clock = createClock();
    const queue = createFairQueue({ now: clock.now, maxDepth: 100000 });
    const normal = queue.push(req('normal', { tag: 'normal' }));
    let normalServedAt = null;
    // Every 1 ms of service time three new stop requests arrive, so pure
    // strict priority would starve the normal request forever.
    for (let step = 0; step < 2000 && normalServedAt === null; step += 1) {
      for (let k = 0; k < 3; k += 1) queue.push(req('stop'));
      const entry = queue.shift();
      if (entry.tag === 'normal') normalServedAt = clock.now();
      clock.advance(1);
    }
    assert.notEqual(normalServedAt, null, 'normal request starved');
    const waited = normalServedAt - normal.enqueuedAt;
    // Not before it ages; then within K strict dispatches + the bypass itself.
    assert.ok(waited >= DEFAULT_AGING_MS, `normal served too early: ${waited} ms`);
    assert.ok(waited <= DEFAULT_AGING_MS + DEFAULT_BYPASS_EVERY + 1, `normal waited ${waited} ms`);
    assert.ok(waited < queue.metrics().maxAgeMs);
  });

  it('keeps FIFO inside each class when bypasses are taken', () => {
    const clock = createClock(0);
    const queue = createFairQueue({ now: clock.now, maxDepth: 100000, agingMs: 10, bypassEvery: 2 });
    for (let i = 0; i < 20; i += 1) {
      queue.push(req('normal', { tag: `n${i}` }));
      queue.push(req('final', { tag: `f${i}` }));
    }
    clock.advance(20);
    const served = { normal: [], final: [], claim: [] };
    for (let step = 0; step < 300 && queue.size > 0; step += 1) {
      if (step < 100) queue.push(req('claim', { tag: `c${step}` }));
      const entry = queue.shift();
      served[entry.priority].push(Number(entry.tag.slice(1)));
      clock.advance(1);
    }
    for (const list of Object.values(served)) {
      assert.deepEqual(list, [...list].sort((x, y) => x - y));
    }
    assert.equal(served.normal.length, 20);
    assert.equal(served.final.length, 20);
  });

  it('serves the oldest aged lower-class head first when bypassing', () => {
    const clock = createClock();
    const queue = createFairQueue({ now: clock.now, agingMs: 100, bypassEvery: 1 });
    queue.push(req('normal', { tag: 'normal-old' }));
    clock.advance(10);
    queue.push(req('final', { tag: 'final-old' }));
    clock.advance(200);
    for (let i = 0; i < 4; i += 1) queue.push(req('stop', { tag: `stop${i}` }));
    const served = [];
    for (let entry = queue.shift(); entry; entry = queue.shift()) served.push(entry.tag);
    // Strict stop, then a bypass (oldest aged: normal), strict stop, bypass (final)...
    assert.deepEqual(served, ['stop0', 'normal-old', 'stop1', 'final-old', 'stop2', 'stop3']);
  });

  it('does not bypass before a lower head has aged', () => {
    const clock = createClock();
    const queue = createFairQueue({ now: clock.now, bypassEvery: 1 });
    queue.push(req('normal', { tag: 'normal' }));
    clock.advance(DEFAULT_AGING_MS - 1);
    for (let i = 0; i < 3; i += 1) queue.push(req('claim', { tag: `claim${i}` }));
    assert.deepEqual([queue.shift().tag, queue.shift().tag, queue.shift().tag, queue.shift().tag], ['claim0', 'claim1', 'claim2', 'normal']);
  });

  it('rejects unknown priorities, duplicate ids and bad sizes', () => {
    const queue = createFairQueue({ now: () => 0 });
    assert.throws(() => queue.push(req('urgent')), TypeError);
    queue.push({ id: 'dup', priority: 'normal', sizeBytes: 1 });
    assert.throws(() => queue.push({ id: 'dup', priority: 'normal', sizeBytes: 1 }), TypeError);
    assert.throws(() => queue.push({ id: 'neg', priority: 'normal', sizeBytes: -1 }), TypeError);
    assert.throws(() => createFairQueue({ agingMs: -1 }), TypeError);
    assert.throws(() => createFairQueue({ bypassEvery: 0 }), TypeError);
    assert.throws(() => createFairQueue({ maxDepth: 0 }), TypeError);
  });
});

describe('fair queue bounds', () => {
  it('refuses overflow by depth with a retryable busy error', () => {
    const queue = createFairQueue({ now: () => 0, maxDepth: 3 });
    for (let i = 0; i < 3; i += 1) queue.push(req('normal'));
    assert.throws(() => queue.push(req('stop')), (err) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'busy');
      assert.equal(err.retryable, true);
      assert.deepEqual(err.details, { operation: 'queue_depth', commitState: 'not_committed' });
      return true;
    });
    assert.equal(queue.size, 3);
    assert.equal(queue.metrics().counters.rejectedBusy, 1);
    queue.shift();
    queue.push(req('stop'));
    assert.equal(queue.size, 3);
  });

  it('refuses a request that can never fit with a non-retryable error', () => {
    const queue = createFairQueue({ now: () => 0, maxBytes: 100 });
    assert.throws(() => queue.push(req('normal', { sizeBytes: 101 })), (err) => {
      assert.equal(err.code, 'io');
      assert.equal(err.retryable, false);
      assert.deepEqual(err.details, { operation: 'payload_too_large', commitState: 'not_committed' });
      return true;
    });
    assert.equal(queue.size, 0);
    assert.equal(queue.metrics().counters.rejectedTooLarge, 1);
  });

  it('refuses overflow by payload bytes and releases bytes on dequeue', () => {
    const queue = createFairQueue({ now: () => 0, maxBytes: 100 });
    queue.push(req('normal', { sizeBytes: 60 }));
    assert.throws(() => queue.push(req('normal', { sizeBytes: 41 })), (err) => err.code === 'busy'
      && err.details.operation === 'queue_bytes');
    queue.push(req('normal', { sizeBytes: 40 }));
    assert.equal(queue.metrics().bytes, 100);
    queue.shift();
    assert.equal(queue.metrics().bytes, 40);
    queue.push(req('normal', { sizeBytes: 60 }));
    assert.equal(queue.metrics().bytes, 100);
  });

  it('expires requests past their deadline or max age before dispatch', () => {
    const clock = createClock();
    const queue = createFairQueue({ now: clock.now, maxAgeMs: 1000 });
    queue.push(req('normal', { tag: 'short', deadlineMs: 50 }));
    queue.push(req('normal', { tag: 'aged' }));
    queue.push(req('stop', { tag: 'deadline-capped', deadlineMs: 5000 }));
    assert.equal(queue.msUntilNextExpiry(), 50);
    clock.advance(49);
    assert.deepEqual(queue.expireDue(), []);
    clock.advance(1);
    assert.deepEqual(queue.expireDue().map((e) => e.tag), ['short']);
    clock.advance(950);
    assert.deepEqual(queue.expireDue().map((e) => e.tag).sort(), ['aged', 'deadline-capped']);
    assert.equal(queue.size, 0);
    assert.equal(queue.msUntilNextExpiry(), null);
    assert.equal(queue.metrics().counters.expired, 3);
    assert.equal(queue.metrics().bytes, 0);
  });

  it('removes an aborted request and reports unknown ids', () => {
    const queue = createFairQueue({ now: () => 0 });
    const a = queue.push(req('normal', { tag: 'a' }));
    queue.push(req('normal', { tag: 'b' }));
    assert.equal(queue.remove(a.id)?.tag, 'a');
    assert.equal(queue.remove(a.id), null);
    assert.equal(queue.shift().tag, 'b');
    assert.equal(queue.shift(), null);
  });

  it('drains everything in arrival order', () => {
    const clock = createClock();
    const queue = createFairQueue({ now: clock.now });
    queue.push(req('normal', { tag: 1 }));
    queue.push(req('stop', { tag: 2 }));
    queue.push(req('claim', { tag: 3 }));
    assert.deepEqual(queue.drainAll().map((e) => e.tag), [1, 2, 3]);
    assert.equal(queue.size, 0);
    assert.equal(queue.metrics().bytes, 0);
  });
});

describe('fair queue metrics', () => {
  it('reports depth, oldest age and dispatched queue-age percentiles without payloads', () => {
    const clock = createClock();
    const queue = createFairQueue({ now: clock.now });
    queue.push(req('normal', { payload: { secret: 'token-123' } }));
    clock.advance(10);
    queue.push(req('claim'));
    clock.advance(5);
    const before = queue.metrics();
    assert.equal(before.depth, 2);
    assert.equal(before.oldestAgeMs, 15);
    assert.equal(before.depthByPriority.normal, 1);
    assert.equal(before.depthByPriority.claim, 1);
    queue.shift();
    queue.shift();
    const after = queue.metrics();
    assert.equal(after.queueAgeMs.n, 2);
    assert.equal(after.queueAgeMs.max, 15);
    assert.doesNotMatch(JSON.stringify(after), /token-123/);
  });

  it('computes nearest-rank percentiles', () => {
    assert.equal(percentile([], 95), null);
    assert.equal(percentile([5, 1, 3], 50), 3);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(hundred, 95), 95);
    assert.equal(percentile(hundred, 100), 100);
  });
});
