import assert from 'node:assert/strict';
import test from 'node:test';

import { isColor, registerTheme, themeCss, themes } from '../app_front/core/theme/themes/index.js';

const BUILTIN_IDS = [
  'dracula', 'one-dark', 'nord', 'monokai', 'solarized-dark', 'github-dark', 'catppuccin-mocha', 'gruvbox-dark', 'tokyo-night',
  'solarized-light', 'github-light', 'catppuccin-latte', 'gruvbox-light',
];
// Load the source definitions: registry entries have already lost invalid UI colors.
const definitions = await Promise.all(BUILTIN_IDS.map(async (id) => {
  const module = await import(`../app_front/core/theme/themes/${id}.js`);
  const exports = Object.values(module);
  assert.equal(exports.length, 1, `${id}: one exported definition`);
  return exports[0];
}));
// Base registry entries have empty token deltas, so use the union of built-in palettes.
const UI_KEYS = [...new Set(definitions.flatMap((def) => Object.keys(def.tokens || {})))].sort();
assert.ok(UI_KEYS.length > 0, 'built-in palettes declare UI tokens');

function assertRecord(value, message) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), message);
  assert.equal(Object.getPrototypeOf(value), Object.prototype, message);
}

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((n) => [n, `bright${n[0].toUpperCase()}${n.slice(1)}`]);
const TERMINAL_KEYS = [...ANSI, 'foreground', 'background', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionInactiveBackground'];
const SYNTAX_KEYS = ['bg', 'text', 'keyword', 'string', 'number', 'title', 'comment', 'variable', 'attribute', 'built-in', 'meta', 'tag', 'deletion', 'addition'];

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('all built-in themes are registered with unique labels', () => {
  for (const id of BUILTIN_IDS) assert.ok(themes.has(id), id);
  const labels = [...themes.values()].map((d) => d.label);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(BUILTIN_IDS.filter((id) => themes.get(id).appearance === 'dark').length, 9);
  assert.equal(BUILTIN_IDS.filter((id) => themes.get(id).appearance === 'light').length, 4);
});

for (const [index, id] of BUILTIN_IDS.entries()) {
  test(`built-in theme ${id}`, () => {
    const def = definitions[index];
    assertRecord(def, `${id}: definition object`);
    assert.equal(def.id, id);
    assert.equal(typeof def.id, 'string');
    assert.match(def.id, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof def.label, 'string');
    assert.ok(def.label.trim(), `${id}: nonempty label`);
    assert.ok(['dark', 'light'].includes(def.appearance), `${id}: appearance`);
    assert.ok(Object.hasOwn(def, 'themeColor') && isColor(def.themeColor), `${id}: themeColor`);
    for (const field of ['tokens', 'terminal', 'syntax']) {
      assert.ok(Object.hasOwn(def, field), `${id}: own ${field} field`);
      assertRecord(def[field], `${id}: ${field} object`);
      for (const [key, value] of Object.entries(def[field])) {
        assert.ok(isColor(value), `${id}: invalid ${field}.${key} color ${value}`);
      }
    }
    const missing = UI_KEYS.filter((key) => !Object.hasOwn(def.tokens, key));
    assert.deepEqual(missing, [], `${id}: missing required UI tokens`);
    for (const key of Object.keys(def.tokens)) assert.match(key, /^--cr-[a-z0-9-]+$/);
    assert.deepEqual(themes.get(id), def, `${id}: registration preserves the raw definition`);

    assert.match(themeCss(def), /^:root:root:root\{/);

    // Terminal palette: 16 ANSI colors plus fg/bg/cursor/selection.
    for (const key of TERMINAL_KEYS) assert.ok(Object.hasOwn(def.terminal, key), `${id}: terminal.${key}`);
    assert.equal(ANSI.length, 16);

    // Full syntax set, each emitted as --cr-code-<key>.
    assert.deepEqual(Object.keys(def.syntax).sort(), [...SYNTAX_KEYS].sort());
    const css = themeCss(def);
    for (const key of SYNTAX_KEYS) assert.ok(css.includes(`--cr-code-${key}:`), `${id}: --cr-code-${key}`);

    const t = def.tokens;
    assert.equal(def.themeColor, t['--cr-bg']);
    assert.equal(def.terminal.background, t['--cr-bg']);
    assert.ok(contrast(t['--cr-text'], t['--cr-bg']) >= 4.5, `${id}: text on bg`);
    assert.ok(contrast(t['--cr-text-muted'], t['--cr-bg']) >= 3, `${id}: muted on bg`);
    assert.ok(contrast(t['--cr-text-inverse'], t['--cr-primary']) >= 4.5, `${id}: inverse on primary`);
    assert.equal(luminance(t['--cr-bg']) < 0.5 ? 'dark' : 'light', def.appearance);
  });
}

test('registerTheme rejects malformed IDs and appearances without changing the registry', () => {
  const valid = definitions[0];
  const before = [...themes.entries()];
  const malformed = [
    null, undefined, {},
    { ...valid, id: '' },
    { ...valid, id: 'Invalid ID' },
    { ...valid, id: '1-invalid' },
    { ...valid, appearance: undefined },
    { ...valid, appearance: 'system' },
    { ...valid, appearance: 'DARK' },
  ];
  try {
    for (const definition of malformed) {
      assert.throws(() => registerTheme(definition), {
        name: 'TypeError', message: 'Invalid theme definition',
      });
      assert.deepEqual([...themes.entries()], before);
    }
  } finally {
    themes.clear();
    for (const [id, definition] of before) themes.set(id, definition);
  }
});
