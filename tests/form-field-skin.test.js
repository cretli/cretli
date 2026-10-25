import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Lit components whose `static styles` must use the shared field skin. */
const COMPONENTS = {
  'cr-bar-input': { file: 'app_front/components/ui/cr-bar-input.js', idle: '.control {' },
  'cr-bar-textarea': { file: 'app_front/components/ui/cr-bar-textarea.js', idle: '.control {' },
  'cr-bar-select': { file: 'app_front/components/ui/cr-bar-select.js', idle: '.trigger {' },
  'cr-searchable-select': { file: 'app_front/components/ui/cr-searchable-select.js', idle: '.trigger {' },
};

/** Returns the `{ ... }` body of the first rule that starts with `selector`. */
function ruleBody(src, selector) {
  const at = src.indexOf(selector);
  assert.ok(at >= 0, `rule ${selector} found`);
  const open = src.indexOf('{', at);
  const close = src.indexOf('}', open);
  return src.slice(open + 1, close);
}

function prop(body, name) {
  const m = body.match(new RegExp(`(?:^|[\\s;])${name}:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

function crFormSource() {
  const recipes = read('app_front/css/cr-recipes.scss');
  const start = recipes.indexOf('\n.cr-form {');
  assert.ok(start >= 0, '.cr-form block exists');
  const end = recipes.indexOf('\n.cr-section-title', start);
  return recipes.slice(start, end > 0 ? end : undefined);
}

const LIGHT = ":root[data-theme='light']";

test('field tokens are defined for dark and light themes', () => {
  const tokens = read('app_front/css/tokens.scss');
  const light = tokens.slice(tokens.indexOf(LIGHT));
  for (const name of ['--cr-field-bg', '--cr-field-border', '--cr-field-border-hover', '--cr-field-focus-border']) {
    assert.ok(tokens.indexOf(`${name}:`) >= 0 && tokens.indexOf(`${name}:`) < tokens.indexOf(LIGHT), `${name} in dark root`);
    assert.match(light, new RegExp(`${name}:`), `${name} in light theme`);
  }
});

test('components and .cr-form share the same idle bg and border tokens', () => {
  const form = crFormSource();
  const formBody = ruleBody(form, 'select,');
  const expected = { bg: 'var(--cr-field-bg)', border: '1px solid var(--cr-field-border)' };
  assert.equal(prop(formBody, 'background'), expected.bg, '.cr-form background');
  assert.equal(prop(formBody, 'border'), expected.border, '.cr-form border');
  for (const [name, { file, idle }] of Object.entries(COMPONENTS)) {
    const body = ruleBody(read(file), idle);
    assert.equal(prop(body, 'background'), expected.bg, `${name} background`);
    assert.equal(prop(body, 'border'), expected.border, `${name} border`);
  }
});

test('components and .cr-form share hover and focus border tokens', () => {
  for (const [name, { file }] of Object.entries(COMPONENTS)) {
    const src = read(file);
    assert.match(src, /border-color:\s*var\(--cr-field-border-hover\)/, `${name} hover`);
    assert.match(src, /border-color:\s*var\(--cr-field-focus-border\)/, `${name} focus`);
  }
  const form = crFormSource();
  assert.match(form, /border-color:\s*var\(--cr-field-border-hover\)/);
  assert.match(form, /border-color:\s*var\(--cr-field-focus-border\)/);
});

test('field skin never falls back to legacy input tokens', () => {
  const sources = { ...Object.fromEntries(Object.entries(COMPONENTS).map(([n, c]) => [n, read(c.file)])), '.cr-form': crFormSource() };
  for (const [name, src] of Object.entries(sources)) {
    assert.doesNotMatch(src, /--cr-input-bg/, `${name} uses --cr-input-bg`);
    assert.doesNotMatch(src, /--cr-border-control/, `${name} uses --cr-border-control`);
    assert.doesNotMatch(src, /--cr-control-idle-bg/, `${name} uses --cr-control-idle-bg`);
    assert.doesNotMatch(src, /--cr-input-focus-border/, `${name} uses --cr-input-focus-border`);
  }
});

test('cr-searchable-select default height follows --cr-control-height', () => {
  const src = read(COMPONENTS['cr-searchable-select'].file);
  assert.match(src, /--cr-searchable-select-height:\s*var\(--cr-control-height\)/);
});

test('MCP and delegation checkboxes use cr-checkbox, not native inputs', () => {
  for (const rel of ['app_front/features/settings/mcpSettings.js', 'app_front/features/settings/delegationSettings.js']) {
    assert.doesNotMatch(read(rel), /type="checkbox"/, `${rel} has native checkbox`);
  }
});
