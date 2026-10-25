import assert from 'node:assert/strict';
import {
  SEGMENT_KEYS,
  diffSignatureSegments,
  createRateWindow,
  createSeqDupMeter,
  quantile,
  presenceFrameReason,
  createUiFreezeMetrics,
} from '../app_front/features/sidebar/sidebarRenderMetrics.js';

function parts(overrides = {}) {
  return {
    layout: 'L',
    structure: 'S',
    status: 'T',
    group: 'G',
    watcher: 'W',
    ...overrides,
  };
}

// ── diffSignatureSegments ──────────────────────────────────────────────────────
{
  // Only the status segment changed → ['status'] (and nothing else).
  assert.deepEqual(diffSignatureSegments(parts(), parts({ status: 'T2' })), ['status']);

  // Watcher-only change → ['watcher'].
  assert.deepEqual(diffSignatureSegments(parts(), parts({ watcher: 'W2' })), ['watcher']);

  // Identical parts → no changed segments.
  assert.deepEqual(diffSignatureSegments(parts(), parts()), []);

  // Multiple changes keep SEGMENT_KEYS order.
  assert.deepEqual(
    diffSignatureSegments(parts(), parts({ structure: 'S2', layout: 'L2' })),
    ['layout', 'structure'],
  );

  // Robust to '||' *inside* a value: structure legitimately contains '||', so it
  // must be compared as one opaque string, never sliced on the separator.
  const base = parts({ structure: 'a||b||c' });
  assert.deepEqual(diffSignatureSegments(base, parts({ structure: 'a||b||c' })), []);
  // A '||'-containing value that changes in a way plain splitting would miss.
  assert.deepEqual(
    diffSignatureSegments(base, parts({ structure: 'a||b||c||d' })),
    ['structure'],
  );

  // null prev (first render) → every named segment is reported as changed.
  assert.deepEqual(diffSignatureSegments(null, parts()), SEGMENT_KEYS);
}

// ── createRateWindow ─────────────────────────────────────────────────────────────
{
  let clock = 100_000; // epoch-aligned, away from a boundary
  const win = createRateWindow(() => clock, 1000);
  for (let i = 0; i < 5; i += 1) win.observe('notifySidebar');
  assert.equal(win.perSec('notifySidebar'), 5, 'X events inside the 1s window → perSec X');
  // Independent labels are counted separately.
  win.observe('presence:title');
  assert.equal(win.perSec('presence:title'), 1);
  assert.equal(win.perSec('chatsChanged'), 0, 'unobserved label reads 0');

  // Rolling into the next window drops the previous bucket.
  clock += 1000;
  assert.equal(win.perSec('notifySidebar'), 0, 'rotated window clears old bucket');
  win.observe('notifySidebar');
  assert.equal(win.perSec('notifySidebar'), 1);
  const snap = win.snapshot();
  assert.equal(snap.notifySidebar, 1);
  assert.equal('presence:title' in snap, false, 'stale label gone after rotation');
}

// ── createSeqDupMeter ────────────────────────────────────────────────────────────
{
  const meter = createSeqDupMeter();
  assert.deepEqual(meter.observe(7, 'sockA'), { isDuplicate: false, crossSocket: false });
  // Same seq again on the SAME socket → duplicate, but not a cross-socket one.
  assert.deepEqual(meter.observe(7, 'sockA'), { isDuplicate: true, crossSocket: false });
  // Same seq from ANOTHER socket → duplicate flagged as cross-socket.
  assert.deepEqual(meter.observe(7, 'sockB'), { isDuplicate: true, crossSocket: true });
  // A new seq → not a duplicate.
  assert.deepEqual(meter.observe(8, 'sockA'), { isDuplicate: false, crossSocket: false });
  // A large seq gap (resume replay) must not crash or mis-flag.
  assert.deepEqual(meter.observe(10_000, 'sockA'), { isDuplicate: false, crossSocket: false });
  // Junk seq values never throw and are never counted as duplicates.
  assert.deepEqual(meter.observe(undefined), { isDuplicate: false, crossSocket: false });
  assert.deepEqual(meter.observe(NaN), { isDuplicate: false, crossSocket: false });
  const snap = meter.snapshot();
  assert.equal(snap.frames, 7);
  assert.equal(snap.duplicates, 2);
  assert.equal(snap.crossSocket, 1);
  assert.equal(typeof snap.dupPct, 'number');
}

