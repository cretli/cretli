import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('Plans panel uses no native textarea or text/date input; every primitive has an aria-label', () => {
  const src = read('app_front/features/initiatives/cr-initiatives-panel.js');
  assert.doesNotMatch(src, /<textarea/);
  assert.doesNotMatch(src, /<input type="(text|date)"/);
  const tags = [...src.matchAll(/<cr-bar-(?:textarea|input)\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(tags.length, 11);
  for (const tag of tags) assert.match(tag, /aria-label=/, tag);
  // Native selects and checkboxes stay: documented in docs/ui-consistency-audit.md section 7.
  assert.equal((src.match(/<select\b/g) || []).length, 5);
});

test('Decisions stack uses cr-bar-textarea and keeps card gestures off the field', () => {
  const src = read('app_front/features/decisions/cr-decision-stack.js');
  assert.doesNotMatch(src, /<textarea/);
  assert.match(src, /<cr-bar-textarea id=\$\{`other-\$\{card\.id\}`\} aria-label=/);
  assert.equal((src.match(/closest\('button, a, textarea, cr-bar-textarea'\)/g) || []).length, 2);
});

test('Todo defer dialog reads values from cr-bar-input with aria-labels', () => {
  const src = read('app_front/features/todo/views/todoDialogs.js');
  assert.match(src, /createElement\('cr-bar-input'\)/);
  assert.match(src, /dateInput\.setAttribute\('aria-label', t\('todo\.deferUntilLabel'\)\)/);
  assert.match(src, /reasonInput\.setAttribute\('aria-label', t\('todo\.deferReasonLabel'\)\)/);
  assert.match(src, /reasonInput\.maxLength = 500/);
});

test('audit doc section 7 records the remaining native fields', () => {
  const doc = read('docs/ui-consistency-audit.md');
  assert.match(doc, /## 7\. Native fields outside Settings/);
  for (const f of ['appsPanel.js', 'wakeupsView.js', 'watcherStatus.js', 'scoutProfileEditorView.js', 'harnessModelRoleConfigModel.js', 'status-tests-input', 'chatDelegations.js']) {
    assert.ok(doc.includes(f), f);
  }
});
