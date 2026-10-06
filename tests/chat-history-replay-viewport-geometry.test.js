/**
 * Stage 2.1 — forced geometry reads during replay scale with batches, not records.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HISTORY_REPLAY_CHUNK_SIZE,
  HISTORY_REPLAY_SYNC_HEAD,
} from '../app_front/lib/chatHistoryReplayLifecycle.js';
import { UI_FREEZE_SYNTHETIC_FIXTURE_RECORD_COUNT } from '../app_front/lib/uiFreezeRenderBudgets.js';
import {
  countReplayViewportAnchorBatches,
  countViewportAnchorBatches,
  createViewportAnchorBatchController,
} from '../app_front/lib/sdkRichViewViewportBatch.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(path.join(projectRoot, 'tests/fixtures/synthetic-history-replay-records.json'), 'utf8'),
);
const richViewSource = readFileSync(path.join(projectRoot, 'app_front/lib/sdk-rich-view.js'), 'utf8');

assert.equal(fixture.records.length, UI_FREEZE_SYNTHETIC_FIXTURE_RECORD_COUNT);

const recordCount = fixture.records.length;
const replayBatchCount = countReplayViewportAnchorBatches(HISTORY_REPLAY_SYNC_HEAD, recordCount);

assert.match(richViewSource, /createViewportAnchorBatchController/);
assert.match(richViewSource, /noteInsertBeforeAnchor/);
assert.match(richViewSource, /applyHistoryRecordsInViewportBatches/);
assert.match(
  richViewSource,
  /prependHistoryRecordsImpl[\s\S]*applyHistoryRecordsInViewportBatches/,
  'prepend history must apply records in viewport batches',
);
assert.doesNotMatch(
  richViewSource,
  /if \(later\) captureInsertScroll\(later\)/,
  'captureInsertScroll must not run unconditionally on every insert',
);

/**
 * Mirrors createSdkRichView viewport batch wiring (captureInsertScroll / restoreInsertScroll / noteInsertBeforeAnchor).
 *
 * @returns {{
 *   probe: Record<string, number>,
 *   batch: ReturnType<typeof createViewportAnchorBatchController>,
 *   noteInsertBeforeAnchor: (later: { isConnected: boolean, getBoundingClientRect: () => { top: number } }) => void,
 *   applyRecordsInViewportBatches: (
 *     startIndex: number,
 *     endIndexExclusive: number,
 *     onRecord: (index: number) => void,
 *   ) => void,
 *   restoreInsertScroll: () => void,
 * }}
 */
function createProductionViewportBatchHarness() {
  /** @type {Record<string, number>} */
  const probe = {};
  globalThis.__cretliUiFreezeGeometryProbe = probe;
  /** @type {{ el: { isConnected: boolean, getBoundingClientRect: () => { top: number } }, top: number } | null} */
  let pendingViewportAnchor = null;
  let preserveViewportAnchor = false;

  function noteForcedGeometryRead(kind) {
    const key = String(kind || 'unknown');
    probe[key] = (Number(probe[key]) || 0) + 1;
  }

  function captureInsertScroll(later) {
    if (!later?.isConnected) return;
    noteForcedGeometryRead('getBoundingClientRect');
    pendingViewportAnchor = {
      el: later,
      top: later.getBoundingClientRect().top,
    };
    preserveViewportAnchor = true;
  }

  function restoreInsertScroll() {
    const anchor = pendingViewportAnchor;
    if (!anchor?.el?.isConnected) return;
    noteForcedGeometryRead('getBoundingClientRect');
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) < 0.5) return;
    noteForcedGeometryRead('getBoundingClientRect');
    anchor.top = anchor.el.getBoundingClientRect().top;
  }

  const batch = createViewportAnchorBatchController({
    capture: () => {},
    restore: () => {
      if (!preserveViewportAnchor || !pendingViewportAnchor) return;
      restoreInsertScroll();
      pendingViewportAnchor = null;
      preserveViewportAnchor = false;
    },
  });

  function noteInsertBeforeAnchor(later) {
    if (!later?.isConnected) return;
    batch.noteInsertBefore(
      () => captureInsertScroll(later),
      () => {
        preserveViewportAnchor = true;
      },
    );
  }

  function applyRecordsInViewportBatches(startIndex, endIndexExclusive, onRecord) {
    batch.forEachRecordInBatches(startIndex, endIndexExclusive, (index) => {
      onRecord(index);
    });
  }

  return {
    probe,
    batch,
    noteInsertBeforeAnchor,
    applyRecordsInViewportBatches,
    restoreInsertScroll,
  };
}

