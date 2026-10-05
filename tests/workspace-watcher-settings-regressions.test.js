/**
 * Regression tests for the Workspace Watcher settings editor fixes:
 *
 *  1. `formatCooldownLabel` stored ms but rendered the raw value for sub-minute
 *     durations ("30000 s"); it must convert 30_000 → "30 s".
 *  2. Emergency stop / clear-stop must PATCH only `stopReason` and never commit
 *     an unsaved mode radio or dirty policy field.
 *  3. An optimistic-save rollback must not clobber a fresher `lastView` written
 *     by a refresh that resolved while the PATCH was in flight.
 *
 * The panel has no jsdom in this suite, so the pure helpers are extracted from
 * source and exercised directly, and the remaining wiring is asserted from
 * source the same way the other settings UI tests do.
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

/** Slice a top-level `function name(...) { ... }` declaration out of source. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  return src.slice(start, i);
}

const stubT = (key) => ({
  'settings.watcherSecondUnit': 's',
  'settings.watcherMinuteUnit': 'min',
}[key] ?? key);

test('cooldown label converts stored milliseconds to human seconds/minutes', () => {
  const formatCooldownLabel = new Function(
    't',
    `${extractFunction(source, 'formatCooldownLabel')}; return formatCooldownLabel;`,
  )(stubT);

  // The regression: a 30s cooldown is stored as 30_000 ms and used to render
  // "30000 s"; it must read "30 s".
  assert.equal(formatCooldownLabel(30_000), '30 s');
  assert.equal(formatCooldownLabel(0), '0 s');
  assert.equal(formatCooldownLabel(1_000), '1 s');
  assert.equal(formatCooldownLabel(45_000), '45 s');
  // At/above a minute it switches unit and never divides again.
  assert.equal(formatCooldownLabel(60_000), '1 min');
  assert.equal(formatCooldownLabel(90_000), '1.5 min');
  assert.equal(formatCooldownLabel(600_000), '10 min');
});

test('the cooldown control is labelled in human units, not milliseconds', () => {
  assert.doesNotMatch(source, /settings\.watcherCooldownMs/, 'the ms-named label key is gone');
  assert.match(source, /t\('settings\.watcherCooldown'\)/, 'the slider uses the unit-neutral label');
  for (const [lang, dict] of [['en', en], ['pl', pl]]) {
    assert.ok(dict.settings?.watcherCooldown, `${lang}.settings.watcherCooldown is missing`);
    assert.doesNotMatch(
      dict.settings.watcherCooldown,
      /\bms\b|\(ms\)/i,
      `${lang} cooldown label still names milliseconds`,
    );
  }
});

test('buildWatcherPatchBody sends only the override keys for targeted actions', () => {
  const buildWatcherPatchBody = new Function(
    `${extractFunction(source, 'buildWatcherPatchBody')}; return buildWatcherPatchBody;`,
  )();

  // Even with a dirty mode checked in the form, a stop/clear-stop override must
  // not carry `mode` (or any policy) into the PATCH.
  const dirtyForm = { mode: 'autopilot', policy: { maxParallel: 5, cooldownMs: 30_000 } };
  const stopBody = buildWatcherPatchBody({ stopReason: 'Stopped from Settings' }, dirtyForm);
  assert.deepEqual(stopBody, { stopReason: 'Stopped from Settings' });
  assert.ok(!('mode' in stopBody), 'emergency stop must not commit a mode');
  assert.ok(!('policy' in stopBody), 'emergency stop must not commit policy');

  assert.deepEqual(buildWatcherPatchBody({ stopReason: '' }, dirtyForm), { stopReason: '' });
  assert.deepEqual(buildWatcherPatchBody({ paused: true }, dirtyForm), { paused: true });

  // A full save still writes the whole form.
  assert.deepEqual(
    buildWatcherPatchBody(null, dirtyForm),
    { mode: 'autopilot', policy: { maxParallel: 5, cooldownMs: 30_000 } },
  );
});

test('stop / clear-stop actions are wired to a stopReason-only override', () => {
  assert.match(source, /saveWatcher\(root, \{ stopReason: t\('settings\.watcherStoppedReason'\) \}\)/);
  assert.match(source, /saveWatcher\(root, \{ stopReason: '' \}\)/);
  // The form is no longer read for an override, and the old mode-commit line is
  // gone for good.
  assert.match(source, /const form = override \? null : readWatcherForm\(root\);/);
  assert.doesNotMatch(source, /body\.mode = form\.mode/);
  assert.match(source, /const body = buildWatcherPatchBody\(override, form\);/);
});

test('optimistic rollback is guarded by the cached-view generation', () => {
  assert.match(source, /let viewSeq = 0;/, 'a dedicated view generation counter exists');
  assert.match(source, /viewSeq \+= 1;/, 'refreshes and optimistic writes bump the generation');
  assert.match(source, /let optimisticViewSeq = /, 'the save records the generation it wrote');
  assert.match(
    source,
    /if \(viewSeq === optimisticViewSeq\) \{[\s\S]*?lastView = prevView;[\s\S]*?viewSeq \+= 1;[\s\S]*?\}/,
    'the rollback only restores the snapshot when no newer view replaced it',
  );
});

test('frontend validation covers scanner interval and quiet-hour semantics', () => {
  const validateFn = extractFunction(source, 'validateWatcherForm');
  // Quiet hours: both bounds well-formed HH:MM and not equal.
  assert.match(validateFn, /CLOCK_RE\.test\(start\)/);
  assert.match(validateFn, /CLOCK_RE\.test\(end\)/);
  assert.match(validateFn, /start === end/);
  assert.match(validateFn, /watcherValidationQuiet/);
  // Scanner interval: bounded 1..24 whenever Scout is enabled.
  assert.match(validateFn, /interval < 1 \|\| interval > 24/);
  assert.match(validateFn, /watcherValidationScoutInterval/);
  // The interval control itself is a 1..24 slider, so it cannot produce an
  // out-of-band value through the UI.
  assert.ok(source.includes('id="watcher-scout-interval" type="range" min="1" max="24"'));
  assert.ok(source.includes('id="watcher-scout-max-per-day" type="number" min="0"'));
  assert.match(extractFunction(source, 'readWatcherForm'), /scoutMaxPerDay:/);
  assert.match(extractFunction(source, 'resetWatcherForm'), /watcher-scout-max-per-day/);
  // Quiet-hour wrap is intentional (e.g. 23:00 → 07:00) and only rejected when
  // the bounds are malformed or equal.
  assert.match(source, /t\('settings\.watcherQuietWrapHint'\)/);
});
