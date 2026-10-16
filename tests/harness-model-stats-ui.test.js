/**
 * Settings → Harness "Model prices and statistics" (L6): pure view model,
 * rendering rules (money vs proxy, attribution) and i18n/markup wiring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import {
  buildHarnessModelStatsViewModel,
  formatPricedValue,
  renderHarnessModelStatsHtml,
} from '../app_front/features/harness-health/harnessModelStatsModel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const t = (key) => key.split('.').reduce((acc, part) => acc?.[part], en) ?? key;

const payload = {
  ok: true,
  priced_stats: {
    attribution: { text: 'Benchmark data: Artificial Analysis', url: 'https://artificialanalysis.ai/' },
    by_level: [
      {
        harness: 'openrouter', model: 'acme/model-x', role: 'implement', level: 'trivial', billing_class: 'api_metered',
        n: 5, usable_rate: 0.8, infra_fail_rate: 0, median_min: 4,
        price_per_1m: { unit: 'usd', is_money: true, input: 1, output: 4, source: 'openrouter_pricing', captured_at: '2026-10-13T00:00:00Z', estimated: false },
        cost_per_pass: { value: 0.02, unit: 'usd', is_money: true, source: 'usage_ledger', captured_at: '2026-10-14T10:00:00Z' },
        benchmark: { status: 'ok', benchmark_score: 0.7, source: 'artificial-analysis', captured_at: '2026-10-12T00:00:00Z', stale: false },
      },
      {
        harness: 'claude', model: 'claude-opus-5-5', role: 'review', level: 'unknown', billing_class: 'unknown',
        n: 2, usable_rate: 1, infra_fail_rate: 0,
        price_per_1m: { unit: 'rcu', is_money: false, input: 5, output: 25, source: 'token_rates', captured_at: '2026-09-30', estimated: true },
        cost_per_pass: { value: 0.05, unit: 'rcu', is_money: false, source: 'cost_proxy', captured_at: '2026-09-30' },
        benchmark: null,
      },
    ],
  },
};

test('formatPricedValue: dollar sign only for is_money usd', () => {
  assert.equal(formatPricedValue({ unit: 'usd', is_money: true }, 1.5, 2), '$1.50');
  assert.equal(formatPricedValue({ unit: 'rcu', is_money: false }, 1.5, 2), '1.50 RCU');
  assert.equal(formatPricedValue({ unit: 'usd', is_money: false }, 1.5, 2), '1.50 RCU');
  assert.equal(formatPricedValue(null, null), '—');
});

test('render: proxy rows never show a currency sign, attribution is credited', () => {
  const model = buildHarnessModelStatsViewModel(payload);
  assert.equal(model.rows.length, 2);
  const out = renderHarnessModelStatsHtml(model, t);
  assert.match(out, /\$1\.00 \/ \$4\.00/, 'metered price in usd');
  assert.match(out, /\$0\.0200/, 'measured cost per pass in usd');
  const proxyRow = out.split('<tr>').find((row) => row.includes('claude-opus-5-5'));
  assert.ok(proxyRow && !proxyRow.includes('$'), 'a proxy row has no currency sign');
  assert.match(proxyRow, /RCU/);
  assert.match(out, /href="https:\/\/artificialanalysis\.ai\/"/);
  assert.match(out, /Artificial Analysis/);
});

test('render: a non-http(s) attribution URL never becomes an href', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'not a url']) {
    const bad = { ...payload, priced_stats: { ...payload.priced_stats, attribution: { text: 'x', url } } };
    const out = renderHarnessModelStatsHtml(buildHarnessModelStatsViewModel(bad), t);
    assert.doesNotMatch(out, /<a [^>]*href=/, `no anchor for ${url}`);
    assert.doesNotMatch(out, /href="(javascript|data):/i);
    assert.match(out, /Artificial Analysis/);
  }
});

test('empty payload renders the empty hint', () => {
  const out = renderHarnessModelStatsHtml(buildHarnessModelStatsViewModel({ ok: true }), t);
  assert.match(out, /No finished delegations/);
});

function keysOf(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object'
    ? keysOf(v, `${prefix}${k}.`)
    : [`${prefix}${k}`]));
}

test('i18n: en and pl define the same harnessModelStats keys', () => {
  assert.deepEqual(keysOf(pl.harnessModelStats).sort(), keysOf(en.harnessModelStats).sort());
});

test('markup: section and controls exist in index.html', () => {
  for (const id of ['harness-model-stats-section', 'harness-model-stats-refresh', 'harness-model-stats-output']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
});
