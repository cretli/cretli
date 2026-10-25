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
import { resolveCrossRoleContinuation } from '../lib/delegation-settings.js';
import { readDelegationSubtab, readReviewSessions, buildDelegationPatch, CONTINUATION_FIELDS, DELEGATION_LEGACY_FIELDS, DELEGATION_SUBTAB_FIELDS, summarizeReviewerPolicy, reviewerPolicyBaseline, selectReviewerPolicySubjects, toStoredPolicy } from '../app_front/features/settings/delegationSettings.js';
import { readAppScssSource } from './helpers/app-scss-source.js';
import { readAppShellSource } from './helpers/app-shell-source.js';
import { registerWorkspaceWatcherRoutes } from '../lib/routes/workspace-watcher-routes.js';
import { tempDir } from './helpers/temp-git-repo.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const source = read('app_front/features/settings/delegationSettings.js');
const html = read('public/index.html');
const app = readAppShellSource();
const docs = read('docs/ARCHITECTURE.md');

test('Delegations has Center / Limits / Review / Sessions / Models subtabs in the Harness-style settings bar', () => {
  assert.match(html, /id="settings-delegation-tabs"[^>]*class|class="settings-tabs cr-tabs settings-subtabs" id="settings-delegation-tabs"/);
  for (const tab of ['delegations', 'delegations-limits', 'delegations-review', 'delegations-sessions', 'delegations-models']) {
    assert.ok(html.includes(`data-settings-tab="${tab}"`), `${tab} tab`);
  }
  for (const tab of ['limits', 'review', 'sessions', 'models']) {
    assert.ok(html.includes(`id="settings-delegation-${tab}-root"`), `${tab} root`);
  }
  assert.match(html, /data-settings-tab="delegations" role="tabpanel">[\s\S]*id="delegation-center-list"/, 'Center keeps the existing view');
});

