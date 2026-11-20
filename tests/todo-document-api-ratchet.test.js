import './helpers/isolated-data-dir.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ratchet for the program goal "no code path reads or serializes all todos"
 * (docs/todo-scalable-architecture.md, phase 1). Whole-document readers may
 * only shrink: a count above its baseline fails. When a count drops, lower the
 * baseline below so the gain cannot be lost again.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['lib', 'scripts'];
const SCAN_FILES = ['server.js'];
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts']);

/** Files that legitimately define or wrap the document API (the shim and the repository). */
const ALLOWLIST = new Set([
  'lib/persist/todos-store.js',
  'lib/persist/todos-persist.js',
  'lib/persist/todos-legacy-adapter.js',
  'lib/persist/todo-repository.js',
]);

const PATTERNS = {
  'listTodos(': /\blistTodos\(/g,
  loadTodosData: /\bloadTodosData\b/g,
  exportSnapshot: /\bexportSnapshot\b/g,
  jsonTodosPayload: /\bjsonTodosPayload\b/g,
};

/**
 * Baseline recorded for phase 1 slice 2: { files, occurrences } per pattern. This slice removed
 * `listTodos(` call sites in todo_list/todo_show/id resolution (todo-tools), operator todo and
 * leaf resolution, and remote getTodo; `todo_next_ready` stays document-based.
 */
const BASELINE = {
  // Recorded as 39 / 101, but commit 9ea4bbffb already measured 40 / 104 (no growth since); corrected
  // to the measured value so the ratchet guards against growth again instead of failing permanently.
  'listTodos(': { files: 40, occurrences: 104 },
  loadTodosData: { files: 8, occurrences: 47 },
  exportSnapshot: { files: 4, occurrences: 12 },
  jsonTodosPayload: { files: 2, occurrences: 10 },
};

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.has(path.extname(entry.name))) yield full;
  }
}

function measure() {
  const files = [...SCAN_FILES.map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f))];
  for (const dir of SCAN_DIRS) if (fs.existsSync(path.join(ROOT, dir))) files.push(...walk(path.join(ROOT, dir)));
  const result = Object.fromEntries(Object.keys(PATTERNS).map((k) => [k, { files: 0, occurrences: 0 }]));
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWLIST.has(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const [name, re] of Object.entries(PATTERNS)) {
      const hits = source.match(re);
      if (!hits) continue;
      result[name].files += 1;
      result[name].occurrences += hits.length;
    }
  }
  return result;
}

describe('whole-document todo API ratchet', () => {
  const current = measure();
  for (const name of Object.keys(PATTERNS)) {
    it(`${name} usage does not grow`, () => {
      const base = BASELINE[name];
      const now = current[name];
      assert.ok(
        now.files <= base.files && now.occurrences <= base.occurrences,
        `${name}: ${now.files} files / ${now.occurrences} occurrences exceeds baseline ${base.files} / ${base.occurrences}. `
        + 'Use the TodoRepository (lib/persist/todo-repository.js) instead of reading the whole document.',
      );
      if (now.files < base.files || now.occurrences < base.occurrences) {
        console.log(`HINT: ${name} shrank to ${now.files} files / ${now.occurrences} occurrences; lower BASELINE in tests/todo-document-api-ratchet.test.js.`);
      }
    });
  }
});
