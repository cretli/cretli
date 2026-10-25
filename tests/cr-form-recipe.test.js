import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const recipes = fs.readFileSync(path.join(root, 'app_front/css/cr-recipes.scss'), 'utf8');
const barInput = fs.readFileSync(path.join(root, 'app_front/components/ui/cr-bar-input.js'), 'utf8');

/** Returns the source from `.cr-form {` to the start of the next top-level block. */
function crFormSource() {
  const start = recipes.indexOf('\n.cr-form {');
  assert.ok(start >= 0, '.cr-form block exists');
  const end = recipes.indexOf('\n.cr-section-title', start);
  return recipes.slice(start, end > 0 ? end : undefined);
}

/** Pulls a declaration value from the first rule block matching `selector`. */
function decl(src, selector, prop) {
  const at = src.indexOf(selector);
  assert.ok(at >= 0, `selector ${selector} found`);
  const m = src.slice(at).match(new RegExp(`${prop}:\\s*([^;]+);`));
  assert.ok(m, `${prop} declared after ${selector}`);
  return m[1].trim();
}

test('.cr-form focus border matches cr-bar-input (shared field tokens)', () => {
  const form = crFormSource();
  const focusForm = form.slice(form.indexOf('&:focus,'));
  const focusBar = barInput.slice(barInput.indexOf('.control:focus'));
  assert.equal(decl(focusForm, '&:focus', 'border-color'), decl(focusBar, '.control:focus', 'border-color'));
  assert.match(focusForm, /--cr-field-focus-border/);
  assert.doesNotMatch(focusForm.split('&:disabled')[0], /--cr-input-focus-border/);
});

test('.cr-form idle border and background match cr-bar-input', () => {
  const form = crFormSource();
  const bar = barInput.slice(barInput.indexOf('.control {'));
  assert.equal(decl(form, 'select,', 'border'), decl(bar, '.control {', 'border'));
  assert.equal(decl(form, 'select,', 'background'), decl(bar, '.control {', 'background'));
  assert.match(form, /height: var\(--cr-form-control-height\)/);
});

test('cr-recipes new form rules contain no !important', () => {
  const start = recipes.indexOf('\n// Opt-in native form controls');
  assert.ok(start >= 0);
  const css = recipes.slice(start).replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(css, /!important/);
});
