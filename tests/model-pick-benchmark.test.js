/**
 * Benchmark audit + shadow ingestion (plan v10 §2.5, leaf L5).
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFICIAL_ANALYSIS_ATTRIBUTION,
  BENCHMARK_BUILTIN_SOURCES,
  findBuiltinBenchmarkSource,
  isBenchmarkSourceUsableForShadow,
} from '../lib/benchmark-source-registry.js';
import {
  BENCHMARK_WEIGHT,
  buildBenchmarkShadow,
  normalizeBenchmarkShadow,
  shrinkBenchmarkScore,
} from '../lib/model-pick-benchmark.js';
import {
  BENCHMARK_FETCH_DAILY_BUDGET,
  fetchBenchmarkSourceSnapshot,
  parseArtificialAnalysisModels,
} from '../lib/benchmark-fetch.js';
import { getArtificialAnalysisApiKey } from '../lib/benchmark-api-key.js';
import { pickAndPersistModelForPurpose } from '../lib/model-pick-service.js';
import { createModelPickRecord, getModelPickRecord } from '../lib/persist/model-pick-decisions-persist.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function snapshot(capturedAt, overrides = {}) {
  return {
    sourceId: 'artificial-analysis',
    kind: 'real',
    capturedAt,
    payload: {
      entries: [
        { modelKey: 'gpt-5.6-sol', mappingDimension: 'base', scores: { coding: 0.9, intelligence: 0.8 } },
        { modelKey: 'gpt-6.1-sol', mappingDimension: 'base', scores: { intelligence: 0.4 } },
      ],
    },
    ...overrides,
  };
}

function tmp(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-shadow-')), name);
}

const pickBase = (extra = {}) => ({
  role: 'implement',
  purpose: 'test',
  chatId: 'c1',
  harnesses: [{ id: 'codex', enabled: true, ready: true, can_delegate: true }],
  delegations: [],
  modelsByHarness: { codex: { favorites_configured: true, items: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }] } },
  now: NOW,
  explore: false,
  file: tmp('picks.json'),
  shadowFile: tmp('shadow.json'),
  ...extra,
});

test('registry audit flags: only Artificial Analysis is usable, via API with attribution', () => {
  const aa = findBuiltinBenchmarkSource('artificial-analysis');
  assert.equal(aa.licenseStatus, 'allowed_api_only');
  assert.equal(aa.scrapingAllowed, false);
  assert.equal(aa.keyRequired, true);
  assert.equal(aa.attributionRequired, true);
  assert.equal(aa.attribution, ARTIFICIAL_ANALYSIS_ATTRIBUTION);
  assert.equal(aa.fetchEnabled, false);
  assert.equal(aa.defaultEnabled, false);
  assert.equal(aa.dailyRequestLimit, 1000);
  assert.ok(aa.officialTermsUrl.startsWith('https://artificialanalysis.ai/'));
  assert.match(aa.termsCheckedAt, /^2026-10-14$/);
  assert.match(aa.licenseNotes, /never scrape/);
  const arena = findBuiltinBenchmarkSource('arena-ai');
  assert.equal(arena.licenseStatus, 'prohibited_automated');
  assert.equal(arena.fetchEnabled, false);
  assert.equal(arena.manualFetchSupported, false);
  assert.equal(arena.defaultEnabled, false);
  const aider = findBuiltinBenchmarkSource('aider-leaderboard');
  assert.equal(aider.licenseStatus, 'unverified');
  assert.equal(aider.defaultEnabled, false);
  const usable = BENCHMARK_BUILTIN_SOURCES.filter(isBenchmarkSourceUsableForShadow).map((s) => s.id);
  assert.deepEqual(usable, ['artificial-analysis']);
  for (const source of BENCHMARK_BUILTIN_SOURCES) {
    assert.equal(source.scrapingAllowed === true, false, source.id);
    if (source.id !== 'local-fixture' && source.id !== 'example-index') assert.ok(source.licenseNotes && source.termsCheckedAt);
  }
});

test('shrinkage pulls toward neutral and stays in 0..1', () => {
  assert.equal(shrinkBenchmarkScore(0.5), 0.5);
  assert.ok(shrinkBenchmarkScore(1) < 1 && shrinkBenchmarkScore(1) > 0.5);
  assert.ok(shrinkBenchmarkScore(0) > 0 && shrinkBenchmarkScore(0) < 0.5);
  assert.equal(shrinkBenchmarkScore(7), shrinkBenchmarkScore(1));
});

test('fresh snapshot: per-role score, weight 0.1, source and date', () => {
  const candidates = [{ harness: 'codex', model: 'gpt-5.6-sol' }, { harness: 'codex', model: 'gpt-6.1-sol' }];
  const block = buildBenchmarkShadow({
    role: 'implement', level: 'standard', selected: candidates[0], candidates,
    snapshots: [snapshot('2026-10-10T00:00:00Z')],
    sourcePreferences: { 'artificial-analysis': { enabled: true } },
    now: NOW,
  });
  assert.equal(block.shadow_only, true);
  assert.equal(block.selected.status, 'ok');
  assert.equal(block.selected.metric, 'coding');
  assert.equal(block.selected.weight, BENCHMARK_WEIGHT);
  assert.equal(block.selected.source, 'artificial-analysis');
  assert.equal(block.selected.captured_at, '2026-10-10T00:00:00Z');
  assert.ok(block.selected.benchmark_score > 0.5 && block.selected.benchmark_score <= 1);
  assert.ok(block.selected.contribution > 0);
  assert.equal(block.attribution, ARTIFICIAL_ANALYSIS_ATTRIBUTION);
  // gpt-6.1-sol has no coding score: neutral, no contribution.
  const other = block.candidates.find((row) => row.candidateId === 'codex/gpt-6.1-sol');
  assert.equal(other.status, 'missing');
  assert.equal(other.contribution, 0);
  assert.equal(other.weight, 0);
});

test('stale snapshot -> weight 0 and no contribution', () => {
  const candidate = { harness: 'codex', model: 'gpt-5.6-sol' };
  const old = new Date(NOW - 30 * DAY).toISOString();
  const block = buildBenchmarkShadow({
    role: 'implement', selected: candidate, candidates: [candidate],
    snapshots: [snapshot(old)],
    sourcePreferences: { 'artificial-analysis': { enabled: true } },
    now: NOW,
  });
  assert.equal(block.selected.status, 'stale');
  assert.equal(block.selected.stale, true);
  assert.equal(block.selected.weight, 0);
  assert.equal(block.selected.contribution, 0);
  assert.equal(block.sources[0].stale, true);
});

test('disabled, fixture, prohibited and unverified sources never feed the shadow', () => {
  const candidate = { harness: 'codex', model: 'gpt-5.6-sol' };
  const fresh = '2026-10-13T00:00:00Z';
  const run = (snaps, prefs) => buildBenchmarkShadow({
    role: 'implement', selected: candidate, candidates: [candidate], snapshots: snaps, sourcePreferences: prefs, now: NOW,
  });
  assert.equal(run([snapshot(fresh)], {}).selected.status, 'no_source');
  for (const sourceId of ['arena-ai', 'aider-leaderboard', 'local-fixture']) {
    const block = run([snapshot(fresh, { sourceId })], { [sourceId]: { enabled: true } });
    assert.equal(block.selected.status, 'no_source', sourceId);
  }
  assert.equal(
    run([snapshot(fresh, { kind: 'fixture' })], { 'artificial-analysis': { enabled: true } }).selected.status,
    'no_source',
  );
});

test('unmapped model is neutral (exact identity only, no prefix join)', () => {
  const candidate = { harness: 'codex', model: 'gpt-5.6' };
  const block = buildBenchmarkShadow({
    role: 'review', selected: candidate, candidates: [candidate],
    snapshots: [snapshot('2026-10-13T00:00:00Z')],
    sourcePreferences: { 'artificial-analysis': { enabled: true } },
    now: NOW,
  });
  assert.equal(block.selected.status, 'unmapped');
  assert.equal(block.selected.benchmark_score, null);
  assert.equal(block.selected.contribution, 0);
});

test('shadow explanation carries benchmark source/date and selection is unchanged', () => {
  const withoutSnapshots = pickAndPersistModelForPurpose(pickBase({ benchmarkSnapshots: [] }));
  const input = pickBase({
    benchmarkSnapshots: [snapshot('2026-10-12T00:00:00Z')],
    benchmarkSourcePreferences: { 'artificial-analysis': { enabled: true } },
  });
  const withSnapshots = pickAndPersistModelForPurpose(input);
  assert.equal(withSnapshots.ok, true);
  assert.deepEqual(withSnapshots.pick, withoutSnapshots.pick);
  assert.deepEqual(withSnapshots.picks, withoutSnapshots.picks);
  assert.deepEqual(withSnapshots.shadow_top, withoutSnapshots.shadow_top);
  const bench = withSnapshots.shadow_explanation.benchmark;
  assert.equal(bench.shadow_only, true);
  assert.equal(bench.selected.source, 'artificial-analysis');
  assert.equal(bench.selected.captured_at, '2026-10-12T00:00:00Z');
  assert.equal(bench.attribution, ARTIFICIAL_ANALYSIS_ATTRIBUTION);
  assert.equal(withoutSnapshots.benchmark, null);
  const record = getModelPickRecord(withSnapshots.pickId, { file: input.file });
  assert.equal(record.benchmark.selected.source, 'artificial-analysis');
  assert.ok(!JSON.stringify(record.benchmark).includes('scores'));
});

test('journal normalization keeps a closed field list', () => {
  const normalized = normalizeBenchmarkShadow({
    role: 'implement',
    attribution: 'x',
    secret: 'nope',
    candidates: [{ candidateId: 'a/b', status: 'ok', benchmark_score: 0.7, weight: 0.1, contribution: 0.02, apiKey: 'k' }, { status: 'bogus' }],
  });
  assert.equal(normalized.candidates.length, 1);
  assert.ok(!JSON.stringify(normalized).includes('nope'));
  assert.ok(!JSON.stringify(normalized).includes('apiKey'));
  assert.equal(normalizeBenchmarkShadow(null), null);
});

const AA_TERMS = {
  sourceId: 'artificial-analysis',
  officialTermsUrl: 'https://artificialanalysis.ai/terms-of-use',
  scopeOfConsent: 'operator-triggered keyed API fetch',
  version: '2026-10',
  verifiedAt: '2026-10-10T00:00:00.000Z',
  costAcknowledged: true,
  redistributionAllowed: true,
  attributionRequired: true,
};

function fakeFetch(status, body, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
}

const AA_BODY = {
  data: [
    { slug: 'GPT-5.6-Sol', evaluations: { artificial_analysis_intelligence_index: 71, artificial_analysis_coding_index: 64.5 } },
    { slug: 'no-evals' },
  ],
};

test('no network request without key, without enable, or for unsupported sources', async () => {
  const calls = [];
  const usageFile = tmp('usage.json');
  const common = { fetchImpl: fakeFetch(200, AA_BODY, calls), now: NOW, usageFile, termsRecord: AA_TERMS };
  const noKey = await fetchBenchmarkSourceSnapshot({ ...common, enabled: true, apiKey: '' });
  assert.equal(noKey.code, 'key_missing');
  const disabled = await fetchBenchmarkSourceSnapshot({ ...common, enabled: false, apiKey: 'k' });
  assert.equal(disabled.code, 'source_disabled');
  const arena = await fetchBenchmarkSourceSnapshot({ ...common, sourceId: 'arena-ai', enabled: true, apiKey: 'k' });
  assert.equal(arena.code, 'fetch_not_supported');
  const aider = await fetchBenchmarkSourceSnapshot({ ...common, sourceId: 'aider-leaderboard', enabled: true, apiKey: 'k' });
  assert.equal(aider.code, 'fetch_not_supported');
  assert.equal(calls.length, 0);
  for (const r of [noKey, disabled, arena, aider]) assert.equal(r.networkAttempted, false);
  assert.equal(getArtificialAnalysisApiKey({ env: {}, settings: {} }), '');
});

test('explicit fetch sends the key only in x-api-key, bounds output, honours TTL and daily budget', async () => {
  const calls = [];
  const usageFile = tmp('usage.json');
  const base = { enabled: true, apiKey: 'aa-secret-key', fetchImpl: fakeFetch(200, AA_BODY, calls), now: NOW, usageFile, termsRecord: AA_TERMS };
  const first = await fetchBenchmarkSourceSnapshot(base);
  assert.equal(first.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['x-api-key'], 'aa-secret-key');
  assert.ok(!String(calls[0].url).includes('aa-secret-key'));
  assert.equal(first.importBody.sourceId, 'artificial-analysis');
  assert.deepEqual(first.importBody.payload.entries, [
    { modelKey: 'gpt-5.6-sol', mappingDimension: 'base', scores: { intelligence: 0.71, coding: 0.645 } },
  ]);
  assert.ok(!JSON.stringify(first).includes('aa-secret-key'));
  // A fresh snapshot is reused unless forced.
  const cached = await fetchBenchmarkSourceSnapshot({ ...base, latestCapturedAt: new Date(NOW - DAY).toISOString() });
  assert.equal(cached.code, 'cache_fresh');
  assert.equal(calls.length, 1);
  // Budget exhausted -> refuse before the network.
  fs.writeFileSync(usageFile, JSON.stringify({ 'artificial-analysis': { day: '2026-10-14', count: BENCHMARK_FETCH_DAILY_BUDGET } }));
  const limited = await fetchBenchmarkSourceSnapshot({ ...base, force: true });
  assert.equal(limited.code, 'daily_limit');
  assert.equal(calls.length, 1);
});

test('provider 429 and bad payloads are reported without leaking the key', async () => {
  const usageFile = tmp('usage.json');
  const limited = await fetchBenchmarkSourceSnapshot({
    enabled: true, apiKey: 'aa-secret-key', now: NOW, usageFile, termsRecord: AA_TERMS, fetchImpl: fakeFetch(429, {}, []),
  });
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.networkAttempted, true);
  const empty = await fetchBenchmarkSourceSnapshot({
    enabled: true, apiKey: 'aa-secret-key', now: NOW, usageFile, termsRecord: AA_TERMS, force: true, fetchImpl: fakeFetch(200, { data: [] }, []),
  });
  assert.equal(empty.code, 'empty_response');
  assert.ok(!JSON.stringify([limited, empty]).includes('aa-secret-key'));
  assert.deepEqual(parseArtificialAnalysisModels(null), []);
});

test('self-hosted Artificial Analysis fetching needs no terms confirmation', async () => {
  const calls = [];
  const usageFile = tmp('usage.json');
  const base = { enabled: true, apiKey: 'aa-secret-key', fetchImpl: fakeFetch(200, AA_BODY, calls), now: NOW, usageFile };
  const missing = await fetchBenchmarkSourceSnapshot(base);
  const denied = await fetchBenchmarkSourceSnapshot({ ...base, termsRecord: { ...AA_TERMS, redistributionAllowed: false } });
  const noCost = await fetchBenchmarkSourceSnapshot({ ...base, termsRecord: { ...AA_TERMS, costAcknowledged: false } });
  for (const r of [missing, denied, noCost]) {
    assert.equal(r.ok, true);
    assert.equal(r.networkAttempted, true);
  }
  assert.equal(calls.length, 3);
  assert.equal(fs.existsSync(usageFile), true);
});

test('response size cap is enforced on bytes', async () => {
  const usageFile = tmp('usage.json');
  const big = 'x'.repeat(5 * 1024 * 1024);
  const byContentLength = await fetchBenchmarkSourceSnapshot({
    enabled: true, apiKey: 'k', now: NOW, usageFile, termsRecord: AA_TERMS,
    fetchImpl: async () => ({
      ok: true, status: 200, headers: { get: () => String(big.length) }, text: async () => { throw new Error('read'); },
    }),
  });
  assert.equal(byContentLength.code, 'size_exceeded');
  // Multi-byte characters: few chars, many bytes.
  const multi = await fetchBenchmarkSourceSnapshot({
    enabled: true, apiKey: 'k', now: NOW, usageFile, termsRecord: AA_TERMS, force: true,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '\u20ac'.repeat(1_500_000) }),
  });
  assert.equal(multi.code, 'size_exceeded');
});

test('concurrent fetches cannot exceed the daily budget', async () => {
  const calls = [];
  const usageFile = tmp('usage.json');
  fs.writeFileSync(usageFile, JSON.stringify({ 'artificial-analysis': { day: '2026-10-14', count: BENCHMARK_FETCH_DAILY_BUDGET - 1 } }));
  const base = { enabled: true, apiKey: 'k', fetchImpl: fakeFetch(200, AA_BODY, calls), now: NOW, usageFile, termsRecord: AA_TERMS, force: true };
  const results = await Promise.all([fetchBenchmarkSourceSnapshot(base), fetchBenchmarkSourceSnapshot(base)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.code === 'daily_limit').length, 1);
  assert.equal(calls.length, 1);
});

test('createModelPickRecord keeps costPolicy, costProxy, complexity and benchmark together', () => {
  const file = tmp('picks.sqlite');
  const rec = createModelPickRecord({
    file,
    role: 'implement',
    purpose: 'test',
    chatId: 'c1',
    picks: [{ harness: 'codex', model: 'gpt-5.6-sol' }],
    complexity: { level: 'standard', signals: [] },
    costProxy: { level: 'standard', selected: { candidateId: 'codex/gpt-5.6-sol', value: 1.2, basis: 'rate', tokenSource: 'role', tier: 2 }, candidates: [] },
    costPolicy: { mode: 'shadow', policyPick: 'codex/gpt-5.6-sol' },
    benchmark: { role: 'implement', candidates: [{ candidateId: 'a/b', status: 'ok', benchmark_score: 0.7, weight: 0.1, contribution: 0.02 }] },
  });
  assert.ok(rec.costPolicy, 'costPolicy kept');
  assert.ok(rec.costProxy, 'costProxy kept');
  assert.ok(rec.benchmark, 'benchmark kept');
  assert.ok(rec.complexity, 'complexity kept');
});
