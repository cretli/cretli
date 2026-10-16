import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_ALIAS_CURRENT_ID, estimateTokenRates } from '../lib/usage/usage-rates.js';
import { listFallbackClaudeModels } from '../lib/claude/claude-models.js';
import {
  TIER_RATE_TABLE,
  buildCostProxyForPick,
  buildCostProxyQualityReport,
  buildCostProxyQualityReportFromRecords,
  collectTokenSamples,
  estimateCostProxy,
  leaveOneOutCalibrationError,
  loadCostProxyConfig,
  normalizeCostProxyConfig,
} from '../lib/model-pick-cost-proxy.js';
import { normalizeCostProxy } from '../lib/model-pick-cost-proxy-record.js';
import { pickAndPersistModelForPurpose } from '../lib/model-pick-service.js';
import { getModelPickRecord } from '../lib/persist/model-pick-decisions-persist.js';

const roleOfRow = (row) => row.role;
const emptySamples = collectTokenSamples([], roleOfRow);

function rows(n, model, role, level, tin, tout) {
  return Array.from({ length: n }, () => ({
    role,
    executor: { model },
    complexity: { level },
    metrics: { tokens_in: tin, tokens_out: tout },
  }));
}

test('alias map matches the numbered Claude catalog ids', () => {
  const ids = new Set(listFallbackClaudeModels().map((m) => m.value));
  for (const id of Object.values(CLAUDE_ALIAS_CURRENT_ID)) assert.ok(ids.has(id), id);
});

test('opus alias, effort variant and numbered id share the 5/25 rate', () => {
  const a = estimateTokenRates('opus::effort=low', 'other');
  const b = estimateTokenRates('claude-opus-5-5::effort=low', 'other');
  assert.deepEqual(a, b);
  assert.equal(a.textInput, 5);
  assert.equal(a.textOutput, 25);
  const proxy = estimateCostProxy({ harness: 'claude', model: 'opus::effort=low', role: 'implement', samples: emptySamples });
  assert.equal(proxy.basis, 'rate');
});

test('sonnet alias is a rate; default alias has no rate and uses the tier table', () => {
  const sonnet = estimateCostProxy({ harness: 'claude', model: 'sonnet::effort=medium', role: 'review', samples: emptySamples });
  assert.equal(sonnet.basis, 'rate');
  assert.equal(sonnet.rates.input, 3);
  assert.equal(estimateTokenRates('default', 'other'), null);
});

test('unknown model has no rate: no OpenRouter fallback, tier table used', () => {
  assert.equal(estimateTokenRates('acme/unknown-model', 'openrouter'), null);
  const proxy = estimateCostProxy({ harness: 'openrouter', model: 'acme/unknown-model', role: 'implement', samples: emptySamples });
  assert.equal(proxy.basis, 'tier_table');
  assert.notDeepEqual(proxy.rates, { input: 0.15, output: 0.6 });
  assert.deepEqual(proxy.rates, TIER_RATE_TABLE[proxy.tier]);
});

test('exact OpenRouter catalog pricing is a rate', () => {
  const r = estimateTokenRates('acme/m', 'openrouter', { openrouterPricing: { prompt: '0.000001', completion: '0.000004' } });
  assert.equal(r.textInput, 1);
  assert.equal(r.textOutput, 4);
  assert.equal(r.source, 'openrouter_pricing');
});

test('token source: history, then role, then constant', () => {
  const model = 'claude-sonnet-5-5';
  const history = collectTokenSamples(rows(5, model, 'implement', 'standard', 1000, 200), roleOfRow);
  const hit = estimateCostProxy({ harness: 'claude', model, role: 'implement', level: 'standard', samples: history });
  assert.equal(hit.tokenSource, 'history');
  assert.deepEqual(hit.tokens, { input: 1000, output: 200 });
  const perRole = estimateCostProxy({ harness: 'claude', model: 'claude-haiku-5-5', role: 'implement', level: 'standard', samples: history });
  assert.equal(perRole.tokenSource, 'role');
  const constant = estimateCostProxy({ harness: 'claude', model, role: 'review', level: 'standard', samples: history });
  assert.equal(constant.tokenSource, 'constant');
  const fewer = collectTokenSamples(rows(4, model, 'implement', 'standard', 1000, 200), roleOfRow);
  assert.equal(estimateCostProxy({ harness: 'claude', model, role: 'implement', level: 'standard', samples: fewer }).tokenSource, 'constant');
});

