/**
 * Stage-9 acceptance/conformance suite, scenarios 1-3.
 *
 * One frozen cutoff (`ACCEPTANCE_CUTOFF`) anchors every assertion. Scenarios
 * 4-6 live in `usage-acceptance-decisions.test.js`, 7-10 in
 * `usage-acceptance-policy.test.js`.
 *
 * Scenario 1: stamp/versions + production Claude resolved / CodeBuddy raw +
 *             cache-write/OpenRouter cache/reasoning + ledger/UI summation.
 * Scenario 2: dedup/replay/restart, provider vs durable_sequence vs none,
 *             concurrent writers, crash before the index, torn journal tail.
 * Scenario 3: snapshot/out-of-order/reset/context epoch, new run, late usage
 *             before/after the horizon, active-run retention across midnight.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ACCEPTANCE_CUTOFF,
  ACCEPTANCE_DAY,
  EXPECTED_DISJOINT,
  PROVIDER_PAYLOADS,
} from './helpers/usage-acceptance-fixture.js';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import {
  USAGE_NORMALIZATION_VERSION,
  USAGE_SCHEMA_VERSION,
  billedTotalTokens,
  partitionUsageTokens,
  promptTokensForWindow,
  resolveUsageCompleteness,
  resolveUsageLifecycle,
  resolveUsageProvenance,
} from '../lib/usage/usage-contract.js';
import { resolveHarnessUsageShape } from '../lib/usage/usage-normalize.js';
import {
  resolveHarnessEventIdentity,
  resolveHarnessUsageTokens,
} from '../lib/usage/harness-usage.js';
import { summarizeUsage } from '../lib/usage/usage-ledger.js';
import { sumUsageTokenBuckets } from '../lib/usage/usage-insights.js';
import {
  commitRunStart,
  commitUsageEvent,
  deriveRunKey,
  readUsageEvents,
  readUsageLedgerState,
  resetUsageLedgerCache,
  usageDayPath,
} from '../lib/persist/usage-persist.js';

const CUTOFF_AT = ACCEPTANCE_CUTOFF;

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'cretli-acceptance-'));
}

/**
 * Builds one production usage event from a frozen provider payload.
 *
 * @param {string} harness
 * @param {object} identity
 * @returns {object}
 */
function eventFromPayload(harness, identity) {
  const payload = PROVIDER_PAYLOADS[harness];
  const tokens = resolveHarnessUsageTokens(harness, { usage: payload.usage });
  const eventIdentity = resolveHarnessEventIdentity(harness, { usage: payload.usage, identity });
  return createUsageEvent({
    harness,
    provider: harness === 'openrouter' ? 'openrouter' : 'other',
    role: 'implement',
    model: `${harness}-model`,
    at: CUTOFF_AT,
    runId: `run-${harness}-accept`,
    sourceSessionId: `sess-${harness}-accept`,
    tokens,
    ...eventIdentity,
  });
}

