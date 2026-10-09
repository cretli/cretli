/**
 * Workspace Watcher cycle usage correlation and cost finalization.
 *
 * Covers the acceptance criteria of TODO 1763b52c:
 *  - own/consolidated, retries and children are never double counted and
 *    duplicate events are dropped,
 *  - correlation uses cycleId/chatId plus run/attempt/delegation membership,
 *    never `event.at`, so late usage after close is included and a manual run
 *    after close is excluded,
 *  - a grandchild delegation is an anomaly, never summed silently,
 *  - orchestrator and whole-tree usage stay separate where attribution is
 *    reliable,
 *  - reported / estimated / subscription / unknown / real zero are distinct,
 *  - usage is provisional until close+24 h, then persisted idempotently with
 *    `usageFinalizedAt`, and expires with the 30-day ledger retention,
 *  - coverage is counted by expected runs for identity, tokens and price.
 *
 * Uses a scratch data dir per case so no live project data is touched.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginWorkspaceWatcherCycleMetric,
  finalizeWorkspaceWatcherCycleMetric,
  getWorkspaceWatcherCycleMetric,
  persistWorkspaceWatcherCycleUsage,
} from '../lib/persist/workspace-watcher-cycle-metrics-persist.js';
import {
  correlateWorkspaceWatcherCycleUsage,
  finalizeDueWorkspaceWatcherCycleUsage,
  finalizeWorkspaceWatcherCycleUsage,
  readWorkspaceWatcherCycleUsage,
  resolveWorkspaceWatcherCycleUsagePhase,
  WORKSPACE_WATCHER_CYCLE_USAGE_GRACE_MS,
  WORKSPACE_WATCHER_CYCLE_USAGE_RETENTION_MS,
} from '../lib/workspace-watcher-cycle-metrics.js';
import { reconcileWorkspaceWatchersOnBoot } from '../lib/workspace-watcher.js';

const T0 = Date.parse('2026-10-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cycle-usage-'));

/**
 * @param {string} name
 * @returns {string}
 */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function cycle(overrides = {}) {
  return {
    cycleId: 'cyc-1',
    orchestratorChatId: 'orch-1',
    orchestratorRunId: 'run-1',
    startedAt: iso(T0),
    closedAt: iso(T0 + 30 * 60 * 1000),
    ...overrides,
  };
}

let eventSeq = 0;
/**
 * @param {object} [overrides]
 * @returns {object}
 */
function event(overrides = {}) {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    at: iso(T0 + eventSeq * 1000),
    eventType: 'delta',
    harness: 'claude',
    identityClass: 'durable_sequence',
    logicalEventKey: `key-${eventSeq}`,
    tokens: { textInput: 100, textOutput: 10 },
    ...overrides,
  };
}

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function delegation(overrides = {}) {
  return {
    id: 'del-1',
    parentChatId: 'orch-1',
    childChatId: 'child-chat-1',
    leafId: 'leaf-1',
    runId: 'child-run-1',
    attemptId: 'child-attempt-1',
    status: 'completed',
    ...overrides,
  };
}

/**
 * @param {string} dataDir
 * @param {object} [overrides]
 * @returns {object}
 */
function seedClosedCycle(dataDir, overrides = {}) {
  const input = cycle(overrides);
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: input.cycleId,
    workspaceFolder: '/w',
    mode: 'implement',
    orchestratorChatId: input.orchestratorChatId,
    todoIds: ['t1'],
    startedAt: input.startedAt,
  });
  finalizeWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: input.cycleId,
    closeSource: 'report',
    closeOutcome: 'success',
    closedAt: input.closedAt,
    reachedRunning: true,
  });
  return input;
}

