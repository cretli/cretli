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
import { buildDelegationPatch, DELEGATION_LEGACY_FIELDS, DELEGATION_SUBTAB_FIELDS, summarizeReviewerPolicy, reviewerPolicyBaseline, selectReviewerPolicySubjects, toStoredPolicy } from '../app_front/features/settings/delegationSettings.js';
import { readAppScssSource } from './helpers/app-scss-source.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const source = read('app_front/features/settings/delegationSettings.js');
const html = read('public/index.html');
const app = read('app_front/App.js');
const docs = read('docs/ARCHITECTURE.md');

test('Delegations has Center / Limits / Review / Models subtabs in the Harness-style settings bar', () => {
  assert.match(html, /id="settings-delegation-tabs"[^>]*class|class="settings-tabs cr-tabs settings-subtabs" id="settings-delegation-tabs"/);
  for (const tab of ['delegations', 'delegations-limits', 'delegations-review', 'delegations-models']) {
    assert.ok(html.includes(`data-settings-tab="${tab}"`), `${tab} tab`);
  }
  for (const tab of ['limits', 'review', 'models']) {
    assert.ok(html.includes(`id="settings-delegation-${tab}-root"`), `${tab} root`);
  }
  assert.match(html, /data-settings-tab="delegations" role="tabpanel">[\s\S]*id="delegation-center-list"/, 'Center keeps the existing view');
});

