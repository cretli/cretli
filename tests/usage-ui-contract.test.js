/**
 * Usage settings UI contract: the static section exposes the controls the
 * module wires, and every `usage.*` key used by the HTML/JS exists in both
 * dictionaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const settingsSource = fs.readFileSync(
  path.join(root, 'app_front/features/usage/usageSettings.js'),
  'utf8'
);

/** @returns {string} */
function usageSection() {
  const start = html.indexOf('<section class="settings-section" data-settings-tab="usage"');
  assert.ok(start > 0, 'usage settings section is missing');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

/**
 * @param {object} dict
 * @param {string} key dotted path
 * @returns {unknown}
 */
function lookup(dict, key) {
  return key
    .split('.')
    .reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), dict);
}

test('usage section exposes the wired ids and accessible chart', () => {
  const section = usageSection();
  for (const id of [
    'usage-range-select',
    'usage-metric-select',
    'usage-group-select',
    'usage-summary-period',
    'usage-summary-empty',
    'usage-loading',
    'usage-error',
    'usage-error-text',
    'usage-retry',
    'usage-content',
    'usage-kpi-error',
    'usage-chart',
    'usage-chart-title',
    'usage-chart-empty',
    'usage-chart-section-error',
    'usage-chart-legend',
    'usage-chart-table',
    'usage-table-section-error',
    'usage-table-title',
    'usage-export-csv',
    'usage-breakdown',
    'usage-breakdown-head',
    'usage-breakdown-body',
    'usage-breakdown-cards',
    'usage-breakdown-empty',
    'usage-kpi-today-cost',
    'usage-kpi-week-cost',
    'usage-kpi-month-cost',
  ]) {
    assert.match(section, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(section, /id="usage-chart"[^>]*role="img"/);
  assert.match(section, /id="usage-chart-table"/);
});

test('usage section offers every range, metric and grouping option', () => {
  const section = usageSection();
  for (const option of ['value="24h"', 'value="7d"', 'value="30d"']) {
    assert.match(section, new RegExp(option));
  }
  for (const option of ['value="tokens"', 'value="usd"', 'value="runs"']) {
    assert.match(section, new RegExp(option));
  }
  for (const option of ['value="harness"', 'value="model"']) {
    assert.match(section, new RegExp(option));
  }
});

test('every usage.* key used by the UI exists in en and pl', () => {
  const keys = new Set();
  for (const source of [usageSection(), settingsSource]) {
    for (const match of source.matchAll(/(["'`])usage\.([A-Za-z0-9_]+)\1/g)) {
      keys.add(`usage.${match[2]}`);
    }
  }
  assert.ok(keys.size > 30, 'expected a substantial usage i18n surface');
  const missingEn = [...keys].filter((key) => typeof lookup(en, key) !== 'string');
  const missingPl = [...keys].filter((key) => typeof lookup(pl, key) !== 'string');
  assert.deepEqual(missingEn, [], 'missing English usage keys');
  assert.deepEqual(missingPl, [], 'missing Polish usage keys');
  assert.deepEqual(
    Object.keys(en.usage).sort(),
    Object.keys(pl.usage).sort(),
    'en/pl usage key sets differ'
  );
});

test('usage section uses per-row p95 and drops the range-level note', () => {
  const section = usageSection();
  assert.doesNotMatch(section, /usage-p95-note/);
  assert.doesNotMatch(section, /usage\.p95Range/);
  // 24h is the current UTC day, so the label must say so instead of "24 h".
  assert.match(section, /data-i18n="usage\.range24h"/);
});
