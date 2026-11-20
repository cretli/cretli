import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageEvent, emptyUsageTokens } from '../lib/usage/usage-event.js';
import {
  USAGE_COMPLETENESS,
  USAGE_CONTRACT_REVISION,
  USAGE_FINAL_USAGE_GRACE_MS,
  USAGE_HARNESS_MATRIX,
  USAGE_IDENTITY_CLASSES,
  USAGE_MATRIX_HARNESSES,
  USAGE_NORMALIZATION_VERSION,
  USAGE_SCHEMA_VERSION,
  additiveTokenTotal,
  aggregateAccountingScopes,
  applyUsageCoverageCorrection,
  billedTotalTokens,
  buildLogicalUsageIdentity,
  buildUsageContractFields,
  canAwaitFinalUsage,
  containsConversationContent,
  describeUsageContract,
  partitionUsageTokens,
  promptTokensForWindow,
  resolveChildUsageModel,
  resolveUsageCompleteness,
  resolveUsageContract,
  resolveUsageLifecycle,
  resolveUsageProvenance,
  resolveWindowSemantics,
} from '../lib/usage/usage-contract.js';
import {
  resolveHarnessReasoningRelation,
  resolveHarnessUsageShape,
} from '../lib/usage/usage-normalize.js';
import { recordHarnessUsageDelta, resolveHarnessUsageTokens } from '../lib/usage/harness-usage.ts';
import {
  buildOpenCodeUsageSdkEvent,
  readOpenCodeTokenSnapshot,
  resolveOpenCodeUsageFromStreamEvent,
} from '../harnesses/opencode/opencode-usage.js';

const REQUIRED_MATRIX_FIELDS = [
  'usageShape',
  'measurementKind',
  'granularity',
  'payloadInputIncludesCache',
  'reasoningRelation',
  'cacheRead',
  'cacheWrite',
  'defaultIdentityClass',
  'identityFields',
  'source',
  'example',
];

test('matrix covers all eleven harnesses with the required contract fields', () => {
  assert.deepEqual([...USAGE_MATRIX_HARNESSES].sort(), [
    'claude',
    'codebuddy',
    'codex',
    'deepseek',
    'mimo',
    'mistral',
    'opencode',
    'openrouter',
    'qwen',
    'sdk',
    'zai',
  ]);
  for (const harness of USAGE_MATRIX_HARNESSES) {
    const entry = USAGE_HARNESS_MATRIX[harness];
    assert.ok(entry, `${harness} has a matrix entry`);
    assert.equal(entry.harness, harness);
    assert.equal(entry.supported, true, `${harness} is supported`);
    for (const field of REQUIRED_MATRIX_FIELDS) {
      assert.notEqual(entry[field], undefined, `${harness}.${field}`);
    }
    assert.ok(['raw', 'resolved'].includes(entry.usageShape), `${harness} usageShape`);
    assert.ok(
      ['delta', 'snapshot', 'cumulative'].includes(entry.measurementKind),
      `${harness} measurementKind`
    );
    assert.ok(
      ['request', 'message', 'turn', 'run', 'session'].includes(entry.granularity),
      `${harness} granularity`
    );
    assert.ok(
      ['subset_of_output', 'separate', 'unknown'].includes(entry.reasoningRelation),
      `${harness} reasoningRelation`
    );
    assert.ok(USAGE_IDENTITY_CLASSES.includes(entry.defaultIdentityClass), `${harness} identityClass`);
    assert.match(String(entry.source), /(lib|harnesses)\//, `${harness} contract source`);
    assert.ok(entry.identityFields.length > 0, `${harness} identity fields`);
    assert.equal(
      containsConversationContent(entry.example),
      false,
      `${harness} example payload carries no conversation content`
    );
  }
});

test('adapter boundary declares raw vs resolved shapes and reasoning relations', () => {
  assert.equal(resolveHarnessUsageShape('claude'), 'resolved');
  assert.equal(resolveHarnessUsageShape('codebuddy'), 'raw');
  assert.equal(resolveHarnessUsageShape('codex'), 'raw');
  assert.equal(resolveHarnessUsageShape('deepseek'), 'resolved');
  assert.equal(resolveHarnessUsageShape('nope'), null);
  assert.equal(resolveHarnessReasoningRelation('opencode'), 'separate');
  assert.equal(resolveHarnessReasoningRelation('codex'), 'subset_of_output');
  assert.equal(resolveHarnessReasoningRelation('openrouter'), 'unknown');
  assert.equal(resolveUsageContract('nope').supported, false);
});

test('Claude resolved camelCase is used as-is; CodeBuddy raw snake_case is resolved', () => {
  // Claude: the room already received `resolveClaudeResultUsage` output.
  const claude = resolveHarnessUsageTokens('claude', {
    usage: { inputTokens: 1050, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 },
  });
  assert.equal(claude.textInput, 100, 'cache read + write are split out, not lost');
  assert.equal(claude.cachedInput, 900);
  assert.equal(claude.cacheWrite, 50);

  // CodeBuddy: raw snake_case must still be translated at the boundary.
  const codebuddy = resolveHarnessUsageTokens('codebuddy', {
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    },
  });
  assert.equal(codebuddy.textInput, 100);
  assert.equal(codebuddy.cachedInput, 900);
  assert.equal(codebuddy.cacheWrite, 50);

  // A legacy raw Claude payload still resolves for backward compatibility.
  const legacyClaude = resolveHarnessUsageTokens('claude', {
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
  });
  assert.equal(legacyClaude.textInput, 100);
  assert.equal(legacyClaude.cacheWrite, 50);
});