// ── quantile ─────────────────────────────────────────────────────────────────────
{
  assert.equal(quantile([]), 0);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([5, 1, 3], 0.5), 3);
}

// ── presenceFrameReason (agentPresence has no server reason → bucket by class) ─────
{
  assert.equal(presenceFrameReason(null), 'unknown');
  assert.equal(presenceFrameReason({ snapshot: true }), 'snapshot');
  assert.equal(presenceFrameReason({ watchers: [{ x: 1 }] }), 'watchers');
  assert.equal(presenceFrameReason({ cleared: ['c1'] }), 'cleared');
  assert.equal(presenceFrameReason({ watchers: [], cleared: [], states: { c1: 1 } }), 'states');
}

// ── inactive guard allocates nothing (requirement 5) ──────────────────────────────
{
  const events = [];
  const metrics = createUiFreezeMetrics({
    now: () => 0,
    active: () => false,
    trace: (category, event, payload) => events.push({ category, event, payload }),
  });
  metrics.recordSidebarRender({ changed: true, sigMs: 1, innerMs: 1, wireMs: 1, rows: 3, rebuilt: true });
  metrics.recordNotifySidebar();
  metrics.recordSidebarPatch({ patchAll: true, rows: 4 });
  metrics.recordPresenceFrame({ reason: 'title', seq: 1, socketId: 'a' });
  metrics.recordChatsChangedFrame({ reason: 'workspace-watcher' });
  metrics.flush();
  assert.equal(metrics.allocated(), false, 'inactive meter never allocates state');
  assert.equal(events.length, 0, 'inactive meter emits nothing');
}

// ── active meter folds into ONE windowed snapshot on roll ─────────────────────────
{
  let clock = 200_000;
  const events = [];
  const metrics = createUiFreezeMetrics({
    now: () => clock,
    active: () => true,
    windowMs: 1000,
    trace: (category, event, payload) => events.push({ category, event, payload }),
  });
  assert.equal(metrics.allocated(), false, 'lazy: nothing until first active touch');

  metrics.recordSidebarRender({ changed: true, sigMs: 2, innerMs: 4, wireMs: 1, rows: 10, rebuilt: true });
  metrics.recordSidebarRender({ changed: false, sigMs: 0.5 });
  metrics.recordNotifySidebar();
  metrics.recordPresenceFrame({ reason: 'watchers', seq: 42, socketId: 'A' });
  metrics.recordPresenceFrame({ reason: 'watchers', seq: 42, socketId: 'B' }); // dup, cross-socket
  metrics.recordChatsChangedFrame({ reason: 'title' });
  assert.equal(metrics.allocated(), true, 'active meter materialises lazily');

  // Granular render points are emitted for every observed render.
  const renders = events.filter((e) => e.event === 'render-rebuild' || e.event === 'render-skip');
  assert.equal(renders.length, 2);
  assert.deepEqual(renders[0].payload.changedSegments, []);

  // Advancing one whole window and recording again rolls the closed bucket out.
  clock += 1000;
  metrics.recordNotifySidebar();
  const snapshots = events.filter((e) => e.event === 'snapshot');
  assert.equal(snapshots.length, 1, 'exactly one aggregated snapshot for the rolled window');
  const s = snapshots[0].payload;
  assert.equal(s.epoch, 200, 'snapshot tagged with the just-closed epoch');
  assert.equal(s.perSec.presence, 2);
  assert.equal(s.perSec['presenceDup:watchers'], 1, 'dup bucket is reason-split');
  assert.equal(s.presenceDup.duplicates, 1);
  assert.equal(s.presenceDup.crossSocket, 1);
  assert.equal(s.renders.rebuilds, 1);
  assert.equal(s.renders.rowsMax, 10);

  metrics.flush();
  assert.equal(events.filter((e) => e.event === 'snapshot').length, 2, 'flush() emits the live window');
}

console.log('sidebar-render-metrics.test.js OK');
