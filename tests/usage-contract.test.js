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
import { recordHarnessUsageDelta, resolveHarnessUsageTokens } from '../lib/usage/harness-usage.js';
import {
  buildOpenCodeUsageSdkEvent,
  readOpenCodeTokenSnapshot,
  resolveOpenCodeUsageFromStreamEvent,
} from '../lib/opencode/opencode-usage.js';

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

test('matrix covers all eight harnesses with the required contract fields', () => {
  assert.deepEqual([...USAGE_MATRIX_HARNESSES].sort(), [
    'claude',
    'codebuddy',
    'codex',
    'deepseek',
    'opencode',
    'openrouter',
    'qwen',
    'sdk',
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
    assert.match(String(entry.source), /lib\//, `${harness} contract source`);
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