test('CodeBuddy usage resolution returns null when the event carries no usage', () => {
  // A usage-shaped event without a `usage` bag must not invent a zero measurement.
  assert.equal(resolveHarnessUsageTokens('codebuddy', { type: 'usage' }), null);
  assert.equal(resolveHarnessUsageTokens('codebuddy', { type: 'usage', usage: null }), null);
  // A null/undefined event is handled at the boundary as well.
  assert.equal(resolveHarnessUsageTokens('codebuddy', null), null);
  assert.equal(resolveHarnessUsageTokens('codebuddy', undefined), null);
});

test('first new event carries schema and normalization versions plus contract fields', () => {
  const event = createUsageEvent({
    harness: 'claude',
    provider: 'other',
    eventType: 'delta',
    model: 'claude-sonnet-4-5',
    tokens: { ...emptyUsageTokens(), textInput: 100, cachedInput: 900, textOutput: 20 },
  });
  assert.equal(event.schemaVersion, USAGE_SCHEMA_VERSION);
  assert.equal(event.normalizationVersion, USAGE_NORMALIZATION_VERSION);
  assert.equal(event.contractRevision, USAGE_CONTRACT_REVISION);
  assert.equal(event.usageShape, 'resolved');
  assert.equal(event.measurementKind, 'snapshot');
  assert.equal(event.granularity, 'run');
  assert.equal(event.inputIncludesCache, true);
  assert.equal(event.reasoningRelation, 'subset_of_output');
  assert.equal(event.provenance, 'reported');
  assert.equal(event.accountingScope, 'own');
  assert.equal(event.lifecycle, 'running');
  assert.equal(event.completeness, 'partial');
  assert.equal(event.identityClass, 'none');
  assert.equal(event.logicalEventKey, null);
});

test('harness run pressure is retained only as bounded counters on Codex and Claude run events', () => {
  for (const harness of ['codex', 'claude']) {
    const pressure = createUsageEvent({
      harness,
      eventType: 'run',
      outcome: 'limit',
      harnessRunPressure: { activeRuns: 2.9, startsLastMinute: 4, startsLastFiveMinutes: 8, secret: 'discard' },
    });
    assert.deepEqual(pressure.harnessRunPressure, {
      activeRuns: 2,
      startsLastMinute: 4,
      startsLastFiveMinutes: 8,
    });
  }
  assert.equal(createUsageEvent({
    harness: 'openrouter', eventType: 'run', harnessRunPressure: { activeRuns: 3 },
  }).harnessRunPressure, undefined);
  assert.equal(createUsageEvent({
    harness: 'claude', eventType: 'delta', harnessRunPressure: { activeRuns: 3 },
  }).harnessRunPressure, undefined);
});

test('provenance distinguishes reported, estimated and unknown', () => {
  assert.equal(resolveUsageProvenance({ tokens: { textInput: 5 } }), 'reported');
  assert.equal(resolveUsageProvenance({ estimated: true, tokens: { textInput: 5 } }), 'estimated');
  assert.equal(resolveUsageProvenance({ reportedUsd: 0 }), 'reported');
  assert.equal(resolveUsageProvenance({}), 'unknown');
  assert.equal(resolveUsageProvenance({ provenance: 'unknown', tokens: { textInput: 5 } }), 'unknown');

  const reported = createUsageEvent({ harness: 'codex', eventType: 'delta', tokens: { textInput: 5 } });
  assert.equal(reported.provenance, 'reported');
  const estimated = createUsageEvent({
    harness: 'codex',
    eventType: 'delta',
    estimated: true,
    tokens: { textInput: 5 },
  });
  assert.equal(estimated.provenance, 'estimated');
  const unknown = createUsageEvent({ harness: 'codex', eventType: 'run', outcome: 'ok' });
  assert.equal(unknown.provenance, 'unknown');
});

test('lifecycle separates running from ended', () => {
  assert.equal(resolveUsageLifecycle({ eventType: 'delta' }), 'running');
  assert.equal(resolveUsageLifecycle({ eventType: 'run' }), 'ended');
  assert.equal(resolveUsageLifecycle({ eventType: 'run', ended: false }), 'running');
  assert.equal(resolveUsageLifecycle({ eventType: 'delta', ended: true }), 'ended');
});

