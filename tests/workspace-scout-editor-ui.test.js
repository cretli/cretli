/**
 * Scout profile editor UI contract (stage 5.2).
 *
 * The pure editor helpers are imported directly (no DOM). The settings wiring is
 * asserted from source the way the other settings UI suites do: every rendered
 * editor action must be declared in `SCOUT_EDITOR_ACTIONS` and dispatched by the
 * panel, the preview must separate the technical `agent` transport from the host
 * read-only policy, and a template draft must never alias the catalog.
 *
 * PL/EN key parity is asserted for every new string so a half-translated editor
 * fails loudly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCOUT_EDITOR_ACTIONS,
  SCOUT_EDITOR_CATEGORIES,
  SCOUT_EDITOR_SOURCES,
  applyDraftEdit,
  draftFromProfile,
  draftFromTemplate,
  renderScoutEditorHtml,
  renderScoutPreviewHtml,
  renderScoutRestoreHtml,
  renderScoutTemplatesHtml,
  scoutEditorAdvancedFieldError,
  scoutEditorFieldErrors,
} from '../app_front/features/watcher/scoutProfileEditorView.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const settingsSource = readSource('app_front/features/settings/workspaceWatcherSettings.js');

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function draft(overrides = {}) {
  return {
    id: 'p1',
    revision: 3,
    name: 'Zapytania zamówień',
    objective: 'Znajdź wolne zapytania.',
    instructions: 'Wskaż plik i pomiar.',
    enabled: false,
    templateId: 'performance',
    templateVersion: '1',
    scope: { mode: 'area', base: 'main', include: ['lib/orders/**'], exclude: [] },
    sources: ['diff', 'logs'],
    categories: ['bug', 'improvement'],
    executor: { auto: true, harness: '', model: '', allowedHarnesses: [] },
    schedule: { mode: 'manual', intervalHours: 6 },
    limits: { maxPerDay: 4, maxFindingsPerScan: 10, timeoutMs: 60_000 },
    ...overrides,
  };
}

test('no rendered editor action is a dead action', () => {
  const html = renderScoutEditorHtml({ draft: draft(), mode: 'edit', profiles: [], selectedId: 'p1' });
  const rendered = new Set([...html.matchAll(/data-scout-editor-action="([^"]+)"/g)].map((match) => match[1]));
  assert.ok(rendered.size >= 5, 'the editor form renders an action set');
  for (const action of rendered) {
    assert.ok(SCOUT_EDITOR_ACTIONS.includes(action), `${action} is not declared in SCOUT_EDITOR_ACTIONS`);
    assert.ok(settingsSource.includes(`'${action}'`), `the settings panel does not dispatch ${action}`);
  }
  // The toolbar actions (no draft open) are dispatched too.
  const toolbar = renderScoutEditorHtml({ profiles: [{ id: 'p1', name: 'Perf', templateId: 'performance' }], selectedId: 'p1' });
  for (const action of [...toolbar.matchAll(/data-scout-editor-action="([^"]+)"/g)].map((match) => match[1])) {
    assert.ok(settingsSource.includes(`'${action}'`), `the settings panel does not dispatch ${action}`);
  }
  assert.match(settingsSource, /SCOUT_EDITOR_ACTIONS\.includes\(action\)/);
});

test('the editor form renders named fields, fieldsets and an alert role', () => {
  const html = renderScoutEditorHtml({
    draft: draft(),
    mode: 'edit',
    fieldErrors: { name: 'Name is required.' },
  });
  for (const field of ['name', 'objective', 'instructions', 'scope.base', 'schedule.intervalHours', 'executor.harness']) {
    assert.ok(html.includes(`data-scout-editor-field="${field}"`), `missing field ${field}`);
  }
  assert.match(html, /<fieldset[^>]*class="[^"]*watcher-scout-editor-group/);
  assert.match(html, /<legend>/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-scout-field-error="name"/);
  // The "Automatic scans" label describes `enabled`, and a manual run stays
  // available while it is off.
  assert.match(html, /watcherScoutAutoScansLabel|Automatic scans/);
});

test('category and source checkboxes render explicit draft values, not catalog defaults', () => {
  const html = renderScoutEditorHtml({ draft: draft({ categories: ['bug'], sources: ['diff'] }), mode: 'edit' });
  for (const category of SCOUT_EDITOR_CATEGORIES) {
    const tag = new RegExp(`data-scout-editor-toggle="categories" value="${category}"[^>]*`);
    const match = html.match(tag);
    assert.ok(match, `missing category checkbox ${category}`);
    if (category === 'bug') assert.match(match[0], /checked/);
    else assert.doesNotMatch(match[0], /checked/);
  }
  for (const source of SCOUT_EDITOR_SOURCES) {
    const match = html.match(new RegExp(`data-scout-editor-toggle="sources" value="${source}"[^>]*`));
    assert.ok(match, `missing source checkbox ${source}`);
    if (source === 'diff') assert.match(match[0], /checked/);
    else assert.doesNotMatch(match[0], /checked/);
  }
  // The list is never empty: an explicit draft always renders its checkboxes.
  assert.match(html, /<fieldset[^>]*>[\s\S]*data-scout-editor-toggle="categories"/);

  // The allowed-harnesses group is seeded from the canonical id set, so an
  // empty stored list still offers a choice, and a saved value stays selected.
  assert.match(html, /data-scout-editor-toggle="executor\.allowedHarnesses" value="opencode"/);
  const narrowed = renderScoutEditorHtml({
    draft: draft({ executor: { auto: false, harness: 'sdk', model: '', allowedHarnesses: ['sdk'] } }),
    mode: 'edit',
  });
  assert.match(narrowed, /data-scout-editor-toggle="executor\.allowedHarnesses" value="sdk" checked/);
});

test('the preview separates the agent transport from the host read-only policy', () => {
  const preview = {
    config: {
      objective: { value: 'o', source: 'template' },
      instructions: { value: 'i', source: 'profile' },
      categories: { value: ['bug'], source: 'default' },
      scope: { value: { mode: 'area' }, source: 'template' },
      sources: { value: ['diff'], source: 'profile' },
      executor: { value: { harness: 'sdk' }, source: 'profile' },
      schedule: { value: { mode: 'manual' }, source: 'default' },
      limits: { value: { maxPerDay: 4 }, source: 'default' },
    },
    prompt: 'You are the Workspace Scout for exactly ONE read-only scan.',
    matchedFiles: ['lib/orders/a.js'],
    blockers: [],
  };
  const html = renderScoutPreviewHtml({ preview });
  assert.match(html, /data-scout-transport="agent"/);
  assert.match(html, /data-scout-readonly="supported"/);
  assert.doesNotMatch(html, /Plan mode/i);
  assert.doesNotMatch(html, /PLAN mode/i);
  for (const provenance of ['default', 'template', 'profile']) {
    assert.ok(html.includes(`data-scout-provenance="${provenance}"`), `missing provenance badge ${provenance}`);
  }
  assert.match(html, /lib\/orders\/a\.js/);
  assert.match(html, /<details/);

  const unsupported = renderScoutPreviewHtml({
    preview: {
      ...preview,
      blockers: [{ code: 'read_only_unsupported_harness', message: 'nope' }],
    },
  });
  assert.match(unsupported, /data-scout-readonly="unsupported"/);
  assert.match(unsupported, /data-scout-blocker="read_only_unsupported_harness"/);
  assert.doesNotMatch(unsupported, /read_only_unsupported_harness<\/li>/, 'the blocker code is translated, not printed raw');
});

test('templates render a grid, an empty state, and restore skips an empty table', () => {
  const filled = renderScoutTemplatesHtml({
    templates: [{ id: 'performance', version: 1, name: 'Wydajność', description: 'd', objective: 'o' }],
  });
  assert.match(filled, /data-scout-template-id="performance"/);
  assert.match(filled, /data-scout-editor-action="template-pick" data-scout-id="performance"/);

  const emptyTemplates = renderScoutTemplatesHtml({ templates: [] });
  assert.match(emptyTemplates, /data-scout-templates-empty/);
  assert.doesNotMatch(emptyTemplates, /<table/);

  const emptyDiff = renderScoutRestoreHtml({ diff: [], templateId: 'performance' });
  assert.match(emptyDiff, /data-scout-restore-empty/);
  assert.doesNotMatch(emptyDiff, /<table/);
  assert.doesNotMatch(emptyDiff, /0 rows/);

  const filledDiff = renderScoutRestoreHtml({
    diff: [{ field: 'name', before: 'a', after: 'b' }],
    templateId: 'performance',
    scoutId: 'p1',
  });
  assert.match(filledDiff, /<table/);
  assert.match(filledDiff, /data-scout-editor-action="restore-confirm"/);
  assert.match(filledDiff, /data-scout-editor-action="restore-cancel"/);
});

test('draftFromTemplate deep copies every array and never aliases the catalog', () => {
  const template = Object.freeze({
    id: 'performance',
    version: 1,
    name: 'Wydajność',
    description: 'd',
    objective: 'o',
    instructions: 'i',
    scope: Object.freeze({
      mode: 'area',
      base: 'main',
      include: Object.freeze(['lib/**']),
      exclude: Object.freeze(['vendor/**']),
    }),
    sources: Object.freeze(['diff', 'logs']),
    categories: Object.freeze(['bug', 'improvement']),
  });
  const copy = draftFromTemplate(template);
  assert.notEqual(copy.sources, template.sources);
  assert.notEqual(copy.categories, template.categories);
  assert.notEqual(copy.scope, template.scope);
  assert.notEqual(copy.scope.include, template.scope.include);
  assert.notEqual(copy.scope.exclude, template.scope.exclude);
  copy.sources.push('gitHistory');
  copy.scope.include.push('lib/orders/**');
  copy.categories.length = 0;
  assert.deepEqual(template.sources, ['diff', 'logs']);
  assert.deepEqual(template.scope.include, ['lib/**']);
  assert.deepEqual(template.categories, ['bug', 'improvement']);
  assert.equal(copy.enabled, false, 'a template never opts into automatic scans');
  assert.equal(copy.schedule.mode, 'manual');

  // The overrides win and are copied too.
  const overridden = draftFromTemplate(template, { name: 'Zapytania zamówień' });
  assert.equal(overridden.name, 'Zapytania zamówień');
  assert.notEqual(overridden.scope.include, template.scope.include);
});

test('draftFromProfile and applyDraftEdit are immutable deep copies', () => {
  const profile = {
    ...draft(),
    scope: { mode: 'area', base: 'main', include: ['lib/**'], exclude: [] },
    sources: ['diff'],
    categories: ['bug'],
  };
  const copy = draftFromProfile(profile);
  assert.equal(copy.id, 'p1', 'the draft keeps the profile id for the edit route');
  assert.equal(copy.revision, 3, 'the draft keeps the CAS revision');
  assert.notEqual(copy.scope.include, profile.scope.include);
  assert.notEqual(copy.sources, profile.sources);
  copy.scope.include.push('x');
  assert.deepEqual(profile.scope.include, ['lib/**']);

  const edited = applyDraftEdit(copy, 'scope.include', ['a/**']);
  assert.deepEqual(edited.scope.include, ['a/**']);
  assert.deepEqual(copy.scope.include, ['lib/**', 'x'], 'the input draft is not mutated');
});

test('scoutEditorFieldErrors mirrors the server thresholds', () => {
  assert.deepEqual(scoutEditorFieldErrors(draft()), {});
  const errors = scoutEditorFieldErrors(draft({
    name: '',
    objective: '',
    categories: [],
    scope: { mode: 'area', base: 'main', include: ['../escape'], exclude: [] },
    schedule: { mode: 'interval', intervalHours: 0 },
    limits: { maxPerDay: -1, maxFindingsPerScan: 9999, timeoutMs: 60_000 },
    executor: { auto: true, harness: 'x', model: '', allowedHarnesses: ['y'] },
  }));
  assert.ok(errors.name);
  assert.ok(errors.objective);
  assert.ok(errors.categories);
  assert.ok(errors['scope.include']);
  assert.ok(errors['schedule.intervalHours']);
  assert.ok(errors['limits.maxPerDay']);
  assert.ok(errors['limits.maxFindingsPerScan']);
  assert.ok(errors['executor.harness']);
});

test('an explicit harness or model is unreachable while automatic selection is on', () => {
  const auto = renderScoutEditorHtml({ draft: draft(), mode: 'edit' });
  const autoHarness = auto.match(/<input[^>]*data-scout-editor-field="executor\.harness"[^>]*>/);
  const autoModel = auto.match(/<input[^>]*data-scout-editor-field="executor\.model"[^>]*>/);
  assert.ok(autoHarness, 'the harness field renders');
  assert.ok(autoModel, 'the model field renders');
  assert.match(autoHarness[0], /\bdisabled\b/, 'auto mode disables the explicit harness input');
  assert.match(autoModel[0], /\bdisabled\b/, 'auto mode disables the explicit model input');

  const explicit = renderScoutEditorHtml({
    draft: draft({ executor: { auto: false, harness: 'sdk', model: 'gpt-5', allowedHarnesses: [] } }),
    mode: 'edit',
  });
  const explicitHarness = explicit.match(/<input[^>]*data-scout-editor-field="executor\.harness"[^>]*>/);
  const explicitModel = explicit.match(/<input[^>]*data-scout-editor-field="executor\.model"[^>]*>/);
  assert.doesNotMatch(explicitHarness[0], /\bdisabled\b/, 'manual mode keeps the explicit harness editable');
  assert.doesNotMatch(explicitModel[0], /\bdisabled\b/, 'manual mode keeps the explicit model editable');

  // The panel couples the two modes: a typed explicit value leaves auto, and
  // re-checking auto clears the now-ignored explicit fields.
  assert.match(settingsSource, /'executor\.harness'.*'executor\.model'|'executor\.model'.*'executor\.harness'/);
  assert.match(settingsSource, /'executor\.auto', false/);
  assert.match(settingsSource, /'executor\.harness', ''/);
  assert.match(settingsSource, /'executor\.model', ''/);
});

test('the advanced section keeps its open state across a repaint', () => {
  const closed = renderScoutEditorHtml({ draft: draft(), mode: 'edit' });
  assert.match(closed, /<details class="watcher-scout-editor-advanced">/, 'the section starts collapsed');
  const open = renderScoutEditorHtml({ draft: draft(), mode: 'edit', advancedOpen: true });
  assert.match(open, /<details class="watcher-scout-editor-advanced" open>/, 'the open state drives the attribute');
  // `<details>` `toggle` does not bubble, so the panel must observe it in the
  // capture phase; an inline `on-toggle` attribute would be dead code.
  assert.match(settingsSource, /addEventListener\('toggle'[\s\S]{0,600}?\}, true\)/);
  assert.match(settingsSource, /advancedOpen: target\.open === true|advancedOpen: true/);
  assert.doesNotMatch(settingsSource, /on-toggle/);
});

test('an advanced-field validation error opens the section and shows a summary', () => {
  assert.equal(scoutEditorAdvancedFieldError({ 'limits.maxPerDay': 'x' }), true);
  assert.equal(scoutEditorAdvancedFieldError({ categories: 'x' }), true);
  assert.equal(scoutEditorAdvancedFieldError({ 'executor.harness': 'x' }), true);
  assert.equal(scoutEditorAdvancedFieldError({ sources: 'x' }), true);
  assert.equal(scoutEditorAdvancedFieldError({ name: 'x', 'scope.base': 'y' }), false);
  assert.equal(scoutEditorAdvancedFieldError({}), false);

  const html = renderScoutEditorHtml({
    draft: draft(),
    mode: 'edit',
    fieldErrors: { name: 'Name is required.', 'limits.maxPerDay': 'Too high.' },
    advancedOpen: true,
  });
  assert.ok(html.includes('data-scout-editor-errors'), 'the summary renders');
  assert.match(html, /data-tone="error"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-scout-error-field="limits\.maxPerDay"/);
  assert.match(html, /Too high\./);
  const summaryAt = html.indexOf('data-scout-editor-errors');
  const detailsAt = html.indexOf('<details');
  assert.ok(summaryAt >= 0 && detailsAt >= 0 && summaryAt < detailsAt, 'the summary sits above the advanced section');
  assert.match(settingsSource, /scoutEditorAdvancedFieldError/);
});

test('PL and EN define every new Scout editor key', () => {
  const keys = [
    'watcherScoutAutoScansLabel',
    'watcherScoutAutoScansHint',
    'watcherScoutEditorTitle',
    'watcherScoutEditorHint',
    'watcherScoutEditorNew',
    'watcherScoutEditorFromTemplate',
    'watcherScoutEditorPickProfile',
    'watcherScoutEditorNoProfile',
    'watcherScoutEditorEdit',
    'watcherScoutPreviewOpen',
    'watcherScoutRestoreOpen',
    'watcherScoutEditorModeCreate',
    'watcherScoutEditorModeTemplate',
    'watcherScoutEditorModeEdit',
    'watcherScoutEditorBasic',
    'watcherScoutEditorName',
    'watcherScoutEditorObjective',
    'watcherScoutEditorInstructions',
    'watcherScoutEditorScope',
    'watcherScoutEditorScopeMode',
    'watcherScoutEditorScopeBase',
    'watcherScoutEditorInclude',
    'watcherScoutEditorExclude',
    'watcherScoutEditorAdd',
    'watcherScoutEditorRemove',
    'watcherScoutEditorSchedule',
    'watcherScoutEditorScheduleMode',
    'watcherScoutEditorIntervalHours',
    'watcherScoutEditorAdvanced',
    'watcherScoutEditorSources',
    'watcherScoutEditorCategories',
    'watcherScoutEditorExecutor',
    'watcherScoutEditorExecutorAuto',
    'watcherScoutEditorHarness',
    'watcherScoutEditorModel',
    'watcherScoutEditorExecutorHint',
    'watcherScoutEditorAllowedHarnesses',
    'watcherScoutEditorMaxPerDay',
    'watcherScoutEditorMaxFindings',
    'watcherScoutEditorTimeoutMs',
    'watcherScoutEditorSave',
    'watcherScoutEditorCancel',
    'watcherScoutEditorClose',
    'watcherScoutEditorDirty',
    'watcherScoutEditorErrorsSummary',
    'watcherScoutEditorLoading',
    'watcherScoutEditorTemplateNote',
    'watcherScoutEditorCasConflict',
    'watcherScoutEditorReloadProfile',
    'watcherScoutEditorOverwrite',
    'watcherScoutEditorFromTemplateError',
    'watcherScoutEditorProfileError',
    'watcherScoutEditorPreviewError',
    'watcherScoutEditorRestoreDiffError',
    'watcherScoutEditorRestoreApplied',
    'watcherScoutEditorRestoreError',
    'watcherScoutEditorNoRestoreTemplate',
    'watcherScoutEditorOverwriteError',
    'watcherScoutEditorSaved',
    'watcherScoutPreviewTitle',
    'watcherScoutTransportAgent',
    'watcherScoutReadOnlySupported',
    'watcherScoutReadOnlyUnsupported',
    'watcherScoutPreviewModelStarted',
    'watcherScoutPreviewNoFiles',
    'watcherScoutPreviewNoBlockers',
    'watcherScoutPreviewPrompt',
    'watcherScoutPreviewFiles',
    'watcherScoutPreviewBlockers',
    'watcherScoutTemplatesTitle',
    'watcherScoutTemplatesHint',
    'watcherScoutTemplatesEmpty',
    'watcherScoutTemplatesUse',
    'watcherScoutRestoreTitle',
    'watcherScoutRestoreQuestion',
    'watcherScoutRestoreTemplateFallback',
    'watcherScoutRestoreEmpty',
    'watcherScoutRestoreField',
    'watcherScoutRestoreBefore',
    'watcherScoutRestoreAfter',
    'watcherScoutRestoreConfirm',
    'watcherScoutRestoreCancel',
    'watcherScoutRestoreConfirmHint',
    'watcherScoutFieldErrors_nameRequired',
    'watcherScoutFieldErrors_nameTooLong',
    'watcherScoutFieldErrors_objectiveRequired',
    'watcherScoutFieldErrors_textTooLong',
    'watcherScoutFieldErrors_categoriesRequired',
    'watcherScoutFieldErrors_tooManyGlobs',
    'watcherScoutFieldErrors_glob_text',
    'watcherScoutFieldErrors_glob_empty',
    'watcherScoutFieldErrors_glob_too_long',
    'watcherScoutFieldErrors_glob_control',
    'watcherScoutFieldErrors_glob_absolute',
    'watcherScoutFieldErrors_glob_escape',
    'watcherScoutFieldErrors_intervalInvalid',
    'watcherScoutFieldErrors_limitInvalid',
    'watcherScoutFieldErrors_limitTooHigh',
    'watcherScoutFieldErrors_harnessNotAllowed',
  ];
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of keys) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
  // Per-value keys used by the editor form.
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    for (const key of [
      'watcherScoutScopeMode_changes',
      'watcherScoutScopeMode_area',
      'watcherScoutScheduleMode_manual',
      'watcherScoutScheduleMode_interval',
      'watcherScoutSource_diff',
      'watcherScoutSource_gitHistory',
      'watcherScoutSource_todoMarkers',
      'watcherScoutSource_testResults',
      'watcherScoutSource_logs',
      'watcherScoutCategory_bug',
      'watcherScoutCategory_improvement',
      'watcherScoutCategory_refactor',
      'watcherScoutCategory_security',
      'watcherScoutCategory_opportunity',
      'watcherScoutCategory_documentation',
      'watcherScoutPreviewField_objective',
      'watcherScoutPreviewField_instructions',
      'watcherScoutPreviewField_categories',
      'watcherScoutPreviewField_scope',
      'watcherScoutPreviewField_sources',
      'watcherScoutPreviewField_executor',
      'watcherScoutPreviewField_schedule',
      'watcherScoutPreviewField_limits',
      'watcherScoutProvenance_default',
      'watcherScoutProvenance_template',
      'watcherScoutProvenance_profile',
      'watcherScoutBlocker_archived',
      'watcherScoutBlocker_category_unavailable',
      'watcherScoutBlocker_executor_unavailable',
      'watcherScoutBlocker_executor_harness_not_allowed',
      'watcherScoutBlocker_scope_requires_include',
      'watcherScoutBlocker_no_files_in_scope',
      'watcherScoutBlocker_read_only_unsupported_harness',
    ]) {
      assert.ok(dict.settings?.[key], `${lang}.settings.${key} is missing`);
    }
  }
});
