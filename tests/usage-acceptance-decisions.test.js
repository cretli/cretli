import './helpers/isolated-data-dir.js';
/**
 * Stage-9 acceptance/conformance: parent/child attribution, pick_id lifecycle
 * and cycle acceptance/cost.
 *
 * Every assertion calls production code; no rule is re-implemented here. All
 * scenarios share the one frozen cutoff from the acceptance fixture so the
 * report can compare them on the same time origin.
 *
 * Persistence (the model-pick decision store) is exercised, so the isolated
 * data dir is imported first: it redirects `data/` before the persist modules
 * resolve their paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ACCEPTANCE_CUTOFF,
  ACCEPTANCE_CUTOFF_MS,
  CYCLE_USAGE_EVENTS,
  DELEGATION_ROWS,
} from './helpers/usage-acceptance-fixture.js';

import { createUsageEvent } from '../lib/usage/usage-event.js';
import {
  buildUsageContractFields,
  hasTokenMeasurement,
  resolveChildUsageModel,
  resolveUsageCompleteness,
  resolveUsageProvenance,
} from '../lib/usage/usage-contract.js';
import { summarizeUsage } from '../lib/usage/usage-ledger.js';
import { buildUsageCoverage, summarizeExecutedChoices } from '../lib/usage/usage-insights.js';
import {
  classifyDelegationPickOrigin,
  finalizeDelegationPickSlotReservation,
  persistModelPickProposal,
  releaseModelPickSlotsForDelegation,
  resolveDelegationPickLinkFields,
  summarizeModelPickExecutionCounters,
} from '../lib/model-pick-decisions.js';
import {
  getModelPickRecord,
  reserveModelPickSlot,
} from '../lib/persist/model-pick-decisions-persist.js';
import { MODEL_PICK_TTL_MS } from '../lib/model-pick-policy.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import { listPurposeUses, pickModelForPurpose } from '../lib/model-pick-service.js';
import {
  buildDelegationQualityCycles,
  summarizeDelegationCycleCostMetrics,
  unionWallMs,
} from '../lib/delegation-cycle-outcomes.js';

const MINUTE = 60 * 1000;
const CUTOFF_MS = ACCEPTANCE_CUTOFF_MS;
/** ISO instant at `minutes` relative to the shared acceptance cutoff. */
const at = (minutes) => new Date(CUTOFF_MS + minutes * MINUTE).toISOString();
const iso = (ms) => new Date(ms).toISOString();

/** A one-pick proposal payload (primary selection only). */
function oneModelPick(harness, model) {
  return { pick: { harness, model }, picks: [{ harness, model }] };
}

function tempPickFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-pick-')), 'model-pick-decisions.json');
}

/**
 * Local frozen delegation rows. The shared fixture supplies the accepted and
 * rejected cycles; these add the sibling/infra/cancel/parallel cases without
 * leaving the one cutoff.
 */
