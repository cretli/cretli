import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCheckRowModel,
  buildKindFields,
  describeRunNowResult,
  formatCheckProgress,
  renderChecksHtml,
  buildKindSettingsPatch,
  buildWakeupQuery,
  buildWakeupRowModel,
  formatWakeupTime,
  renderKindFilterOptions,
  renderKindsHtml,
  renderStateFilterOptions,
  renderStatusHtml,
  renderJobsHtml,
  renderWakeupRowsHtml,
} from '../app_front/features/wakeups/wakeupsView.js';
import { USAGE_LIMIT_RESUME_SETTINGS_SCHEMA } from '../lib/usage-limit-resume-settings.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { readAppShellSource } from './helpers/app-shell-source.js';

void ISOLATED_DATA_DIR;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
const usageKind = {
  kind: 'usage_limit_resume', label: 'Usage <b>', description: 'desc', enabled: true,
  settings: { enabled: true, marginMs: 5000 }, settingsSchema: USAGE_LIMIT_RESUME_SETTINGS_SCHEMA,
};

test('empty rows render an empty-state hint; a null dueAt renders a dash', () => {
  assert.match(renderWakeupRowsHtml([], t), /wakeups\.empty/);
  assert.match(renderWakeupRowsHtml(undefined, t), /wakeups\.empty/);
  const model = buildWakeupRowModel({ id: 'a', kind: 'k', state: 'armed', dueAt: null }, t);
  assert.equal(model.dueAt, '—');
  assert.equal(formatWakeupTime('garbage'), '—');
  const html = renderWakeupRowsHtml([{ id: 'a', kind: 'k', state: 'armed', dueAt: null, attempts: 2 }], t);
  assert.match(html, /<td>—<\/td>/);
});

test('Cancel is offered for armed rows only; ids and text are escaped', () => {
  const html = renderWakeupRowsHtml([
    { id: 'x"><i>', kind: 'k', state: 'armed', reason: '<script>' },
    { id: 'b', kind: 'k', state: 'resumed' },
  ], t, 'en', { k: 'Kind <K>' });
  assert.equal((html.match(/data-wakeup-cancel=/g) || []).length, 1);
  assert.ok(!html.includes('<script>') && !html.includes('<i>'));
  assert.ok(html.includes('Kind &lt;K&gt;'));
  assert.equal(buildWakeupRowModel({ state: 'weird' }, t).state, 'weird');
  assert.equal(buildWakeupRowModel({ state: 'armed' }, t).canCancel, true);
  assert.equal(buildWakeupRowModel({ state: 'cancelled' }, t).canCancel, false);
});

test('kind fields come from settingsSchema and merge stored values', () => {
  const fields = buildKindFields(usageKind);
  assert.deepEqual(fields.map((f) => f.key).sort(), Object.keys(USAGE_LIMIT_RESUME_SETTINGS_SCHEMA).sort());
  assert.equal(fields.find((f) => f.key === 'marginMs').value, 5000);
  assert.equal(fields.find((f) => f.key === 'jitterMs').value, USAGE_LIMIT_RESUME_SETTINGS_SCHEMA.jitterMs.default);
  assert.deepEqual(buildKindFields({}), []);
  assert.deepEqual(buildKindFields({ settingsSchema: { x: { type: 'string' } } }), []);
});

test('settings patch: toggles always sent, empty or junk numbers omitted', () => {
  const patch = buildKindSettingsPatch(usageKind, { enabled: true, allowPremium: false, marginMs: '1500.4', jitterMs: '', maxChain: 'abc' });
  assert.equal(patch.enabled, true);
  assert.equal(patch.allowPremium, false);
  assert.equal(patch.marginMs, 1500);
  assert.ok(!('jitterMs' in patch) && !('maxChain' in patch));
});

test('kinds render label (escaped), enabled flag, schema controls and save button', () => {
  const html = renderKindsHtml([usageKind, { kind: 'bare', settings: {}, settingsSchema: {} }], t);
  assert.ok(html.includes('Usage &lt;b&gt;'));
  assert.match(html, /wakeups\.enabled/);
  assert.match(html, /data-wakeup-field="marginMs"[^>]*value="5000"/);
  assert.match(html, /max="900000"/);
  assert.match(html, /data-wakeup-kind-save="usage_limit_resume"/);
  assert.match(html, /wakeups\.noSettings/, 'a kind with no schema has no save button');
  assert.ok(!/data-wakeup-kind-save="bare"/.test(html));
  assert.match(renderKindsHtml([], t), /wakeups\.noKinds/);
});

test('status tolerates a missing payload, empty jobs and null lastTickAt', () => {
  assert.match(renderStatusHtml(null, t), /wakeups\.statusUnavailable/);
  const html = renderStatusHtml({ running: true, tickMs: 60000, lastTickAt: null, kinds: [{ kind: 'a', maxPerTick: 3 }], jobs: [] }, t);
  assert.match(html, /a: 3/);
  assert.match(html, /wakeups\.seconds:\{&quot;count&quot;:60\}/);
  assert.match(html, /<dd>—<\/dd>/);
  assert.doesNotThrow(() => renderStatusHtml({}, t));
});

