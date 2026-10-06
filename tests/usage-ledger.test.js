import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import {
  recordUsage,
  summarizeUsage,
  summarizeUsageTimeseries,
} from '../lib/usage/usage-ledger.js';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import { aggregateAccountingScopes } from '../lib/usage/usage-contract.js';
import { readUsageEvents } from '../lib/persist/usage-persist.js';

test('records priced events to a daily jsonl file', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-'));
  const openai = recordUsage(
    {
      provider: 'openai',
      feature: 'voice-live',
      model: 'gpt-realtime-2.1',
      tokens: { audioInput: 1_000_000 },
      at: '2026-08-28T10:00:00.000Z',
    },
    { dataDir }
  );
  const google = recordUsage(
    {
      provider: 'google',
      feature: 'voice-live',
      model: 'gemini-3.1-flash-live-preview',
      tokens: { audioInput: 1_000_000 },
      at: '2026-08-28T11:00:00.000Z',
    },
    { dataDir }
  );
  assert.equal(openai.usd, 32);
  assert.ok(google.usd > 0 && google.usd < 10);
  const events = readUsageEvents({
    from: '2026-08-28',
    to: '2026-08-28',
    dataDir,
  });
  assert.equal(events.length, 2);
  const summary = summarizeUsage(events);
  assert.ok(summary.totalUsd > 32);
  assert.equal(summary.byProvider.openai.usd, 32);
  assert.equal(summary.byFeature['voice-live'].events, 2);
  assert.equal(summary.byDay['2026-08-28'].events, 2);
});

test('Cursor tokens count but do not become zero dollars', () => {
  const events = [
    {
      provider: 'cursor',
      feature: 'chat',
      usd: null,
      tokens: { textInput: 100, textOutput: 20, audioInput: 0, audioOutput: 0, cachedInput: 0, reasoning: 0 },
    },
    {
      provider: 'openai',
      feature: 'voice-tts',
      usd: 0.5,
      tokens: { textInput: 0, textOutput: 0, audioInput: 0, audioOutput: 0, cachedInput: 0, reasoning: 0 },
    },
  ];
  const summary = summarizeUsage(events);
  assert.equal(summary.totalUsd, 0.5);
  assert.equal(summary.unpricedEvents, 1);
  assert.equal(summary.tokens.textInput, 100);
});

test('new usage event fields are validated and defaulted', () => {
  const event = createUsageEvent({
    provider: 'openai',
    feature: 'chat',
    harness: 'claude',
    role: 'review',
    eventType: 'run',
    outcome: 'limit',
    errorCode: '  429 too many   ',
    latencyMs: 1234.6,
    ttftMs: -5,
    delegationId: 'del-1',
    attemptId: 'att-1',
  });
  assert.equal(event.harness, 'claude');
  assert.equal(event.role, 'review');
  assert.equal(event.eventType, 'run');
  assert.equal(event.outcome, 'limit');
  assert.equal(event.errorCode, '429 too many');
  assert.equal(event.latencyMs, 1235);
  assert.equal(event.ttftMs, undefined);
  assert.equal(event.delegationId, 'del-1');
  assert.equal(event.attemptId, 'att-1');

  const legacy = createUsageEvent({ provider: 'openai', feature: 'chat' });
  assert.equal(legacy.eventType, 'delta');
  assert.equal(legacy.harness, undefined);
  assert.equal(legacy.outcome, undefined);
});