const CYCLE_ROWS = Object.freeze({
  twoPass: Object.freeze([
    Object.freeze({
      id: 'impl-two', status: 'completed', role: 'implement', assignment: 'implement',
      parentChatId: 'parent-two', leafId: 'leaf-two',
      createdAt: at(-300), startedAt: at(-300), finishedAt: at(-290),
      taskOutcome: 'success', report: 'done\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-two-a', status: 'completed', role: 'review', assignment: 'review',
      parentChatId: 'parent-two', leafId: 'leaf-two',
      createdAt: at(-290), startedAt: at(-290), finishedAt: at(-288),
      report: 'ok\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-two-b', status: 'completed', role: 'review', assignment: 'review',
      parentChatId: 'parent-two', leafId: 'leaf-two',
      createdAt: at(-289), startedAt: at(-289), finishedAt: at(-287),
      report: 'ok\n\nVERDICT: PASS',
    }),
  ]),
  mixed: Object.freeze([
    Object.freeze({
      id: 'impl-mixed', status: 'completed', role: 'implement', assignment: 'implement',
      parentChatId: 'parent-mixed', leafId: 'leaf-mixed',
      createdAt: at(-280), startedAt: at(-280), finishedAt: at(-270),
      taskOutcome: 'success', report: 'done\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-mixed-pass', status: 'completed', role: 'review', assignment: 'review',
      parentChatId: 'parent-mixed', leafId: 'leaf-mixed',
      createdAt: at(-270), startedAt: at(-270), finishedAt: at(-268),
      report: 'ok\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-mixed-fail', status: 'completed', role: 'review', assignment: 'review',
      parentChatId: 'parent-mixed', leafId: 'leaf-mixed',
      createdAt: at(-269), startedAt: at(-269), finishedAt: at(-267),
      report: 'found a bug\n\nVERDICT: FAIL',
    }),
  ]),
  implementNotCompleted: Object.freeze([
    Object.freeze({
      id: 'impl-failed', status: 'failed', role: 'implement', assignment: 'implement',
      parentChatId: 'parent-failed', leafId: 'leaf-failed',
      createdAt: at(-260), startedAt: at(-260), finishedAt: at(-250),
      report: 'done\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-after-failed', status: 'completed', role: 'review', assignment: 'review',
      parentChatId: 'parent-failed', leafId: 'leaf-failed',
      createdAt: at(-250), startedAt: at(-250), finishedAt: at(-248),
      report: 'ok\n\nVERDICT: PASS',
    }),
  ]),
  reviewInfra: Object.freeze([
    Object.freeze({
      id: 'impl-infra', status: 'completed', role: 'implement', assignment: 'implement',
      parentChatId: 'parent-infra', leafId: 'leaf-infra',
      createdAt: at(-240), startedAt: at(-240), finishedAt: at(-230),
      taskOutcome: 'success', report: 'done\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-infra', status: 'failed', role: 'review', assignment: 'review',
      parentChatId: 'parent-infra', leafId: 'leaf-infra',
      createdAt: at(-230), startedAt: at(-230), finishedAt: at(-228),
      // An empty/failed review report is an infrastructure failure, not a verdict.
      report: '',
    }),
  ]),
  reviewCancelled: Object.freeze([
    Object.freeze({
      id: 'impl-cancel', status: 'completed', role: 'implement', assignment: 'implement',
      parentChatId: 'parent-cancel', leafId: 'leaf-cancel',
      createdAt: at(-220), startedAt: at(-220), finishedAt: at(-210),
      taskOutcome: 'success', report: 'done\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-cancelled', status: 'cancelled', role: 'review', assignment: 'review',
      parentChatId: 'parent-cancel', leafId: 'leaf-cancel',
      createdAt: at(-210), startedAt: at(-210), finishedAt: at(-208),
      report: 'ok\n\nVERDICT: PASS',
    }),
  ]),
  parallelReviews: Object.freeze([
    Object.freeze({
      id: 'impl-parallel', status: 'completed', role: 'implement', assignment: 'implement',
      parentChatId: 'parent-parallel', leafId: 'leaf-parallel',
      createdAt: at(-120), startedAt: at(-120), finishedAt: at(-110),
      taskOutcome: 'success', report: 'done\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-parallel-a', status: 'completed', role: 'review', assignment: 'review',
      parentChatId: 'parent-parallel', leafId: 'leaf-parallel',
      createdAt: at(-118), startedAt: at(-118), finishedAt: at(-115),
      report: 'ok\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-parallel-b', status: 'completed', role: 'review', assignment: 'review',
      parentChatId: 'parent-parallel', leafId: 'leaf-parallel',
      createdAt: at(-117), startedAt: at(-117), finishedAt: at(-116),
      report: 'ok\n\nVERDICT: PASS',
    }),
  ]),
  sequential: Object.freeze([
    Object.freeze({
      id: 'impl-seq', status: 'completed', role: 'implement', assignment: 'implement',
      parentChatId: 'parent-seq', leafId: 'leaf-seq',
      createdAt: at(-120), startedAt: at(-120), finishedAt: at(-110),
      taskOutcome: 'success', report: 'done\n\nVERDICT: PASS',
    }),
    Object.freeze({
      id: 'rev-seq', status: 'completed', role: 'review', assignment: 'review',
      parentChatId: 'parent-seq', leafId: 'leaf-seq',
      createdAt: at(-110), startedAt: at(-110), finishedAt: at(-105),
      report: 'ok\n\nVERDICT: PASS',
    }),
  ]),
});

// ---------------------------------------------------------------------------
// Scenario 4 — parent/child attribution and coverage
// ---------------------------------------------------------------------------

