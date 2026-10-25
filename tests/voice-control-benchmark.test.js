import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {
  DEFAULT_REPEATS,
  MAX_REPEATS,
  MAX_SESSION_CAP_USD,
  SESSION_CAP_USD,
  createCostTracker,
  estimateCorpusPerTurnUsd,
  estimateScenarioPrefixUsd,
  estimateTurnUsd,
  loadCorpus,
  measureSchemaTokens,
  planLiveRun,
  providerUsageUsd,
  ratesForBackend,
  resolveCapUsd,
  resolveLiveCredential,
  runReplaySessions,
  scoreCall,
  summarizeRuns,
  validateCorpus,
  validateRepeats,
  writeResults,
} from '../scripts/voice-control-benchmark.mjs';

test('corpus is valid, has >= 40 PL/EN utterances and diacritics cases', () => {
  const actual = loadCorpus();
  assert.deepEqual(validateCorpus(actual), []);
  assert.ok(actual.some((item) => item.lang === 'pl'));
  assert.ok(actual.some((item) => item.lang === 'en'));
  assert.ok(actual.some((item) => item.tags?.includes('diacritics')));
  assert.ok(actual.some((item) => item.tags?.includes('ambiguous')));
});

test('validateCorpus rejects unknown tools and short corpora', () => {
  const actual = validateCorpus([{ id: 'x', lang: 'en', text: 'hi', tool: 'nope', target: { action: 'a' } }]);
  assert.ok(actual.some((problem) => problem.includes('unknown tool')));
  assert.ok(actual.some((problem) => problem.includes('need >= 40')));
});

test('validateCorpus rejects arg keys and enum values outside the tool schema', () => {
  const base = { id: 'x', lang: 'en', text: 'hi', target: { action: 'a' } };
  const unknownKey = validateCorpus([{ ...base, tool: 'send_prompt', args: { txt: 'x' } }]);
  assert.ok(unknownKey.some((problem) => problem.includes('"txt" is not in send_prompt\'s schema')));
  const badEnum = validateCorpus([{ ...base, tool: 'set_chat_mode', args: { mode: 'yolo' } }]);
  assert.ok(badEnum.some((problem) => problem.includes('set_chat_mode.mode')));
  const missingRequired = validateCorpus([{ ...base, tool: 'run_task', args: {} }]);
  assert.ok(missingRequired.some((problem) => problem.includes('missing required arg "label"')));
  const badAlternative = validateCorpus([{ ...base, tool: 'switch_chat', argsAny: [{ chat_id: 'c1' }, { id: 'c2' }] }]);
  assert.ok(badAlternative.some((problem) => problem.includes('"id" is not in switch_chat\'s schema')));
});

test('scoreCall ignores diacritics and skips gap utterances', () => {
  const inputItem = { tool: 'switch_chat', args: { title: 'Zażółć' } };
  assert.equal(scoreCall(inputItem, { name: 'switch_chat', args: { title: 'zazolc gesla' } }), true);
  assert.equal(scoreCall(inputItem, { name: 'rename_chat', args: {} }), false);
  assert.equal(scoreCall({ tool: null }, null), null);
});

test('ambiguous entries accept the documented argument alternatives', () => {
  const inputItem = loadCorpus().find((item) => item.id === 'u12');
  assert.equal(scoreCall(inputItem, { name: 'switch_chat', args: { title: '3' } }), true);
  assert.equal(scoreCall(inputItem, { name: 'switch_chat', args: { title: 'chat number three' } }), true);
  assert.equal(scoreCall(inputItem, { name: 'switch_chat', args: { title: 'refactor' } }), false);
});

test('schema token baseline covers three backends and Gemini is not larger than OpenAI', () => {
  const actual = measureSchemaTokens();
  const backends = new Set(actual.map((row) => row.backend));
  assert.deepEqual([...backends].sort(), ['gemini', 'openai-flagship', 'openai-mini']);
  const openai = actual.find((row) => row.backend === 'openai-mini' && row.lang === 'en');
  const gemini = actual.find((row) => row.backend === 'gemini' && row.lang === 'en');
  assert.ok(gemini.tools <= openai.tools);
  assert.ok(openai.total > 1000);
});

test('summarizeRuns computes accuracy and p95', () => {
  const inputRuns = Array.from({ length: 20 }, (_, i) => ({ correct: i < 18, latencyMs: (i + 1) * 100 }));
  const actual = summarizeRuns(inputRuns);
  assert.equal(actual.accuracy, 0.9);
  assert.equal(actual.p95LatencyMs, 1900);
  assert.equal(estimateScenarioPrefixUsd(1000, null), null);
});

test('up-front estimate refuses a run that would exceed the cap', () => {
  const plan = planLiveRun({ utteranceCount: 45, repeats: 20, perTurnUsd: 0.015, capUsd: SESSION_CAP_USD });
  assert.equal(plan.allowed, false);
  assert.equal(plan.sessions, 900);
  assert.ok(plan.estimatedUsd > SESSION_CAP_USD);
  assert.match(plan.reason, /exceeds the \$5 cap/);
  const small = planLiveRun({ utteranceCount: 45, repeats: 5, perTurnUsd: 0.002, capUsd: SESSION_CAP_USD });
  assert.equal(small.allowed, true);
  assert.equal(small.estimatedUsd, 45 * 5 * 0.002);
  assert.equal(small.reason, null);
  assert.equal(planLiveRun({ utteranceCount: 1, repeats: 1, perTurnUsd: null, capUsd: SESSION_CAP_USD }).allowed, false);
});