test('run events never add tokens or dollars', () => {
  const deltaEvent = createUsageEvent({
    provider: 'openai',
    feature: 'chat',
    harness: 'codex',
    model: 'gpt-5-codex',
    role: 'implement',
    tokens: { textInput: 1_000_000, textOutput: 1_000_000 },
  });
  const pricedDelta = { ...deltaEvent, usd: 12, estimated: true };
  const runOk = createUsageEvent({
    harness: 'codex',
    model: 'gpt-5-codex',
    role: 'implement',
    eventType: 'run',
    outcome: 'ok',
    latencyMs: 100,
    tokens: { textInput: 999_999, textOutput: 999_999 },
  });
  const runError = createUsageEvent({
    harness: 'codex',
    model: 'gpt-5-codex',
    role: 'implement',
    eventType: 'run',
    outcome: 'error',
    errorCode: 'run_error',
    latencyMs: 300,
  });
  const runLimit = createUsageEvent({
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    role: 'chat',
    eventType: 'run',
    outcome: 'limit',
    latencyMs: 200,
  });
  const summary = summarizeUsage([pricedDelta, runOk, runError, runLimit]);
  // The delta is a rate-table estimate, so it stays in estimatedUsd only.
  assert.equal(summary.totalUsd, 0);
  assert.equal(summary.estimatedUsd, 12);
  assert.equal(summary.unpricedEvents, 0);
  assert.equal(summary.tokens.textInput, 1_000_000);
  assert.equal(summary.tokens.textOutput, 1_000_000);
  assert.equal(summary.runs, 3);
  assert.equal(summary.okRuns, 1);
  assert.equal(summary.errorRuns, 1);
  assert.equal(summary.limitHits, 1);
  assert.equal(summary.successRate, 0.3333);
  assert.equal(summary.errorRate, 0.3333);
  assert.equal(summary.p50LatencyMs, 200);
  assert.equal(summary.p95LatencyMs, 300);
  assert.equal(summary.byHarness.codex.runs, 2);
  assert.equal(summary.byHarness.codex.events, 1);
  assert.equal(summary.byModel['gpt-5-codex'].tokens.textInput, 1_000_000);
  assert.equal(summary.byRole.implement.runs, 2);
  assert.equal(summary.byRole.chat.runs, 1);
});

test('legacy events without harness fall back to the provider mapping', () => {
  const summary = summarizeUsage([
    { provider: 'cursor', model: 'composer-2', feature: 'chat', usd: null, tokens: { textInput: 10 } },
    { provider: 'openrouter', model: 'llama-3', feature: 'chat', usd: 1, tokens: { textInput: 20 } },
    { provider: 'openai', model: 'gpt-realtime', feature: 'voice-live', usd: 2, tokens: { audioInput: 30 } },
    { provider: 'mystery', feature: 'chat', usd: null, tokens: { textInput: 40 } },
  ]);
  assert.equal(summary.byHarness.sdk.events, 1);
  assert.equal(summary.byHarness.openrouter.events, 1);
  assert.equal(summary.byHarness.voice.events, 1);
  assert.equal(summary.byHarness.unknown.events, 1);
  assert.equal(summary.byModel['composer-2'].events, 1);
  assert.equal(summary.byModel.unknown.events, 1);
});