test('same effort factor for rate and tier_table; none for history volumes', () => {
  const rate = (model) => estimateCostProxy({ harness: 'claude', model, role: 'implement', samples: emptySamples });
  const low = rate('claude-sonnet-5-5::effort=low');
  const high = rate('claude-sonnet-5-5::effort=high');
  const factor = high.tokens.input / low.tokens.input;
  assert.ok(factor > 1);
  assert.equal(high.rates.input, low.rates.input);
  const tierLow = estimateCostProxy({ harness: 'openrouter', model: 'acme/x::reasoning_effort=low', role: 'implement', samples: emptySamples });
  const tierHigh = estimateCostProxy({ harness: 'openrouter', model: 'acme/x::reasoning_effort=high', role: 'implement', samples: emptySamples });
  assert.equal(tierHigh.basis, 'tier_table');
  assert.equal(tierHigh.tokens.input / tierLow.tokens.input, factor);
  assert.deepEqual(tierHigh.rates, tierLow.rates);
  const hist = collectTokenSamples(rows(5, 'claude-sonnet-5-5::effort=high', 'implement', 'standard', 500, 100), roleOfRow);
  const h = estimateCostProxy({ harness: 'claude', model: 'claude-sonnet-5-5::effort=high', role: 'implement', level: 'standard', samples: hist });
  assert.deepEqual(h.tokens, { input: 500, output: 100 });
});

test('auto/default has no tier and no rate: basis empty, value null', () => {
  const proxy = estimateCostProxy({ harness: 'claude', model: 'default', role: 'implement', samples: emptySamples });
  assert.equal(proxy.basis, 'empty');
  assert.equal(proxy.value, null);
});

test('value is in RCU and never carries a usd field', () => {
  const proxy = estimateCostProxy({ harness: 'claude', model: 'claude-opus-5-5', role: 'review', samples: emptySamples });
  assert.equal(proxy.unit, 'rcu');
  assert.ok(!('usd' in proxy));
  const expected = (proxy.tokens.input * 5 + proxy.tokens.output * 25) / 1e6;
  assert.ok(Math.abs(proxy.value - expected) < 1e-9);
  const block = buildCostProxyForPick({
    pickResult: { picks: [{ harness: 'claude', model: 'claude-opus-5-5' }], candidates: [{ harness: 'claude', model: 'claude-sonnet-5-5' }] },
    role: 'review', level: 'standard', rows: [], roleOfRow,
  });
  assert.ok(!JSON.stringify(block).includes('usd'));
  assert.equal(block.candidates.length, 2);
  assert.equal(normalizeCostProxy({ ...block, usd: 3, selected: { ...block.selected, usd: 3 } }).selected.usd, undefined);
});

test('operator config overrides tier table; invalid values are ignored', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')), 'profiles.json');
  fs.writeFileSync(file, JSON.stringify({ costProxy: { tierRateTable: { 3: { input: 7, output: 9 }, 4: { input: -1, output: 1 } } } }));
  const config = loadCostProxyConfig({ filePath: file });
  assert.deepEqual(config.tierRateTable[3], { input: 7, output: 9 });
  assert.deepEqual(config.tierRateTable[4], TIER_RATE_TABLE[4]);
  assert.deepEqual(normalizeCostProxyConfig(null).tierRateTable[5], TIER_RATE_TABLE[5]);
});

test('leave-one-out is undetermined below n=5 and numeric above', () => {
  const mk = (model, tier, input, output) => ({ model, tier, rates: { input, output } });
  assert.equal(leaveOneOutCalibrationError([mk('a', 3, 3, 15), mk('b', 3, 3, 15)]).undetermined, true);
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((m) => mk(m, 3, 3, 15));
  const res = leaveOneOutCalibrationError(many);
  assert.equal(res.undetermined, false);
  assert.equal(res.meanAbsError, 0);
});

