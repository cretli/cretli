import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  buildDelegationQualityCycles,
  createSharedUsageReader,
} from '../lib/delegation-cycle-outcomes.js';
import { buildDelegationLoopReport } from '../lib/delegation-loop-report.js';
import {
  buildDelegationLoopReportByCohort,
  buildDelegationStatsSnapshot,
} from '../lib/routes/delegations-routes.js';

function fixture(size) {
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const rows = Array.from({ length: size }, (_, index) => {
    const review = index % 4 === 3;
    const cohort = Math.floor(index / 4);
    const at = new Date(now - index * 1000).toISOString();
    return {
      id: `delegation-${index}`,
      parentChatId: `parent-${cohort}`,
      controllerChatId: `parent-${cohort}`,
      leafId: `leaf-${cohort}`,
      childChatId: `child-${index}`,
      assignment: review ? 'review' : 'implement',
      workRole: review ? 'review' : 'implement',
      status: 'completed',
      createdAt: at,
      startedAt: at,
      finishedAt: new Date(now - index * 1000 + 500).toISOString(),
      executor: { transport: 'codex', model: 'example-model' },
      report: review ? 'TASK: review\nVERDICT: PASS' : 'TASK: implement\nVERDICT: PASS',
    };
  });
  const events = Array.from({ length: size * 5 }, (_, index) => ({
    eventType: 'delta',
    delegationId: `delegation-${index % size}`,
    usd: 0.001,
    billingClass: 'priced',
  }));
  return { rows, events };
}

test('delegation loop aggregation stays linear and below the cold-route budget', () => {
  const { rows, events } = fixture(10_000);
  const cycles = buildDelegationQualityCycles({ rows, includeOpen: true });
  const shared = createSharedUsageReader(() => events);
  const started = performance.now();
  const leaves = buildDelegationLoopReportByCohort(rows, cycles, [], shared);
  const elapsedMs = performance.now() - started;
  assert.equal(leaves.length, 2500);
  assert.ok(elapsedMs < 300, `10k-row cold loop report took ${elapsedMs.toFixed(1)} ms`);
});

test('cohort partitioning preserves the loop report and leaf filter contract', () => {
  const { rows, events } = fixture(40);
  const cycles = buildDelegationQualityCycles({ rows, includeOpen: true });
  const now = Date.now;
  Date.now = () => Date.parse('2026-10-24T12:00:00.000Z');
  try {
    const expected = buildDelegationLoopReport({
      rows,
      cycles,
      workflows: [],
      readUsageEvents: () => events,
    });
    const actual = buildDelegationLoopReportByCohort(
      rows,
      cycles,
      [],
      createSharedUsageReader(() => events),
    );
    assert.deepEqual(actual, expected);
    const filtered = buildDelegationLoopReportByCohort(
      rows,
      cycles.filter((cycle) => cycle.leafId === 'leaf-3'),
      [],
      createSharedUsageReader(() => events),
      'leaf-3',
    );
    assert.deepEqual(filtered, expected.filter((leaf) => leaf.leafId === 'leaf-3'));
  } finally {
    Date.now = now;
  }
});

test('cold delegation statistics stay below 300 ms and yield to concurrent work', async () => {
  const { rows, events } = fixture(10_000);
  let usageReads = 0;
  let ticks = 0;
  let maxGapMs = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const current = performance.now();
    maxGapMs = Math.max(maxGapMs, current - previous);
    previous = current;
    ticks += 1;
  }, 5);
  const started = performance.now();
  let snapshot;
  try {
    snapshot = await buildDelegationStatsSnapshot({
      rows,
      workflows: [],
      readUsageEvents: () => {
        usageReads += 1;
        return events;
      },
      listCatalog: async () => [],
    });
  } finally {
    clearInterval(timer);
  }
  const elapsedMs = performance.now() - started;
  assert.equal(snapshot.ok, true);
  assert.equal(usageReads, 1, 'one usage-window read serves cycle and per-leaf metrics');
  assert.ok(elapsedMs < 300, `10k-row cold stats took ${elapsedMs.toFixed(1)} ms`);
  assert.ok(ticks > 0, 'aggregation yielded to the event loop');
  assert.ok(maxGapMs < 75, `concurrent timer stalled for ${maxGapMs.toFixed(1)} ms`);
});
