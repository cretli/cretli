import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyUsageLimitResumePatch } from '../lib/routes/usage-limit-resume-routes.js';
import { USAGE_LIMIT_RESUME_DEFAULTS, normalizeUsageLimitResumeSettings } from '../lib/usage-limit-resume-settings.js';
import {
  LIMIT_RESUME_NUMBER_FIELDS,
  LIMIT_RESUME_TOGGLE_FIELDS,
  buildLimitResumePatch,
  buildLimitResumeRowModel,
  renderLimitResumeRowsView as _renderLimitResumeRowsView,
} from '../app_front/features/usage/usageLimitResumeView.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { templateToString as _str } from './helpers/lit-template-string.js';
const renderLimitResumeRowsHtml = (...args) => _str(_renderLimitResumeRowsView(...args));

void ISOLATED_DATA_DIR;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const t = (key) => key;

test('PATCH validator: round-trip keeps valid values and fills defaults', () => {
  const first = applyUsageLimitResumePatch(undefined, { enabled: true, maxChain: 3 });
  assert.equal(first.ok, true);
  assert.equal(first.value.enabled, true);
  assert.equal(first.value.maxChain, 3);
  assert.equal(first.value.marginMs, USAGE_LIMIT_RESUME_DEFAULTS.marginMs);
  const second = applyUsageLimitResumePatch(first.value, { marginMs: 5000 });
  assert.equal(second.value.enabled, true, 'omitted keys keep the stored value');
  assert.deepEqual(normalizeUsageLimitResumeSettings(second.value), second.value);
});

test('PATCH validator: bounds are clamped and junk is dropped', () => {
  const result = applyUsageLimitResumePatch({}, {
    marginMs: 99_999_999, jitterMs: -5, maxChain: 99, maxPerTick: 0, catchUpMs: 'abc', enabled: 'yes', rogue: 1,
  });
  assert.equal(result.value.marginMs, 900_000);
  assert.equal(result.value.jitterMs, 0);
  assert.equal(result.value.maxChain, 5);
  assert.equal(result.value.maxPerTick, 1);
  assert.equal(result.value.catchUpMs, USAGE_LIMIT_RESUME_DEFAULTS.catchUpMs);
  assert.equal(result.value.enabled, false);
  assert.equal('rogue' in result.value, false);
  for (const bad of [null, [], 'x', 5]) assert.equal(applyUsageLimitResumePatch({}, bad).ok, false);
});

test('form values map to a patch; empty numeric fields are omitted', () => {
  const patch = buildLimitResumePatch({
    'usage-resume-enabled': true, 'usage-resume-allow-premium': false, 'usage-resume-delegations': true,
    'usage-resume-margin': '1500.4', 'usage-resume-jitter': '', 'usage-resume-max-chain': 'x',
  });
  assert.deepEqual(patch, { enabled: true, allowPremium: false, resumeDelegations: true, marginMs: 1500 });
  assert.deepEqual(Object.values(LIMIT_RESUME_NUMBER_FIELDS).sort(), ['catchUpMs', 'jitterMs', 'marginMs', 'maxChain', 'maxPerTick']);
  assert.equal(Object.keys(LIMIT_RESUME_TOGGLE_FIELDS).length, 3);
});

test('row rendering escapes every server-provided string', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = renderLimitResumeRowsHtml([{
    id: `p"><script>${evil}`, harness: evil, model: '"q"', subjectModel: evil, resetAt: 'not a date', state: 'armed', reason: evil,
  }], t, 'en');
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /data-limit-resume-cancel="p&quot;&gt;&lt;script&gt;/);
});

test('only armed rows can be cancelled; empty list shows the hint', () => {
  assert.equal(buildLimitResumeRowModel({ state: 'armed' }, t).canCancel, true);
  for (const state of ['resuming', 'resumed', 'cancelled', 'expired', 'blocked']) {
    assert.equal(buildLimitResumeRowModel({ state }, t).canCancel, false);
  }
  assert.match(renderLimitResumeRowsHtml([], t), /usageLimitResume\.empty/);
  assert.equal(renderLimitResumeRowsHtml([{ id: 'a', state: 'resumed' }], t).includes('data-limit-resume-cancel'), false);
});

test('index.html: the card lives inside the usage settings tab', () => {
  const html = read('public/index.html');
  const start = html.indexOf('data-settings-tab="usage" hidden');
  const end = html.indexOf('data-settings-tab="account"', start);
  assert.ok(start > 0 && end > start);
  const block = html.slice(start, end);
  for (const id of [...Object.keys(LIMIT_RESUME_TOGGLE_FIELDS), ...Object.keys(LIMIT_RESUME_NUMBER_FIELDS), 'usage-resume-save', 'usage-resume-list']) {
    assert.ok(block.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(/.test(block.slice(block.indexOf('usage-resume-title'))), false, 'no hardcoded colours');
});

test('every usageLimitResume key exists in pl.js and en.js', () => {
  const used = new Set();
  for (const rel of ['public/index.html', 'app_front/features/usage/usageSettings.js', 'app_front/features/usage/usageLimitResumeView.js']) {
    for (const m of read(rel).matchAll(/usageLimitResume\.([A-Za-z_]+)/g)) used.add(m[1]);
  }
  for (const state of ['armed', 'resuming', 'resumed', 'cancelled', 'expired', 'blocked']) used.add(`state_${state}`);
  used.delete('state_');
  assert.ok(used.size > 20);
  assert.deepEqual(Object.keys(en.usageLimitResume).sort(), Object.keys(pl.usageLimitResume).sort());
  for (const key of used) {
    assert.ok(typeof en.usageLimitResume[key] === 'string' && en.usageLimitResume[key], `en.${key}`);
    assert.ok(typeof pl.usageLimitResume[key] === 'string' && pl.usageLimitResume[key], `pl.${key}`);
  }
});
