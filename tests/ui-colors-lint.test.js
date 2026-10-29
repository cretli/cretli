// Ratchet for literal colours (hex, rgb(), rgba()) in the UI style layer.
//
// Colours must come from `--cr-*` tokens (app_front/css/tokens.scss). The count
// of literals per file may only go down; a scanned file absent from the
// baseline must have zero. Allowlisted brand colours (logos, harness brands)
// may remain in the baseline.
//
// Scope: `app_front/css/**/*.scss` (minus tokens.scss) and `css\`` blocks in
// `app_front/components/**/*.js`. Regenerate after deliberately removing
// literals (maintainer action):
//
//   UI_COLORS_BASELINE_WRITE=1 node --test tests/ui-colors-lint.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_DIR = path.join(root, 'app_front/css');
const COMPONENTS_DIR = path.join(root, 'app_front/components');
const BASELINE_PATH = path.join(root, 'tests/fixtures/ui-colors-baseline.json');
const WRITE_BASELINE = process.env.UI_COLORS_BASELINE_WRITE === '1';

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\)/g;

/** Removes block and `//` line comments (not inside strings / after `:`). */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Counts colour literals in a style source. `url(...)` payloads are skipped. */
function countColors(source) {
  const css = stripComments(source).replace(/url\([^)]*\)/g, 'url()');
  return (css.match(COLOR_LITERAL) || []).length;
}

/** Extracts the bodies of css`...` template literals from a JS source. */
function cssBlocks(js) {
  return [...js.matchAll(/css`([\s\S]*?)`/g)].map((m) => m[1]).join('\n');
}

function listFiles(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, ext, out);
    else if (entry.isFile() && entry.name.endsWith(ext)) {
      if (dir === CSS_DIR && entry.name === 'tokens.scss') continue;
      out.push(full);
    }
  }
  return out;
}

function scan() {
  const counts = {};
  const add = (file, n) => { counts[path.relative(root, file).split(path.sep).join('/')] = n; };
  for (const f of listFiles(CSS_DIR, '.scss')) add(f, countColors(fs.readFileSync(f, 'utf8')));
  for (const f of listFiles(COMPONENTS_DIR, '.js')) {
    add(f, countColors(cssBlocks(fs.readFileSync(f, 'utf8'))));
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

test('scanner counts hex and rgb(a) literals, ignores var(), comments and url()', () => {
  assert.equal(countColors('.a { color: #fff; background: rgba(0, 0, 0, 0.5); }'), 2);
  assert.equal(countColors('.a { color: var(--cr-color-fff); }'), 0);
  assert.equal(countColors('// color: #fff\n/* #000 */ .a { x: y; }'), 0);
  assert.equal(countColors('.a { background: url("data:image/svg+xml,#fff"); }'), 0);
  assert.equal(countColors('.a { box-shadow: 0 0 1px rgb(0 0 0 / 0.3); }'), 1);
});

test('css`` blocks are extracted from Lit sources only', () => {
  assert.equal(countColors(cssBlocks('const x = "#fff"; static styles = css`a{color:#000}`;')), 1);
});

test('colour literals never grow beyond the committed baseline', () => {
  const counts = scan();
  assert.ok(Object.keys(counts).length > 0);
  if (WRITE_BASELINE) {
    const nonZero = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({
      generatedFrom: head,
      rule: 'Per-file count of literal colours (hex/rgb/rgba) in app_front/css/**/*.scss '
        + '(tokens.scss excluded) and css`` blocks in app_front/components/**/*.js. Counts may '
        + 'only decrease; a file absent from this map must have 0. Regenerate with '
        + 'UI_COLORS_BASELINE_WRITE=1.',
      counts: nonZero,
    }, null, 2)}\n`);
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.equal(typeof baseline.counts, 'object');
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline.counts[file] ?? 0;
    assert.ok(count <= allowed,
      `${file}: ${count} literal colour(s), baseline allows ${allowed}. Use a --cr-* token.`);
  }
});