test('completeness: one usage is never complete; missing/unsupported are distinct', () => {
  assert.equal(
    resolveUsageCompleteness({ supported: true, lifecycle: 'running', measurementPresent: true }),
    'partial'
  );
  assert.equal(
    resolveUsageCompleteness({ supported: true, lifecycle: 'ended', measurementPresent: false }),
    'missing'
  );
  assert.equal(resolveUsageCompleteness({ supported: false }), 'unsupported');
  assert.equal(
    resolveUsageCompleteness({
      supported: true,
      lifecycle: 'ended',
      measurementPresent: true,
      coverage: { proof: true, expectedRequests: 3, coveredRequests: 2 },
    }),
    'partial'
  );
  assert.equal(
    resolveUsageCompleteness({
      supported: true,
      lifecycle: 'ended',
      measurementPresent: true,
      coverage: { proof: true, expectedRequests: 3, coveredRequests: 3 },
    }),
    'complete'
  );

  // A single delta event is never complete, even when it carries tokens.
  const delta = createUsageEvent({
    harness: 'codex',
    eventType: 'delta',
    tokens: { textInput: 10 },
    coverage: { proof: true, expectedRequests: 1, coveredRequests: 1 },
  });
  assert.equal(delta.completeness, 'partial');
  assert.equal(delta.lifecycle, 'running');
});

test('consolidated coverage requires child coverage; reported zero counts as a measurement', () => {
  assert.equal(
    resolveUsageCompleteness({
      supported: true,
      lifecycle: 'ended',
      measurementPresent: true,
      coverage: {
        proof: true,
        expectedRequests: 1,
        coveredRequests: 1,
        scope: 'consolidated',
        expectedChildren: 2,
        coveredChildren: 1,
      },
    }),
    'partial'
  );
  assert.equal(
    resolveUsageCompleteness({
      supported: true,
      lifecycle: 'ended',
      measurementPresent: true,
      coverage: {
        proof: true,
        expectedRequests: 1,
        coveredRequests: 1,
        scope: 'consolidated',
        expectedChildren: 2,
        coveredChildren: 2,
      },
    }),
    'complete'
  );
  // Reported zero with a correct final is a measurement, not missing.
  assert.equal(
    resolveUsageCompleteness({
      supported: true,
      lifecycle: 'ended',
      measurementPresent: true,
      coverage: { proof: true, expectedRequests: 1, coveredRequests: 1 },
    }),
    'complete'
  );
  // No measurement at all stays null/missing rather than becoming zero.
  assert.equal(
    resolveUsageCompleteness({ supported: true, lifecycle: 'ended', measurementPresent: false }),
    'missing'
  );
});

test('reasoning subset is split out; separate is additive; unknown is diagnostic only', () => {
  const sdk = partitionUsageTokens(
    { textInput: 1200, cachedInput: 900, textOutput: 80, reasoning: 20 },
    'sdk'
  );
  assert.equal(sdk.inputWithoutCache, 300);
  assert.equal(sdk.cacheRead, 900);
  assert.equal(sdk.outputWithoutReasoning, 60);
  assert.equal(sdk.reasoning, 20);
  assert.equal(sdk.reasoningDiagnostic, false);
  assert.equal(additiveTokenTotal(sdk), 1280);
  assert.equal(promptTokensForWindow({ textInput: 1200, cachedInput: 900 }, 'sdk'), 1200);

  const opencode = partitionUsageTokens(
    { textInput: 500, cachedInput: 300, cacheWrite: 40, textOutput: 20, reasoning: 5 },
    'opencode'
  );
  assert.equal(opencode.inputWithoutCache, 500);
  assert.equal(opencode.outputWithoutReasoning, 20);
  assert.equal(opencode.reasoningDiagnostic, false);
  assert.equal(additiveTokenTotal(opencode), 865);

  const qwen = partitionUsageTokens(
    { textInput: 600, cachedInput: 400, textOutput: 120, reasoning: 33 },
    'qwen'
  );
  assert.equal(qwen.reasoningDiagnostic, true, 'unknown relation is a diagnostic subcounter');
  assert.equal(qwen.outputWithoutReasoning, 120, 'unknown relation does not rewrite output');
  assert.equal(additiveTokenTotal(qwen), 1120, 'diagnostic reasoning is excluded');
});

test('cache write is a first-class bucket alongside cache read', () => {
  const claude = partitionUsageTokens(
    { textInput: 100, cachedInput: 900, cacheWrite: 50, textOutput: 20 },
    'claude'
  );
  assert.equal(claude.inputWithoutCache, 100);
  assert.equal(claude.cacheRead, 900);
  assert.equal(claude.cacheWrite, 50);
  assert.equal(claude.outputWithoutReasoning, 20);
  assert.equal(additiveTokenTotal(claude), 1070, '100 + 900 + 50 + 20 disjoint tokens');
});

test('billedTotal and promptTokensForWindow are different derivatives of one contract', () => {
  const tokens = { textInput: 1200, cachedInput: 900, textOutput: 80, reasoning: 20 };
  const billed = billedTotalTokens(tokens, 'sdk');
  const window = promptTokensForWindow(tokens, 'sdk');
  assert.equal(billed, 1280);
  assert.equal(window, 1200);
  assert.notEqual(billed, window);
  // Cache still occupies the context window, so window never equals output.
  assert.ok(window >= tokens.cachedInput);
});

