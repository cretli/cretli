#!/usr/bin/env node
/**
 * Frontend size ratchet baseline (docs/frontend-architecture.md).
 *
 * Records, per source file under app_front/, the line count and the number of
 * `innerHTML` occurrences. tests/front-size-ratchet.test.js compares the tree
 * against tests/fixtures/front-size-baseline.json: files may only shrink, new
 * files must stay small and free of innerHTML.
 *
 *   node scripts/front-size-baseline.js                        # print a summary
 *   node scripts/front-size-baseline.js --write                # lock gains in (values only go down)
 *   node scripts/front-size-baseline.js --write --allow-raise  # operator only: accept growth
 *
 * `--write` never raises a recorded value and never records a new file that
 * breaks the new-file limits, so regenerating the baseline cannot make a
 * violating change pass (an agent did exactly that for a moved file with
 * innerHTML on 2026-10-24).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontRoot = path.join(projectRoot, 'app_front');
export const baselinePath = path.join(projectRoot, 'tests', 'fixtures', 'front-size-baseline.json');
const EXTENSIONS = new Set(['.js', '.mjs', '.ts']);
// i18n catalogs are string data that grows with every UI label, not code to split.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'i18n']);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/**
 * `innerHTML` uses in source text: property access only (`el.innerHTML`,
 * `el?.innerHTML`), so the word in a comment such as "built without innerHTML"
 * is not counted.
 *
 * @param {string} text
 * @returns {number}
 */
export function countInnerHtml(text) {
  return (String(text).match(/\??\.innerHTML\b/g) || []).length;
}

/** Measure every source file: { 'app_front/x.js': { lines, innerHTML } }. */
export function measureFront() {
  const files = [];
  walk(frontRoot, files);
  const result = {};
  for (const file of files.sort()) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const innerHTML = countInnerHtml(text);
    result[path.relative(projectRoot, file).split(path.sep).join('/')] = { lines, innerHTML };
  }
  return result;
}

/** Limits for a file the baseline does not know yet (mirrors the ratchet test). */
export const MAX_NEW_FILE_LINES = 1000;

/**
 * Next baseline from the previous one and a fresh measurement: known files keep
 * the lower of the two values, gone files drop out, and a new file is recorded
 * only while it meets the new-file limits.
 *
 * @param {Record<string, { lines: number, innerHTML: number }>} previous
 * @param {Record<string, { lines: number, innerHTML: number }>} current
 * @returns {Record<string, { lines: number, innerHTML: number }>}
 */
export function tightenFrontBaseline(previous, current) {
  /** @type {Record<string, { lines: number, innerHTML: number }>} */
  const next = {};
  for (const [file, now] of Object.entries(current)) {
    const was = previous[file];
    if (was) {
      next[file] = { lines: Math.min(was.lines, now.lines), innerHTML: Math.min(was.innerHTML, now.innerHTML) };
    } else if (now.lines <= MAX_NEW_FILE_LINES && now.innerHTML === 0) {
      next[file] = now;
    }
  }
  return next;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = measureFront();
  const names = Object.keys(current);
  const totalLines = names.reduce((n, f) => n + current[f].lines, 0);
  const totalInner = names.reduce((n, f) => n + current[f].innerHTML, 0);
  if (process.argv.includes('--write')) {
    let previous = {};
    try {
      previous = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).files || {};
    } catch {
      previous = {};
    }
    const files = process.argv.includes('--allow-raise') ? current : tightenFrontBaseline(previous, current);
    fs.writeFileSync(baselinePath, `${JSON.stringify({ files }, null, 2)}\n`);
    console.log(`Wrote ${path.relative(projectRoot, baselinePath)}`);
  }
  console.log(`${names.length} files, ${totalLines} lines, ${totalInner} innerHTML occurrences`);
}