test('scenario 1: versions/cache/reasoning survive the production adapter boundary', () => {
  // Adapter boundary: Claude is resolved, CodeBuddy raw (never double-normalized).
  assert.equal(resolveHarnessUsageShape('claude'), 'resolved');
  assert.equal(resolveHarnessUsageShape('codebuddy'), 'raw');

  const identities = {
    claude: { requestId: 'req-claude-1', messageId: 'msg-claude-1' },
    codebuddy: { requestId: 'req-codebuddy-1', messageId: 'msg-codebuddy-1' },
    openrouter: { providerEventId: 'or-event-1' },
    deepseek: { messageId: 'ds-message-1' },
  };
  const events = [];
  for (const harness of Object.keys(PROVIDER_PAYLOADS)) {
    const event = eventFromPayload(harness, identities[harness]);
    events.push(event);
    const expected = EXPECTED_DISJOINT[harness];
    assert.deepEqual(
      {
        textInput: event.tokens.textInput,
        textOutput: event.tokens.textOutput,
        cachedInput: event.tokens.cachedInput,
        cacheWrite: event.tokens.cacheWrite,
        reasoning: event.tokens.reasoning,
      },
      expected,
      `${harness} disjoint token bag`
    );
  }

  // Version stamps and provenance are present on the first new event.
  for (const event of events) {
    assert.equal(event.schemaVersion, USAGE_SCHEMA_VERSION, `${event.harness} schemaVersion`);
    assert.equal(event.normalizationVersion, USAGE_NORMALIZATION_VERSION, `${event.harness} normalizationVersion`);
    assert.ok(event.contractRevision, `${event.harness} contractRevision`);
    assert.equal(event.provenance, 'reported');
    assert.equal(resolveUsageProvenance(event), 'reported');
    // A token delta keeps the run running; only a run event ends it.
    assert.equal(resolveUsageLifecycle(event), 'running');
  }

  // OpenRouter is provider-identified; the others use a durable sequence.
  assert.equal(events[2].identityClass, 'provider');
  assert.equal(events[0].identityClass, 'durable_sequence');
  assert.ok(events[0].logicalEventKey);
  assert.equal(events[0].lifecycle, 'running');

  // Cache read/write and reasoning stay disjoint and additive.
  const claudeBuckets = partitionUsageTokens(events[0].tokens, 'claude');
  assert.equal(claudeBuckets.inputWithoutCache, 100);
  assert.equal(claudeBuckets.cacheRead, 900);
  assert.equal(claudeBuckets.cacheWrite, 50);
  assert.equal(claudeBuckets.outputWithoutReasoning, 20);
  assert.equal(billedTotalTokens(events[0].tokens, 'claude'), 1070);
  // Context window still includes cache; billed total and window differ.
  assert.equal(promptTokensForWindow(events[0].tokens, 'claude'), 1050);
  assert.notEqual(promptTokensForWindow(events[0].tokens, 'claude'), billedTotalTokens(events[0].tokens, 'claude'));

  // DeepSeek reasoning is a subset of output: additive, not double-counted.
  const deepseekBuckets = partitionUsageTokens(events[3].tokens, 'deepseek');
  assert.equal(deepseekBuckets.outputWithoutReasoning, 30);
  assert.equal(deepseekBuckets.reasoning, 20);
  assert.equal(deepseekBuckets.reasoningDiagnostic, false);
  assert.equal(billedTotalTokens(events[3].tokens, 'deepseek'), 900 + 100 + 30 + 20);

  // Ledger read-model agrees with the UI bucket aggregator on disjoint sums.
  const summary = summarizeUsage(events);
  const uiBuckets = sumUsageTokenBuckets(events);
  const expectedInput = 100 + 900 + 600 + 900;
  const expectedCacheRead = 900 + 400 + 400 + 100;
  const expectedCacheWrite = 50 + 50;
  const expectedOutput = 20 + 20 + 20 + 30;
  const expectedReasoning = 20;
  assert.equal(summary.tokens.textInput, expectedInput, 'cache never folded into input');
  assert.equal(summary.tokens.cachedInput, expectedCacheRead);
  assert.equal(summary.tokens.cacheWrite, expectedCacheWrite);
  assert.equal(summary.tokens.textOutput, expectedOutput);
  assert.equal(summary.tokens.reasoning, expectedReasoning);
  assert.equal(uiBuckets.inputWithoutCache, expectedInput);
  assert.equal(uiBuckets.cacheRead, expectedCacheRead);
  assert.equal(uiBuckets.cacheWrite, expectedCacheWrite);
  assert.equal(uiBuckets.outputWithoutReasoning, expectedOutput);
  assert.equal(uiBuckets.reasoning, expectedReasoning);
  assert.equal(uiBuckets.totalTokens, expectedInput + expectedCacheRead + expectedCacheWrite + expectedOutput + expectedReasoning);
  assert.equal(summary.eventsByScope.own, events.length, 'no scope mixing on a plain cohort');
  assert.equal(summary.mixed, false);
});

