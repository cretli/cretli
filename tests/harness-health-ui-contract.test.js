/**
 * Harness health UI contract: the i18n surface is complete in en+pl, the API
 * client exposes the two endpoints, the row renderer attaches the card, and the
 * card's `hidden` attribute is protected from flex `display` overrides.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} rel @returns {string} */
function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const modelSource = read('app_front/features/harness-health/harnessHealthModel.js');
const cardSource = read('app_front/features/harness-health/harnessHealthCard.js');
const cacheSource = read('app_front/features/harness-health/harnessHealthCache.js');
const harnessSource = read('app_front/harnessSettings.js');
const apiSource = read('app_front/api.js');
const scss = read('app_front/css/app.scss');

test('every harnessHealth.* key used by the UI exists in en and pl', () => {
  const keys = new Set();
  for (const source of [modelSource, cardSource, harnessSource]) {
    for (const match of source.matchAll(/harnessHealth\.([A-Za-z0-9_]+)/g)) {
      keys.add(match[1]);
    }
  }
  assert.ok(keys.size >= 30, `expected a substantial harness health surface, got ${keys.size}`);
  const missingEn = [...keys].filter((key) => typeof en.harnessHealth?.[key] !== 'string');
  const missingPl = [...keys].filter((key) => typeof pl.harnessHealth?.[key] !== 'string');
  assert.deepEqual(missingEn, [], 'missing English harnessHealth keys');
  assert.deepEqual(missingPl, [], 'missing Polish harnessHealth keys');
});

test('en and pl harnessHealth key sets match', () => {
  assert.deepEqual(
    Object.keys(en.harnessHealth).sort(),
    Object.keys(pl.harnessHealth).sort(),
    'en/pl harnessHealth key sets differ'
  );
});

