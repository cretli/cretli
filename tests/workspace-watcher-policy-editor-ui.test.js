/**
 * Workspace Watcher policy-editor UI contract.
 *
 * The Settings panel is real DOM and this suite has no jsdom, so — exactly like
 * `workspace-watcher-settings-ui.test.js` — the wiring is asserted from source.
 * This file covers the *policy editor* that the JSON-free form must expose:
 *   - mode as radios, not a <select>
 *   - workspace folder shown
 *   - cooldown as a ms→min slider
 *   - quiet hours as an enable toggle + HH:MM time inputs that wrap midnight
 *   - allowed harnesses as a checkbox multi-select driven by the catalog
 *   - the Scout block (toggle / 1-24h interval / auto-create / categories)
 *   - reset-to-defaults, client validation, and an optimistic status-card update
 * plus the critical backend rule that the maxParallel ceiling lives in
 * `normalizeWorkspaceWatcherPolicy`, not only in the HTML `max`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(
  path.join(root, 'app_front/features/settings/workspaceWatcherSettings.js'),
  'utf8',
);
const persistSource = fs.readFileSync(
  path.join(root, 'lib/persist/workspace-watchers-persist.js'),
  'utf8',
);

test('mode is a radio group (off/observe/autopilot), not a select', () => {
  assert.doesNotMatch(source, /<select id="watcher-mode"/, 'the old mode <select> is gone');
  assert.match(source, /type="radio"\s+name="watcher-mode"/);
  assert.match(source, /const MODES = \['off', 'observe', 'autopilot'\]/);
  assert.match(source, /name="watcher-mode" value="\$\{mode\}"/, 'radios are mapped over MODES');
  assert.match(source, /querySelector\('input\[name="watcher-mode"\]:checked'\)/, 'the form reads the checked radio');
});

test('the workspace folder is shown in the general section', () => {
  assert.match(source, /t\('settings\.watcherWorkspaceFolder'\)/);
  assert.match(source, /class="watcher-folder"/);
});

test('cooldown is a ms→min slider and the persisted default is 30s', () => {
  assert.ok(source.includes('id="watcher-cooldown" type="range"'), 'cooldown renders as a range slider');
  assert.match(source, /COOLDOWN_STEP_MS = 30_000/);
  assert.match(source, /function formatCooldownLabel\(ms\)/, 'a ms→min/second label helper exists');
  // The editor's reset mirror must equal the shipped server default (30s), so a
  // reset followed by a refetch never jumps.
  assert.match(source, /cooldownMs: 30_000/);
});

test('quiet hours expose an enable toggle, HH:MM time inputs, and a midnight-wrap hint', () => {
  assert.match(source, /id="watcher-quiet-enabled"/);
  assert.ok(source.includes('id="watcher-quiet-start" type="time"'), 'start uses a native time picker');
  assert.ok(source.includes('id="watcher-quiet-end" type="time"'), 'end uses a native time picker');
  assert.match(source, /t\('settings\.watcherQuietWrapHint'\)/);
  // Disabled (toggle off) sends an empty pair; the guardrails already read that
  // as "no quiet hours", so no separate server `enabled` flag is needed.
  assert.match(
    source,
    /quietHours: quietEnabled \? \{ start: quietStart, end: quietEnd \} : \{ start: '', end: '' \}/,
  );
});

test('allowed harnesses are a catalog-driven checkbox multi-select', () => {
  assert.match(source, /\/api\/harness-catalog\/harnesses/, 'the catalog is fetched');
  assert.match(source, /querySelectorAll\('\[data-harness\]:checked'\)/, 'checked harness ids are gathered');
  assert.match(source, /allowedHarnesses: harnesses,/);
  // Any already-allowed id the catalog no longer lists is still rendered so a
  // save can never silently drop it.
  assert.match(source, /harnessRows\.push\(\{ id, label: id \}\)/);
});

test('the Scout block renders toggle, 1-24h interval slider, auto-create and categories', () => {
  assert.match(source, /t\('settings\.watcherScoutSection'\)/);
  assert.match(source, /id="watcher-scout-enabled"/);
  assert.match(source, /id="watcher-scout-autocreate"/);
  assert.ok(
    source.includes('id="watcher-scout-interval" type="range" min="1" max="24"'),
    'interval is a 1-24h slider',
  );
  assert.match(source, /querySelectorAll\('\[data-scout-category\]:checked'\)/);
  for (const field of ['scoutEnabled', 'scoutIntervalHours', 'scoutAutoCreate', 'scoutCategories']) {
    assert.match(source, new RegExp(`${field}:`), `readWatcherForm sends ${field}`);
  }
  // Categories mirror the closed server set so the UI and allow-list can't drift.
  assert.match(source, /SCOUT_CATEGORIES = \['bug', 'improvement', 'refactor', 'security', 'opportunity', 'documentation'\]/);
});

test('a reset-to-defaults control fills the client default mirror (form-only, no PATCH)', () => {
  assert.match(source, /id="watcher-reset"/);
  assert.match(source, /function resetWatcherForm\(root\)/);
  assert.match(source, /addEventListener\('click', \(\) => resetWatcherForm\(root\)\)/);
  assert.match(source, /maxCyclesPerDay: 20/);
  assert.match(source, /maxConsecutiveFailures: 3/);
  assert.match(source, /maxParallel: 1/);
  // Reset must not itself fire a PATCH — it only repopulates the editor.
  const resetFn = source.slice(source.indexOf('function resetWatcherForm'));
  assert.doesNotMatch(resetFn.slice(0, resetFn.indexOf('\nconst ACTION_ENDPOINTS')), /method: 'PATCH'/);
});

test('the form validates client-side and surfaces errors in a dedicated node', () => {
  assert.match(source, /function validateWatcherForm\(root\)/);
  assert.match(source, /id="watcher-form-error"/);
  assert.match(source, /t\('settings\.watcherValidationMaxParallel'\)/);
  assert.match(source, /maxParallel < 1 \|\| maxParallel > 5/, 'maxParallel bounded 1..5 in the client too');
  // Save blocks on validation before the round-trip.
  assert.match(source, /const errors = validateWatcherForm\(root\);[\s\S]*?if \(errors\.length\) \{\s*showFormError\(root, errors\);\s*return;/);
});

test('a full save updates the status card optimistically, never the form', () => {
  assert.match(source, /const prevView = lastView;/, 'prior view is snapshotted for rollback');
  assert.match(source, /paintWatcherStatusCard\(root\);/, 'the isolated status card is repainted');
  // The optimistic repaint happens before the awaited PATCH.
  const saveFn = source.slice(source.indexOf('async function saveWatcher'));
  assert.ok(
    saveFn.indexOf('paintWatcherStatusCard(root)') < saveFn.indexOf("method: 'PATCH'"),
    'optimistic paint precedes the PATCH round-trip',
  );
  // The status card is isolated so repainting it cannot wipe the editable form.
  assert.match(source, /function paintWatcherStatusCard\(root\)/);
  assert.match(source, /<div id="watcher-status-card" class="cr-card watcher-status-card">/);
});

test('CRITICAL: maxParallel is capped in the backend normalizer, not only in HTML', () => {
  assert.match(
    persistSource,
    /maxParallel: Math\.min\(WORKSPACE_WATCHER_MAX_PARALLEL, Math\.max\(1, normalizeCount\(source\.maxParallel, 1\)\)\)/,
    'the store clamps maxParallel to [1, WORKSPACE_WATCHER_MAX_PARALLEL]',
  );
  assert.match(persistSource, /WORKSPACE_WATCHER_MAX_PARALLEL = 5/);
});

test('every new editor label exists in both en and pl', () => {
  const keys = [
    'watcherGeneral', 'watcherWorkspaceFolder', 'watcherLimits',
    'watcherSecondUnit', 'watcherMinuteUnit', 'watcherHourUnit',
    'watcherQuietHours', 'watcherQuietEnabled', 'watcherQuietWrapHint', 'watcherPlanGate',
    'watcherAllowedHarnessesHint', 'watcherNoHarnesses',
    'watcherScoutSection', 'watcherScoutEnabled', 'watcherScoutAutoCreate',
    'watcherScoutMaxParallel', 'watcherScoutMaxParallelHint',
    'watcherScoutInterval', 'watcherScoutCategories',
    'watcherCat_bug', 'watcherCat_improvement', 'watcherCat_refactor', 'watcherCat_security',
    'watcherCat_opportunity', 'watcherCat_documentation',
    'watcherOrchestrator', 'watcherResetDefaults',
    'watcherValidationMaxParallel', 'watcherValidationQuiet', 'watcherValidationScoutInterval',
  ];
  for (const key of keys) {
    assert.ok(typeof en.settings?.[key] === 'string' && en.settings[key].trim(), `en.settings.${key} is missing`);
    assert.ok(typeof pl.settings?.[key] === 'string' && pl.settings[key].trim(), `pl.settings.${key} is missing`);
  }
});