test('scenario 2: dedup/replay/restart, identity classes, crash and torn tail', async () => {
  const dataDir = tempDir();

  // A durable identity is committed exactly once and survives a cache reset.
  const durable = createUsageEvent({
    harness: 'claude',
    provider: 'other',
    runId: 'run-dedup',
    sourceSessionId: 'sess-dedup',
    requestId: 'req-dedup',
    tokens: { textInput: 100, textOutput: 10 },
    at: CUTOFF_AT,
  });
  assert.equal(durable.identityClass, 'durable_sequence');
  assert.equal(commitUsageEvent(durable, { dataDir }).status, 'committed');
  resetUsageLedgerCache(dataDir);
  assert.equal(commitUsageEvent(durable, { dataDir }).status, 'duplicate');
  assert.equal(
    summarizeUsage(readUsageEvents({ from: ACCEPTANCE_DAY, to: ACCEPTANCE_DAY, dataDir })).tokens.textInput,
    100
  );

  // Two genuinely distinct requests with identical counters and time are both
  // real usage: identity, not the numbers, decides.
  const requestA = createUsageEvent({
    harness: 'claude',
    provider: 'other',
    runId: 'run-two',
    sourceSessionId: 'sess-two',
    requestId: 'req-two-a',
    tokens: { textInput: 40 },
    at: CUTOFF_AT,
  });
  const requestB = createUsageEvent({
    harness: 'claude',
    provider: 'other',
    runId: 'run-two',
    sourceSessionId: 'sess-two',
    requestId: 'req-two-b',
    tokens: { textInput: 40 },
    at: CUTOFF_AT,
  });
  assert.notEqual(requestA.logicalEventKey, requestB.logicalEventKey);
  assert.equal(commitUsageEvent(requestA, { dataDir }).status, 'committed');
  assert.equal(commitUsageEvent(requestB, { dataDir }).status, 'committed');

  // A provider event id dedups too.
  const providerEvent = createUsageEvent({
    harness: 'openrouter',
    provider: 'openrouter',
    providerEventId: 'or-dedup-1',
    tokens: { textInput: 5 },
    at: CUTOFF_AT,
  });
  assert.equal(providerEvent.identityClass, 'provider');
  assert.ok(providerEvent.logicalEventKey, 'a provider event id derives a dedup key');
  assert.equal(commitUsageEvent(providerEvent, { dataDir }).status, 'committed');
  assert.equal(commitUsageEvent(providerEvent, { dataDir }).status, 'duplicate');

  // No reproducible identity is never deduped by numbers.
  const anonymous = createUsageEvent({
    harness: 'other',
    provider: 'other',
    tokens: { textInput: 7 },
    at: CUTOFF_AT,
  });
  assert.equal(anonymous.identityClass, 'none');
  assert.equal(anonymous.logicalEventKey, null);
  assert.equal(commitUsageEvent(anonymous, { dataDir }).status, 'committed');
  assert.equal(commitUsageEvent(anonymous, { dataDir }).status, 'committed');

  // Crash after the journal append, before the index write: the next read
  // rebuilds from the journal and the same identity is a duplicate again.
  const crashDir = tempDir();
  const crashEvent = createUsageEvent({
    harness: 'deepseek',
    provider: 'other',
    runId: 'run-crash',
    sourceSessionId: 'sess-crash',
    messageId: 'msg-crash',
    tokens: { textInput: 7 },
    at: CUTOFF_AT,
  });
  assert.equal(commitUsageEvent(crashEvent, { dataDir: crashDir, persistIndex: false }).status, 'committed');
  assert.equal(readUsageEvents({ from: ACCEPTANCE_DAY, to: ACCEPTANCE_DAY, dataDir: crashDir }).length, 1);
  resetUsageLedgerCache(crashDir);
  assert.equal(readUsageLedgerState({ dataDir: crashDir }).keyCount, 1, 'index recovered from the journal');
  assert.equal(commitUsageEvent(crashEvent, { dataDir: crashDir }).status, 'duplicate');

  // An incomplete last journal line is corrupt, not committed.
  const tornDir = tempDir();
  commitRunStart({ harness: 'codex', runId: 'run-torn', at: `${ACCEPTANCE_DAY}T09:59:00.000Z` }, { dataDir: tornDir });
  const tornFile = usageDayPath(tornDir, ACCEPTANCE_DAY);
  // Torn write: append half an envelope, no terminating newline.
  writeFileSync(
    tornFile,
    `${readFileSync(tornFile, 'utf8')}{"v":1,"seq":999,"kind":"usage","at":"2026-10-10T10:01:00.000Z","event":{`,
    'utf8'
  );
  resetUsageLedgerCache(tornDir);
  assert.equal(readUsageEvents({ from: ACCEPTANCE_DAY, to: ACCEPTANCE_DAY, dataDir: tornDir }).length, 0);
  assert.ok(readUsageLedgerState({ dataDir: tornDir }).diagnostics.corrupt >= 1);

  // Cross-process concurrent writers commit one logical key exactly once.
  const concDir = tempDir();
  const moduleUrl = pathToFileURL(path.resolve('lib/persist/usage-persist.js')).href;
  const eventUrl = pathToFileURL(path.resolve('lib/usage/usage-event.js')).href;
  const worker = `
    import { commitUsageEvent } from ${JSON.stringify(moduleUrl)};
    import { createUsageEvent } from ${JSON.stringify(eventUrl)};
    const event = createUsageEvent({
      harness: 'claude', provider: 'other', runId: 'run-conc', sourceSessionId: 'sess-conc',
      requestId: 'req-conc', tokens: { textInput: 10 }, at: '${CUTOFF_AT}',
    });
    const result = commitUsageEvent(event, { dataDir: process.env.LEDGER_TEST_DIR });
    process.stdout.write(result.status);
  `;
  const statuses = await Promise.all(
    Array.from({ length: 4 }, () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
          env: { ...process.env, LEDGER_TEST_DIR: concDir },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk;
        });
        child.on('close', () => resolve(out));
      })
    )
  );
  assert.equal(statuses.filter((status) => status === 'committed').length, 1);
  assert.equal(statuses.filter((status) => status === 'duplicate').length, 3);
  assert.equal(readUsageEvents({ from: ACCEPTANCE_DAY, to: ACCEPTANCE_DAY, dataDir: concDir }).length, 1);
});