test('filters: option lists and query string', () => {
  assert.match(renderKindFilterOptions([{ kind: 'a', label: 'A' }], t), /<option value="a">A<\/option>/);
  assert.match(renderStateFilterOptions(t), /value="armed"/);
  assert.equal(buildWakeupQuery({}), '');
  assert.equal(buildWakeupQuery({ kind: 'a b', state: 'armed' }), '?kind=a+b&state=armed');
});

test('i18n: pl and en carry the same wakeups keys; tab and section are wired', () => {
  assert.deepEqual(Object.keys(pl.wakeups).sort(), Object.keys(en.wakeups).sort());
  assert.ok(pl.settings.tabsWakeups && en.settings.tabsWakeups);
  assert.ok(pl.usageLimitResume.openWakeups && en.usageLimitResume.openWakeups);
  const html = read('public/index.html');
  assert.match(html, /data-settings-tab="wakeups" role="tab"/);
  assert.match(html, /id="settings-wakeups-section" data-settings-tab="wakeups"/);
  assert.match(read('lib/spa-routes.js'), /'wakeups'/);
  assert.match(read('public/sw-routes.js'), /'wakeups'/);
  assert.match(readAppShellSource(), /refreshWakeupsSettings/);
  for (const key of ['title', 'empty', 'cancel', 'state_armed', 'colDue']) assert.ok(en.wakeups[key] && pl.wakeups[key]);
});

const check = (over = {}) => ({
  id: 'c1', kind: 'condition_check', state: 'armed', subjectId: 'todo-1',
  details: {
    title: 'Measure <coverage>', expiresAt: '2026-03-15T00:00:00.000Z', startedChatId: '',
    progress: { current: 7, target: 20, met: false, error: '' },
  },
  ...over,
});

test('check strip: empty list renders nothing so the strip hides', () => {
  assert.equal(renderChecksHtml([], t), '');
  assert.equal(renderChecksHtml(undefined, t), '');
  assert.equal(renderChecksHtml([{ id: 'x', kind: 'usage_limit_resume', state: 'armed' }], t), '');
});

test('check progress: current / target, a label when not evaluated, a label on predicate error', () => {
  assert.equal(formatCheckProgress({ current: 7, target: 20 }, t), '7 / 20');
  assert.equal(formatCheckProgress(null, t), 'wakeups.check_notEvaluated');
  assert.equal(formatCheckProgress({ current: null, target: null, error: 'boom' }, t), 'wakeups.check_predicateError');
});

test('check strip: armed row has Run now + Cancel, text is escaped', () => {
  const html = renderChecksHtml([check()], t, 'en');
  assert.match(html, /data-check-run="c1"/);
  assert.match(html, /data-wakeup-cancel="c1"/);
  assert.ok(html.includes('7 / 20'));
  assert.ok(html.includes('Measure &lt;coverage&gt;'));
  assert.ok(!html.includes('<coverage>'));
  const restart = renderChecksHtml([check({ details: { title: 'T', progress: null } })], t);
  assert.ok(restart.includes('wakeups.check_notEvaluated'));
});

test('check strip: terminal row shows the started chat link and no buttons', () => {
  const item = check({ state: 'resumed', details: { title: 'T', startedChatId: 'chat"1', progress: null } });
  const model = buildCheckRowModel(item, t);
  assert.equal(model.canAct, false);
  assert.equal(model.chatHref, '/?panel=chat&chat=chat%221');
  const html = renderChecksHtml([item], t);
  assert.match(html, /href="\/\?panel=chat&amp;chat=chat%221"/);
  assert.ok(!html.includes('data-check-run'));
});

test('run now: condition_not_met shows progress, other failures a generic message', () => {
  const text = describeRunNowResult({ code: 'condition_not_met', progress: { current: 3, target: 20 } }, t);
  assert.ok(text.includes('3 / 20'));
  assert.equal(describeRunNowResult({ code: 'not_armed' }, t), 'wakeups.check_runFailed');
});

test('check strip i18n keys exist in en and pl', () => {
  for (const key of ['checksTitle', 'check_runNow', 'check_openChat', 'check_expires', 'check_notEvaluated', 'check_predicateError', 'check_notMet', 'check_runFailed']) {
    assert.ok(en.wakeups[key], `en ${key}`);
    assert.ok(pl.wakeups[key], `pl ${key}`);
  }
  const html = read('public/index.html');
  assert.match(html, /id="wakeups-checks-section" hidden/);
});

test('periodic jobs render read-only with the owning-setting hint; both locales carry the keys', () => {
  const job = { id: 'chat_auto_archive', label: 'Archive <x>', intervalMs: 60000, enabled: false, settingKey: 'chatAutoArchive', lastRunAt: null, lastResult: { archived: 2, scanned: 5 }, lastError: null };
  const html = renderStatusHtml({ running: false, tickMs: 60000, kinds: [], jobs: [job] }, t);
  assert.ok(html.includes('Archive &lt;x&gt;'));
  assert.match(html, /wakeups\.disabled/);
  assert.match(html, /wakeups\.jobArchiveHint/);
  assert.ok(!/<input|<button/.test(html), 'read-only');
  assert.match(renderJobsHtml([{ ...job, lastError: 'boom' }], t), /boom/);
  assert.equal(renderJobsHtml([], t), '');
  for (const key of ['jobsTitle', 'jobEvery', 'jobLastRun', 'jobError', 'jobArchiveHint']) assert.ok(en.wakeups[key] && pl.wakeups[key]);
});