test('orchestrator retries and children are summed once; own and consolidated stay apart', () => {
  const row = cycle({ orchestratorRunIds: ['run-1', 'run-2'] });
  const delegations = [delegation()];
  const events = [
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'o1', tokens: { textInput: 100 }, usd: 1 }),
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-2', logicalEventKey: 'o2', tokens: { textInput: 50 }, usd: 0.5 }),
    event({ cycleId: 'cyc-1', delegationId: 'del-1', chatId: 'child-chat-1', runId: 'child-run-1', logicalEventKey: 'c1', tokens: { textInput: 200 }, usd: 2 }),
  ];
  const summary = correlateWorkspaceWatcherCycleUsage(row, { events, delegations, now: T0 + 2 * HOUR });
  assert.equal(summary.orchestrator.own.runs.length, 2, 'both orchestrator retries count');
  assert.equal(summary.orchestrator.own.totalTokens, 150);
  assert.equal(summary.children.own.totalTokens, 200);
  assert.equal(summary.tree.reliable, true);
  assert.equal(summary.tree.own.totalTokens, 350, 'tree = orchestrator own + child own');
  assert.equal(summary.tree.cost.reportedUsd, 3.5);
  assert.equal(summary.orchestrator.consolidated.eventCount, 0);

  // A consolidated orchestrator aggregate must not be added to the own sums.
  const withConsolidated = correlateWorkspaceWatcherCycleUsage(row, {
    events: [
      ...events,
      event({
        cycleId: 'cyc-1',
        chatId: 'orch-1',
        runId: 'run-2',
        logicalEventKey: 'o-cons',
        accountingScope: 'consolidated',
        tokens: { textInput: 999 },
        usd: 9,
      }),
    ],
    delegations,
    now: T0 + 2 * HOUR,
  });
  assert.equal(withConsolidated.orchestrator.own.totalTokens, 150, 'own stays separate');
  assert.equal(withConsolidated.orchestrator.consolidated.totalTokens, 999);
  assert.equal(withConsolidated.tree.reliable, false, 'a consolidated aggregate makes the tree unsafe to sum');
  assert.equal(withConsolidated.tree.own, null, 'own is not mixed with the consolidated aggregate');
});

test('legacy events without a cycle id still join by run membership', () => {
  const row = cycle({ orchestratorRunIds: ['run-1', 'run-2'] });
  const events = [
    event({ chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'l1', tokens: { textInput: 11 } }),
    event({ chatId: 'orch-1', runId: 'run-2', logicalEventKey: 'l2', tokens: { textInput: 22 } }),
    // Same chat, a run outside the cycle membership: not attributable.
    event({ chatId: 'orch-1', runId: 'not-in-cycle', logicalEventKey: 'l3', tokens: { textInput: 500 } }),
  ];
  const summary = correlateWorkspaceWatcherCycleUsage(row, { events, now: T0 + HOUR });
  assert.equal(summary.orchestrator.own.totalTokens, 33);
  assert.equal(summary.anomalies.orchestratorRunsNotInCycle, 1);
});

test('duplicate events are dropped by durable identity', () => {
  const row = cycle();
  const shared = event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'dup', tokens: { textInput: 100 } });
  const summary = correlateWorkspaceWatcherCycleUsage(row, {
    events: [shared, { ...shared }, shared],
    now: T0 + HOUR,
  });
  assert.equal(summary.orchestrator.own.eventCount, 1);
  assert.equal(summary.dedupe.duplicateEventCount, 2);
  assert.equal(summary.orchestrator.own.totalTokens, 100);
});

test('late usage after close is included by run membership, but a manual run is not', () => {
  const row = cycle({ orchestratorRunIds: ['run-1', 'run-retry'] });
  const events = [
    // Late ledger event stamped with the cycle: still the same run.
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'late', at: iso(T0 + 5 * HOUR), tokens: { textInput: 42 } }),
    // A retry recorded after close but part of the cycle.
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-retry', logicalEventKey: 'retry', at: iso(T0 + 6 * HOUR), tokens: { textInput: 8 } }),
    // A manual run in the same chat after close: no cycle id, unknown run id.
    event({ chatId: 'orch-1', runId: 'manual-1', logicalEventKey: 'manual', at: iso(T0 + 7 * HOUR), tokens: { textInput: 500 } }),
  ];
  const summary = correlateWorkspaceWatcherCycleUsage(row, { events, now: T0 + 8 * HOUR });
  assert.equal(summary.orchestrator.own.totalTokens, 50, 'late and retry events are in, the manual run is out');
  assert.equal(summary.anomalies.orchestratorRunsNotInCycle, 1);
  assert.equal(summary.provisional, true, 'close+30min is still inside the 24h grace');
});

