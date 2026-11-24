// Native <textarea> guard for Settings (docs/ui-consistency-audit.md sections 6-7).
//
// Complements tests/settings-native-textarea-guard.test.js: every native textarea
// that may remain must be listed here with a reason, so a new one fails the test
// and a stale exception (the field was migrated) fails it too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Native textarea ids allowed in public/index.html (id -> reason). */
const HTML_EXCEPTIONS = {
  'browser-policy-allowed-origins': 'Settings, kept native (audit sections 2.2 and 6): URL list needs spellcheck=false, autocapitalize=off, autocomplete=off and monospace, which cr-bar-textarea cannot express.',
  'status-tests-input': 'Tests panel, kept native (audit sections 2.2 and 7): dark monospace paste buffer, not a Settings form.',
  'chat-settings-sdk-system-prompt': 'Chat settings modal, kept native (audit sections 2.2, 6 and 7): chat module outside the Settings leaf, legacy chat layer by owner decision.',
};

/** Native textarea sources allowed under app_front/features/settings (repo path -> reason). Empty on purpose. */
const SETTINGS_JS_EXCEPTIONS = {};

const NATIVE_TEXTAREA = /<textarea\b|\bel\(\s*['"]textarea['"]|createElement\(\s*['"]textarea['"]/;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

test('Settings sources contain no native textarea outside the exception list', () => {
  const dir = path.join(root, 'app_front/features/settings');
  const files = walk(dir).filter((f) => /\.(js|mjs|ts|html)$/.test(f));
  assert.ok(files.length > 0);
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (NATIVE_TEXTAREA.test(fs.readFileSync(f, 'utf8')) && !(rel in SETTINGS_JS_EXCEPTIONS)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'use <cr-bar-textarea> or add a reasoned exception');
  for (const rel of Object.keys(SETTINGS_JS_EXCEPTIONS)) {
    assert.match(fs.readFileSync(path.join(root, rel), 'utf8'), NATIVE_TEXTAREA, `stale exception ${rel}`);
  }
});

test('audit doc records each HTML exception as an exception, not a pending migration', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/ui-consistency-audit.md'), 'utf8');
  for (const id of Object.keys(HTML_EXCEPTIONS)) {
    const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes(`#${id}`) && l.includes('Exception'));
    assert.ok(row, `docs/ui-consistency-audit.md 2.2 must list #${id} as an Exception`);
    assert.doesNotMatch(row, /\| Migrate \|/);
  }
});

test('public/index.html native textareas are exactly the reasoned exceptions', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const found = [...html.matchAll(/<textarea\b[^>]*>/g)].map((m) => (m[0].match(/\bid="([^"]+)"/) || [])[1] || m[0]);
  for (const id of found) assert.ok(id in HTML_EXCEPTIONS, `native textarea ${id} needs <cr-bar-textarea> or a reasoned exception`);
  for (const id of Object.keys(HTML_EXCEPTIONS)) {
    assert.ok(found.includes(id), `stale exception ${id}`);
    assert.ok(HTML_EXCEPTIONS[id].length > 10, `${id} needs a reason`);
  }
});