test('unknown window semantics yield no certain percentage', () => {
  // Stage 2 verified OpenRouter `prompt_tokens` already contains cached tokens,
  // so its payload window semantics are inclusive (the bag itself is disjoint).
  assert.equal(resolveWindowSemantics('openrouter'), 'inclusive');
  assert.equal(promptTokensForWindow({ textInput: 40 }, 'openrouter'), 40);
  assert.equal(promptTokensForWindow({ textInput: 40 }, 'unknown-harness'), null);
  assert.equal(resolveWindowSemantics('codex'), 'inclusive');
  assert.equal(resolveWindowSemantics('opencode'), 'disjoint');
});

test('own and consolidated scopes are never summed together', () => {
  const aggregate = aggregateAccountingScopes([
    { scope: 'own', harness: 'codex', tokens: { textInput: 100, cachedInput: 900 } },
    { scope: 'consolidated', harness: 'codex', tokens: { textInput: 50 } },
  ]);
  assert.equal(aggregate.mixed, true);
  assert.equal(aggregate.own.inputWithoutCache, 100);
  assert.equal(aggregate.own.cacheRead, 900);
  assert.equal(aggregate.consolidated.inputWithoutCache, 50);
  assert.equal(typeof aggregate.combined, 'undefined');
});

test('logical identity requires a durable mapping and a source event id', () => {
  const durable = buildLogicalUsageIdentity({
    harness: 'codex',
    runId: 'run-1',
    sourceSessionId: 'sess-1',
    turnId: 'turn-1',
    measurementType: 'delta',
  });
  assert.equal(durable.identityClass, 'durable_sequence');
  assert.ok(durable.logicalEventKey);

  const provider = buildLogicalUsageIdentity({ harness: 'openrouter', providerEventId: 'gen-1' });
  assert.equal(provider.identityClass, 'provider');
  assert.ok(provider.logicalEventKey);

  const none = buildLogicalUsageIdentity({ harness: 'codex', tokens: { textInput: 5 } });
  assert.equal(none.identityClass, 'none');
  assert.equal(none.logicalEventKey, null);

  // A freshly assigned ordinal is not durable and must not dedup.
  const replayed = buildLogicalUsageIdentity({
    harness: 'codex',
    runId: 'run-1',
    sourceSessionId: 'sess-1',
    turnId: 'turn-1',
    durableSequence: false,
  });
  assert.equal(replayed.identityClass, 'none');
  assert.equal(replayed.logicalEventKey, null);

  // Same durable components produce the same key; re-receipt cannot mint a new one.
  const twin = buildLogicalUsageIdentity({
    harness: 'codex',
    runId: 'run-1',
    sourceSessionId: 'sess-1',
    turnId: 'turn-1',
    measurementType: 'delta',
  });
  assert.equal(twin.logicalEventKey, durable.logicalEventKey);
});

test('late credible measurements correct coverage but never the run count', () => {
  const now = Date.now();
  assert.equal(canAwaitFinalUsage({ endedAt: new Date(now - 1000).toISOString(), now }), true);
  assert.equal(
    canAwaitFinalUsage({
      endedAt: new Date(now - USAGE_FINAL_USAGE_GRACE_MS - 1000).toISOString(),
      now,
    }),
    false
  );

  const corrected = applyUsageCoverageCorrection({
    runCount: 7,
    previous: { completeness: 'partial', coveredRequests: 1 },
    correction: { completeness: 'complete', coveredRequests: 3 },
  });
  assert.equal(corrected.runCount, 7, 'run count is stable');
  assert.equal(corrected.completeness, 'complete');
  assert.equal(corrected.coveredRequests, 3);
  assert.equal(corrected.corrected, true);
  assert.ok(USAGE_COMPLETENESS.includes(corrected.completeness));
});

test('child model comes from the payload, never from the parent', () => {
  assert.equal(resolveChildUsageModel({ model: 'child-model', parentModel: 'parent-model' }), 'child-model');
  assert.equal(resolveChildUsageModel({ parentModel: 'parent-model' }), '');
  assert.equal(resolveChildUsageModel({}), '');
});

test('contract fields survive the harness delta path with durable ids', () => {
  const partial = recordHarnessUsageDelta(
    { chatId: 'c1', _runId: 'run-9', _runSourceSessionId: 'sess-9' },
    'claude',
    {
      type: 'usage',
      identity: { requestId: 'req-9' },
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900 },
    },
    (row) => row
  );
  assert.ok(partial);
  assert.equal(partial.provenance, 'reported');
  assert.equal(partial.accountingScope, 'own');
  assert.equal(partial.granularity, 'run');
  assert.equal(partial.runId, 'run-9');
  assert.equal(partial.sourceSessionId, 'sess-9');
  assert.equal(partial.requestId, 'req-9');

  const event = createUsageEvent(partial);
  assert.equal(event.identityClass, 'durable_sequence');
  assert.ok(event.logicalEventKey);
});