test('a deferred child lands after close through its delegation id', () => {
  const row = cycle();
  const delegations = [delegation({ id: 'del-late', childChatId: 'child-late', status: 'running' })];
  const summary = correlateWorkspaceWatcherCycleUsage(row, {
    events: [
      event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'own', tokens: { textInput: 10 } }),
      // The child finishes and reports after the orchestrator already closed.
      event({
        delegationId: 'del-late',
        chatId: 'child-late',
        runId: 'child-run-late',
        logicalEventKey: 'late-child',
        at: iso(T0 + 3 * HOUR),
        tokens: { textInput: 77 },
        usd: 0.25,
      }),
    ],
    delegations,
    now: T0 + HOUR,
  });
  assert.equal(summary.children.own.totalTokens, 77);
  assert.equal(summary.tree.own.totalTokens, 87);
  assert.equal(summary.coverage.identity.covered, 2, 'both the orchestrator and the deferred child are covered');
});

test('a grandchild delegation is reported as an anomaly and never summed', () => {
  const row = cycle();
  const delegations = [
    delegation({ id: 'del-child', childChatId: 'child-chat-1' }),
    delegation({ id: 'del-grand', parentChatId: 'child-chat-1', childChatId: 'grand-chat' }),
  ];
  const summary = correlateWorkspaceWatcherCycleUsage(row, {
    events: [
      event({ cycleId: 'cyc-1', delegationId: 'del-child', chatId: 'child-chat-1', logicalEventKey: 'child', tokens: { textInput: 20 } }),
      event({ cycleId: 'cyc-1', delegationId: 'del-grand', chatId: 'grand-chat', logicalEventKey: 'grand', tokens: { textInput: 1000 } }),
    ],
    delegations,
    now: T0 + HOUR,
  });
  assert.equal(summary.anomalies.grandchildren.length, 1);
  assert.equal(summary.anomalies.grandchildren[0].delegationId, 'del-grand');
  assert.equal(summary.tree.own.totalTokens, 20, 'the grandchild measurement is not summed');
});

test('reported, estimated, subscription, unknown and real zero stay distinct', () => {
  const row = cycle();
  const base = [
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'r', usd: 1, tokens: { textInput: 1 } }),
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'e', usd: 2, estimated: true, tokens: { textInput: 1 } }),
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 's', billingMode: 'subscription', tokens: { textInput: 5 } }),
  ];
  const mixed = correlateWorkspaceWatcherCycleUsage(row, { events: base, now: T0 + HOUR });
  assert.equal(mixed.tree.cost.reportedUsd, 1);
  assert.equal(mixed.tree.cost.estimatedUsd, 2);
  assert.equal(mixed.tree.cost.subscriptionEventCount, 1, 'subscription carries no USD');
  assert.equal(mixed.tree.cost.totalKnownUsd, 3, 'subscription is excluded from the USD sum');
  assert.equal(mixed.tree.cost.zero, false);

  const partial = correlateWorkspaceWatcherCycleUsage(row, {
    events: [...base, event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'u', tokens: { textInput: 1 } })],
    now: T0 + HOUR,
  });
  assert.equal(partial.tree.cost.partial, true, 'an unpriced event makes the sum an explicit lower bound');
  assert.equal(partial.tree.cost.totalKnownUsd, 3, 'the known lower bound stays reported+estimated');
  assert.equal(partial.tree.cost.unknownEventCount, 1);

  const zero = correlateWorkspaceWatcherCycleUsage(row, {
    events: [event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'z', usd: 0, tokens: { textInput: 0 } })],
    now: T0 + HOUR,
  });
  assert.equal(zero.tree.cost.reportedUsd, 0, 'a real zero is not null');
  assert.equal(zero.tree.cost.totalKnownUsd, 0);
  assert.equal(zero.tree.cost.zero, true);
  assert.equal(zero.tree.cost.partial, false);

  const none = correlateWorkspaceWatcherCycleUsage(row, { events: [], now: T0 + HOUR });
  assert.equal(none.tree.cost.reportedUsd, null);
  assert.equal(none.tree.cost.estimatedUsd, null);
  assert.equal(none.tree.cost.totalKnownUsd, null);
  assert.equal(none.tree.cost.provenance, 'unknown');
  assert.equal(none.tree.cost.zero, false, 'unknown is distinct from zero');
});

