import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDelegationSettingsTab } from '../lib/spa-routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const lessonsUi = read('app_front/features/settings/reviewLessonsSettings.js');
const findingsUi = read('app_front/components/ui/cr-todo-review-findings.js');

test('Lessons subtab is wired into the Delegations settings bar and routes', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('data-settings-tab="delegations-lessons"'));
  assert.ok(html.includes('id="settings-delegation-lessons-root"'));
  assert.ok(isDelegationSettingsTab('delegations-lessons'));
  assert.ok(read('public/sw-routes.js').includes("'delegations-lessons'"));
});

test('lesson and finding text is never rendered as HTML and uses tokens only', () => {
  for (const source of [lessonsUi, findingsUi]) {
    assert.ok(!/innerHTML|insertAdjacentHTML|unsafeHTML/.test(source));
  }
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(findingsUi), 'no hardcoded colors in the Lit component');
});

test('new UI has no Polish literals outside the i18n dictionaries', () => {
  for (const source of [lessonsUi, findingsUi]) assert.ok(!/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(source));
});

test('a stale lesson write reloads instead of overwriting', () => {
  assert.match(lessonsUi, /expectedRevision: lesson\.revision/);
  assert.match(lessonsUi, /status === 409/);
  assert.match(findingsUi, /code === 'CONFLICT'/);
  assert.match(findingsUi, /expectedSeq/);
});