test('API client exposes harness health read and lockout clear', () => {
  assert.match(apiSource, /export async function getHarnessHealth\(/);
  assert.match(apiSource, /export async function clearHarnessUsageLimit\(/);
  assert.match(apiSource, /\/api\/harnesses\/health/);
  assert.match(apiSource, /\/api\/harnesses\/\$\{id\}\/usage-limit\/clear/);
});

test('harness row renderer attaches the lazy health card', () => {
  assert.match(harnessSource, /import \{ attachHarnessHealthRow \} from '\.\/features\/harness-health\/harnessHealthCard\.js'/);
  assert.match(
    harnessSource,
    /listEl\.appendChild\(item\);\s*\n\s*\/\/[^\n]*\n\s*attachHarnessHealthRow\(item, row\.id, row\.label\);/
  );
});

test('card controller is lazy, cached and accessible', () => {
  assert.match(cacheSource, /HARNESS_HEALTH_CACHE_TTL_MS = 60 \* 1000/);
  assert.match(cardSource, /getHarnessHealth\(\{ from, to, fresh \}\)/);
  assert.match(cardSource, /toggle\.setAttribute\('aria-expanded'/);
  assert.match(cardSource, /aria-controls/);
  assert.match(cardSource, /window\.confirm\(t\('harnessHealth\.unlockConfirm'/);
  assert.match(cardSource, /clearHarnessUsageLimit\(record\.harnessId, \{ model \}\)/);
  assert.match(cardSource, /data-role="notice"/);
});

test('a lockout clear invalidates the cache before the forced refresh', () => {
  // The generation guard is what stops a pre-POST GET from winning the race.
  assert.match(cacheSource, /const seq = \+\+latestSeq/);
  assert.match(cacheSource, /if \(seq !== latestSeq\) return null/);
  assert.match(cacheSource, /cache = \{ at: now\(\), payload: data \}/);
  assert.match(cardSource, /healthCache\.invalidate\(\);\s*\n\s*renderExpandedCards\(\);\s*\n\s*await reloadCard\(record, true\)/);
});

test('a forced health GET bypasses the URL-keyed dedupeGetJson', () => {
  // Reusing an in-flight GET that started before the clear POST would let the
  // stale payload commit under the newest seq, so fresh must skip the map.
  const start = apiSource.indexOf('export async function getHarnessHealth(');
  assert.ok(start >= 0, 'getHarnessHealth must be exported');
  const end = apiSource.indexOf('\n}', start);
  assert.ok(end > start, 'getHarnessHealth body must close at column zero');
  const body = apiSource.slice(start, end + 2);
  assert.match(body, /if \(query\.fresh\) return apiFetchJson\(url, undefined, 'getHarnessHealth'\);/);
  assert.match(body, /return dedupeGetJson\(url, 'getHarnessHealth'\);/);
  assert.ok(
    body.indexOf('apiFetchJson') < body.indexOf('dedupeGetJson'),
    'the fresh branch must return before the dedupe fallback'
  );
  assert.match(
    cacheSource,
    /fetchHealth\(force \? \{ from, to, fresh: true \} : \{ from, to \}\)/,
    'the cache controller must forward fresh only for forced loads'
  );
});

test('the error state keeps the sticky notice slot for unlock feedback', () => {
  assert.match(cardSource, /function noticeSlotHtml/);
  assert.match(cardSource, /function setNotice\(record, message\)/);
  assert.match(cardSource, /harness-health-panel harness-health-error">'[\s\S]*?noticeSlotHtml\(record\)/);
});

test('the toggle aria-label tracks open/closed state and the active language', () => {
  assert.match(cardSource, /function applyToggleLabel/);
  assert.match(cardSource, /toggleAriaHide/);
  assert.match(cardSource, /toggleAriaShow/);
  assert.match(cardSource, /addEventListener\('cr-lang-changed'/);
});

test('health row keeps controls on one line with the card below', () => {
  assert.match(cardSource, /itemEl\.classList\.add\('harness-health-row'\)/);
  assert.match(scss, /\.harness-health-row \{[\s\S]*?grid-template-columns: auto auto minmax\(0, 1fr\) auto auto;/);
  assert.match(scss, /\.harness-health-card \{[\s\S]*?grid-column: 1 \/ -1;/);
});

test('health card keeps local contrast and larger mobile tap targets', () => {
  assert.match(scss, /--harness-health-muted: var\(--cr-text-subtle, var\(--cr-text-muted\)\)/);
  assert.match(scss, /@media \(max-width: 599px\) \{[\s\S]*?\.harness-health-toggle \{[\s\S]*?min-width: 2\.75rem;/);
  assert.match(scss, /@media \(max-width: 599px\) \{[\s\S]*?\.harness-health-refresh,[\s\S]*?min-height: 2\.75rem;/);
});

test('utilization is read as a stored percentage, never re-scaled per value', () => {
  assert.match(modelSource, /num \/ 100/);
  assert.doesNotMatch(modelSource, /num > 1 \? num \/ 100 : num/);
});

test('sparkline is an accessible image with a table fallback', () => {
  assert.match(modelSource, /role="img"/);
  assert.match(modelSource, /aria-label=/);
  assert.match(modelSource, /renderDailyTableHtml/);
  assert.match(modelSource, /<details class="harness-health-daily">/);
});

test('hidden attribute is protected from flex display overrides', () => {
  assert.match(scss, /\.harness-health-card\[hidden\][\s\S]*?display: none !important;/);
  assert.match(scss, /\.harness-health-panel\[hidden\]/);
});

test('renderers escape dynamic ledger text', () => {
  assert.match(modelSource, /escapeHtml\(/);
  assert.match(modelSource, /errorCode/);
  assert.match(modelSource, /lastErrors/);
});

test('no new runtime dependency is added for the card', () => {
  const pkg = JSON.parse(read('app_front/package.json'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assert.equal(deps.chart, undefined);
  assert.equal(deps['chart.js'], undefined);
});


test('every harness exposes a Statistics tab and a dedicated panel', () => {
  const html = read('public/index.html');
  for (const harness of ['sdk', 'openrouter', 'opencode', 'codebuddy', 'deepseek', 'qwen', 'claude', 'codex']) {
    assert.ok(html.includes(`data-settings-tab="harness-${harness}-stats" role="tab"`));
    assert.ok(html.includes(`data-settings-tab="harness-${harness}-stats" role="tabpanel"`));
  }
  const app = read('app_front/App.js');
  assert.match(app, /showHarnessStatistics\(getHarnessIdFromSettingsTab\(tabId\)\)/);
  assert.match(cardSource, /export async function showHarnessStatistics/);
});
