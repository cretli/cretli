import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

test('features/settings creates no native textarea', () => {
  const files = walk(path.join(root, 'app_front/features/settings')).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /<textarea|el\('textarea'|createElement\(\s*'textarea'/, path.relative(root, f));
  }
});

test('public/index.html keeps only the documented native textareas', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const ids = [...html.matchAll(/<textarea[^>]*\bid="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(ids, ['browser-policy-allowed-origins', 'chat-settings-sdk-system-prompt', 'status-tests-input']);
});

test('migrated textareas pass an aria-label and the lessons limit is enforced', () => {
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  assert.match(read('app_front/features/settings/executionSettings.js'), /<cr-bar-textarea id="execution-prepare"[^>]*aria-label=/);
  assert.match(read('app_front/features/watcher/scoutProfileEditorView.js'), /<cr-bar-textarea id="watcher-scout-editor-instructions"[^>]*aria-label=/);
  assert.match(read('app_front/features/settings/agentPromptsSettings.js'), /'aria-label': title/);
});

test('lesson text limit clamps host and inner control on input and change', async () => {
  const mod = await import('../app_front/features/settings/lessonTextLimit.js');
  const { bindLessonTextLimit, clampLessonText, LESSON_TEXT_MAX } = mod;
  assert.equal(LESSON_TEXT_MAX, 300);
  assert.equal(clampLessonText('x'.repeat(400)).length, 300);
  const listeners = {};
  const inner = { value: 'a'.repeat(300) };
  const host = { value: 'a'.repeat(300), shadowRoot: { querySelector: () => inner }, addEventListener: (n, f) => { listeners[n] = f; } };
  bindLessonTextLimit(host);
  for (const evt of ['input', 'change']) {
    inner.value = 'a'.repeat(300) + 'bbb';
    host.value = inner.value;
    listeners[evt]();
    assert.equal(host.value.length, 300, `${evt}: host`);
    assert.equal(inner.value.length, 300, `${evt}: inner`);
  }
});

test('lesson save path clamps the text before building the payload', () => {
  const src = fs.readFileSync(path.join(root, 'app_front/features/settings/reviewLessonsSettings.js'), 'utf8');
  assert.match(src, /const value = clampLessonText\(inner\?\.value \?\? text\.value\)\.trim\(\);/);
  assert.match(src, /patch: \{ text: value, pathGlobs \}/);
});