test('scenario 3: snapshots/reset/late usage and active-run retention across midnight', () => {
  const dataDir = tempDir();
  const baselineKey = JSON.stringify(['baseline', 'sdk', 'run-snap', '', 'sess-snap', '', '']);
  const snapshot = (input, at) => createUsageEvent({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-snap',
    sourceSessionId: 'sess-snap',
    tokens: { textInput: input },
    at,
  });
  const hints = (input) => ({ baselineKey, snapshotTokens: { textInput: input } });

  assert.equal(
    commitUsageEvent(snapshot(100, `${ACCEPTANCE_DAY}T10:00:00.000Z`), { dataDir }, hints(100)).status,
    'committed'
  );
  // Restart: the committed baseline is reloaded and the next cumulative
  // snapshot is diffed instead of counted from scratch.
  resetUsageLedgerCache(dataDir);
  const second = commitUsageEvent(snapshot(140, `${ACCEPTANCE_DAY}T10:01:00.000Z`), { dataDir }, hints(140));
  assert.equal(second.status, 'committed');
  assert.equal(second.event.tokens.textInput, 40);
  // An out-of-order older snapshot must not roll the baseline back.
  const stale = commitUsageEvent(snapshot(90, `${ACCEPTANCE_DAY}T10:02:00.000Z`), { dataDir }, hints(90));
  assert.equal(stale.status, 'empty');
  assert.deepEqual(
    readUsageEvents({ from: ACCEPTANCE_DAY, to: ACCEPTANCE_DAY, dataDir }).map((row) => row.tokens.textInput),
    [100, 40]
  );

  // A new run (new runId) or a new context epoch resets the snapshot baseline.
  const runBKey = JSON.stringify(['baseline', 'sdk', 'run-snap-b', '', 'sess-snap', '', '']);
  const runB = createUsageEvent({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-snap-b',
    sourceSessionId: 'sess-snap',
    tokens: { textInput: 800 },
    at: `${ACCEPTANCE_DAY}T10:05:00.000Z`,
  });
  const runBResult = commitUsageEvent(runB, { dataDir }, { baselineKey: runBKey, snapshotTokens: { textInput: 800 } });
  assert.equal(runBResult.status, 'committed');
  assert.equal(runBResult.event.tokens.textInput, 800, 'a new run does not subtract the old run');

  // A run that starts before midnight and is measured after it keeps one run.
  const nightDir = tempDir();
  const nightKey = deriveRunKey({ harness: 'sdk', runId: 'run-night' });
  commitRunStart(
    { harness: 'sdk', runId: 'run-night', runKey: nightKey, at: '2026-10-09T23:50:00.000Z' },
    { dataDir: nightDir }
  );
  commitUsageEvent(
    createUsageEvent({
      harness: 'sdk',
      provider: 'cursor',
      runId: 'run-night',
      tokens: { textInput: 20 },
      at: '2026-10-10T00:10:00.000Z',
    }),
    { dataDir: nightDir, now: Date.parse('2026-10-10T01:00:00.000Z') }
  );
  const nightState = readUsageLedgerState({ dataDir: nightDir });
  assert.equal(nightState.activeRuns, 1, 'the active run spans midnight as one run');
  assert.equal(nightState.endedRuns, 0);
  assert.equal(readUsageEvents({ from: '2026-10-09', to: '2026-10-10', dataDir: nightDir }).length, 1);

  // Late usage inside the 24 h grace corrects coverage without adding a run.
  const lateDir = tempDir();
  const runKey = deriveRunKey({ harness: 'sdk', runId: 'run-late' });
  commitRunStart({ harness: 'sdk', runId: 'run-late', runKey, at: `${ACCEPTANCE_DAY}T10:00:00.000Z` }, { dataDir: lateDir });
  commitUsageEvent(
    createUsageEvent({
      harness: 'sdk',
      provider: 'cursor',
      eventType: 'run',
      outcome: 'ok',
      runId: 'run-late',
      at: `${ACCEPTANCE_DAY}T10:05:00.000Z`,
      coverage: { proof: false, expectedRequests: 1, coveredRequests: 1, scope: 'own' },
    }),
    { dataDir: lateDir }
  );
  assert.equal(readUsageLedgerState({ dataDir: lateDir }).endedRuns, 1);
  const late = createUsageEvent({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-late',
    tokens: { textInput: 50 },
    final: true,
    at: `${ACCEPTANCE_DAY}T11:00:00.000Z`,
  });
  const lateResult = commitUsageEvent(
    late,
    { dataDir: lateDir, now: Date.parse(`${ACCEPTANCE_DAY}T12:00:00.000Z`) },
    { final: true }
  );
  assert.equal(lateResult.status, 'committed');
  const afterLate = readUsageLedgerState({ dataDir: lateDir });
  const lateRun = afterLate.runs.find((run) => run.runId === 'run-late');
  assert.equal(afterLate.endedRuns, 1, 'a late measurement never adds a run');
  assert.equal(lateRun.coverage.proof, true);
  assert.equal(lateRun.coverage.completeness, 'complete');

  // A measurement past the 24 h horizon is a stale diagnostic, not a re-count.
  const staleDir = tempDir();
  const staleKey = deriveRunKey({ harness: 'sdk', runId: 'run-stale' });
  commitRunStart({ harness: 'sdk', runId: 'run-stale', runKey: staleKey, at: '2026-10-01T10:00:00.000Z' }, { dataDir: staleDir });
  commitUsageEvent(
    createUsageEvent({
      harness: 'sdk',
      provider: 'cursor',
      eventType: 'run',
      outcome: 'ok',
      runId: 'run-stale',
      at: '2026-10-01T10:05:00.000Z',
    }),
    { dataDir: staleDir }
  );
  const staleLate = createUsageEvent({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-stale',
    tokens: { textInput: 999 },
    at: '2026-10-03T10:00:00.000Z',
  });
  const staleResult = commitUsageEvent(
    staleLate,
    { dataDir: staleDir, now: Date.parse('2026-10-03T12:00:00.000Z') }
  );
  assert.equal(staleResult.stale, true);
  assert.equal(
    readUsageEvents({ from: '2026-10-01', to: '2026-10-03', dataDir: staleDir }).length,
    1,
    'stale usage stays out of the normal aggregates'
  );
  assert.equal(readUsageLedgerState({ dataDir: staleDir }).diagnostics.stale, 1);

  // Completeness never conflates "running" with "ended".
  assert.equal(resolveUsageCompleteness({ lifecycle: 'running', measurementPresent: true }), 'partial');
  assert.equal(resolveUsageCompleteness({ lifecycle: 'ended', measurementPresent: false }), 'missing');
  assert.equal(resolveUsageCompleteness({ supported: false }), 'unsupported');
});