test('opencode snapshot carries cache write through the adapter boundary', () => {
  const snapshot = readOpenCodeTokenSnapshot({ input: 10, output: 5, cache: { read: 2, write: 3 } });
  assert.equal(snapshot.cacheWrite, 3);

  const resolved = resolveOpenCodeUsageFromStreamEvent(
    {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg-1',
          role: 'assistant',
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 3 } },
        },
      },
    },
    new Map()
  );
  assert.ok(resolved);
  assert.equal(resolved.delta.cacheWrite, 3);
  assert.equal(resolved.sdkEvent.usage.tokens.cache.write, 3);
  assert.equal(buildOpenCodeUsageSdkEvent({ input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 4 }).usage.tokens.cache.write, 4);
});

test('describeUsageContract exposes provenance/lifecycle/completeness with derivations', () => {
  const described = describeUsageContract({
    harness: 'codex',
    eventType: 'delta',
    tokens: { textInput: 600, cachedInput: 400, textOutput: 250, reasoning: 30 },
  });
  assert.equal(described.usageShape, 'raw');
  assert.equal(described.windowSemantics, 'inclusive');
  assert.equal(described.provenance, 'reported');
  assert.equal(described.lifecycle, 'running');
  assert.equal(described.completeness, 'partial');
  assert.equal(described.promptTokensForWindow, 1000);
  assert.equal(described.billedTotalTokens, 600 + 400 + 220 + 30);
});

test('buildUsageContractFields defaults an unsupported harness to unsupported', () => {
  const fields = buildUsageContractFields({ harness: 'mystery', eventType: 'run', outcome: 'ok' });
  assert.equal(fields.usageShape, undefined);
  assert.equal(fields.lifecycle, 'ended');
  assert.equal(fields.completeness, 'unsupported');
  assert.equal(fields.provenance, 'unknown');
});

test('occupancy assessment: reliable only with scope, granularity, completeness, freshness, epoch and limit', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const now = 1_000_000;
  const base = {
    tokens: { textInput: 500, cachedInput: 300, cacheWrite: 40 },
    contract: 'opencode',
    scope: 'current_prompt',
    provenance: 'reported',
    granularity: 'message',
    completeness: 'complete',
    observedAt: now - 1000,
    now,
    contextEpoch: 3,
    currentContextEpoch: 3,
    limitTokens: 8400,
  };
  const ok = c.assessContextOccupancy(base);
  assert.equal(ok.reliable, true);
  assert.equal(ok.promptTokens, 840);
  assert.equal(ok.percent, 10);
  assert.deepEqual(ok.cache, { read: 300, write: 40, separate: true });
  const cases = {
    scope_not_current_prompt: { scope: 'run_billing' },
    granularity_unreliable: { granularity: 'run' },
    measurement_incomplete: { completeness: 'missing' },
    measurement_incomplete_partial: { completeness: 'partial' },
    stale_or_unknown_time: { observedAt: now - c.USAGE_OCCUPANCY_MAX_AGE_MS - 1 },
    context_epoch_mismatch: { currentContextEpoch: 4 },
    limit_unknown: { limitTokens: null },
  };
  for (const [reason, patch] of Object.entries(cases)) {
    const r = c.assessContextOccupancy({ ...base, ...patch });
    assert.equal(r.percent, null, reason);
    assert.ok(r.reasons.includes(reason.replace(/_partial$/, '')), reason);
  }
  assert.equal(c.assessContextOccupancy({ ...base, limitTokens: 0 }).percent, null);
});

test('occupancy assessment: null/missing is not zero, reported zero is a measurement, unknown semantics has no percent', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const now = 5000;
  const base = {
    scope: 'current_prompt', provenance: 'reported', granularity: 'request', completeness: 'complete',
    observedAt: now, now, contextEpoch: 'a', currentContextEpoch: 'a', limitTokens: 1000,
  };
  const missing = c.assessContextOccupancy({ ...base, contract: 'opencode' });
  assert.equal(missing.promptTokens, null);
  assert.equal(missing.percent, null);
  assert.equal(c.promptTokensForWindow({}, 'opencode'), null);
  assert.equal(c.promptTokensForWindow({ textInput: 0 }, 'opencode'), 0);
  // explicit promptTokens without a contract cannot bypass unknown semantics
  const noContract = c.assessContextOccupancy({ ...base, promptTokens: 100 });
  assert.equal(noContract.percent, null);
  assert.ok(noContract.reasons.includes('window_semantics_unknown'));
  const none = c.assessContextOccupancy({ ...base, promptTokens: null });
  assert.equal(none.percent, null);
  assert.ok(none.reasons.includes('prompt_tokens_unknown'));
  const zero = c.assessContextOccupancy({ ...base, contract: 'opencode', promptTokens: 0 });
  assert.equal(zero.reliable, true);
  assert.equal(zero.percent, 0);
  const unknown = c.assessContextOccupancy({ ...base, contract: 'no-such-harness', tokens: { textInput: 10 } });
  assert.equal(unknown.percent, null);
  assert.equal(c.assessContextOccupancy({}).percent, null);
  // cache is never subtracted from an explicit prompt size
  const cached = c.assessContextOccupancy({ ...base, contract: 'opencode', promptTokens: 400, tokens: { cachedInput: 300 } });
  assert.equal(cached.promptTokens, 400);
  assert.equal(cached.cache.read, 300);
});

