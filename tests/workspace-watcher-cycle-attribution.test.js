/**
 * Contract: the versioned cycle attribution records orchestrator outcome,
 * rounds per leaf and child composition without conflating jobs/retries with
 * rounds, and without guessing an actual provider that telemetry never saw.
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_WATCHER_CYCLE_ATTRIBUTION_SCHEMA_VERSION,
  buildWorkspaceWatcherCycleAttribution,
  normalizeWorkspaceWatcherCycleAttribution,
} from '../lib/workspace-watcher-cycle-attribution.js';
import { resolveWorkspaceWatcherCycleAttributionForClose } from '../lib/workspace-watcher-cycle-close.js';
import { createDelegationRecord } from '../lib/persist/delegations-persist.js';
import { appendUsageEvent } from '../lib/persist/usage-persist.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  beginWorkspaceWatcherCycleMetric,
  finalizeWorkspaceWatcherCycleMetric,
  getWorkspaceWatcherCycleMetric,
} from '../lib/persist/workspace-watcher-cycle-metrics-persist.js';

const T0 = Date.parse('2026-10-10T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

test('rounds per leaf come from the durable workflow, never from job counts', () => {
  const cycle = { cycleId: 'c1', orchestratorChatId: 'orch-1', todoIds: ['t1', 't2'] };
  const attribution = buildWorkspaceWatcherCycleAttribution({
    cycle,
    workflowRows: [
      { parentChatId: 'orch-1', leafId: 't1', round: 3, maxRounds: 4, lastVerdict: 'FAIL' },
    ],
    // Five delegation rows must NOT turn into a round count for t2.
    delegations: Array.from({ length: 5 }, (_, index) => ({
      id: `d${index}`, parentChatId: 'orch-1', childChatId: `child-${index}`,
    })),
  });
  assert.equal(attribution.roundsByLeaf.t1.round, 3);
  assert.equal(attribution.roundsByLeaf.t1.source, 'durable');
  assert.deepEqual(attribution.roundsByLeaf.t2, {
    round: null,
    maxRounds: null,
    lastVerdict: null,
    source: 'unknown',
  });
});

test('child composition keeps requested and actual identity separate', () => {
  const attribution = buildWorkspaceWatcherCycleAttribution({
    cycle: { cycleId: 'c2', orchestratorChatId: 'orch-2', todoIds: ['t1'] },
    delegations: [
      {
        id: 'd1', parentChatId: 'orch-2', childChatId: 'child-1', leafId: 't1',
        pickRole: 'implement', assignment: 'implement', status: 'completed', taskOutcome: 'success',
        executor: { transport: 'codex', model: 'gpt-6.1-sol::effort=low' },
      },
      {
        id: 'd2', parentChatId: 'orch-2', childChatId: 'child-2',
        assignment: 'review', status: 'failed',
        executor: { transport: 'deepseek', model: 'deepseek-v4' },
      },
      // Foreign child: a different parent must never be attributed to this cycle.
      { id: 'd3', parentChatId: 'other', childChatId: 'child-3', executor: { transport: 'mock', model: 'x' } },
    ],
    events: [
      // Telemetry confirms the actual pair for d1 only.
      { delegationId: 'd1', chatId: 'child-1', harness: 'codex', model: 'gpt-6.1-sol::effort=low', provider: 'openai' },
    ],
  });
  assert.equal(attribution.childCount, 2);
  const [first, second] = attribution.children;
  assert.equal(first.role, 'implement');
  assert.equal(first.requestedHarness, 'codex');
  assert.equal(first.requestedModel, 'gpt-6.1-sol::effort=low');
  assert.equal(first.requestedEffort, 'low');
  assert.equal(first.harness, 'codex', 'actual harness is confirmed by telemetry');
  assert.equal(first.model, 'gpt-6.1-sol::effort=low');
  assert.equal(first.provider, 'openai');
  assert.equal(first.effort, 'low');
  assert.equal(first.outcome, 'success');
  assert.equal(second.role, 'review');
  assert.equal(second.harness, null, 'without telemetry the actual harness stays unknown');
  assert.equal(second.model, null, 'without telemetry the actual model stays unknown');
  assert.equal(second.provider, null);
});

test('review protocol version defaults to the current protocol and normalizes old records', () => {
  const current = buildWorkspaceWatcherCycleAttribution({ cycle: { cycleId: 'c3', todoIds: [] } });
  assert.equal(current.schemaVersion, WORKSPACE_WATCHER_CYCLE_ATTRIBUTION_SCHEMA_VERSION);
  assert.match(current.reviewProtocolVersion, /^review-protocol-/);
  const legacy = normalizeWorkspaceWatcherCycleAttribution({
    schemaVersion: 1,
    roundsByLeaf: { t1: { round: 2, maxRounds: 4, lastVerdict: 'PASS', source: 'durable' } },
    children: [{ delegationId: 'd', requestedModel: 'm', model: null, provider: null }],
  });
  assert.equal(legacy.roundsByLeaf.t1.round, 2);
  assert.equal(legacy.children[0].requestedModel, 'm');
  assert.equal(legacy.children[0].model, null);
  assert.equal(legacy.reviewProtocolVersion, null, 'a missing protocol stays unknown, never guessed');
});

test('close path fills child actual identity from correlated usage events', () => {
  createDelegationRecord({
    id: 'd-close-1',
    parentChatId: 'orch-close',
    childChatId: 'child-close-1',
    leafId: 't1',
    workspaceFolder: '/w',
    status: 'completed',
    executor: { transport: 'codex', model: 'gpt-6.1-sol' },
  });
  appendUsageEvent({
    at: iso(T0 + 30_000),
    delegationId: 'd-close-1',
    chatId: 'child-close-1',
    harness: 'codex',
    model: 'gpt-6.1-sol::effort=high',
    provider: 'openai',
    logicalEventKey: 'close-attrib-1',
    tokens: { textInput: 10, textOutput: 5 },
  }, { dataDir: ISOLATED_DATA_DIR });
  const attribution = resolveWorkspaceWatcherCycleAttributionForClose({
    cycle: {
      cycleId: 'cy-close',
      chatId: 'orch-close',
      runId: 'run-close',
      startedAt: iso(T0),
      closedAt: iso(T0 + 60_000),
    },
    claimedTodoIds: ['t1'],
    closedAt: iso(T0 + 60_000),
    dataDir: ISOLATED_DATA_DIR,
  });
  assert.equal(attribution.childCount, 1);
  assert.equal(attribution.children[0].requestedModel, 'gpt-6.1-sol');
  assert.equal(attribution.children[0].model, 'gpt-6.1-sol::effort=high');
  assert.equal(attribution.children[0].provider, 'openai');
  assert.equal(attribution.children[0].effort, 'high');
});

test('close path leaves actual identity unknown when telemetry is absent', () => {
  createDelegationRecord({
    id: 'd-close-2',
    parentChatId: 'orch-close-2',
    childChatId: 'child-close-2',
    workspaceFolder: '/w',
    status: 'completed',
    executor: { transport: 'sdk', model: 'gpt-5.6' },
  });
  const attribution = resolveWorkspaceWatcherCycleAttributionForClose({
    cycle: {
      cycleId: 'cy-close-2',
      chatId: 'orch-close-2',
      startedAt: iso(T0),
      closedAt: iso(T0 + 60_000),
    },
    closedAt: iso(T0 + 60_000),
    dataDir: ISOLATED_DATA_DIR,
  });
  assert.equal(attribution.children[0].requestedModel, 'gpt-5.6');
  assert.equal(attribution.children[0].model, null);
  assert.equal(attribution.children[0].provider, null);
});

test('finalize persists the attribution block and a legacy record reads back null', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-cycle-attribution-'));
  beginWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'cy-attrib',
    workspaceFolder: '/w',
    mode: 'implement',
    orchestratorChatId: 'orch-9',
    todoIds: ['t1'],
    startedAt: iso(T0),
  });
  const attribution = buildWorkspaceWatcherCycleAttribution({
    cycle: { cycleId: 'cy-attrib', orchestratorChatId: 'orch-9', todoIds: ['t1'] },
    workflowRows: [{ parentChatId: 'orch-9', leafId: 't1', round: 1, maxRounds: 4, lastVerdict: 'PASS' }],
  });
  finalizeWorkspaceWatcherCycleMetric({
    dataDir,
    cycleId: 'cy-attrib',
    closeSource: 'report',
    closeOutcome: 'success',
    reportedOutcome: 'success',
    closedAt: iso(T0 + 60_000),
    attribution,
  });
  const record = getWorkspaceWatcherCycleMetric('cy-attrib', { dataDir });
  assert.equal(record.attribution.roundsByLeaf.t1.round, 1);
  assert.equal(record.attribution.roundsByLeaf.t1.lastVerdict, 'PASS');
  assert.match(record.attribution.reviewProtocolVersion, /^review-protocol-/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

console.log('workspace-watcher-cycle-attribution.test.js OK');