test('subtabs expose every workspace and server delegation field', () => {
  const rendered = Object.values(DELEGATION_SUBTAB_FIELDS).flat().map((spec) => spec.field).sort();
  assert.deepEqual([...rendered, ...DELEGATION_LEGACY_FIELDS].sort(), [...DELEGATION_SETTING_FIELDS].sort());
  const limits = DELEGATION_SUBTAB_FIELDS.limits.map((s) => s.field);
  for (const f of ['parallel_implement_fanout', 'max_depth', 'tree_slot_limit', 'run_deadline_implement_ms', 'run_deadline_review_fix_ms', 'cancelling_timeout_ms', 'global_limit', 'queue_max']) {
    assert.ok(limits.includes(f), f);
  }
  const review = DELEGATION_SUBTAB_FIELDS.review.map((s) => s.field);
  for (const f of ['review_fanout', 'review_allow_uncertified', 'code_review_phase', 'code_review_max_closures', 'reviewer_policy']) {
    assert.ok(review.includes(f), f);
  }
  assert.deepEqual(DELEGATION_SUBTAB_FIELDS.models.map((s) => s.field), ['empty_favorites', 'plan_window_enabled', 'plan_window_hard_free_percent']);
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
  assert.match(source, /buildDelegationPatch\(\{ \.\.\.state\.data\?\.effective, reviewer_policy: reviewerPolicyBaseline/);
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
    if (spec.kind === 'reviewer_policy') continue;
    keys.add(`settings.delegationField_${spec.field}`);
    keys.add(`settings.delegationHint_${spec.field}`);
  }
  for (const tab of ['center', 'limits', 'review', 'models']) keys.add(`settings.delegationSubtab_${tab}`);
  for (const tab of ['limits', 'review', 'models']) keys.add(`settings.delegationSettings_${tab}Hint`);
  for (const s of ['workspace', 'env', 'default']) keys.add(`settings.delegationSource_${s}`);
  for (const o of ['deny', 'all']) keys.add(`settings.delegationEnum_empty_favorites_${o}`);
  for (const subject of ['plan', 'code']) {
    keys.add(`settings.reviewerSubject_${subject}`);
    keys.add(`settings.reviewerSubject_${subject}_heading`);
  }
  for (const [key, options] of [['selection', ['auto', 'fixed_pair']], ['members_source', ['learned', 'configured']], ['session', ['fresh', 'leaf', 'orchestrator']]]) {
    for (const o of options) keys.add(`settings.reviewerOption_${key}_${o}`);
  }
  for (const o of ['fresh', 'leaf', 'orchestrator']) keys.add(`settings.reviewerSummarySession_${o}`);
  for (const o of ['policy', 'legacy']) keys.add(`settings.reviewerSource_${o}`);
  for (const k of ['chat.delegationSessionFresh', 'chat.delegationReviewerPolicy']) keys.add(k);
  const get = (dict, key) => key.split('.').reduce((acc, part) => acc?.[part], dict);
  for (const key of keys) {
    assert.ok(typeof get(en, key) === 'string', `en ${key}`);
    assert.ok(typeof get(pl, key) === 'string', `pl ${key}`);
  }
});

test('Save footer is revealed for the delegations section and statuses are styled', () => {
  const appScss = readAppScssSource();
  const recipes = read('app_front/css/cr-recipes.scss');
  assert.match(appScss, /#settings-delegation-footer \{\s*display: flex;/);
  assert.match(appScss, /data-settings-tab='delegations-limits'/);
  assert.match(read('public/index.html'), /id="settings-delegation-footer"/);
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

test('reviewer policy: summary names the subject, selection and session scope; baseline mirrors the view', () => {
  const summary = summarizeReviewerPolicy('code', { selection: 'fixed_pair', members_source: 'learned', session: 'leaf' });
  assert.match(summary, /Code review|Review kodu/);
  assert.match(summary, /fixed pair|stała para/i);
  assert.match(summary, /subtask|podzadani/);
  assert.match(summarizeReviewerPolicy('plan', { selection: 'auto', session: 'fresh' }), /automatic|automatyczni/);
  const view = {
    plan: { selection: 'auto', members_source: 'learned', members: [], session: 'fresh', source: 'legacy' },
    code: { selection: 'fixed_pair', members_source: 'configured', members: [{ harness: 'a', model: 'm1' }, { harness: 'b', model: 'm2' }], session: 'orchestrator', source: 'policy' },
  };
  const baseline = reviewerPolicyBaseline(view);
  assert.deepEqual(Object.keys(baseline), ['plan', 'code']);
  assert.equal(baseline.code.members.length, 2);
  // Unchanged form -> no patch; a session change -> only reviewer_policy.
  assert.deepEqual(buildDelegationPatch({ reviewer_policy: baseline }, { reviewer_policy: structuredClone(baseline) }), {});
  const changed = structuredClone(baseline);
  changed.plan.session = 'leaf';
  assert.deepEqual(Object.keys(buildDelegationPatch({ reviewer_policy: baseline }, { reviewer_policy: changed })), ['reviewer_policy']);
  // Members are dropped unless the pair is chosen explicitly.
  assert.deepEqual(toStoredPolicy({ selection: 'fixed_pair', members_source: 'learned', members: view.code.members, session: 'x' }).members, []);
});

test('reviewer policy UI states the mode scope, implement/fix limitation and fallback behavior', () => {
  for (const key of ['reviewerScopeHint', 'reviewerImplementFixNote', 'reviewerFallbackHint', 'reviewerMigrationStrict']) {
    assert.ok(en.settings[key] && pl.settings[key], key);
  }
  assert.match(source, /data-reviewer-policy=/);
  assert.match(source, /data-reviewer-migration-notice/);
  // The legacy checkbox is gone from the controls.
  assert.doesNotMatch(source, /field: 'reviewer_pair_strict'/);
});

test('saving one review subject does not pin a legacy-derived subject', () => {
  const view = {
    plan: { selection: 'auto', members_source: 'learned', members: [], session: 'fresh', source: 'legacy' },
    code: { selection: 'fixed_pair', members_source: 'learned', members: [], session: 'leaf', source: 'legacy' },
  };
  const baseline = reviewerPolicyBaseline(view);
  // Editing plan only writes plan; the derived code subject stays absent.
  assert.deepEqual(
    Object.keys(selectReviewerPolicySubjects(view, baseline, { plan: { ...baseline.plan, session: 'leaf' }, code: { ...baseline.code } })),
    ['plan'],
  );
  // Nothing changed: the field is omitted entirely (no empty reviewer_policy).
  assert.deepEqual(
    selectReviewerPolicySubjects(view, baseline, { plan: { ...baseline.plan }, code: { ...baseline.code } }),
    {},
  );
  // An explicitly saved, untouched subject is preserved in the patch.
  const savedView = { ...view, code: { ...view.code, source: 'policy' } };
  assert.deepEqual(
    Object.keys(selectReviewerPolicySubjects(savedView, baseline, { plan: { ...baseline.plan, session: 'leaf' }, code: { ...baseline.code } })),
    ['plan', 'code'],
  );
});