test('scenario 4: own and consolidated usage stay separate (summary.tokens is the own view)', () => {
  const ownEvent = createUsageEvent({
    harness: 'codex',
    eventType: 'delta',
    model: 'own-model',
    at: iso(CUTOFF_MS - MINUTE),
    tokens: { textInput: 100, textOutput: 20 },
  });
  const childEvent = createUsageEvent({
    harness: 'claude',
    eventType: 'delta',
    accountingScope: 'consolidated',
    model: 'child-model',
    parentModel: 'own-model',
    at: ACCEPTANCE_CUTOFF,
    tokens: { textInput: 50, textOutput: 10 },
  });
  assert.equal(ownEvent.accountingScope, 'own');
  assert.equal(childEvent.accountingScope, 'consolidated');

  const summary = summarizeUsage([ownEvent, childEvent]);
  assert.equal(summary.mixed, true);
  assert.equal(summary.eventsByScope.own, 1);
  assert.equal(summary.eventsByScope.consolidated, 1);
  assert.equal(summary.tokensByScope.own.textInput, 100);
  assert.equal(summary.tokensByScope.consolidated.textInput, 50);
  assert.equal(summary.tokensByScope.consolidated.textOutput, 10);
  assert.equal(summary.tokens.textInput, 100, 'the top-level tokens view is the own view');
  assert.notEqual(summary.tokens.textInput, 150, 'consolidated tokens never leak into the top-level total');
  assert.equal(summary.tokens, summary.tokensByScope.own, 'the top-level tokens field aliases the own scope');
});

test('scenario 4: child model resolves from the child payload', () => {
  assert.equal(resolveChildUsageModel({ model: 'child-model', parentModel: 'parent-model' }), 'child-model');
  assert.equal(resolveChildUsageModel({ parentModel: 'parent-model' }), '');
  assert.equal(resolveChildUsageModel({}), '');

  const childEvent = createUsageEvent({
    harness: 'claude',
    eventType: 'delta',
    accountingScope: 'consolidated',
    parentModel: 'parent-model',
    tokens: { textInput: 5 },
  });
  assert.equal(childEvent.model, '', 'a child event never inherits the parent model');

  const withModel = createUsageEvent({
    harness: 'claude',
    model: 'child-model',
    parentModel: 'parent-model',
    tokens: { textInput: 5 },
  });
  assert.equal(withModel.model, 'child-model');
});

test('scenario 4: completeness/coverage keep a reported zero and never fake zero ratios', () => {
  // complete / partial / missing / unsupported are distinct.
  assert.equal(
    resolveUsageCompleteness({
      supported: true,
      lifecycle: 'ended',
      measurementPresent: true,
      coverage: { proof: true, expectedRequests: 2, coveredRequests: 2 },
    }),
    'complete'
  );
  assert.equal(
    resolveUsageCompleteness({
      supported: true,
      lifecycle: 'ended',
      measurementPresent: true,
      coverage: { proof: true, expectedRequests: 2, coveredRequests: 1 },
    }),
    'partial'
  );
  assert.equal(
    resolveUsageCompleteness({ supported: true, lifecycle: 'ended', measurementPresent: false }),
    'missing'
  );
  assert.equal(resolveUsageCompleteness({ supported: false }), 'unsupported');

  // A single measurement through the real contract path is never complete.
  const single = createUsageEvent({
    harness: 'codex',
    eventType: 'delta',
    tokens: { textInput: 10 },
    coverage: { proof: true, expectedRequests: 1, coveredRequests: 1 },
  });
  assert.equal(single.lifecycle, 'running');
  assert.equal(single.completeness, 'partial');

  // A reported zero is a measurement; absent data stays missing.
  assert.equal(hasTokenMeasurement({ textInput: 0 }), true);
  assert.equal(hasTokenMeasurement(null), false);
  assert.equal(hasTokenMeasurement({}), false);
  const zeroRun = createUsageEvent({
    harness: 'codex',
    eventType: 'run',
    outcome: 'ok',
    tokens: { textInput: 0 },
    measurementPresent: true,
    coverage: { proof: true, expectedRequests: 1, coveredRequests: 1 },
  });
  assert.equal(zeroRun.lifecycle, 'ended');
  assert.equal(zeroRun.measurementPresent, true, 'a reported zero is a measurement');
  assert.equal(zeroRun.completeness, 'complete');
  const noMeasurement = createUsageEvent({ harness: 'codex', eventType: 'run', outcome: 'ok' });
  assert.equal(noMeasurement.measurementPresent, undefined);
  assert.equal(noMeasurement.completeness, 'missing');

  // Two ratios with explicit denominators.
  const runs = [
    {
      runKey: 'own-1', runId: 'run-own-1', harness: 'codex', role: 'implement', status: 'ended',
      endedAt: iso(CUTOFF_MS - 5 * MINUTE), measurementPresent: true, completeness: 'complete',
      coverage: { proof: true },
    },
    {
      runKey: 'own-2', runId: 'run-own-2', harness: 'codex', role: 'implement', status: 'ended',
      endedAt: iso(CUTOFF_MS - 4 * MINUTE), measurementPresent: false, completeness: 'missing',
    },
  ];
  const events = [
    { id: 'own-evt-1', runId: 'run-own-1', harness: 'codex', eventType: 'delta', at: iso(CUTOFF_MS - 5 * MINUTE), tokens: { textInput: 10 } },
  ];
  const coverage = buildUsageCoverage({
    runs,
    events,
    window: { fromMs: CUTOFF_MS - 60 * MINUTE, toMs: CUTOFF_MS },
  });
  assert.equal(coverage.runs.ended, 2);
  assert.equal(coverage.endedWithUsage.n, 1);
  assert.equal(coverage.endedWithUsage.denominator, 2);
  assert.equal(coverage.endedWithUsage.ratio, 0.5);
  assert.equal(coverage.endedComplete.n, 1);
  assert.equal(coverage.endedComplete.denominator, 2);
  assert.equal(coverage.endedComplete.ratio, 0.5);

  const empty = buildUsageCoverage({ runs: [], events: [] });
  assert.equal(empty.endedWithUsage.denominator, 0);
  assert.equal(empty.endedWithUsage.ratio, null, 'an empty denominator yields null, never a fake zero');
  assert.equal(empty.endedComplete.denominator, 0);
  assert.equal(empty.endedComplete.ratio, null);
});

