// Guard test for raw `font-size` literals in the SCSS layer.
//
// The design system routes font sizes through `--cr-font-size-*` tokens
// (docs/ui-font-size-tokens.md). Migrating the legacy literals is incremental,
// so this test is a ratchet: the count of raw literals per file may only go
// down.
//
// Baseline: `tests/fixtures/ui-tokens-baseline.json` stores the commit it was
// generated from and a per-file count map. A scanned file that is absent from
// the baseline must have zero raw literals; a listed file must not exceed its
// recorded count.
//
// Regenerate the baseline after deliberately removing literals (maintainer
// action; a normal run never writes it):
//
//   UI_TOKENS_BASELINE_WRITE=1 node --test tests/ui-tokens-lint.test.js
//
// Scope: only `app_front/css/**/*.scss`, recursively. `tokens.scss` is skipped
// because it defines the tokens and must hold the raw values by design. Lit
// `static styles` live in JS and are not scanned. Colours (hex values) are out
// of scope.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_DIR = path.join(root, 'app_front/css');
const BASELINE_PATH = path.join(root, 'tests/fixtures/ui-tokens-baseline.json');
const WRITE_BASELINE = process.env.UI_TOKENS_BASELINE_WRITE === '1';

const FONT_SIZE_DECL = /(?<![-\w])font-size\s*:\s*([^;}\n]+)/g;
const NUMERIC_UNIT = /(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|pt|%)(?![a-z])/i;

/**
 * Removes block and `//` line comments so commented-out rules are not counted.
 * Quoted strings and `https://` inside an unquoted url() are not comments, so a
 * declaration later on that line must survive.
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i];
        out += c;
        i += 1;
        if (c === '\\' && i < source.length) {
          out += source[i];
          i += 1;
        } else if (c === quote) {
          break;
        }
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '/' && source[i - 1] !== ':') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Counts `font-size` declarations whose value carries a numeric unit.
 * `var(...)` values (tokens, calc with a scale) and keywords do not count.
 */
function countRawFontSizes(source) {
  const css = stripComments(source);
  let count = 0;
  for (const match of css.matchAll(FONT_SIZE_DECL)) {
    const value = match[1].trim();
    if (value.includes('var(')) continue;
    if (NUMERIC_UNIT.test(value)) count += 1;
  }
  return count;
}

/** Lists scanned SCSS files recursively, sorted for a stable baseline order. */
function listScssFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listScssFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.scss')) {
      if (dir === CSS_DIR && entry.name === 'tokens.scss') continue;
      found.push(full);
    }
  }
  return found.sort();
}

/** Maps every scanned file (repo-relative POSIX path) to its raw literal count. */
function scanScss() {
  const counts = {};
  for (const file of listScssFiles(CSS_DIR)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    counts[rel] = countRawFontSizes(fs.readFileSync(file, 'utf8'));
  }
  return counts;
}

function currentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function writeBaseline(counts) {
  const baseline = {
    generatedFrom: currentCommit(),
    rule: 'Per-file count of raw font-size literals in app_front/css/**/*.scss '
      + '(tokens.scss excluded). Counts may only decrease; a file absent from this '
      + 'map must have 0. Regenerate with UI_TOKENS_BASELINE_WRITE=1.',
    counts,
  };
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

const SAMPLE_SCSS = `
// font-size: 3rem; commented out, not a declaration
/* font-size: 2rem; blocked out, not a declaration */
.sample {
  background: url(https://example.com/x.png); font-size: 0.75rem;
  font-size: var(--cr-font-size-sm);
  font-size: inherit;
}
`;

test('scanner counts one raw literal and ignores var(), keywords and comments', () => {
  assert.equal(countRawFontSizes(SAMPLE_SCSS), 1);
  assert.equal(countRawFontSizes('.a { font-size: 13px; }'), 1);
  assert.equal(countRawFontSizes('.a { font-size: var(--cr-font-size-sm); }'), 0);
  assert.equal(countRawFontSizes('.a { font-size: inherit; }'), 0);
});

test('raw font-size literals never grow beyond the committed baseline', () => {
  const counts = scanScss();
  assert.ok(Object.keys(counts).length > 0, 'at least one SCSS file is scanned');

  if (WRITE_BASELINE) {
    const written = writeBaseline(counts);
    assert.ok(written.generatedFrom.length > 0, 'baseline records the generating commit');
    return;
  }

  assert.ok(fs.existsSync(BASELINE_PATH), `missing ${path.relative(root, BASELINE_PATH)}; generate it with UI_TOKENS_BASELINE_WRITE=1`);
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.equal(typeof baseline.generatedFrom, 'string');
  assert.ok(baseline.generatedFrom.length > 0, 'baseline records the generating commit');
  assert.equal(typeof baseline.rule, 'string');
  assert.equal(typeof baseline.counts, 'object');

  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline.counts[file] ?? 0;
    assert.ok(
      count <= allowed,
      `${file}: ${count} raw font-size literal(s), baseline allows ${allowed}. `
        + 'Use a --cr-font-size-* token, or lower the baseline with UI_TOKENS_BASELINE_WRITE=1.',
    );
  }
});
