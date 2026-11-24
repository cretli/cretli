// Hard font-size ratchet over app_front/css/** (docs/ui-font-size-tokens.md, "Guards").
//
// Unlike tests/ui-tokens-lint.test.js (all SCSS, per-file, regenerated through an
// env flag) this guard excludes the legacy exact-value layer and tokens.scss and
// keeps its baseline in tests/fixtures/ui-font-size-hard-baseline.json, tightened
// with scripts/ui-font-size-baseline.js. The count can only go down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXCLUDED_PREFIXES,
  baselinePath,
  countHardFontSizes,
  measureHardFontSizes,
  tightenHardBaseline,
} from '../scripts/ui-font-size-baseline.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('scanner counts hard rem/px/em literals and ignores tokens, keywords and comments', () => {
  assert.equal(countHardFontSizes('.a { font-size: 0.8rem; }'), 1);
  assert.equal(countHardFontSizes('.a { font-size: 13px; }'), 1);
  assert.equal(countHardFontSizes('.a { font-size: .9em; }'), 1);
  assert.equal(countHardFontSizes('.a { font-size: var(--cr-font-size-sm); }'), 0);
  assert.equal(countHardFontSizes('.a { font-size: inherit; }'), 0);
  assert.equal(countHardFontSizes('// font-size: 1rem;\n/* font-size: 2px; */\n.a { margin: 0; }'), 0);
  assert.equal(countHardFontSizes('.a { background: url(https://x.test/a.png); font-size: 12px; }'), 1);
});

test('scanner edge cases: var() mixed with hard sizes, case, !important, @media, scss variables, font shorthand', () => {
  assert.equal(countHardFontSizes('.a { font-size: calc(var(--x) + 1px); }'), 1);
  assert.equal(countHardFontSizes('.a { font-size: clamp(12px, var(--x), 1rem); }'), 1);
  assert.equal(countHardFontSizes('.a { font-size: clamp(var(--a), var(--b, 12px), var(--c)); }'), 0);
  assert.equal(countHardFontSizes('.a { font-size: calc(var(--cr-font-size-sm) * 1.1); }'), 0);
  assert.equal(countHardFontSizes('.a { FONT-SIZE: 14PX; }'), 1);
  assert.equal(countHardFontSizes('.a { Font-Size: 0.9REM !important; }'), 1);
  assert.equal(countHardFontSizes('.a { font-size: 13px !important; }'), 1);
  assert.equal(countHardFontSizes('.a { font-size: var(--cr-font-size-sm) !important; }'), 0);
  assert.equal(countHardFontSizes('@media (min-width: 768px) { .a { font-size: 1rem; } }'), 1);
  assert.equal(countHardFontSizes('@media (min-width: 768px) { .a { margin: 12px; } }'), 0);
  assert.equal(countHardFontSizes('.a { font-size: $size; font-size: map-get($sizes, sm); }'), 0);
  assert.equal(countHardFontSizes('.a { font: 12px/1.4 sans-serif; }'), 1);
  assert.equal(countHardFontSizes('.a { font: var(--f); font: inherit; font: italic var(--s)/1.4 serif; }'), 0);
  assert.equal(countHardFontSizes('.a { font-family: serif; line-height: 1.2em; }'), 0);
});

test('scan covers base/_global.scss and skips only the legacy layer and tokens.scss', () => {
  const files = Object.keys(measureHardFontSizes());
  assert.ok(files.includes('app_front/css/base/_global.scss'));
  assert.ok(files.includes('app_front/css/features/settings/_mcp.scss'));
  for (const file of files) {
    assert.ok(!EXCLUDED_PREFIXES.some((p) => file === p || file.startsWith(p)), file);
  }
  assert.ok(!files.some((f) => f.endsWith('/tokens.scss')));
});

test('tighten never raises a count and drops files that reached zero', () => {
  assert.deepEqual(tightenHardBaseline({ a: 4, b: 2 }, { a: 3, b: 0, c: 5 }), { a: 3 });
});

test('hard font-size literals never grow beyond the committed baseline', () => {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.equal(typeof baseline.counts, 'object');
  const current = measureHardFontSizes();
  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline.counts[file] ?? 0;
    assert.ok(
      count <= allowed,
      `${file}: ${count} hard font-size literal(s), baseline allows ${allowed}. `
        + 'Use a --cr-font-size-* token (docs/ui-font-size-tokens.md).',
    );
  }
  for (const file of Object.keys(baseline.counts)) {
    assert.ok(file in current, `${file} is in the baseline but no longer scanned; run scripts/ui-font-size-baseline.js --write`);
    assert.ok(fs.existsSync(path.join(root, file)), file);
  }
});