test('scenario 4: legacy rows without a source stay unknown/legacy, never auto/manual', () => {
  const link = resolveDelegationPickLinkFields({ assignment: 'implement', harness: 'a', model: 'm' });
  assert.equal(link.pickOrigin, 'unknown');
  assert.equal(link.pickOriginDetail, 'legacy');
  assert.equal(link.pickLinkStatus, 'legacy');

  const choices = summarizeExecutedChoices(
    [{ ...link, executor: { transport: 'a', model: 'm' } }],
    { proposals: 1 }
  );
  assert.equal(choices.unknown, 1);
  assert.equal(choices.auto, 0);
  assert.equal(choices.manual, 0);
  assert.equal(choices.originDetails.legacy, 1);

  // Usage without any source keeps an unknown provenance instead of a guess.
  assert.equal(resolveUsageProvenance({}), 'unknown');
  assert.equal(
    buildUsageContractFields({ harness: 'mystery', eventType: 'run', outcome: 'ok' }).provenance,
    'unknown'
  );
});

// ---------------------------------------------------------------------------
// Scenario 5 — pick_id lifecycle
// ---------------------------------------------------------------------------

test('scenario 5: a pick without a delegation start only raises proposals', () => {
  const file = tempPickFile();
  persistModelPickProposal({
    chatId: 'chat-s5-proposals',
    role: 'implement',
    now: CUTOFF_MS,
    pickResult: oneModelPick('a', 'm-a'),
    file,
  });
  const counters = summarizeModelPickExecutionCounters([], { file });
  assert.equal(counters.proposals, 1);
  assert.equal(counters.executedAuto, 0);
  assert.equal(counters.executedManual, 0);
  assert.equal(counters.executedUnknown, 0);
  assert.equal(counters.runs, 0);
  assert.equal(counters.cycles, null, 'a missing cycle denominator stays null, not a guessed 0');
});