test('quality report: shares, empty and calibration', () => {
  const s = collectTokenSamples(rows(5, 'claude-sonnet-5-5', 'implement', 'standard', 1000, 100), roleOfRow);
  const estimates = [
    estimateCostProxy({ harness: 'claude', model: 'claude-sonnet-5-5', role: 'implement', level: 'standard', samples: s }),
    estimateCostProxy({ harness: 'claude', model: 'claude-opus-5-5', role: 'implement', level: 'standard', samples: s }),
    estimateCostProxy({ harness: 'openrouter', model: 'acme/x', role: 'implement', level: 'standard', samples: s }),
    estimateCostProxy({ harness: 'claude', model: 'default', role: 'implement', samples: s }),
  ];
  const report = buildCostProxyQualityReport({ estimates });
  assert.equal(report.n, 4);
  assert.equal(report.basisRateShare, 0.5);
  assert.equal(report.emptyShare, 0.25);
  assert.equal(report.tokenSourceHistoryShare, 0.25);
  assert.equal(report.historyShareMet, false);
  assert.equal(report.leaveOneOut.undetermined, true);
  assert.equal(report.holdout.undetermined, true);
});

test('pick journals cost_proxy with basis/tokenSource and does not alter selection', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')), 'picks.json');
  const base = {
    role: 'implement',
    purpose: 'test',
    chatId: 'c1',
    harnesses: [{ id: 'codex', enabled: true, ready: true, can_delegate: true }],
    delegations: [],
    modelsByHarness: { codex: { favorites_configured: true, items: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }] } },
    now: Date.parse('2026-10-14T12:00:00Z'),
    shadow: false,
    explore: false,
    file,
  };
  const a = pickAndPersistModelForPurpose({ ...base, costProxyConfig: normalizeCostProxyConfig(null) });
  const b = pickAndPersistModelForPurpose({ ...base, costProxyConfig: normalizeCostProxyConfig({ tierRateTable: { 1: { input: 99, output: 99 }, 3: { input: 99, output: 99 } } }) });
  assert.equal(a.ok, true, JSON.stringify(a.error || a.diagnosis || {}).slice(0, 300));
  assert.deepEqual(a.pick, b.pick);
  assert.equal(a.costProxy.unit, 'rcu');
  const record = getModelPickRecord(a.pickId, { file });
  assert.ok(record.costProxy.selected);
  assert.ok(['rate', 'tier_table', 'empty'].includes(record.costProxy.selected.basis));
  assert.ok(['history', 'role', 'constant'].includes(record.costProxy.selected.tokenSource));
  assert.ok(!JSON.stringify(record.costProxy).includes('usd'));
});

test('(model, role) history is reachable even without a persisted level', () => {
  const model = 'claude-sonnet-5-5';
  // Rows written before the level was journaled have no `complexity`.
  const noLevel = Array.from({ length: 5 }, () => ({
    role: 'implement',
    executor: { model },
    metrics: { tokens_in: 800, tokens_out: 160 },
  }));
  const samples = collectTokenSamples(noLevel, roleOfRow);
  const asked = estimateCostProxy({ harness: 'claude', model, role: 'implement', level: 'standard', samples });
  assert.equal(asked.tokenSource, 'history');
  assert.deepEqual(asked.tokens, { input: 800, output: 160 });
  const askedWithoutLevel = estimateCostProxy({ harness: 'claude', model, role: 'implement', samples });
  assert.equal(askedWithoutLevel.tokenSource, 'history');
  // A different model still falls back to the all-role median.
  const other = estimateCostProxy({ harness: 'claude', model: 'claude-haiku-5-5', role: 'implement', samples });
  assert.equal(other.tokenSource, 'role');
});