test('coverage counts expected runs separately for identity, tokens and price', () => {
  const row = cycle({ orchestratorRunIds: ['run-1'] });
  const delegations = [
    delegation({ id: 'del-a', childChatId: 'child-a' }),
    delegation({ id: 'del-b', childChatId: 'child-b' }),
  ];
  const summary = correlateWorkspaceWatcherCycleUsage(row, {
    events: [
      event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'o', tokens: { textInput: 10 }, usd: 0.1 }),
      event({ cycleId: 'cyc-1', delegationId: 'del-a', chatId: 'child-a', runId: 'run-a', logicalEventKey: 'a', tokens: { textInput: 20 } }),
      event({ cycleId: 'cyc-1', delegationId: 'del-b', chatId: 'child-b', runId: 'run-b', logicalEventKey: 'b', tokens: { textInput: 0 } }),
    ],
    delegations,
    now: T0 + HOUR,
  });
  assert.equal(summary.coverage.expectedRuns, 3);
  assert.equal(summary.coverage.identity.ratio, 1);
  assert.equal(summary.coverage.tokens.covered, 2);
  assert.equal(summary.coverage.tokens.ratio, 0.6667);
  assert.equal(summary.coverage.price.covered, 1);
  assert.equal(summary.coverage.price.ratio, 0.3333);
});

test('phase moves open -> provisional -> final -> expired around the grace and retention', () => {
  const closedAt = iso(T0);
  assert.equal(resolveWorkspaceWatcherCycleUsagePhase({ closedAt: '' }, { now: T0 }).phase, 'open');
  assert.equal(resolveWorkspaceWatcherCycleUsagePhase({ closedAt }, { now: T0 + 23 * HOUR }).phase, 'provisional');
  assert.equal(resolveWorkspaceWatcherCycleUsagePhase({ closedAt }, { now: T0 + 25 * HOUR }).phase, 'final');
  assert.equal(resolveWorkspaceWatcherCycleUsagePhase({ closedAt }, { now: T0 + 31 * DAY }).phase, 'expired');
  assert.equal(WORKSPACE_WATCHER_CYCLE_USAGE_GRACE_MS, DAY);
  assert.equal(WORKSPACE_WATCHER_CYCLE_USAGE_RETENTION_MS, 30 * DAY);
});

test('finalization is idempotent and a late measurement before it is included', () => {
  const dataDir = freshDataDir('finalize');
  seedClosedCycle(dataDir, { closedAt: iso(T0 - 25 * HOUR) });
  const events = [
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'own', tokens: { textInput: 100 }, usd: 0.5 }),
    // Late usage lands between close and finalization.
    event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'late', at: iso(T0 - 24 * HOUR), tokens: { textInput: 25 }, usd: 0.25 }),
  ];
  const deps = { readUsageEvents: () => events, loadDelegations: () => [] };
  const first = finalizeWorkspaceWatcherCycleUsage({ cycleId: 'cyc-1', dataDir, now: T0 }, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.reason, 'usage_finalized');
  assert.equal(first.record.usageFinalized, true);
  assert.ok(first.record.usageFinalizedAt);
  assert.equal(first.record.usage.tree.cost.reportedUsd, 0.75);
  assert.equal(first.record.usage.tree.own.totalTokens, 125);

  // A replay must not change the stored sums, even if new usage appears.
  const replay = finalizeWorkspaceWatcherCycleUsage({
    cycleId: 'cyc-1',
    dataDir,
    now: T0 + HOUR,
  }, { readUsageEvents: () => [...events, event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'later', tokens: { textInput: 999 } })] });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.record.usage.tree.own.totalTokens, 125, 'a finalized record is stable');
  const stored = getWorkspaceWatcherCycleMetric('cyc-1', { dataDir });
  assert.equal(stored.usage.tree.own.totalTokens, 125);
  assert.equal(stored.usageFinalizedAt, first.record.usageFinalizedAt);
});