test('subtabs expose every workspace and server delegation field', () => {
  // reviewer_policy is edited in two places on purpose: membership in Review, session scope in Sessions.
  const rendered = [...new Set(Object.values(DELEGATION_SUBTAB_FIELDS).flat().map((spec) => spec.field))].sort();
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
    if (spec.kind === 'reviewer_policy' || spec.kind === 'review_sessions') continue;
    keys.add(`settings.delegationField_${spec.field}`);
    keys.add(`settings.delegationHint_${spec.field}`);
  }
  for (const tab of ['center', 'limits', 'review', 'sessions', 'models']) keys.add(`settings.delegationSubtab_${tab}`);
  for (const tab of ['limits', 'review', 'sessions', 'models']) keys.add(`settings.delegationSettings_${tab}Hint`);
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
  const html = read('public/index.html');
  assert.match(html, /id="settings-delegation-save"/);
  assert.match(html, /data-settings-footer-for="delegations-limits delegations-review delegations-sessions delegations-models"/);
  assert.doesNotMatch(appScss, /data-settings-tab='delegations-limits'/);
  assert.match(recipes, /&\.is-error \{\s*color: var\(--cr-danger-text\)/);
  assert.match(recipes, /\.cr-status[\s\S]*\[data-tone='error'\] \{\s*color: var\(--cr-error\)/);
  assert.match(recipes, /\.cr-badge/);
  assert.match(source, /class="cr-badge" data-delegation-source/);
  assert.match(recipes, /cr-bar-button\.cr-field-action\s*\{\s*width: auto/);
});

test('Delegation panels opt into .cr-form and the tab rules stay on tokens', () => {
  const appScss = readAppScssSource();
  const recipes = read('app_front/css/cr-recipes.scss');
  // Every Delegation subtab wrapper opts into the native form recipe, the same
  // way watcherPanelAttrs() does for the Watcher panels.
  assert.match(html, /<section class="settings-section cr-form" data-settings-tab="delegations" role="tabpanel">/);
  for (const tab of ['limits', 'review', 'models', 'lessons']) {
    assert.match(html, new RegExp(`id="settings-delegation-${tab}-root" class="cr-form"`), `${tab} root opts into cr-form`);
  }
  // The Delegation rules live in their own app.scss partial (step 0 layout).
  assert.match(appScss, /@use '\.\/features\/settings\/delegation';/);
  const delegation = read('app_front/css/features/settings/_delegation.scss');
  const fontSizes = [...delegation.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const value of fontSizes) {
    assert.match(value, /var\(--cr-font-size-(xs|sm|md|lg|xl)\)/, `delegation font-size ${value}`);
  }
  assert.doesNotMatch(delegation, /font-size:\s*[^;]*\d+(?:\.\d+)?px/);
  assert.doesNotMatch(delegation, /!important/);
  // Off-scale literals the tab used before the migration are now tokens.
  assert.match(appScss, /\.settings-section-title \{[^}]*font-size: var\(--cr-font-size-lg\)/);
  assert.match(recipes, /\.cr-badge \{[^}]*font-size: var\(--cr-font-size-xs\)/);
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

test('favorites do not hold the first paint and reach tabs with unsaved edits', () => {
  // Settings render as soon as /api/delegation-settings answers.
  assert.doesNotMatch(source, /Promise\.all\(\[api\(API_PATH\), loadFavorites\(\)/);
  assert.match(source, /const favoritesLoad = loadFavorites\(\)\.catch\(\(\) => null\);\s*const \{ status, json \} = await api\(API_PATH\);/);
  // Clean tabs repaint; dirty tabs only get fresh reviewer-pair options.
  assert.match(source, /renderCleanTabs\(\);\s*refreshDirtyMemberOptions\(\);/);
  assert.match(source, /function refreshDirtyMemberOptions\(\) \{[\s\S]*?for \(const tab of state\.dirty\)[\s\S]*?memberSelectOptions\(String\(el\.value \|\| ''\)\)/);
  // Both pair renderers and the dirty refresh share one option builder
  // (its definition plus the two renderer calls).
  assert.equal(source.match(/memberSelectOptions\(current\)/g)?.length, 3);
});

test('Sessions subtab: three sections, five choices, one owner form, membership stays in Review', () => {
  assert.deepEqual(DELEGATION_SUBTAB_FIELDS.sessions.map((s) => s.field), ['continue_plan_sessions', 'plan_session_scope', 'continue_implement_sessions', 'implement_session_scope', 'continue_fix_sessions', 'fix_session_scope', 'continue_cross_role_sessions', 'reviewer_policy']);
  assert.ok(!DELEGATION_SUBTAB_FIELDS.review.some((s) => s.field.startsWith('continue_')), 'no continuation switch in Review');
  assert.ok(DELEGATION_SUBTAB_FIELDS.review.some((s) => s.kind === 'reviewer_policy'), 'membership stays in Review');
  for (const key of ['plan', 'work', 'review']) {
    for (const dict of [en, pl]) assert.equal(typeof dict.settings[`sessionsSection_${key}`], 'string');
  }
  // The Review membership form no longer renders a session select.
  assert.doesNotMatch(source, /select\('session'/);
});

test('Sessions subtab: cross-role switch is rendered, default off, saved, and warns about independence (en + pl)', async () => {
  const spec = DELEGATION_SUBTAB_FIELDS.sessions.find((row) => row.field === 'continue_cross_role_sessions');
  assert.equal(spec?.kind, 'continuation_bool', 'saved through the same checkbox path as the work switches');
  assert.match(source, /function renderCrossRoleSwitch\(data\)/);
  assert.match(source, /section\('cross', renderCrossRoleSwitch\(data\)\)/);
  assert.match(source, /data-cross-role-warning/);
  for (const dict of [en, pl]) {
    assert.equal(typeof dict.settings.sessionsSection_cross, 'string');
    assert.equal(typeof dict.settings.delegationField_continue_cross_role_sessions, 'string');
    assert.equal(typeof dict.settings.delegationHint_continue_cross_role_sessions, 'string');
    assert.match(dict.settings.delegationCrossRoleIndependenceWarning, /independent|niezależn/);
    assert.equal(typeof dict.chat.delegationSessionResumedCrossRole, 'string');
    assert.equal(typeof dict.chat.delegationSessionReasons.resume_cross_role_unsupported, 'string');
  }
  const dataDir = tempDir('cretli-cross-role-settings-data-');
  const workspace = tempDir('cretli-cross-role-settings-workspace-');
  try {
    const call = mountDelegationSettingsRoutes(dataDir, workspace);
    const defaults = (await call('GET')).body;
    assert.equal(defaults.effective.continue_cross_role_sessions, false, 'default off');
    assert.equal(defaults.source.continue_cross_role_sessions, 'default');
    assert.equal((await call('PATCH', { continue_cross_role_sessions: true })).status, 200);
    const stored = (await call('GET')).body;
    assert.equal(stored.effective.continue_cross_role_sessions, true);
    assert.equal(stored.source.continue_cross_role_sessions, 'workspace');
    assert.equal(resolveCrossRoleContinuation({ workspaceFolder: workspace, dataDir }), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

/** Minimal DOM stand-in: blocks with checkbox/select children, enough for readReviewSessions. */
function fakeSessionsRoot(rows) {
  const blocks = rows.map(({ subject, on, scope }) => {
    const controls = {
      continue: { checked: on },
      scope: { value: scope },
    };
    return {
      dataset: { sessionPolicy: subject },
      querySelector: (selector) => controls[/data-policy-key="(\w+)"/.exec(selector)?.[1]] || null,
    };
  });
  return { querySelectorAll: (selector) => (selector === '[data-session-policy]' ? blocks : []) };
}

function fakeSessionsForm(work, reviews) {
  const reviewRoot = fakeSessionsRoot(reviews);
  return {
    querySelector(selector) {
      const field = /data-delegation-field="([^"]+)"/.exec(selector)?.[1];
      return field ? { checked: work[field] === true, value: field.endsWith('_session_scope') ? (work[field] || 'leaf') : work[field] === true ? 'on' : 'off' } : null;
    },
    querySelectorAll: reviewRoot.querySelectorAll,
  };
}

function mountDelegationSettingsRoutes(dataDir, workspace) {
  const routes = new Map();
  const app = {};
  for (const method of ['get', 'put', 'patch', 'post', 'delete']) {
    app[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
  }
  registerWorkspaceWatcherRoutes(app, { dataDir, getCurrentCwd: () => workspace });
  return async (method, body = {}) => {
    const handler = routes.get(`${method} /api/delegation-settings`);
    assert.ok(handler, `${method} settings route`);
    let status = 200;
    let payload = null;
    const res = {
      status(code) { status = code; return res; },
      json(value) { payload = value; return res; },
    };
    await handler({ query: {}, body }, res);
    return { status, body: payload };
  };
}

test('readReviewSessions maps the checkbox + scope onto reviewer_policy.session and keeps membership', () => {
  const view = {
    plan: { selection: 'fixed_pair', members_source: 'learned', members: [], session: 'fresh', source: 'policy' },
    code: { selection: 'auto', members_source: 'learned', members: [], session: 'leaf', source: 'legacy' },
  };
  const root = fakeSessionsRoot([
    { subject: 'plan', on: true, scope: 'orchestrator' },
    { subject: 'code', on: false, scope: 'leaf' },
  ]);
  const out = readReviewSessions(root, view);
  assert.equal(out.plan.session, 'orchestrator');
  assert.equal(out.plan.selection, 'fixed_pair', 'membership untouched');
  assert.equal(out.code.session, 'fresh');
  // An untouched legacy-derived subject is not pinned.
  const same = readReviewSessions(fakeSessionsRoot([{ subject: 'code', on: true, scope: 'leaf' }]), view);
  assert.deepEqual(same, {});
});

test('Sessions form shows implement/fix on and plan off by default, and a stored false wins', async () => {
  const dataDir = tempDir('cretli-delegation-ui-default-data-');
  const workspace = tempDir('cretli-delegation-ui-default-workspace-');
  try {
    const call = mountDelegationSettingsRoutes(dataDir, workspace);
    const defaults = (await call('GET')).body;
    assert.equal(defaults.effective.continue_plan_sessions, false);
    assert.equal(defaults.effective.continue_implement_sessions, true);
    assert.equal(defaults.effective.continue_fix_sessions, true);
    assert.equal(defaults.effective.implement_session_scope, 'leaf');
    assert.equal(defaults.effective.fix_session_scope, 'leaf');
    for (const field of CONTINUATION_FIELDS) assert.equal(defaults.source[field], 'default', field);
    // Saving an unrelated setting does not materialise the switches.
    assert.equal((await call('PATCH', { review_fanout: 1 })).status, 200);
    const unrelated = (await call('GET')).body;
    for (const field of CONTINUATION_FIELDS) assert.equal(unrelated.source[field], 'default', field);
    assert.equal(unrelated.effective.continue_implement_sessions, true);
    // An explicit false is stored and wins over the default.
    assert.equal((await call('PATCH', { continue_implement_sessions: false })).status, 200);
    const stored = (await call('GET')).body;
    assert.equal(stored.effective.continue_implement_sessions, false);
    assert.equal(stored.source.continue_implement_sessions, 'workspace');
    assert.equal(stored.effective.continue_fix_sessions, true);
    assert.equal(stored.source.continue_fix_sessions, 'default');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Sessions form saves unchecked work switches through PATCH and reloads review-only changes', async () => {
  const dataDir = tempDir('cretli-delegation-ui-data-');
  const workspace = tempDir('cretli-delegation-ui-workspace-');
  try {
    const call = mountDelegationSettingsRoutes(dataDir, workspace);
    const seeded = await call('PATCH', {
      continue_plan_sessions: true,
      continue_implement_sessions: true,
      continue_fix_sessions: true,
    });
    assert.equal(seeded.status, 200);

    const loaded = (await call('GET')).body;
    const unchecked = fakeSessionsForm({
      continue_plan_sessions: false,
      continue_implement_sessions: false,
      continue_fix_sessions: false,
    }, [
      { subject: 'plan', on: false, scope: 'leaf' },
      { subject: 'code', on: false, scope: 'leaf' },
    ]);
    const readUnchecked = readDelegationSubtab(unchecked, 'sessions', loaded);
    assert.deepEqual(
      Object.fromEntries(CONTINUATION_FIELDS.map((field) => [field, readUnchecked.values[field]])),
      {
        continue_plan_sessions: false,
        continue_implement_sessions: false,
        continue_fix_sessions: false,
      },
      'continuation_bool reads checked, never the checkbox value "on"',
    );
    const offPatch = buildDelegationPatch(
      { ...loaded.effective, reviewer_policy: reviewerPolicyBaseline(loaded.reviewerPolicy) },
      readUnchecked.values,
    );
    assert.deepEqual(Object.keys(offPatch).sort(), [...CONTINUATION_FIELDS].sort());
    assert.equal((await call('PATCH', offPatch)).status, 200);

    const reloaded = (await call('GET')).body;
    for (const field of CONTINUATION_FIELDS) assert.equal(reloaded.effective[field], false, field);
    const unchangedRead = readDelegationSubtab(unchecked, 'sessions', reloaded);
    assert.deepEqual(
      buildDelegationPatch(
        { ...reloaded.effective, reviewer_policy: reviewerPolicyBaseline(reloaded.reviewerPolicy) },
        unchangedRead.values,
      ),
      {},
      'Save with no changes emits no PATCH fields',
    );

    const reviewOnlyRoot = fakeSessionsForm({
      continue_plan_sessions: false,
      continue_implement_sessions: false,
      continue_fix_sessions: false,
    }, [
      { subject: 'plan', on: true, scope: 'leaf' },
      { subject: 'code', on: false, scope: 'leaf' },
    ]);
    const reviewOnlyRead = readDelegationSubtab(reviewOnlyRoot, 'sessions', reloaded);
    const reviewOnlyPatch = buildDelegationPatch(
      { ...reloaded.effective, reviewer_policy: reviewerPolicyBaseline(reloaded.reviewerPolicy) },
      reviewOnlyRead.values,
    );
    assert.deepEqual(Object.keys(reviewOnlyPatch), ['reviewer_policy']);
    assert.equal((await call('PATCH', reviewOnlyPatch)).status, 200);
    const reviewReload = (await call('GET')).body;
    assert.equal(reviewReload.reviewerPolicy.plan.session, 'leaf');
    assert.equal(reviewReload.reviewerPolicy.code.session, 'fresh');
    for (const field of CONTINUATION_FIELDS) assert.equal(reviewReload.effective[field], false, field);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});


test('Sessions form PATCH persists each work scope independently and reloads it', async () => {
  const dataDir = tempDir('cretli-scope-ui-data-');
  const workspace = tempDir('cretli-scope-ui-workspace-');
  try {
    const call = mountDelegationSettingsRoutes(dataDir, workspace);
    const loaded = (await call('GET')).body;
    const form = fakeSessionsForm({
      continue_implement_sessions: true,
      implement_session_scope: 'orchestrator',
      plan_session_scope: 'leaf',
      fix_session_scope: 'leaf',
    }, []);
    const parsed = readDelegationSubtab(form, 'sessions', loaded);
    assert.equal(parsed.values.implement_session_scope, 'orchestrator');
    assert.equal(parsed.values.fix_session_scope, 'leaf');
    const patch = buildDelegationPatch(loaded.effective, parsed.values);
    assert.equal(patch.implement_session_scope, 'orchestrator');
    assert.equal(patch.fix_session_scope, undefined);
    assert.equal((await call('PATCH', patch)).status, 200);
    assert.equal((await call('GET')).body.effective.implement_session_scope, 'orchestrator');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
