import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nothing } from 'lit';
import { CrUsageKpis } from '../app_front/features/usage/components/cr-usage-kpis.js';
import { createUsageState, usageState } from '../app_front/features/usage/state/usageState.js';
import { clearUsageContent, renderUsage } from '../app_front/features/usage/usageDom.js';
import {
  renderBreakdownCardsView,
  renderBreakdownHeadView,
  renderBreakdownRowsView,
  renderChartTableHeadView,
  renderChartTableRowsView,
  renderLegendView,
} from '../app_front/features/usage/views/usageBreakdownView.js';
import { renderHarnessBillingView } from '../app_front/features/usage/billingView.js';
import { renderSubscriptionsView } from '../app_front/features/usage/billingSubscriptions.js';
import { sectionHint } from '../app_front/features/usage/usageInsightsView.js';
import { templateToString } from './helpers/lit-template-string.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usageDir = path.join(root, 'app_front/features/usage');
const t = (key) => key;

/** @param {string} rel */
function walk(rel) {
  const dir = path.join(usageDir, rel);
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? walk(path.join(rel, entry.name))
    : (entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : [])));
}

test('Usage state exposes reactive summary and language signals', () => {
  const state = createUsageState();
  const sample = { tokens: { input: 12 } };
  state.summary.set(sample);
  assert.equal(state.summary.get(), sample);
  assert.equal(typeof usageState.language.get, 'function');
});

test('KPI element re-renders from signals (reactive update)', () => {
  const state = createUsageState();
  state.zoneDay.set('2026-05-10');
  state.language.set('en');
  const el = new CrUsageKpis();
  el.state = state;
  state.summary.set({ kpi: { today: { usd: 1.5, tokens: 1000, runs: 2, successRate: 1 }, week: {}, month: {} } });
  const first = templateToString(el.render());
  assert.match(first, /id="usage-kpi-today-cost">\$1\.50<\//);
  assert.match(first, /id="usage-kpi-week-cost">\$0\.00<\//);
  state.summary.set({ kpi: { today: { usd: 7.25, tokens: 5, runs: 0 }, week: {}, month: {} } });
  const second = templateToString(el.render());
  assert.match(second, /id="usage-kpi-today-cost">\$7\.25<\//);
  assert.notEqual(first, second);
});

test('renderUsage ignores a missing host and clearUsageContent does not throw', () => {
  assert.doesNotThrow(() => renderUsage(null, nothing));
  assert.doesNotThrow(() => clearUsageContent(undefined));
});

test('Breakdown head renders sortable headers with aria-sort for tr/thead hosts', () => {
  const columns = [
    { key: 'label', labelKey: 'usage.colModel', sortable: false },
    { key: 'tokens', labelKey: 'usage.colTokens', sortable: true },
    { key: 'usd', labelKey: 'usage.colCost', sortable: true },
  ];
  const out = templateToString(renderBreakdownHeadView(columns, { sortKey: 'tokens', sortDir: 'asc' }, t));
  assert.match(out, /^<tr>/);
  assert.match(out, /<th scope="col">usage\.colModel<\/th>/);
  assert.match(out, /aria-sort="ascending"><button type="button" class="settings-usage-sort is-active" data-sort-key="tokens">usage\.colTokens<span class="settings-usage-sort-arrow" aria-hidden="true">▲<\/span>/);
  assert.match(out, /aria-sort="none"><button type="button" class="settings-usage-sort" data-sort-key="usd">/);
});

test('Breakdown rows and cards (tbody and narrow cards) escape labels and show share', () => {
  const rows = [
    { label: '<img src=x>', harness: '', usd: 2, tokens: 10, totalTokens: 1500, runs: 4, okRuns: 3, errorRuns: 1, successRate: 0.75, p95LatencyMs: 120 },
    { label: 'b', usd: 0, tokens: 0, totalTokens: 0, runs: 0, okRuns: 0, errorRuns: 0, successRate: null, p95LatencyMs: null },
  ];
  const ctx = { max: 10, total: 10, lang: 'en', sortKey: 'tokens', t, label: (row) => row.label };
  const body = templateToString(renderBreakdownRowsView(rows, ctx));
  assert.equal(body.match(/<tr>/g).length, 2);
  assert.match(body, /&lt;img src=x&gt;/);
  assert.doesNotMatch(body, /<img/);
  assert.match(body, /settings-usage-share-fill" style="width:100%"/);
  assert.match(body, /<td>120 ms<\/td>/);
  const cards = templateToString(renderBreakdownCardsView(rows, ctx));
  assert.equal(cards.match(/<article class="settings-usage-card">/g).length, 2);
  assert.match(cards, /<dt>usage\.colCost<\/dt>/);
});

test('Chart table (thead + tbody) and legend render series and bucket totals', () => {
  const model = {
    buckets: ['2026-05-01', '2026-05-02'],
    series: [{ label: 'gpt', colorIndex: 1, total: 30, values: [10, 20] }],
    bucketTotals: [10, 20],
  };
  const head = templateToString(renderChartTableHeadView(model, t));
  assert.match(head, /<th scope="col">usage\.chartBucket<\/th><th scope="col">gpt<\/th><th scope="col">usage\.chartTotal<\/th>/);
  const body = templateToString(renderChartTableRowsView(model, 'tokens', 'en'));
  assert.match(body, /<th scope="row">2026-05-02<\/th><td>20<\/td><td>20<\/td>/);
  const legend = templateToString(renderLegendView(model, 'tokens', 'en'));
  assert.match(legend, /settings-usage-series-1/);
  assert.match(legend, /settings-usage-legend-value">30<\//);
});

test('Select option lists and hints are Lit templates, not parsed strings', () => {
  assert.match(templateToString(sectionHint('a < b')), /^<p class="settings-hint">a &lt; b<\/p>$/);
  assert.equal(templateToString(renderHarnessBillingView('qwen', { accounts: [] }, { t })), '');
  const subs = templateToString(renderSubscriptionsView({ subscriptions: [] }, { t }));
  assert.match(subs, /billing\.subEmpty/);
});

test('No Usage module builds HTML strings or touches innerHTML / DOMParser', () => {
  for (const file of walk('.')) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    assert.doesNotMatch(source, /\.innerHTML\s*=/, rel);
    assert.doesNotMatch(source, /DOMParser|setUsageContent|insertAdjacentHTML/, rel);
    assert.doesNotMatch(source, /\.join\(''\)/, `${rel} should compose Lit templates, not concatenated strings`);
  }
});

test('usageSettings.js stays under the 1000-line size limit', () => {
  const lines = fs.readFileSync(path.join(usageDir, 'usageSettings.js'), 'utf8').split('\n').length;
  assert.ok(lines <= 1000, `usageSettings.js has ${lines} lines`);
});