test('scenario 5: pick_id links valid, expired, or mismatched role/model', () => {
  const file = tempPickFile();
  const now = CUTOFF_MS;
  const persisted = persistModelPickProposal({
    chatId: 'chat-s5-link',
    role: 'implement',
    now,
    pickResult: oneModelPick('deepseek', 'deepseek-chat'),
    file,
  });
  const base = {
    pickId: persisted.pickId,
    harness: 'deepseek',
    model: 'deepseek-chat',
    assignment: 'implement',
    parentChatId: 'chat-s5-link',
    now,
    file,
  };

  const valid = classifyDelegationPickOrigin(base);
  assert.equal(valid.origin, 'auto');
  assert.equal(valid.originDetail, 'selected');
  assert.equal(valid.linkStatus, 'linked');

  const expired = classifyDelegationPickOrigin({ ...base, now: now + MODEL_PICK_TTL_MS + 1 });
  assert.equal(expired.origin, 'unknown');
  assert.equal(expired.originDetail, 'rejected-link');
  assert.equal(expired.linkStatus, 'rejected-link');

  const wrongModel = classifyDelegationPickOrigin({ ...base, model: 'not-picked' });
  assert.equal(wrongModel.origin, 'unknown');
  assert.equal(wrongModel.linkStatus, 'rejected-link');

  const wrongRole = classifyDelegationPickOrigin({ ...base, assignment: 'review' });
  assert.equal(wrongRole.origin, 'unknown');
  assert.equal(wrongRole.linkStatus, 'rejected-link');
});