test('contract revision is reconciled and older event versions stay readable', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const fs = await import('node:fs');
  const doc = fs.readFileSync(new URL('../docs/usage-contract.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('contract revision `' + c.USAGE_CONTRACT_REVISION + '`'));
  assert.ok(doc.includes('schemaVersion = ' + c.USAGE_SCHEMA_VERSION));
  assert.equal(c.isReadableUsageVersion({}), true);
  assert.equal(c.isReadableUsageVersion({ schemaVersion: 1, normalizationVersion: 1 }), true);
  assert.equal(c.isReadableUsageVersion({ schemaVersion: 2, normalizationVersion: 2 }), true);
  assert.equal(c.isReadableUsageVersion({ schemaVersion: 3, normalizationVersion: 2 }), true);
  assert.equal(c.isReadableUsageVersion({ schemaVersion: 99 }), false);
  const d = c.describeUsageContract({ harness: 'codex', schemaVersion: 1, tokens: { textInput: 5 } });
  assert.equal(d.schemaVersion, 1);
});

test('docs matrix lists every contract harness', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const fs = await import('node:fs');
  const doc = fs.readFileSync(new URL('../docs/usage-contract.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('## 10.'), doc.indexOf('## 11.'));
  for (const h of c.USAGE_MATRIX_HARNESSES) assert.ok(section.includes('| `' + h + '` |'), h);
});

test('occupancy eligibility: request vs run, snapshot vs cumulative, estimated, consolidated', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const now = 9_000_000;
  const base = {
    tokens: { textInput: 1000 }, contract: 'opencode', scope: 'current_prompt',
    provenance: 'reported', granularity: 'request', measurementKind: 'snapshot',
    completeness: 'complete', observedAt: now - 10, now, transport: 'live',
    contextEpoch: 1, currentContextEpoch: 1, limitTokens: 10000,
  };
  assert.equal(c.assessContextOccupancy(base).percent, 10);
  assert.equal(c.assessContextOccupancy({ ...base, measurementKind: 'delta' }).percent, 10);
  // run/session granularity: rejected unless current-prompt semantics are confirmed snapshot
  const run = c.assessContextOccupancy({ ...base, granularity: 'run' });
  assert.equal(run.percent, null);
  assert.ok(run.reasons.includes('granularity_unreliable'));
  assert.equal(c.assessContextOccupancy({ ...base, granularity: 'run', currentPromptConfirmed: true }).percent, 10);
  assert.equal(
    c.assessContextOccupancy({ ...base, granularity: 'session', currentPromptConfirmed: true, measurementKind: 'delta' }).percent,
    null,
  );
  const cum = c.assessContextOccupancy({ ...base, measurementKind: 'cumulative', granularity: 'run', currentPromptConfirmed: true });
  assert.equal(cum.percent, null);
  assert.ok(cum.reasons.includes('measurement_cumulative'));
  for (const provenance of ['estimated', 'unknown', undefined]) {
    const r = c.assessContextOccupancy({ ...base, provenance });
    assert.equal(r.percent, null, String(provenance));
    assert.ok(r.reasons.includes('provenance_not_reported'));
  }
  const cons = c.assessContextOccupancy({ ...base, accountingScope: 'consolidated' });
  assert.equal(cons.percent, null);
  assert.ok(cons.reasons.includes('accounting_scope_consolidated'));
  assert.equal(c.assessContextOccupancy({ ...base, accountingScope: 'own' }).percent, 10);
});

test('occupancy eligibility: zero vs missing, complete vs partial', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const now = 100;
  const base = {
    contract: 'opencode', scope: 'current_prompt', provenance: 'reported', granularity: 'turn',
    completeness: 'complete', observedAt: now, now, transport: 'live',
    contextEpoch: 0, currentContextEpoch: 0, limitTokens: 500,
  };
  assert.equal(c.assessContextOccupancy({ ...base, tokens: { textInput: 0 } }).percent, 0);
  assert.equal(c.assessContextOccupancy({ ...base, tokens: {} }).percent, null);
  assert.equal(c.assessContextOccupancy({ ...base, tokens: { textInput: 5 }, completeness: 'partial' }).percent, null);
});