test('selected marks the real pick and is null when the primary pair is unusable', () => {
  const picked = buildCostProxyForPick({
    pickResult: {
      pick: { harness: 'claude', model: 'claude-opus-5-5' },
      picks: [{ harness: 'claude', model: 'claude-opus-5-5' }],
      candidates: [{ harness: 'claude', model: 'claude-sonnet-5-5' }],
    },
    role: 'review', level: 'standard', rows: [], roleOfRow,
  });
  assert.equal(picked.selected.candidateId, 'claude/claude-opus-5-5');
  const noPrimary = buildCostProxyForPick({
    pickResult: { picks: [{ harness: '', model: '' }], candidates: [{ harness: 'claude', model: 'claude-sonnet-5-5' }] },
    role: 'review', level: 'standard', rows: [], roleOfRow,
  });
  assert.equal(noPrimary.selected, null);
  assert.equal(noPrimary.candidates.length, 1);
  assert.equal(noPrimary.candidates[0].candidateId, 'claude/claude-sonnet-5-5');
});

test('quality report from persisted records collects candidates and falls back to selected', () => {
  const records = {
    a: {
      id: 'a',
      costProxy: {
        unit: 'rcu',
        level: 'standard',
        selected: null,
        candidates: [
          { candidateId: 'claude/claude-opus-5-5', value: 1, basis: 'rate', tokenSource: 'history', tier: 4 },
          { candidateId: 'openrouter/acme/x', value: 1, basis: 'tier_table', tokenSource: 'role', tier: 3 },
        ],
      },
    },
    b: {
      id: 'b',
      costProxy: {
        unit: 'rcu',
        level: '',
        selected: { candidateId: 'claude/claude-sonnet-5-5', value: 1, basis: 'rate', tokenSource: 'history', tier: 2 },
        candidates: [],
      },
    },
    c: { id: 'c' },
  };
  const report = buildCostProxyQualityReportFromRecords(records);
  assert.equal(report.n, 3);
  assert.equal(report.tokenSourceHistoryShare, 0.6667);
  assert.equal(report.historyShareMet, true);
  assert.equal(buildCostProxyQualityReportFromRecords(null).n, 0);
});

test('quality report from records hydrates exact rates so leave-one-out is measurable', () => {
  const candidates = [
    ['claude/claude-opus-5-5', 4],
    ['claude/opus', 4],
    ['claude/claude-sonnet-5-5', 2],
    ['claude/sonnet', 2],
    ['claude/claude-haiku-5-5', 1],
    ['claude/haiku', 1],
  ].map(([candidateId, tier]) => ({ candidateId, value: 1, basis: 'rate', tokenSource: 'history', tier }));
  const records = { p: { id: 'p', costProxy: { unit: 'rcu', level: '', selected: null, candidates } } };
  const report = buildCostProxyQualityReportFromRecords(records);
  assert.equal(report.n, 6);
  assert.equal(report.leaveOneOut.undetermined, false);
  assert.equal(report.leaveOneOut.n, 6);
  assert.equal(report.leaveOneOut.meanAbsError, 0);
});

test('a throwing openrouter pricing getter degrades to no costProxy and keeps the pick', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-')), 'picks.json');
  const base = {
    role: 'implement',
    purpose: 'test',
    chatId: 'c-openrouter',
    harnesses: [{ id: 'openrouter', enabled: true, ready: true, can_delegate: true }],
    delegations: [],
    modelsByHarness: {
      openrouter: { favorites_configured: true, items: [{ id: 'acme/x', roles: ['implement'], cost_tier: 3, quality_tier: 3, speed_tier: 3 }] },
    },
    now: Date.parse('2026-10-14T12:00:00Z'),
    shadow: false,
    explore: false,
    file,
  };
  const ok = pickAndPersistModelForPurpose({
    ...base,
    openrouterPricingFor: () => ({ prompt: '0.000001', completion: '0.000004' }),
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.error || ok.diagnosis || {}).slice(0, 300));
  assert.equal(ok.pick.harness, 'openrouter');
  assert.equal(ok.costProxy.selected.basis, 'rate');

  const throwing = pickAndPersistModelForPurpose({
    ...base,
    chatId: 'c-openrouter-throw',
    openrouterPricingFor: () => { throw new Error('pricing cache exploded'); },
  });
  assert.equal(throwing.ok, true, 'a proxy failure never fails the pick');
  assert.equal(throwing.costProxy, null);
  assert.deepEqual(throwing.pick, ok.pick);
});