test('timeseries buckets by day/hour and grouping metric', () => {
  const events = [
    { at: '2026-08-28T10:15:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'delta', usd: null, tokens: { textInput: 100 } },
    { at: '2026-08-28T10:45:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'delta', usd: null, tokens: { textInput: 50 } },
    { at: '2026-08-29T09:00:00.000Z', provider: 'openai', harness: 'codex', model: 'gpt-5-codex', feature: 'chat', eventType: 'delta', usd: 3, tokens: { textInput: 10, textOutput: 5 } },
    { at: '2026-08-29T09:30:00.000Z', provider: 'openai', harness: 'codex', model: 'gpt-5-codex', feature: 'chat', eventType: 'run', outcome: 'ok', latencyMs: 50 },
  ];
  const byDay = summarizeUsageTimeseries(events, { bucket: 'day', groupBy: 'harness', metric: 'tokens' });
  assert.deepEqual(byDay.buckets, ['2026-08-28', '2026-08-29']);
  assert.deepEqual(byDay.series, [
    { group: 'codex', values: [0, 15] },
    { group: 'sdk', values: [150, 0] },
  ]);

  const byHour = summarizeUsageTimeseries(events, { bucket: 'hour', groupBy: 'model', metric: 'events' });
  assert.deepEqual(byHour.buckets, ['2026-08-28T10:00:00.000Z', '2026-08-29T09:00:00.000Z']);
  assert.equal(byHour.series.find((row) => row.group === 'composer-2').values[0], 2);

  const runs = summarizeUsageTimeseries(events, { bucket: 'day', groupBy: 'harness', metric: 'runs' });
  assert.deepEqual(runs.series, [
    { group: 'codex', values: [0, 1] },
    { group: 'sdk', values: [0, 0] },
  ]);

  const usd = summarizeUsageTimeseries(events, { bucket: 'day', groupBy: 'model', metric: 'usd' });
  assert.equal(usd.series.find((row) => row.group === 'gpt-5-codex').values[1], 3);
});

test('estimated USD is kept out of totalUsd and group usd', () => {
  const summary = summarizeUsage([
    { provider: 'openai', feature: 'chat', model: 'gpt', usd: 2, estimated: false, tokens: {} },
    { provider: 'other', harness: 'claude', feature: 'chat', model: 'claude-sonnet-4-5', usd: 3, estimated: true, tokens: {} },
  ]);
  assert.equal(summary.totalUsd, 2);
  assert.equal(summary.estimatedUsd, 3);
  assert.equal(summary.byProvider.openai.usd, 2);
  assert.equal(summary.byProvider.other.usd, 0);
  assert.equal(summary.byProvider.other.estimatedUsd, 3);
});

test('timeseries events metric ignores run events like summary does', () => {
  const events = [
    { at: '2026-08-28T10:00:00.000Z', provider: 'openai', harness: 'codex', model: 'gpt', feature: 'chat', eventType: 'delta', usd: 1, tokens: {} },
    { at: '2026-08-28T10:05:00.000Z', provider: 'openai', harness: 'codex', model: 'gpt', feature: 'chat', eventType: 'run', outcome: 'ok' },
  ];
  const summary = summarizeUsage(events);
  const series = summarizeUsageTimeseries(events, { bucket: 'day', groupBy: 'model', metric: 'events' });
  assert.equal(summary.byModel.gpt.events, 1);
  assert.equal(series.series.find((row) => row.group === 'gpt').values[0], 1);
});

test('usage events keep only known token keys and clamp huge values', () => {
  const event = createUsageEvent({
    provider: 'openai',
    feature: 'chat',
    tokens: { textInput: 9e15, evil: 5, audioOutput: -3 },
  });
  assert.deepEqual(
    Object.keys(event.tokens).sort(),
    ['audioInput', 'audioOutput', 'cacheWrite', 'cachedInput', 'reasoning', 'textInput', 'textOutput']
  );
  assert.equal(event.tokens.textInput, 1e10);
  assert.equal(event.tokens.evil, undefined);
  assert.equal(event.tokens.audioOutput, 0);
});

test('group rows carry p50/p95 latency from run events', () => {
  const events = [
    { at: '2026-08-28T10:00:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'delta', usd: null, tokens: { textInput: 10 } },
    { at: '2026-08-28T10:01:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'run', outcome: 'ok', latencyMs: 100 },
    { at: '2026-08-28T10:02:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'run', outcome: 'ok', latencyMs: 200 },
    { at: '2026-08-28T10:03:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'run', outcome: 'error', latencyMs: 900 },
    { at: '2026-08-28T10:04:00.000Z', provider: 'openai', harness: 'codex', model: 'gpt-5-codex', feature: 'chat', eventType: 'run', outcome: 'ok', latencyMs: 50 },
    { at: '2026-08-28T10:05:00.000Z', provider: 'openai', harness: 'codex', model: 'delta-only', feature: 'chat', eventType: 'delta', usd: 1, tokens: { textInput: 5 } },
  ];
  const summary = summarizeUsage(events);
  assert.equal(summary.byHarness.sdk.p50LatencyMs, 200);
  assert.equal(summary.byHarness.sdk.p95LatencyMs, 900);
  assert.equal(summary.byModel['composer-2'].p50LatencyMs, 200);
  assert.equal(summary.byModel['composer-2'].p95LatencyMs, 900);
  assert.equal(summary.byModel['gpt-5-codex'].p95LatencyMs, 50);
  // A delta-only model has no run samples, so it stays null instead of zero.
  assert.equal(summary.byModel['delta-only'].p95LatencyMs, null);
  assert.equal(summary.byModel['composer-2'].harness, 'sdk');
  assert.deepEqual(summary.byModel['composer-2'].harnesses, ['sdk']);
  assert.equal(summary.byHarness.sdk.harness, 'sdk');
  assert.equal(summary.byDay['2026-08-28'].p95LatencyMs, 900);
});

test('summary derives disjoint tokens so cache and reasoning are not double counted', () => {
  const summary = summarizeUsage([
    {
      provider: 'openai',
      harness: 'codex',
      model: 'gpt-5-codex',
      feature: 'chat',
      usd: null,
      tokens: { textInput: 600, cachedInput: 400, textOutput: 250, reasoning: 30 },
    },
    {
      provider: 'other',
      harness: 'claude',
      model: 'claude-sonnet-4-5',
      feature: 'chat',
      usd: null,
      tokens: { textInput: 100, cachedInput: 900, cacheWrite: 50, textOutput: 20 },
    },
  ]);
  // codex: 600 uncached + 400 cache-read + (250 - 30) output + 30 reasoning
  // claude: 100 uncached + 900 cache-read + 50 cache-write + 20 output
  assert.equal(summary.tokens.textInput, 700);
  assert.equal(summary.tokens.cachedInput, 1300);
  assert.equal(summary.tokens.cacheWrite, 50);
  assert.equal(summary.tokens.textOutput, 240, 'reasoning is subtracted from the codex output bucket');
  assert.equal(summary.tokens.reasoning, 30);
  const additive = Object.values(summary.tokens).reduce((sum, value) => sum + value, 0);
  assert.equal(additive, 2320, '1250 codex + 1070 claude');
});

test('summary keeps OpenRouter cache disjoint from prompt tokens', () => {
  const summary = summarizeUsage([
    {
      provider: 'openrouter',
      harness: 'openrouter',
      model: 'llama-3',
      feature: 'chat',
      usd: null,
      tokens: { textInput: 600, cachedInput: 400, textOutput: 20 },
    },
  ]);
  assert.equal(summary.tokens.textInput, 600);
  assert.equal(summary.tokens.cachedInput, 400);
  assert.equal(summary.tokens.textOutput, 20);
});

test('own and consolidated scopes are subtotaled separately and flagged mixed', () => {
  const events = [
    {
      at: '2026-08-28T10:00:00.000Z',
      provider: 'other',
      harness: 'deepseek',
      model: 'deepseek-flash',
      feature: 'chat',
      usd: null,
      accountingScope: 'own',
      tokens: { textInput: 100, cachedInput: 20, textOutput: 10 },
    },
    {
      at: '2026-08-28T10:01:00.000Z',
      provider: 'other',
      harness: 'deepseek',
      model: 'deepseek-flash',
      feature: 'chat',
      usd: 2,
      accountingScope: 'consolidated',
      tokens: { textInput: 40, cachedInput: 5, textOutput: 5 },
    },
  ];
  const summary = summarizeUsage(events);

  // The default top-level view is `own`: the child delta must not leak in.
  assert.equal(summary.tokens.textInput, 100);
  assert.equal(summary.tokens.cachedInput, 20);
  assert.equal(summary.tokens.textOutput, 10);
  assert.equal(summary.tokensByScope.own.textInput, 100);
  assert.equal(summary.tokensByScope.consolidated.textInput, 40);
  assert.equal(summary.tokensByScope.consolidated.cachedInput, 5);
  assert.equal(summary.totalUsd, 0, 'consolidated usd is not own usd');
  assert.equal(summary.usdByScope.consolidated, 2);
  assert.equal(summary.eventsByScope.own, 1);
  assert.equal(summary.eventsByScope.consolidated, 1);
  assert.equal(summary.mixed, true, 'both scopes present must be flagged');

  // Group rows carry the same split, so a UI row cannot add the scopes either.
  const row = summary.byModel['deepseek-flash'];
  assert.equal(row.tokens.textInput, 100);
  assert.equal(row.tokensByScope.consolidated.textInput, 40);
  assert.equal(row.usd, 0);
  assert.equal(row.usdByScope.consolidated, 2);
  assert.equal(row.events, 1, 'group event count is the own view');
  assert.equal(row.eventsByScope.consolidated, 1);
  assert.equal(row.mixed, true);
});

test('a single-scope summary stays unmixed and equals its own subtotal', () => {
  const ownOnly = summarizeUsage([
    { provider: 'other', harness: 'deepseek', model: 'deepseek-flash', feature: 'chat', usd: null, accountingScope: 'own', tokens: { textInput: 7 } },
  ]);
  assert.equal(ownOnly.mixed, false);
  assert.equal(ownOnly.tokens.textInput, 7);
  assert.equal(ownOnly.tokensByScope.consolidated.textInput, 0);

  const consolidatedOnly = summarizeUsage([
    { provider: 'other', harness: 'deepseek', model: 'deepseek-flash', feature: 'chat', usd: null, accountingScope: 'consolidated', tokens: { textInput: 9 } },
  ]);
  assert.equal(consolidatedOnly.mixed, false);
  assert.equal(consolidatedOnly.tokens.textInput, 0, 'the own default view ignores consolidated-only data');
  assert.equal(consolidatedOnly.tokensByScope.consolidated.textInput, 9);
});

test('ledger scope subtotals agree with the contract aggregator', () => {
  const events = [
    { provider: 'other', harness: 'deepseek', model: 'm', feature: 'chat', usd: null, accountingScope: 'own', tokens: { textInput: 100, cachedInput: 20, textOutput: 10 } },
    { provider: 'other', harness: 'deepseek', model: 'm', feature: 'chat', usd: null, accountingScope: 'consolidated', tokens: { textInput: 40, cachedInput: 5, textOutput: 5 } },
  ];
  const summary = summarizeUsage(events);
  const aggregate = aggregateAccountingScopes(
    events.map((event) => ({ scope: event.accountingScope, harness: event.harness, tokens: event.tokens }))
  );
  assert.equal(summary.tokensByScope.own.textInput, aggregate.own.inputWithoutCache);
  assert.equal(summary.tokensByScope.own.cachedInput, aggregate.own.cacheRead);
  assert.equal(summary.tokensByScope.own.textOutput, aggregate.own.outputWithoutReasoning);
  assert.equal(summary.tokensByScope.consolidated.textInput, aggregate.consolidated.inputWithoutCache);
  assert.equal(summary.mixed, aggregate.mixed);
});

test('timeseries token series stay inside one accounting scope', () => {
  const events = [
    { at: '2026-08-28T10:00:00.000Z', provider: 'other', harness: 'deepseek', model: 'deepseek-flash', feature: 'chat', eventType: 'delta', usd: null, accountingScope: 'own', tokens: { textInput: 100 } },
    { at: '2026-08-28T10:01:00.000Z', provider: 'other', harness: 'deepseek', model: 'deepseek-flash', feature: 'chat', eventType: 'delta', usd: null, accountingScope: 'consolidated', tokens: { textInput: 40 } },
    { at: '2026-08-28T10:02:00.000Z', provider: 'other', harness: 'deepseek', model: 'child-only-model', feature: 'chat', eventType: 'delta', usd: null, accountingScope: 'consolidated', tokens: { textInput: 9 } },
  ];
  const own = summarizeUsageTimeseries(events, { bucket: 'day', groupBy: 'model', metric: 'tokens' });
  assert.equal(own.scope, 'own');
  assert.equal(own.series.find((row) => row.group === 'deepseek-flash').values[0], 100);
  assert.equal(
    own.series.some((row) => row.group === 'child-only-model'),
    false,
    'a consolidated-only group is not an all-zero own series'
  );

  const consolidated = summarizeUsageTimeseries(events, {
    bucket: 'day',
    groupBy: 'model',
    metric: 'tokens',
    scope: 'consolidated',
  });
  assert.equal(consolidated.scope, 'consolidated');
  assert.equal(consolidated.series.find((row) => row.group === 'deepseek-flash').values[0], 40);
  assert.equal(consolidated.series.find((row) => row.group === 'child-only-model').values[0], 9);
});

test('byModel rows expose the dominant harness and the ranked harness list', () => {
  const summary = summarizeUsage([
    { provider: 'other', harness: 'claude', model: 'shared-model', feature: 'chat', usd: null, tokens: { textInput: 1 } },
    { provider: 'other', harness: 'codex', model: 'shared-model', feature: 'chat', usd: null, tokens: { textInput: 1 } },
    { provider: 'other', harness: 'codex', model: 'shared-model', feature: 'chat', usd: null, tokens: { textInput: 1 } },
  ]);
  assert.equal(summary.byModel['shared-model'].harness, 'codex');
  assert.deepEqual(summary.byModel['shared-model'].harnesses, ['codex', 'claude']);
  assert.equal(summary.byHarness.claude.harness, 'claude');
});

test('timeseries fills missing buckets inside the requested from..to range', () => {
  const events = [
    { at: '2026-08-28T10:15:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'delta', usd: null, tokens: { textInput: 100 } },
    { at: '2026-08-31T10:45:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'delta', usd: null, tokens: { textInput: 50 } },
  ];
  const filled = summarizeUsageTimeseries(events, {
    bucket: 'day',
    groupBy: 'model',
    metric: 'tokens',
    from: '2026-08-28',
    to: '2026-08-31',
  });
  assert.deepEqual(filled.buckets, ['2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']);
  assert.deepEqual(filled.series, [{ group: 'composer-2', values: [100, 0, 0, 50] }]);

  const hourly = summarizeUsageTimeseries(
    [{ at: '2026-08-28T10:15:00.000Z', provider: 'cursor', harness: 'sdk', model: 'composer-2', feature: 'chat', eventType: 'delta', usd: null, tokens: { textInput: 5 } }],
    { bucket: 'hour', groupBy: 'model', metric: 'tokens', from: '2026-08-28', to: '2026-08-28' }
  );
  assert.equal(hourly.buckets.length, 24);
  assert.equal(hourly.buckets[0], '2026-08-28T00:00:00.000Z');
  assert.equal(hourly.buckets[10], '2026-08-28T10:00:00.000Z');
  assert.equal(hourly.series[0].values[9], 0);
  assert.equal(hourly.series[0].values[10], 5);
});