test('a restart during finalization retries cleanly and never double counts', () => {
  const dataDir = freshDataDir('restart');
  seedClosedCycle(dataDir, { closedAt: iso(T0 - 25 * HOUR) });
  const events = [event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'own', tokens: { textInput: 100 } })];
  const failingStore = {
    getWorkspaceWatcherCycleMetric: (cycleId, options) => getWorkspaceWatcherCycleMetric(cycleId, options),
    persistWorkspaceWatcherCycleUsage: () => {
      const error = new Error('process restarted before the atomic write');
      error.code = 'EIO';
      throw error;
    },
  };
  // Attempt 1 dies before the record is updated.
  const crashed = finalizeWorkspaceWatcherCycleUsage(
    { cycleId: 'cyc-1', dataDir, now: T0 },
    { cycleMetricsStore: failingStore, readUsageEvents: () => events, loadDelegations: () => [] }
  );
  assert.equal(crashed.ok, false);
  assert.equal(crashed.reason, 'usage_finalize_failed');
  assert.equal(getWorkspaceWatcherCycleMetric('cyc-1', { dataDir }).usageFinalizedAt, null);
  // Attempt 2 after "restart" writes the final sums exactly once.
  const retried = finalizeWorkspaceWatcherCycleUsage(
    { cycleId: 'cyc-1', dataDir, now: T0 },
    { readUsageEvents: () => events, loadDelegations: () => [] }
  );
  assert.equal(retried.ok, true);
  assert.equal(retried.record.usage.tree.own.totalTokens, 100);
  const again = finalizeWorkspaceWatcherCycleUsage({ cycleId: 'cyc-1', dataDir, now: T0 }, {});
  assert.equal(again.replay, true);
  assert.equal(again.record.usage.tree.own.totalTokens, 100);
});

test('provisional usage is not finalized; an expired cycle gets an explicit marker', () => {
  const provisionalDir = freshDataDir('provisional');
  seedClosedCycle(provisionalDir, { closedAt: iso(T0 - HOUR) });
  const refused = finalizeWorkspaceWatcherCycleUsage({ cycleId: 'cyc-1', dataDir: provisionalDir, now: T0 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'usage_provisional');
  assert.equal(getWorkspaceWatcherCycleMetric('cyc-1', { dataDir: provisionalDir }).usageFinalizedAt, null);

  const expiredDir = freshDataDir('expired');
  // The cycle record is still inside the store retention (closed 25 h ago), but
  // the injected ledger retention has already elapsed, so the state is
  // `expired` and a marker is persisted instead of a fabricated sum.
  seedClosedCycle(expiredDir, { closedAt: iso(T0 - 25 * HOUR) });
  const expired = finalizeWorkspaceWatcherCycleUsage({ cycleId: 'cyc-1', dataDir: expiredDir, now: T0, retentionMs: HOUR });
  assert.equal(expired.ok, true);
  assert.equal(expired.reason, 'usage_expired');
  assert.equal(expired.record.usageExpired, true);
  assert.equal(expired.record.usageFinalized, false);
  assert.equal(expired.record.usage, null, 'no fabricated sum after the ledger retention');
});

test('read returns a live provisional summary, then the frozen final one', () => {
  const dataDir = freshDataDir('read');
  seedClosedCycle(dataDir, { closedAt: iso(T0 - HOUR) });
  const deps = {
    readUsageEvents: () => [event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'own', tokens: { textInput: 12 } })],
    loadDelegations: () => [],
  };
  const live = readWorkspaceWatcherCycleUsage('cyc-1', { dataDir, now: T0 }, deps);
  assert.equal(live.phase, 'provisional');
  assert.equal(live.provisional, true);
  assert.equal(live.stored, false);
  assert.equal(live.usage.tree.own.totalTokens, 12);

  const freshDir = freshDataDir('read-final');
  seedClosedCycle(freshDir, { closedAt: iso(T0 - 25 * HOUR) });
  const finalized = finalizeWorkspaceWatcherCycleUsage({ cycleId: 'cyc-1', dataDir: freshDir, now: T0 }, deps);
  assert.equal(finalized.ok, true);
  const frozen = readWorkspaceWatcherCycleUsage('cyc-1', { dataDir: freshDir, now: T0 + 2 * HOUR }, deps);
  assert.equal(frozen.phase, 'final');
  assert.equal(frozen.finalized, true);
  assert.equal(frozen.stored, true);
  assert.equal(frozen.usage.tree.own.totalTokens, 12);
});

