/**
 * Screencast helper tests: the mode gate, binary framing, the unacked-frame
 * window with drop/collapse and rate adaptation, and the metrics that must never
 * report `0` for a dimension nobody measured. Pure functions with an injected
 * clock, so no timer and no browser is involved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_LIMITS } from '../lib/browser/constants.js';
import {
  normalizeScreencastMode,
  isExperimentalMode,
  screencastEveryNthFrame,
  buildStartScreencastParams,
  buildScreencastFrameHeader,
  pairScreencastFrame,
  decodeScreencastFrame,
  createScreencastGate,
} from '../lib/browser/screencast.js';
import {
  createScreencastMetrics,
  defaultResourceSampler,
} from '../lib/browser/screencast-metrics.js';

const JPEG = Buffer.from('fake-jpeg-bytes', 'utf8');

function clock(start = 1000) {
  const ref = { value: start };
  return { at: ref, now: () => ref.value };
}

test('the screencast flag fails closed to off', () => {
  assert.equal(normalizeScreencastMode('off'), 'off');
  assert.equal(normalizeScreencastMode('experimental'), 'experimental');
  assert.equal(normalizeScreencastMode('EXPERIMENTAL'), 'experimental');
  assert.equal(normalizeScreencastMode(' experimental '), 'experimental');
  // Anything unexpected must never become a streaming mode.
  for (const value of [undefined, null, '', 'true', 'on', 'always', 1, {}, [], true]) {
    assert.equal(normalizeScreencastMode(value), 'off', `normalizes ${String(value)}`);
  }
  assert.equal(isExperimentalMode('experimental'), true);
  assert.equal(isExperimentalMode('off'), false);
  assert.equal(isExperimentalMode(undefined), false);
  // R1: the shipped default keeps the existing pull behaviour.
  assert.equal(BROWSER_LIMITS.SCREENCAST_MODE, 'off');
});

test('everyNthFrame maps a target fps onto the compositor cadence', () => {
  assert.equal(screencastEveryNthFrame(3, BROWSER_LIMITS), 10);
  assert.equal(screencastEveryNthFrame(5, BROWSER_LIMITS), 6);
  assert.equal(screencastEveryNthFrame(1, BROWSER_LIMITS), 30);
  // A rate above the cadence still asks for every frame, never 0.
  assert.equal(screencastEveryNthFrame(60, BROWSER_LIMITS), 1);
  assert.equal(screencastEveryNthFrame(0, BROWSER_LIMITS), 10);
  assert.equal(screencastEveryNthFrame('nope', BROWSER_LIMITS), 10);
});

test('start params are jpeg and bounded by the limits', () => {
  const params = buildStartScreencastParams({ width: 390, height: 844, quality: 999, everyNthFrame: 4 }, BROWSER_LIMITS);
  assert.equal(params.format, 'jpeg');
  assert.equal(params.quality, BROWSER_LIMITS.SCREENCAST_MAX_QUALITY);
  assert.equal(params.everyNthFrame, 4);
  assert.equal(params.maxWidth, 390);
  assert.equal(params.maxHeight, 844);
  const low = buildStartScreencastParams({ quality: 1, everyNthFrame: 1 }, BROWSER_LIMITS);
  assert.equal(low.quality, BROWSER_LIMITS.SCREENCAST_MIN_QUALITY);
  assert.equal(low.everyNthFrame, 1);
  // A caller that sends nothing sensible for the cadence gets the default, not 0.
  assert.equal(buildStartScreencastParams({ everyNthFrame: 0 }, BROWSER_LIMITS).everyNthFrame, 10);
  assert.equal(buildStartScreencastParams({}, BROWSER_LIMITS).maxWidth, undefined);
});

test('one frame is a JSON header plus a blob the header can prove', () => {
  const header = buildScreencastFrameHeader({
    seq: 7,
    browserTabId: 'tab-1',
    frameIndex: 42,
    byteLength: JPEG.length,
    width: 390,
    height: 844,
    capturedAt: 1234,
  });
  assert.equal(header.type, 'screencast-frame');
  assert.equal(header.seq, 7);
  assert.equal(header.browserTabId, 'tab-1');
  assert.equal(header.frameIndex, 42);
  assert.equal(header.mimeType, 'image/jpeg');
  assert.equal(header.byteLength, JPEG.length);
  assert.equal(header.width, 390);
  assert.equal(header.capturedAt, 1234);

  assert.deepEqual(pairScreencastFrame(header, JPEG.length), {
    seq: 7,
    byteLength: JPEG.length,
    header,
  });
  // A blob whose size disagrees with the header is not this frame.
  assert.equal(pairScreencastFrame(header, JPEG.length + 1), null);
  assert.equal(pairScreencastFrame(null, JPEG.length), null);
  assert.equal(pairScreencastFrame({ seq: 'x' }, JPEG.length), null);
  assert.equal(pairScreencastFrame({ seq: -1 }, JPEG.length), null);
  assert.equal(pairScreencastFrame(header, 0), null);
});

test('a CDP frame decodes with a trusted capture stamp and an oversized flag', () => {
  const EPOCH = 1_700_000_000_000;
  const { at, now } = clock(EPOCH);
  const payload = {
    data: JPEG.toString('base64'),
    frameIndex: 9,
    metadata: { timestamp: (EPOCH - 40) / 1000 },
  };
  const decoded = decodeScreencastFrame(payload, now, BROWSER_LIMITS);
  assert.equal(decoded.frameIndex, 9);
  assert.equal(decoded.byteLength, JPEG.length);
  assert.equal(Buffer.from(decoded.bytes).toString('utf8'), 'fake-jpeg-bytes');
  assert.equal(decoded.capturedAt, EPOCH - 40);
  assert.equal(decoded.oversized, false);

  // A future or absurdly old stamp is not believable: the latency metric then
  // falls back to the server span instead of reporting nonsense.
  const future = decodeScreencastFrame(
    { ...payload, metadata: { timestamp: (at.value + 600_000) / 1000 } },
    now,
    BROWSER_LIMITS,
  );
  assert.equal(future.capturedAt, null);
  const ancient = decodeScreencastFrame({ ...payload, metadata: { timestamp: 1 } }, now, BROWSER_LIMITS);
  assert.equal(ancient.capturedAt, null);
  const noMeta = decodeScreencastFrame({ data: payload.data, frameIndex: 1 }, now, BROWSER_LIMITS);
  assert.equal(noMeta.capturedAt, null);

  const big = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64');
  assert.equal(decodeScreencastFrame({ data: big, frameIndex: 2 }, now, BROWSER_LIMITS).oversized, true);
  assert.equal(decodeScreencastFrame({}, now, BROWSER_LIMITS).byteLength, 0);
});

test('the frame window never grows and a collapsed frame is reported for its ack', () => {
  const { now } = clock(0);
  const gate = createScreencastGate({ now, limits: BROWSER_LIMITS });
  assert.equal(gate.maxUnacked, 1);

  const first = gate.admit({ frameIndex: 100 });
  assert.equal(first.seq, 1);
  assert.deepEqual(first.collapsed, []);
  assert.equal(gate.pendingCount(), 1);

  // The second frame arrives before the first is acknowledged: the oldest one is
  // collapsed and handed back so Chromium is still answered for it.
  const second = gate.admit({ frameIndex: 101 });
  assert.equal(second.seq, 2);
  assert.deepEqual(second.collapsed, [{ seq: 1, frameIndex: 100 }]);
  assert.deepEqual(gate.pendingSeqs(), [2]);
  assert.deepEqual(gate.getTotals(), { sent: 2, dropped: 1 });

  const resolved = gate.resolve(2);
  assert.equal(resolved.frameIndex, 101);
  assert.equal(gate.resolve(2), null, 'one frame is acknowledged at most once');
  assert.equal(gate.resolve(99), null);
});

test('drain empties the window and reports every unresolved frame', () => {
  const { now } = clock(0);
  const gate = createScreencastGate({ now, limits: { ...BROWSER_LIMITS, SCREENCAST_MAX_UNACKED_FRAMES: 3 } });
  gate.admit({ frameIndex: 1 });
  gate.admit({ frameIndex: 2 });
  const acked = gate.resolve(1);
  assert.equal(acked.frameIndex, 1);
  gate.admit({ frameIndex: 3 });
  assert.deepEqual(gate.drain(), [{ seq: 2, frameIndex: 2 }, { seq: 3, frameIndex: 3 }]);
  assert.equal(gate.pendingCount(), 0);
});

test('a stalled acks lowers fps and quality, then recovers toward the caps', () => {
  const { at, now } = clock(0);
  const gate = createScreencastGate({ now, limits: BROWSER_LIMITS });
  const start = gate.target();
  assert.equal(start.fps, BROWSER_LIMITS.SCREENCAST_DEFAULT_FPS);
  assert.equal(start.quality, BROWSER_LIMITS.SCREENCAST_DEFAULT_QUALITY);
  assert.equal(gate.needsRestart(start), false, 'an unchanged target never restarts the stream');

  // Every admission collapses its predecessor: a full window of pressure.
  for (let i = 0; i < BROWSER_LIMITS.SCREENCAST_ADAPT_WINDOW; i += 1) {
    at.value += 100;
    gate.admit({ frameIndex: i });
  }
  const down = gate.target();
  assert.equal(down.fps, start.fps - 1);
  assert.equal(down.quality, start.quality - 10);
  assert.equal(gate.needsRestart(start), true);
  assert.deepEqual(gate.markRestart(), down);
  // Restarts are throttled: re-issuing startScreencast costs a frame gap.
  assert.equal(gate.needsRestart(down), false);
  at.value += BROWSER_LIMITS.SCREENCAST_RESTART_MIN_MS;
  assert.equal(gate.needsRestart(start), true);

  // A clean window (no collapse, because the caller keeps up) climbs back.
  for (let i = 0; i < BROWSER_LIMITS.SCREENCAST_ADAPT_WINDOW * BROWSER_LIMITS.SCREENCAST_ADAPT_UP_WINDOWS; i += 1) {
    at.value += 100;
    gate.resolve(gate.admit({ frameIndex: 500 + i }).seq);
  }
  const up = gate.target();
  assert.ok(up.fps > down.fps, `fps recovered from ${down.fps} to ${up.fps}`);
  assert.ok(up.quality > down.quality);
  assert.ok(up.fps <= BROWSER_LIMITS.SCREENCAST_MAX_FPS);
  assert.ok(up.quality <= BROWSER_LIMITS.SCREENCAST_MAX_QUALITY);
});

test('adaptation stops at the floors and raises nothing past the caps', () => {
  const { at, now } = clock(0);
  const gate = createScreencastGate({
    now,
    limits: { ...BROWSER_LIMITS, SCREENCAST_DEFAULT_FPS: 1, SCREENCAST_MIN_FPS: 1, SCREENCAST_DEFAULT_QUALITY: 30, SCREENCAST_MIN_QUALITY: 30 },
  });
  for (let i = 0; i < BROWSER_LIMITS.SCREENCAST_ADAPT_WINDOW * 3; i += 1) {
    at.value += 100;
    gate.admit({ frameIndex: i });
  }
  assert.deepEqual(gate.target(), {
    fps: 1,
    quality: 30,
    everyNthFrame: screencastEveryNthFrame(1, gate.limits),
  });

  const ceiling = createScreencastGate({
    now,
    limits: { ...BROWSER_LIMITS, SCREENCAST_DEFAULT_FPS: 5, SCREENCAST_MAX_FPS: 5, SCREENCAST_DEFAULT_QUALITY: 90, SCREENCAST_MAX_QUALITY: 90 },
  });
  for (let i = 0; i < BROWSER_LIMITS.SCREENCAST_ADAPT_WINDOW * 3; i += 1) {
    at.value += 100;
    ceiling.resolve(ceiling.admit({ frameIndex: i }).seq);
  }
  assert.equal(ceiling.target().fps, 5);
  assert.equal(ceiling.target().quality, 90);
});

test('metrics report nothing until it is measured', () => {
  const { at, now } = clock(5000);
  const metrics = createScreencastMetrics({ now, sampleResource: null });
  const empty = metrics.snapshot();
  assert.equal(empty.fps, null);
  assert.equal(empty.avgLatencyMs, null);
  assert.equal(empty.p95LatencyMs, null);
  assert.equal(empty.lastLatencyMs, null);
  assert.equal(empty.lastFrameAgeMs, null);
  assert.equal(empty.tabHeap.usedBytes, null);
  assert.equal(empty.browserPid, null);
  // Unmeasured dimensions are null, never a zero that looks like an idle reading.
  assert.equal(empty.framesSent, 0);
  assert.equal(empty.framesDropped, 0);
  assert.equal(typeof defaultResourceSampler, 'function');
  const hostSample = defaultResourceSampler();
  assert.ok(hostSample && Number.isFinite(hostSample.rssBytes), 'the real sampler answers on Node');

  metrics.noteFrameSent({ seq: 1, capturedAt: null });
  assert.equal(metrics.snapshot().fps, null, 'one arrival is not a rate');
  at.value += 500;
  metrics.noteFrameSent({ seq: 2, capturedAt: null });
  assert.equal(metrics.snapshot().fps, 2);
});

test('latency is capture to client ack and rejects impossible spans', () => {
  const { at, now } = clock(10_000);
  const metrics = createScreencastMetrics({ now, sampleResource: null });
  metrics.noteFrameSent({ seq: 1, capturedAt: 9_900 });
  at.value = 10_100;
  assert.equal(metrics.noteFrameAcked({ seq: 1 }), 200);
  assert.equal(metrics.snapshot().avgLatencyMs, 200);
  assert.equal(metrics.snapshot().lastLatencyMs, 200);
  assert.equal(metrics.snapshot().framesAcked, 1);

  // An ack for a frame nobody sent records nothing.
  assert.equal(metrics.noteFrameAcked({ seq: 42 }), null);
  // A capture stamp in the future would produce a negative latency: ignored.
  metrics.noteFrameSent({ seq: 2, capturedAt: 99_000 });
  at.value = 10_200;
  assert.equal(metrics.noteFrameAcked({ seq: 2 }), null);
  assert.equal(metrics.snapshot().lastLatencyMs, 200, 'the bad sample did not overwrite it');

  at.value = 900_000;
  metrics.noteFrameSent({ seq: 3, capturedAt: null });
  assert.equal(metrics.noteFrameAcked({ seq: 3 }), null, 'a span over the bound is not a measurement');
});

test('resource samples become a cpu percentage and an rss reading', () => {
  const { at, now } = clock(1000);
  let cpu = 1000;
  const metrics = createScreencastMetrics({
    now,
    sampleResource: () => ({ cpuMicros: (cpu += 500), rssBytes: 4242, pid: 7 }),
    windowMs: 2000,
  });
  metrics.noteFrameSent({ seq: 1 });
  assert.equal(metrics.snapshot().hostProcess.cpuPercent, null, 'the first sample has no delta');
  assert.equal(metrics.snapshot().hostProcess.rssBytes, 4242);
  assert.equal(metrics.snapshot().hostProcess.pid, 7);
  at.value += 100;
  metrics.noteFrameSent({ seq: 2 });
  // 500us of cpu over 100ms of wall time is 0.5%.
  assert.equal(metrics.snapshot().hostProcess.cpuPercent, 0.5);

  metrics.noteHeapUsage({ usedSize: 111, totalSize: 222 });
  assert.deepEqual(metrics.snapshot().tabHeap, { usedBytes: 111, totalBytes: 222, at: 1100 });
  metrics.noteHeapUsage({ usedSize: -1 });
  assert.equal(metrics.snapshot().tabHeap.usedBytes, 111, 'a bad sample is dropped, not zeroed');
  metrics.noteBrowserPid(1234);
  assert.equal(metrics.snapshot().browserPid, 1234);
  metrics.noteBrowserPid(undefined);
  assert.equal(metrics.snapshot().browserPid, null);

  metrics.reset();
  const after = metrics.snapshot();
  assert.equal(after.fps, null);
  assert.equal(after.hostProcess.cpuPercent, null);
  assert.equal(after.tabHeap.usedBytes, null);
});

test('a sampler that throws or is unavailable leaves the dimension null', () => {
  const { now } = clock(1000);
  const throwing = createScreencastMetrics({
    now,
    sampleResource: () => {
      throw new Error('no permission');
    },
  });
  throwing.noteFrameSent({ seq: 1 });
  throwing.noteFrameSent({ seq: 2 });
  assert.equal(throwing.snapshot().hostProcess.rssBytes, null);
  assert.equal(throwing.snapshot().hostProcess.cpuPercent, null);

  const nullish = createScreencastMetrics({ now, sampleResource: () => null });
  nullish.noteFrameSent({ seq: 1 });
  assert.equal(nullish.snapshot().hostProcess.pid, null);
});
