/**
 * Settings → Delegations subtabs UI contract (source assertions, no jsdom).
 * Pattern: tests/workspace-watcher-policy-editor-ui.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { DELEGATION_SETTING_FIELDS } from '../lib/delegation-settings-schema.js';
import { buildDelegationPatch, DELEGATION_SUBTAB_FIELDS } from '../app_front/features/settings/delegationSettings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const source = read('app_front/features/settings/delegationSettings.js');
const html = read('public/index.html');
const app = read('app_front/App.js');
const docs = read('docs/ARCHITECTURE.md');

test('Delegations section has Center / Limits / Review / Models subtabs on .cr-tabs', () => {
  assert.match(html, /id="delegation-subtabs" class="cr-tabs"/);
  for (const tab of ['center', 'limits', 'review', 'models']) {
    assert.ok(html.includes(`data-delegation-subtab="${tab}"`), `${tab} subtab button`);
    assert.ok(html.includes(`data-delegation-panel="${tab}"`), `${tab} panel`);
  }
  for (const tab of ['limits', 'review', 'models']) {
    assert.ok(html.includes(`id="settings-delegation-${tab}-root"`), `${tab} root`);
  }
  assert.match(html, /data-delegation-panel="center">[\s\S]*id="delegation-center-list"/, 'Center keeps the existing view');
});

test('subtabs expose every workspace and server delegation field', () => {
  const rendered = Object.values(DELEGATION_SUBTAB_FIELDS).flat().map((spec) => spec.field).sort();
  assert.deepEqual(rendered, [...DELEGATION_SETTING_FIELDS].sort());
  const limits = DELEGATION_SUBTAB_FIELDS.limits.map((s) => s.field);
  for (const f of ['max_depth', 'tree_slot_limit', 'run_deadline_implement_ms', 'run_deadline_review_fix_ms', 'cancelling_timeout_ms', 'global_limit', 'queue_max']) {
    assert.ok(limits.includes(f), f);
  }
  const review = DELEGATION_SUBTAB_FIELDS.review.map((s) => s.field);
  for (const f of ['review_fanout', 'parallel_implement_fanout', 'review_allow_uncertified', 'code_review_phase', 'code_review_max_closures', 'reviewer_pair_enabled', 'reviewer_pair_members']) {
    assert.ok(review.includes(f), f);
  }
  assert.deepEqual(DELEGATION_SUBTAB_FIELDS.models.map((s) => s.field), ['empty_favorites']);
});

test('every field shows env default and a source badge; server fields are read-only', () => {
  assert.match(source, /data-delegation-source=/);
  assert.match(source, /t\('settings\.delegationSettingsEnvDefault'\)/);
  assert.match(source, /data\.envDefault\?\.\[field\]/);
  assert.match(source, /data\.scope\?\.\[field\] === 'server'/);
  assert.match(source, /const dis = readOnly \? ' disabled' : ''/);
});

test('save sends PATCH with only changed fields and there is no second write path', () => {
  assert.match(source, /method: 'PATCH'/);
  assert.match(source, /buildDelegationPatch\(state\.data\?\.effective, values\)/);
  assert.deepEqual(
    buildDelegationPatch({ max_depth: 1, review_fanout: 2, reviewer_pair_members: [] }, { max_depth: 3, review_fanout: 2, reviewer_pair_members: [] }),
    { max_depth: 3 },
  );
  assert.deepEqual(buildDelegationPatch({ a: 1 }, { a: 1 }), {});
  assert.doesNotMatch(read('app_front/features/settings/workspaceWatcherSettings.js'), /api\/delegation-settings/);
});

test('reviewer pair members come from Settings favorites and need 0 or 2', () => {
  assert.match(source, /enabled_only=1/);
  assert.match(source, /data-delegation-pair-member=/);
  assert.match(source, /members\.length === 1/);
});

test('Usage and Watcher delegation fields link to the subtabs', () => {
  const usage = html.slice(html.indexOf('data-settings-tab="usage"'));
  assert.match(usage, /data-delegation-subtab-link="models"/);
  assert.match(usage, /data-delegation-subtab-link="review"/);
  const watcher = html.slice(html.indexOf('data-settings-tab="watcher" hidden'), html.indexOf('data-settings-tab="usage" hidden'));
  assert.match(watcher, /data-delegation-subtab-link="limits"/);
  assert.match(source, /closest\('\[data-delegation-subtab-link\]'\)/);
});

test('App wires the panel and docs describe the UI', () => {
  assert.match(app, /initDelegationSettings\(\)/);
  assert.match(app, /refreshDelegationSettings\(\)/);
  assert.match(docs, /Settings → Delegations[^\n]*(Limits|subtab)/);
});

test('i18n keys used by the module exist in pl and en', () => {
  const keys = new Set([...source.matchAll(/t\('(settings\.[A-Za-z_]+)'/g)].map((m) => m[1]));
  for (const spec of Object.values(DELEGATION_SUBTAB_FIELDS).flat()) {
    keys.add(`settings.delegationField_${spec.field}`);
    keys.add(`settings.delegationHint_${spec.field}`);
  }
  for (const tab of ['center', 'limits', 'review', 'models']) keys.add(`settings.delegationSubtab_${tab}`);
  for (const tab of ['limits', 'review', 'models']) keys.add(`settings.delegationSettings_${tab}Hint`);
  for (const s of ['workspace', 'env', 'default']) keys.add(`settings.delegationSource_${s}`);
  for (const o of ['deny', 'all']) keys.add(`settings.delegationEnum_empty_favorites_${o}`);
  const get = (dict, key) => key.split('.').reduce((acc, part) => acc?.[part], dict);
  for (const key of keys) {
    assert.ok(typeof get(en, key) === 'string', `en ${key}`);
    assert.ok(typeof get(pl, key) === 'string', `pl ${key}`);
  }
});

test('Save footer is revealed for the delegations section and statuses are styled', () => {
  const appScss = read('app_front/css/app.scss');
  const recipes = read('app_front/css/cr-recipes.scss');
  assert.match(appScss, /#settings-panel \.settings-section\[data-settings-tab='delegations'\]:not\(\[hidden\]\) \.cr-page-footer/);
  // A bare `#settings-panel:has(...delegations...) .cr-page-footer` would also match #settings-workspace-save-row.
  assert.doesNotMatch(appScss, /#settings-panel:has\(\.settings-section\[data-settings-tab='delegations'\][^)]*\)\)? \.cr-page-footer/);
  assert.match(recipes, /&\.is-error \{\s*color: var\(--cr-danger-text\)/);
  assert.match(recipes, /\.cr-status[\s\S]*\[data-tone='error'\] \{\s*color: var\(--cr-error\)/);
  assert.match(recipes, /\.cr-badge/);
  assert.match(source, /class="cr-badge" data-delegation-source/);
  assert.match(recipes, /cr-bar-button\.cr-field-action\s*\{\s*width: auto/);
});

test('saving re-renders only the saved subtab', () => {
  assert.match(source, /function renderAll\(only\)/);
  assert.match(source, /renderAll\(tab\);/);
  assert.match(source, /rerenderPreservingEdits/);
});

test('hidden delegation subpanels are really hidden', () => {
  const appScss = read('app_front/css/app.scss');
  const html = read('public/index.html');
  assert.match(appScss, /\[data-delegation-panel\]\[hidden\] \{\s*display: none;/);
  const wrappers = html.match(/<div data-delegation-panel="[a-z]+"[^>]*>/g) || [];
  assert.equal(wrappers.length, 4);
  for (const w of wrappers) assert.doesNotMatch(w, /class=/, w);
});