test('scenario 5: one slot winner, idempotent replay and release', async () => {
  const file = tempPickFile();
  const now = CUTOFF_MS;
  const persisted = persistModelPickProposal({
    chatId: 'chat-s5-slot',
    role: 'review',
    now,
    pickResult: oneModelPick('a', 'm-a'),
    file,
  });

  const first = await reserveModelPickSlot({
    pickId: persisted.pickId, selectionSlot: 0, delegationId: 'd-first', idempotencyKey: 'key-1', now, file,
  });
  assert.equal(first.ok, true);
  assert.equal(first.replay, false);

  const second = await reserveModelPickSlot({
    pickId: persisted.pickId, selectionSlot: 0, delegationId: 'd-second', idempotencyKey: 'key-2', now, file,
  });
  assert.equal(second.ok, false, 'exactly one start wins the slot');
  assert.equal(second.code, 'slot_taken');

  const replay = await reserveModelPickSlot({
    pickId: persisted.pickId, selectionSlot: 0, delegationId: 'd-replay', idempotencyKey: 'key-1', now, file,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true, 'the same idempotency key replays without a second reservation');

  const finalized = await finalizeDelegationPickSlotReservation({
    pickId: persisted.pickId, selectionSlot: 0, delegationId: 'd-replay', idempotencyKey: 'key-1', pickOrigin: 'auto', now, file,
  });
  assert.equal(finalized.ok, true);

  assert.equal(releaseModelPickSlotsForDelegation({ pickId: persisted.pickId, delegationId: 'd-first', file }), true);
  assert.deepEqual(getModelPickRecord(persisted.pickId, { file }).slots, {}, 'release frees the aborted start slot');

  const retake = await reserveModelPickSlot({
    pickId: persisted.pickId, selectionSlot: 0, delegationId: 'd-retake', idempotencyKey: 'key-3', now, file,
  });
  assert.equal(retake.ok, true);
  assert.equal(retake.replay, false);
});

test('scenario 5: fanout slots classify alternate/fanout; audit candidates never match', () => {
  const file = tempPickFile();
  const now = CUTOFF_MS;
  const persisted = persistModelPickProposal({
    chatId: 'chat-s5-fanout',
    role: 'review',
    now,
    pickResult: {
      pick: { harness: 'a', model: 'm-a' },
      picks: [
        { harness: 'a', model: 'm-a' },
        { harness: 'b', model: 'm-b' },
        { harness: 'c', model: 'm-c' },
      ],
      candidates: [{ harness: 'x', model: 'm-x' }],
    },
    file,
  });

  const primary = classifyDelegationPickOrigin({
    pickId: persisted.pickId, harness: 'a', model: 'm-a', assignment: 'review', parentChatId: 'chat-s5-fanout', now, file,
  });
  assert.equal(primary.originDetail, 'selected');
  assert.equal(primary.selectionSlot, 0);

  const secondary = classifyDelegationPickOrigin({
    pickId: persisted.pickId, harness: 'b', model: 'm-b', assignment: 'review', parentChatId: 'chat-s5-fanout', now, file,
  });
  assert.equal(secondary.originDetail, 'fanout');
  assert.equal(secondary.selectionSlot, 1);

  const third = classifyDelegationPickOrigin({
    pickId: persisted.pickId, harness: 'c', model: 'm-c', assignment: 'review', parentChatId: 'chat-s5-fanout', now, file,
  });
  assert.equal(third.originDetail, 'fanout');
  assert.equal(third.selectionSlot, 2);

  const record = getModelPickRecord(persisted.pickId, { file });
  assert.equal(record.picks[1].originDetailHint, 'alternate', 'secondary explicit picks are alternates before fanout classification');
  const auditRows = record.candidates.filter((row) => row.selectionSlot == null);
  assert.ok(auditRows.length >= 1, 'audit-only candidates keep a null slot');

  const auditLink = classifyDelegationPickOrigin({
    pickId: persisted.pickId, harness: 'x', model: 'm-x', assignment: 'review', parentChatId: 'chat-s5-fanout', now, file,
  });
  assert.equal(auditLink.origin, 'unknown');
  assert.equal(auditLink.linkStatus, 'rejected-link');
  assert.equal(auditLink.selectionSlot, null);
});

test('scenario 5: manual source is an allow-list counted apart from auto/unknown', () => {
  for (const source of ['manual', 'user', 'operator', 'ui', 'settings-ui', 'todo-assignee']) {
    const link = classifyDelegationPickOrigin({ manualSource: source, assignment: 'implement' });
    assert.equal(link.origin, 'manual', source);
    assert.equal(link.linkStatus, 'linked', source);
  }
  for (const source of ['hacker', 'auto', 'selected', 'free text']) {
    const link = classifyDelegationPickOrigin({ manualSource: source, assignment: 'implement' });
    assert.equal(link.origin, 'unknown', source);
    assert.equal(link.linkStatus, 'rejected-link', source);
  }

  const counters = summarizeModelPickExecutionCounters(
    [{ pickOrigin: 'auto' }, { pickOrigin: 'manual' }, { pickOrigin: 'manual' }, { pickOrigin: '' }],
    { loadPicks: () => ({}) }
  );
  assert.equal(counters.executedAuto, 1);
  assert.equal(counters.executedManual, 2);
  assert.equal(counters.executedUnknown, 1);
  assert.equal(counters.runs, 4);
});

const PURPOSE_HARNESSES = Object.freeze([
  Object.freeze({ id: 'a', enabled: true, ready: true, can_delegate: true }),
  Object.freeze({ id: 'b', enabled: true, ready: true, can_delegate: true }),
]);
const PURPOSE_MODELS = Object.freeze({
  a: Object.freeze({
    favorites_configured: true,
    items: Object.freeze([
      Object.freeze({ id: 'm-a', roles: Object.freeze(['implement']), cost_tier: 1, quality_tier: 3, speed_tier: 3 }),
    ]),
  }),
  b: Object.freeze({
    favorites_configured: true,
    items: Object.freeze([
      Object.freeze({ id: 'm-b', roles: Object.freeze(['implement']), cost_tier: 1, quality_tier: 3, speed_tier: 3 }),
    ]),
  }),
});

test('scenario 5: purpose Watcher/Scout uses are tagged and scoped', () => {
  const now = CUTOFF_MS;
  const chats = [
    { pickPurpose: 'scout', agentTransport: 'a', model: 'm-a', createdAt: iso(now - 1000) },
    { pickPurpose: 'watcher', agentTransport: 'b', model: 'm-b', createdAt: iso(now - 1000) },
    // Outside the role-usage window: a tagged but stale chat is not a purpose use.
    { pickPurpose: 'scout', agentTransport: 'a', model: 'm-a', createdAt: iso(now - 40 * 24 * 60 * MINUTE) },
    { pickPurpose: 'other', agentTransport: 'b', model: 'm-b', createdAt: iso(now - 1000) },
  ];

  const scoutUses = listPurposeUses('scout', { chats, now });
  assert.equal(scoutUses.length, 1, 'only in-window scout chats are purpose uses');
  assert.equal(scoutUses[0].harness, 'a');
  const watcherUses = listPurposeUses('watcher', { chats, now });
  assert.equal(watcherUses.length, 1);
  assert.equal(watcherUses[0].harness, 'b');
  assert.equal(listPurposeUses('other', { chats, now }).length, 1);
  assert.equal(listPurposeUses('', { chats, now }).length, 0, 'an empty purpose is not a scope');

  const base = {
    role: 'implement',
    harnesses: PURPOSE_HARNESSES,
    modelsByHarness: PURPOSE_MODELS,
    rotation: { mode: 'balanced' },
    explore: false,
    shadow: false,
    now,
  };
  const freshHistory = buildModelPickHistory({
    role: 'implement', harnesses: PURPOSE_HARNESSES, delegations: [], now, lockouts: [], planLimits: [],
  });
  const fresh = pickModelForPurpose({ ...base, purpose: 'scout', history: freshHistory });
  assert.equal(fresh.ok, true);
  const used = fresh.pick.harness;

  const scopedUses = Array.from({ length: 3 }, () => ({
    harness: used,
    model: used === 'a' ? 'm-a' : 'm-b',
    createdAt: iso(now - 1000),
  }));
  const usedHistory = buildModelPickHistory({
    role: 'implement', harnesses: PURPOSE_HARNESSES, delegations: [], extraUses: scopedUses, now, lockouts: [], planLimits: [],
  });
  const shifted = pickModelForPurpose({ ...base, purpose: 'scout', history: usedHistory });
  assert.equal(shifted.ok, true);
  assert.notEqual(shifted.pick.harness, used, 'tagged purpose uses feed the same rotation balance');
});

// ---------------------------------------------------------------------------
// Scenario 6 — cycle acceptance and cost
// ---------------------------------------------------------------------------

test('scenario 6: accepted-by-review needs a completed implement and every sibling PASS', () => {
  const accepted = buildDelegationQualityCycles({ rows: DELEGATION_ROWS.acceptedCycle });
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].closed, true);
  assert.equal(accepted[0].technicalSuccess, true);
  assert.equal(accepted[0].acceptedByReview, true);
  assert.equal(accepted[0].qualityOutcome, 'accepted-by-review');
  assert.deepEqual(accepted[0].reviewVerdicts, ['PASS']);
  assert.equal(accepted[0].wallTimeMs, 15 * MINUTE, 'sequential implement 09:00-09:10 + review 09:10-09:15');

  // A review FAIL is a quality verdict: the implement still succeeded, the
  // cycle is rejected by review, and it is not an infra run.
  const rejected = buildDelegationQualityCycles({ rows: DELEGATION_ROWS.rejectedCycle });
  assert.equal(rejected[0].technicalSuccess, true, 'a review FAIL does not lower technical success');
  assert.equal(rejected[0].acceptedByReview, false);
  assert.equal(rejected[0].qualityOutcome, 'rejected-by-review');
  assert.equal(rejected[0].runClass, 'quality');
  assert.ok(rejected[0].reviewVerdicts.includes('FAIL'));

  const twoPass = buildDelegationQualityCycles({ rows: CYCLE_ROWS.twoPass });
  assert.equal(twoPass[0].acceptedByReview, true, 'every sibling review must PASS');
  assert.deepEqual(twoPass[0].reviewVerdicts, ['PASS', 'PASS']);

  const mixed = buildDelegationQualityCycles({ rows: CYCLE_ROWS.mixed });
  assert.equal(mixed[0].technicalSuccess, true);
  assert.equal(mixed[0].acceptedByReview, false);
  assert.equal(mixed[0].qualityOutcome, 'rejected-by-review');

  const notCompleted = buildDelegationQualityCycles({ rows: CYCLE_ROWS.implementNotCompleted });
  assert.equal(notCompleted[0].technicalSuccess, false);
  assert.equal(notCompleted[0].acceptedByReview, false, 'a final implement that did not complete cannot be accepted');
});