/** Minimal DOM to assert anchor restore math (manual scroll preserved). */
function createScrollHarness() {
  let scrollTop = 40;
  let childTop = 120;
  const mountEl = {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(next) {
      scrollTop = Number(next) || 0;
    },
  };
  const anchorEl = {
    isConnected: true,
    getBoundingClientRect: () => ({ top: childTop }),
  };
  return {
    mountEl,
    anchorEl,
    nudgeChildBy(delta) {
      childTop += delta;
    },
    restoreAnchor(anchorTop) {
      const delta = anchorEl.getBoundingClientRect().top - anchorTop;
      if (Math.abs(delta) < 0.5) return;
      mountEl.scrollTop += delta;
      childTop -= delta;
    },
  };
}

{
  const harness = createScrollHarness();
  const anchorTop = harness.anchorEl.getBoundingClientRect().top;
  harness.nudgeChildBy(48);
  harness.restoreAnchor(anchorTop);
  assert.equal(harness.mountEl.scrollTop, 88);
  assert.equal(harness.anchorEl.getBoundingClientRect().top, anchorTop);
}

function countCaptureReads(probe) {
  return Number(probe.getBoundingClientRect) || 0;
}

{
  const { probe, batch, noteInsertBeforeAnchor, applyRecordsInViewportBatches } =
    createProductionViewportBatchHarness();
  const anchorEl = { isConnected: true, getBoundingClientRect: () => ({ top: 200 }) };

  applyRecordsInViewportBatches(0, HISTORY_REPLAY_SYNC_HEAD, () => {
    noteInsertBeforeAnchor(anchorEl);
  });
  applyRecordsInViewportBatches(HISTORY_REPLAY_SYNC_HEAD, recordCount, () => {
    noteInsertBeforeAnchor(anchorEl);
  });

  const expectedCaptures = countReplayViewportAnchorBatches(HISTORY_REPLAY_SYNC_HEAD, recordCount);
  assert.equal(
    batch.getCaptureCalls(),
    expectedCaptures,
    'production batch controller: one capture call per replay chunk on sync+tail simulation',
  );
  assert.equal(
    batch.getRestoreCalls(),
    expectedCaptures,
    'one restore per replay chunk (sync head + async tail)',
  );
  assert.ok(batch.getCaptureCalls() < recordCount, 'captures must be O(batches), not O(records)');
  assert.ok(
    countCaptureReads(probe) >= expectedCaptures,
    'probe must record at least one geometry read per batch capture',
  );
  assert.ok(
    countCaptureReads(probe) < recordCount,
    'probe geometry reads must not scale with every record',
  );
}

{
  const prependCount = HISTORY_REPLAY_CHUNK_SIZE * 3 + 17;
  const { batch, noteInsertBeforeAnchor, applyRecordsInViewportBatches } =
    createProductionViewportBatchHarness();
  const anchorEl = { isConnected: true, getBoundingClientRect: () => ({ top: 120 }) };

  applyRecordsInViewportBatches(0, prependCount, () => {
    noteInsertBeforeAnchor(anchorEl);
  });

  const prependBatches = countViewportAnchorBatches(prependCount);
  assert.equal(batch.getCaptureCalls(), prependBatches, 'prepend path must batch insert-before captures');
  assert.equal(batch.getRestoreCalls(), prependBatches, 'prepend path must restore once per batch');
}

{
  const { batch, noteInsertBeforeAnchor } = createProductionViewportBatchHarness();
  const anchorEl = { isConnected: true, getBoundingClientRect: () => ({ top: 50 }) };
  const unbatchedCount = HISTORY_REPLAY_CHUNK_SIZE + 5;
  for (let index = 0; index < unbatchedCount; index += 1) {
    noteInsertBeforeAnchor(anchorEl);
  }
  assert.equal(
    batch.getCaptureCalls(),
    unbatchedCount,
    'without batch depth, every insert-before triggers capture (regression guard)',
  );
}

{
  const { batch, noteInsertBeforeAnchor, applyRecordsInViewportBatches } =
    createProductionViewportBatchHarness();
  const anchorEl = { isConnected: true, getBoundingClientRect: () => ({ top: 80 }) };
  const size = HISTORY_REPLAY_CHUNK_SIZE;
  const total = size + 4;
  let throwsRemaining = 1;
  assert.throws(() => {
    applyRecordsInViewportBatches(0, total, (index) => {
      noteInsertBeforeAnchor(anchorEl);
      if (index === 3 && throwsRemaining > 0) {
        throwsRemaining -= 1;
        throw new Error('applyHistoryRecord failed mid-batch');
      }
    });
  }, /applyHistoryRecord failed mid-batch/);
  assert.equal(batch.getDepth(), 0, 'batch depth must reset after exception mid-chunk');
  assert.equal(batch.getRestoreCalls(), 1, 'restore must run for the partial batch before rethrow');
}

console.log(
  `chat-history-replay-viewport-geometry.test.js OK (${recordCount} records, ${replayBatchCount} replay batches)`,
);