test('corpus estimate uses the shared token rates per backend', () => {
  for (const backend of ['openai-mini', 'openai-flagship', 'gemini']) {
    const perTurnUsd = estimateCorpusPerTurnUsd({ backend, utterances: loadCorpus() });
    assert.ok(Number.isFinite(perTurnUsd) && perTurnUsd > 0, backend);
  }
  const rates = ratesForBackend('openai-mini');
  assert.equal(estimateTurnUsd({ promptTokens: 1_000_000, outputTokens: 0, rates }), rates.textInput);
});

test('provider usage is priced from the shared token rates', () => {
  const mini = ratesForBackend('openai-mini');
  const actualMini = providerUsageUsd('openai-mini', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    input_token_details: { cached_tokens: 500_000 },
  });
  assert.ok(Math.abs(actualMini - (mini.textInput * 0.5 + mini.cachedInput * 0.5 + mini.textOutput)) < 1e-9);
  const gemini = ratesForBackend('gemini');
  const actualGemini = providerUsageUsd('gemini', {
    promptTokenCount: 1_000_000,
    cachedContentTokenCount: 400_000,
    candidatesTokenCount: 1_000_000,
  });
  assert.ok(Math.abs(actualGemini - (gemini.textInput * 0.6 + gemini.cachedInput * 0.4 + gemini.textOutput)) < 1e-9);
  assert.equal(providerUsageUsd('openai-mini', null), 0);
});

test('repeats are bounded to 1..20', () => {
  assert.deepEqual(validateRepeats(''), { ok: true, repeats: DEFAULT_REPEATS, problem: null });
  assert.equal(validateRepeats('1').repeats, 1);
  assert.equal(validateRepeats(String(MAX_REPEATS)).repeats, MAX_REPEATS);
  for (const bad of ['0', '21', '2.5', 'abc', '-3']) {
    assert.equal(validateRepeats(bad).ok, false, `repeats ${bad}`);
    assert.match(validateRepeats(bad).problem, /integer 1\.\.20/);
  }
});

test('cap override is documented-bound and cannot pass the hard maximum', () => {
  assert.equal(resolveCapUsd(undefined).capUsd, SESSION_CAP_USD);
  assert.equal(resolveCapUsd('').source, 'default');
  assert.equal(resolveCapUsd('1.5').capUsd, 1.5);
  assert.equal(resolveCapUsd(String(MAX_SESSION_CAP_USD)).ok, true);
  assert.equal(resolveCapUsd(String(MAX_SESSION_CAP_USD + 1)).ok, false);
  assert.match(resolveCapUsd(String(MAX_SESSION_CAP_USD + 1)).problem, /hard maximum/);
  assert.equal(resolveCapUsd('0').ok, false);
  assert.equal(resolveCapUsd('free').ok, false);
});

test('live mode requires the provider key of the chosen backend', () => {
  const missingOpenai = resolveLiveCredential('openai-mini', {});
  assert.equal(missingOpenai.ok, false);
  assert.match(missingOpenai.problem, /OPENAI_API_KEY/);
  const missingGemini = resolveLiveCredential('gemini', { OPENAI_API_KEY: 'sk-x' });
  assert.equal(missingGemini.ok, false);
  assert.match(missingGemini.problem, /GEMINI_API_KEY/);
  assert.equal(resolveLiveCredential('openai-flagship', { OPENAI_API_KEY: 'sk-x' }).ok, true);
  const unknownBackend = resolveLiveCredential('openai-turbo', { OPENAI_API_KEY: 'sk-x' });
  assert.equal(unknownBackend.ok, false);
  assert.match(unknownBackend.problem, /unknown backend/);
});

test('mid-run cost tracking aborts at the cap and keeps partial runs', async () => {
  const tracker = createCostTracker(0.05);
  const seen = [];
  const actual = await runReplaySessions({
    items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    repeats: 2,
    tracker,
    replay: async (item) => {
      seen.push(item.id);
      return { id: item.id, correct: true, latencyMs: 10, costUsd: 0.02 };
    },
  });
  assert.equal(actual.aborted, true);
  assert.equal(actual.runs.length, 3);
  assert.deepEqual(seen, ['a', 'a', 'b']);
  assert.equal(tracker.totalUsd, 0.06);
  assert.equal(tracker.exceeded, true);
  assert.equal(summarizeRuns(actual.runs).accuracy, 1);
});

test('mid-run cost tracking runs to completion under the cap', async () => {
  const tracker = createCostTracker(SESSION_CAP_USD);
  const actual = await runReplaySessions({
    items: [{ id: 'a' }, { id: 'b' }],
    repeats: 2,
    tracker,
    replay: async (item) => ({ id: item.id, correct: null, latencyMs: NaN, costUsd: 0.01 }),
  });
  assert.equal(actual.aborted, false);
  assert.equal(actual.runs.length, 4);
  assert.equal(tracker.totalUsd, 0.04);
});

test('aborted runs write their partial results to VOICE_BENCH_OUTPUT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bench-'));
  const outputPath = path.join(dir, 'partial.json');
  const originalLog = console.log;
  console.log = () => {};
  try {
    const actual = writeResults({ aborted: true, partial: true, spentUsd: 5.01 }, { VOICE_BENCH_OUTPUT: outputPath });
    assert.equal(actual, outputPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), { aborted: true, partial: true, spentUsd: 5.01 });
    assert.equal(writeResults({ aborted: false }, {}), null);
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