test('scenario 6: infra/cancelled reviews stay undecided and set the run class', () => {
  const infra = buildDelegationQualityCycles({ rows: CYCLE_ROWS.reviewInfra });
  assert.equal(infra[0].unreviewed, false, 'a failed review ran, it is not "no review"');
  assert.equal(infra[0].acceptedByReview, false);
  assert.equal(infra[0].qualityOutcome, 'undecided');
  assert.equal(infra[0].runClass, 'infra');

  const cancelled = buildDelegationQualityCycles({ rows: CYCLE_ROWS.reviewCancelled });
  assert.equal(cancelled[0].acceptedByReview, false);
  assert.equal(cancelled[0].qualityOutcome, 'undecided');
  assert.equal(cancelled[0].runClass, 'cancel');
});

test('scenario 6: cost per accepted divides only priced closed usage; zero accepted is null', () => {
  const accepted = buildDelegationQualityCycles({ rows: DELEGATION_ROWS.acceptedCycle });
  const rejected = buildDelegationQualityCycles({ rows: DELEGATION_ROWS.rejectedCycle });
  const readUsageEvents = () => CYCLE_USAGE_EVENTS;

  const both = summarizeDelegationCycleCostMetrics([...accepted, ...rejected], {
    now: CUTOFF_MS,
    readUsageEvents,
  });
  assert.equal(both.acceptedCount, 1);
  assert.equal(both.rejectedCount, 1);
  assert.equal(both.closedCycleCount, 2);
  assert.equal(both.totalCostUsd, 3.5, '1.0 + 0.5 + 2.0 priced usage over the cohort');
  assert.equal(both.effectiveCostPerAcceptedUsd, 3.5, 'priced total / accepted cycles');
  assert.equal(both.denominators.pricedEvents, 3);
  assert.equal(both.denominators.totalEvents, 3);
  assert.equal(both.unknownUsageEventCount, 0);
  assert.equal(both.subscriptionUsageEventCount, 0);

  const rejectedOnly = summarizeDelegationCycleCostMetrics(rejected, { now: CUTOFF_MS, readUsageEvents });
  assert.equal(rejectedOnly.acceptedCount, 0);
  assert.equal(rejectedOnly.totalCostUsd, 2, 'priced usage stays visible without an accepted cycle');
  assert.equal(rejectedOnly.effectiveCostPerAcceptedUsd, null, 'accepted=0 yields null, never a fake zero');
});