test('the due sweep finalizes only cycles past the grace and never redoes work', () => {
  const dataDir = freshDataDir('sweep');
  seedClosedCycle(dataDir, { cycleId: 'due', closedAt: iso(T0 - 25 * HOUR) });
  seedClosedCycle(dataDir, { cycleId: 'recent', closedAt: iso(T0 - HOUR) });
  const deps = {
    readUsageEvents: () => [],
    loadDelegations: () => [],
  };
  const first = finalizeDueWorkspaceWatcherCycleUsage({ dataDir, now: T0 }, deps);
  assert.equal(first.considered, 2);
  assert.equal(first.finalized, 1);
  assert.equal(first.provisional, 1);
  const second = finalizeDueWorkspaceWatcherCycleUsage({ dataDir, now: T0 }, deps);
  assert.equal(second.considered, 1, 'the finalized cycle is skipped');
  assert.equal(second.provisional, 1);
});

test('boot reconcile finalizes due usage after a restart', () => {
  const dataDir = freshDataDir('boot');
  seedClosedCycle(dataDir, { closedAt: iso(T0 - 25 * HOUR) });
  const events = [event({ cycleId: 'cyc-1', chatId: 'orch-1', runId: 'run-1', logicalEventKey: 'own', tokens: { textInput: 30 } })];
  reconcileWorkspaceWatchersOnBoot({
    dataDir,
    now: T0,
    cycleUsageEvents: events,
    cycleUsageDelegations: [],
    cycleUsageDeps: { readUsageEvents: () => events, loadDelegations: () => [] },
  });
  const stored = getWorkspaceWatcherCycleMetric('cyc-1', { dataDir });
  assert.equal(stored.usageFinalized, true);
  assert.equal(stored.usage.tree.own.totalTokens, 30);
});

test('a ledger read failure is never finalized as zero', () => {
  const dataDir = freshDataDir('read-failure');
  seedClosedCycle(dataDir, { closedAt: iso(T0 - 25 * HOUR) });
  let writeCalls = 0;
  const store = {
    getWorkspaceWatcherCycleMetric: (cycleId, options) => getWorkspaceWatcherCycleMetric(cycleId, options),
    persistWorkspaceWatcherCycleUsage: () => {
      writeCalls += 1;
      throw new Error('must not be reached');
    },
  };
  const result = finalizeWorkspaceWatcherCycleUsage(
    { cycleId: 'cyc-1', dataDir, now: T0 },
    {
      cycleMetricsStore: store,
      readUsageEvents: () => { throw new Error('ledger offline'); },
      loadDelegations: () => [],
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'usage_ledger_read_failed');
  assert.equal(writeCalls, 0, 'a failed ledger read never writes a frozen zero');
  assert.equal(getWorkspaceWatcherCycleMetric('cyc-1', { dataDir }).usageFinalizedAt, null);
});

test('persist refuses a foreign cycle id instead of creating a usage-only record', () => {
  const dataDir = freshDataDir('foreign');
  const result = persistWorkspaceWatcherCycleUsage({
    dataDir,
    cycleId: 'does-not-exist',
    usage: correlateWorkspaceWatcherCycleUsage(cycle(), { events: [], now: T0 }),
    finalized: true,
  });
  assert.equal(result.persisted, false);
  assert.equal(result.record, null);
  assert.equal(getWorkspaceWatcherCycleMetric('does-not-exist', { dataDir }), null);
});
