/**
 * Settings → Usage sub-views: markup contract and the view switch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGE_VIEWS, applyUsageView, normalizeUsageView } from '../app_front/features/usage/usageViews.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const sectionStart = html.indexOf('data-settings-tab="usage" hidden role="tabpanel"');
const section = html.slice(sectionStart, html.indexOf('</section>', sectionStart));

test('every sub-view has a tab and a host', () => {
  for (const view of USAGE_VIEWS) {
    assert.match(section, new RegExp(`data-usage-view-tab="${view}"`), `${view} tab`);
    assert.match(section, new RegExp(`data-usage-view="[^"]*\\b${view}\\b`), `${view} host`);
  }
});

test('each block lives in the sub-view that loads it', () => {
  const hostOf = (id) => {
    const at = section.indexOf(`id="${id}"`);
    assert.ok(at > 0, `${id} exists`);
    const open = section.lastIndexOf('data-usage-view="', at);
    return section.slice(open + 'data-usage-view="'.length, section.indexOf('"', open + 'data-usage-view="'.length));
  };
  assert.equal(hostOf('usage-billing'), 'billing');
  assert.equal(hostOf('usage-plan-limits'), 'limits');
  assert.equal(hostOf('usage-resume-list'), 'limits');
  assert.equal(hostOf('delegation-stats-table'), 'delegations');
  assert.equal(hostOf('usage-retention-days'), 'settings');
  assert.equal(hostOf('usage-kpis'), 'overview analysis');
  assert.equal(hostOf('usage-top'), 'overview analysis');
});

test('unknown views fall back to Overview', () => {
  assert.equal(normalizeUsageView('billing'), 'billing');
  assert.equal(normalizeUsageView('nope'), 'overview');
  assert.equal(normalizeUsageView(null), 'overview');
});

test('applyUsageView toggles hosts, parts and tab state', () => {
  const el = (attrs) => ({
    hidden: false,
    tabIndex: 0,
    attrs: { ...attrs },
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
  });
  const shared = el({ 'data-usage-view': 'overview analysis', id: 'usage-view-overview' });
  const billing = el({ 'data-usage-view': 'billing' });
  const overviewPart = el({ 'data-usage-view-part': 'overview' });
  const analysisPart = el({ 'data-usage-view-part': 'analysis' });
  const tabs = USAGE_VIEWS.map((view) => el({ 'data-usage-view-tab': view }));
  const rootNode = {
    querySelectorAll(sel) {
      if (sel === '[data-usage-view]') return [shared, billing];
      if (sel === '[data-usage-view-part]') return [overviewPart, analysisPart];
      if (sel === '[data-usage-view-tab]') return tabs;
      return [];
    },
    querySelector: (sel) => (sel === '#usage-view-overview' ? shared : null),
  };
  applyUsageView('analysis', rootNode);
  assert.equal(shared.hidden, false);
  assert.equal(billing.hidden, true);
  assert.equal(overviewPart.hidden, true);
  assert.equal(analysisPart.hidden, false);
  assert.equal(tabs.find((tab) => tab.attrs['data-usage-view-tab'] === 'analysis').attrs['aria-selected'], 'true');
  assert.equal(shared.attrs['aria-labelledby'], 'usage-view-tab-analysis');
  applyUsageView('billing', rootNode);
  assert.equal(shared.hidden, true);
  assert.equal(billing.hidden, false);
});