test('scenario 6: unknown and subscription usage stay counts, never billed at API prices', () => {
  const rejected = buildDelegationQualityCycles({ rows: DELEGATION_ROWS.rejectedCycle });
  const events = Object.freeze([
    Object.freeze({ eventType: 'delta', delegationId: 'job-impl-bad', usd: 2.0, billingClass: 'api_metered' }),
    Object.freeze({ eventType: 'delta', delegationId: 'job-impl-bad', usd: 99.0, billingClass: 'unknown' }),
    Object.freeze({ eventType: 'delta', delegationId: 'job-impl-bad', usd: 55.0, billingClass: 'subscription_quota' }),
    Object.freeze({ eventType: 'delta', delegationId: 'job-impl-bad', usd: null }),
  ]);

  const metrics = summarizeDelegationCycleCostMetrics(rejected, {
    now: CUTOFF_MS,
    readUsageEvents: () => events,
  });
  assert.equal(metrics.totalCostUsd, 2.0, 'only the priced/metered event is billed');
  assert.equal(metrics.unknownUsageEventCount, 1);
  assert.equal(metrics.subscriptionUsageEventCount, 1);
  assert.equal(metrics.denominators.totalEvents, 4, 'unpriced usage stays visible in the denominator');
  assert.equal(metrics.denominators.pricedEvents, 1);
  assert.ok(Math.abs(metrics.pricedEventShare - 0.25) < 1e-9);
  assert.equal(metrics.effectiveCostPerAcceptedUsd, null);
});

test('scenario 6: unionWallMs counts overlapping reviews once, sequential adds durations', () => {
  const implement = { startedAt: at(-120), finishedAt: at(-110) };
  const reviewA = { startedAt: at(-118), finishedAt: at(-115) };
  const reviewB = { startedAt: at(-117), finishedAt: at(-116) };
  assert.equal(unionWallMs([implement, reviewA, reviewB]), 10 * MINUTE, 'two fully-overlapping reviews stay 10 minutes');
  assert.equal(unionWallMs([reviewA, implement, reviewB]), 10 * MINUTE, 'interval union is order independent');

  const sequentialImplement = { startedAt: at(-120), finishedAt: at(-110) };
  const sequentialReview = { startedAt: at(-110), finishedAt: at(-105) };
  assert.equal(
    unionWallMs([sequentialImplement, sequentialReview]),
    15 * MINUTE,
    'a sequential implement then review adds durations (10 + 5)'
  );

  const parallelCycle = buildDelegationQualityCycles({ rows: CYCLE_ROWS.parallelReviews });
  assert.equal(parallelCycle[0].wallTimeMs, 10 * MINUTE, 'the enriched cycle uses the same union');
  const sequentialCycle = buildDelegationQualityCycles({ rows: CYCLE_ROWS.sequential });
  assert.equal(sequentialCycle[0].wallTimeMs, 15 * MINUTE);
});
