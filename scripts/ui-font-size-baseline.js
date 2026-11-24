#!/usr/bin/env node
/**
 * Hard font-size ratchet baseline (docs/ui-font-size-tokens.md, "Guards").
 *
 * Counts hard `font-size: <number><rem|px|em>` declarations in app_front/css/**
 * outside the legacy exact-value layer and tokens.scss. tests/ui-font-size-hard.test.js
 * compares the tree with tests/fixtures/ui-font-size-hard-baseline.json: a file
 * may only keep or lower its recorded count, an unlisted file must have zero.
 *
 *   node scripts/ui-font-size-baseline.js                        # print a summary
 *   node scripts/ui-font-size-baseline.js --write                # lock gains in (values only go down)
 *   node scripts/ui-font-size-baseline.js --write --allow-raise  # operator only: accept growth
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_DIR = path.join(projectRoot, 'app_front', 'css');
export const baselinePath = path.join(projectRoot, 'tests', 'fixtures', 'ui-font-size-hard-baseline.json');

/** Legacy exact-value layer (docs/ui-font-size-tokens.md) and the token definitions. */
export const EXCLUDED_PREFIXES = [
  'app_front/css/features/chat/',
  'app_front/css/features/sidebar/',
  'app_front/css/cr-recipes.scss',
  'app_front/css/tokens.scss',
];

// CSS property names are case-insensitive; `font` shorthand is matched separately.
const FONT_SIZE_DECL = /(?<![-\w])font-size\s*:\s*([^;}\n]+)/gi;
const FONT_SHORTHAND_DECL = /(?<![-\w])font\s*:\s*([^;}\n]+)/gi;
const NUMERIC_UNIT = /(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)(?![a-z])/i;

/** Removes `var(...)` references (nested parentheses included); their fallbacks are not hard sizes. */
function stripVarCalls(value) {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (/var\(/iy.test(value.slice(i, i + 4)) && (i === 0 || !/[-\w]/.test(value[i - 1]))) {
      let depth = 0;
      let j = i + 3;
      for (; j < value.length; j += 1) {
        if (value[j] === '(') depth += 1;
        else if (value[j] === ')' && --depth === 0) break;
      }
      i = j;
      out += ' ';
    } else out += value[i];
  }
  return out;
}

/** Drops block and `//` comments; `//` after `:` (url schemes) is kept. */
export function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Counts hard font-size declarations. Only `var(...)` references are ignored, so
 * `calc(var(--x) + 1px)` and `clamp(12px, var(--x), 1rem)` still count. A `font:`
 * shorthand counts when its size part (the value before any `/line-height`) holds
 * a hard length. SCSS variables (`$size`) and keywords are not literals.
 */
export function countHardFontSizes(source) {
  const css = stripComments(source);
  let count = 0;
  for (const match of css.matchAll(FONT_SIZE_DECL)) {
    if (NUMERIC_UNIT.test(stripVarCalls(match[1]))) count += 1;
  }
  for (const match of css.matchAll(FONT_SHORTHAND_DECL)) {
    const value = stripVarCalls(match[1]).replace(/\/\s*[^\s,]+/g, ' ');
    if (NUMERIC_UNIT.test(value)) count += 1;
  }
  return count;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.scss')) out.push(full);
  }
}

/** Counts per scanned file (repo-relative POSIX path), including zeros. */
export function measureHardFontSizes() {
  const files = [];
  walk(CSS_DIR, files);
  const result = {};
  for (const file of files.sort()) {
    const rel = path.relative(projectRoot, file).split(path.sep).join('/');
    if (EXCLUDED_PREFIXES.some((p) => rel === p || rel.startsWith(p))) continue;
    result[rel] = countHardFontSizes(fs.readFileSync(file, 'utf8'));
  }
  return result;
}

/** Keeps the lower of recorded and current per file; files at zero drop out. */
export function tightenHardBaseline(previous, current) {
  const next = {};
  for (const [file, now] of Object.entries(current)) {
    const value = Math.min(previous[file] ?? 0, now);
    if (value > 0) next[file] = value;
  }
  return next;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = measureHardFontSizes();
  const total = Object.values(current).reduce((n, c) => n + c, 0);
  if (process.argv.includes('--write')) {
    let previous = {};
    try {
      previous = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).counts || {};
    } catch {
      previous = {};
    }
    const raise = process.argv.includes('--allow-raise');
    const counts = raise
      ? Object.fromEntries(Object.entries(current).filter(([, c]) => c > 0))
      : tightenHardBaseline(previous, current);
    const baseline = {
      rule: 'Per-file count of hard font-size literals (rem|px|em) in app_front/css/**/*.scss, excluding the legacy layer and tokens.scss. Counts may only decrease; a file absent from this map must have 0. Tighten with node scripts/ui-font-size-baseline.js --write.',
      excluded: EXCLUDED_PREFIXES,
      counts,
    };
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Wrote ${path.relative(projectRoot, baselinePath)}`);
  }
  console.log(`${Object.keys(current).length} files scanned, ${total} hard font-size literals`);
}