test('occupancy freshness: TTL depends on transport, stale keeps lastKnown but no percent', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const now = 50_000_000;
  const age = (ms) => now - ms;
  const live = { observedAt: age(c.USAGE_OCCUPANCY_MAX_AGE_MS), now, transport: 'live' };
  assert.equal(c.resolveOccupancyFreshness(live).fresh, true);
  assert.equal(c.resolveOccupancyFreshness({ ...live, observedAt: age(c.USAGE_OCCUPANCY_MAX_AGE_MS + 1) }).reason, 'stale');
  // closed or unknown transport expires sooner
  const closedAt = age(c.USAGE_OCCUPANCY_CLOSED_TRANSPORT_MAX_AGE_MS + 1);
  assert.equal(c.resolveOccupancyFreshness({ observedAt: closedAt, now, transport: 'closed' }).fresh, false);
  assert.equal(c.resolveOccupancyFreshness({ observedAt: closedAt, now }).fresh, false);
  assert.equal(c.resolveOccupancyFreshness({ observedAt: closedAt, now, transport: 'live' }).fresh, true);
  assert.equal(c.resolveOccupancyFreshness({ observedAt: now + 60_000, now, transport: 'live' }).reason, 'future');
  assert.equal(c.resolveOccupancyFreshness({ now }).reason, 'unknown_time');
  const r = c.assessContextOccupancy({
    tokens: { textInput: 100 }, contract: 'opencode', scope: 'current_prompt', provenance: 'reported',
    granularity: 'request', completeness: 'complete', observedAt: closedAt, now, transport: 'closed',
    contextEpoch: 2, currentContextEpoch: 2, limitTokens: 1000,
  });
  assert.equal(r.percent, null);
  assert.equal(r.stale, true);
  assert.equal(r.lastKnown.promptTokens, 100);
  assert.equal(r.expiresAt, closedAt + c.USAGE_OCCUPANCY_CLOSED_TRANSPORT_MAX_AGE_MS);
});

test('context epoch: lifecycle events bump monotonically, old epoch rejected without touching totals', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  assert.deepEqual([...c.USAGE_CONTEXT_EPOCH_BUMP_EVENTS], ['fresh_session', 'reset', 'compaction', 'model_switch']);
  let epoch = null;
  const seen = [];
  for (const ev of ['fresh_session', 'compaction', 'request', 'reset', 'model_switch']) {
    epoch = c.advanceContextEpoch(epoch, ev);
    seen.push(epoch);
  }
  assert.deepEqual(seen, [1, 2, 2, 3, 4]);
  assert.equal(c.advanceContextEpoch('weird', 'reset'), 1);
  assert.deepEqual(c.compareContextEpoch(3, 4), { accepted: false, relation: 'older' });
  assert.deepEqual(c.compareContextEpoch(5, 4), { accepted: false, relation: 'newer' });
  assert.deepEqual(c.compareContextEpoch('a', 'b'), { accepted: false, relation: 'different' });
  assert.equal(c.compareContextEpoch(null, 1).relation, 'unknown');

  // The factory derives completeness/provider itself; pin them for the assertion.
  const ev = {
    ...createUsageEvent({
      harness: 'opencode', model: 'm', contextEpoch: 2, provenance: 'reported',
      granularity: 'request', tokens: { textInput: 800 },
    }),
    provider: 'p',
    completeness: 'complete',
  };
  const snapshot = JSON.stringify(ev);
  const billedBefore = c.billedTotalTokens(ev.tokens, 'opencode');
  const limits = { [c.buildOccupancyLimitKey({ harness: 'opencode', provider: 'p', model: 'm', config: 'default' })]: { contextWindowTokens: 8000 } };
  const fresh = c.assessEventOccupancy(ev, { currentContextEpoch: 2, now: Date.parse(ev.at) + 1000, transport: 'live', config: 'default', limits });
  assert.equal(fresh.reliable, true);
  assert.equal(fresh.percent, 10);
  // compaction/reset/model switch moved the epoch on: the old event is rejected
  const old = c.assessEventOccupancy(ev, { currentContextEpoch: 3, now: Date.parse(ev.at) + 1000, transport: 'live', config: 'default', limits });
  assert.equal(old.percent, null);
  assert.ok(old.reasons.includes('context_epoch_old'));
  assert.equal(JSON.stringify(ev), snapshot);
  assert.equal(c.billedTotalTokens(ev.tokens, 'opencode'), billedBefore);
});

test('occupancy limits: keyed by harness+provider+model+config, window vs input/output vs reserve', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const k = (o) => c.buildOccupancyLimitKey({ harness: 'opencode', provider: 'p', model: 'm', config: 'default', ...o });
  assert.equal(k({}), 'opencode|p|m|default');
  assert.equal(k({ config: '' }), null);
  assert.equal(k({ model: undefined }), null);
  const registry = { [k({})]: { contextWindowTokens: 200000, maxInputTokens: 180000, maxOutputTokens: 32000, responseReserveTokens: 20000 } };
  const hit = c.resolveOccupancyLimit(registry, { harness: 'opencode', provider: 'p', model: 'm', config: 'default' });
  assert.equal(hit.contextWindowTokens, 200000);
  assert.equal(hit.maxOutputTokens, 32000);
  assert.equal(hit.usableInputTokens, 180000);
  // model switch / other config / provider: no fallback to a neighbour entry
  assert.equal(c.resolveOccupancyLimit(registry, { harness: 'opencode', provider: 'p', model: 'm2', config: 'default' }), null);
  assert.equal(c.resolveOccupancyLimit(registry, { harness: 'opencode', provider: 'p', model: 'm', config: '1m' }), null);
  assert.equal(c.resolveOccupancyLimit(registry, { harness: 'opencode', provider: 'q', model: 'm', config: 'default' }), null);
  assert.equal(c.resolveOccupancyLimit(registry, { harness: 'sdk', provider: 'p', model: 'm', config: 'default' }), null);
  // window unknown even if max output is known: no limit
  assert.equal(c.resolveOccupancyLimit({ [k({})]: { maxOutputTokens: 4096 } }, { harness: 'opencode', provider: 'p', model: 'm', config: 'default' }), null);
  // output cap stands in for the reserve
  assert.equal(c.normalizeOccupancyLimit({ contextWindowTokens: 1000, maxOutputTokens: 300 }).usableInputTokens, 700);
  assert.equal(c.normalizeOccupancyLimit({ contextWindowTokens: -1 }).contextWindowTokens, null);

  const now = 7000;
  const base = {
    tokens: { textInput: 1000 }, contract: 'opencode', scope: 'current_prompt', provenance: 'reported',
    granularity: 'request', completeness: 'complete', observedAt: now, now, transport: 'live',
    contextEpoch: 1, currentContextEpoch: 1,
  };
  // percent is of the window; headroom respects reserve and max input
  const ok = c.assessContextOccupancy({ ...base, limit: { key: k({}), ...registry[k({})] }, limitKey: k({}) });
  assert.equal(ok.percent, 0.5);
  assert.equal(ok.headroomTokens, 179000);
  // limit belongs to another model than the measurement
  const wrong = c.assessContextOccupancy({ ...base, limit: { key: k({ model: 'm2' }), contextWindowTokens: 8000 }, limitKey: k({}) });
  assert.equal(wrong.percent, null);
  assert.ok(wrong.reasons.includes('limit_key_mismatch'));
  // unknown limit => null, never a guessed percent
  const unk = c.assessContextOccupancy({ ...base, limit: { key: k({}), maxOutputTokens: 100 }, limitKey: k({}) });
  assert.equal(unk.percent, null);
  assert.ok(unk.reasons.includes('limit_unknown'));
});

test('occupancy cache semantics and old-schema compatibility', async () => {
  const c = await import('../lib/usage/usage-contract.js');
  const now = 3000;
  const base = {
    contract: 'opencode', scope: 'current_prompt', provenance: 'reported', granularity: 'request',
    completeness: 'complete', observedAt: now, now, transport: 'live',
    contextEpoch: 1, currentContextEpoch: 1, limitTokens: 1000,
  };
  // cache is part of the prompt, reported separately and never subtracted
  const cached = c.assessContextOccupancy({ ...base, promptTokens: 500, tokens: { cachedInput: 200, cacheWrite: 50 } });
  assert.equal(cached.percent, 50);
  assert.deepEqual(cached.cache, { read: 200, write: 50, separate: true });
  // cache larger than the stated prompt is contradictory data
  const bad = c.assessContextOccupancy({ ...base, promptTokens: 100, tokens: { cachedInput: 200 } });
  assert.equal(bad.percent, null);
  assert.ok(bad.reasons.includes('cache_exceeds_prompt'));

  // legacy v1 event: readable, but no provenance/granularity/epoch => never eligible, no throw
  const legacy = { schemaVersion: 1, harness: 'opencode', provider: 'p', model: 'm', at: new Date(now).toISOString(), tokens: { textInput: 10 } };
  const r = c.assessEventOccupancy(legacy, { now, transport: 'live', currentContextEpoch: 1, config: 'default' });
  assert.equal(r.percent, null);
  assert.equal(r.reliable, false);
  assert.ok(r.reasons.includes('provenance_not_reported'));
  assert.ok(!r.reasons.includes('schema_unreadable'));
  // a schema newer than this build is unreadable
  const future = c.assessEventOccupancy({ ...legacy, schemaVersion: 99 }, { now });
  assert.ok(future.reasons.includes('schema_unreadable'));
  assert.equal(future.percent, null);
  assert.equal(c.assessEventOccupancy(null).percent, null);
  // event-level run granularity: needs the caller's confirmation
  const runEv = { ...legacy, schemaVersion: 2, provenance: 'reported', granularity: 'run', measurementKind: 'snapshot', completeness: 'complete', contextEpoch: 1 };
  const limits = { 'opencode|p|m|default': { contextWindowTokens: 100 } };
  const ctx = { now, transport: 'live', currentContextEpoch: 1, config: 'default', limits };
  assert.equal(c.assessEventOccupancy(runEv, ctx).percent, null);
  assert.equal(c.assessEventOccupancy(runEv, { ...ctx, currentPromptConfirmed: true }).percent, 10);
  // estimated and consolidated events never qualify
  assert.equal(c.assessEventOccupancy({ ...runEv, granularity: 'request', provenance: 'estimated' }, ctx).percent, null);
  assert.equal(c.assessEventOccupancy({ ...runEv, granularity: 'request', accountingScope: 'consolidated' }, ctx).percent, null);
});
