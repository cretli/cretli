/**
 * Guard: a unit test that loads a lib/persist module must not touch the real
 * `data/` directory. Persist modules resolve their paths at module load, so
 * the data dir has to be redirected before the first such import.
 *
 * A test file passes when it does one of:
 *   (a) imports `./helpers/isolated-data-dir.js` (or another isolating module,
 *       see ISOLATING_SPECS) as its FIRST import,
 *   (b) assigns (or passes to a child process) CRETLI_DATA_DIR / CRETLI_TEST_DATA_DIR before its first
 *       persist import (only possible with dynamic imports),
 *   (c) injects its own `dataDir` option into the code under test,
 *   (d) is on the explicit ALLOWED list below with a reason.
 *
 * The ALLOWED list must not grow without review: fix the test instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(ROOT, 'tests');

// Modules that redirect the data dir as an import side effect. The first two
// import isolated-data-dir.js themselves; the scratch fixture sets
// CRETLI_DATA_DIR directly.
const ISOLATING_SPECS = new Set([
  './helpers/isolated-data-dir.js',
  './helpers/default-optional-harnesses.js',
  './fixtures/storage-history-scratch-data.js',
]);
const PERSIST_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`][^'"`]*lib\/persist(?:\.js|\/)[^'"`]*['"`]/;
// First import of any form: `import 'x'`, `import a from 'x'`, multi-line
// `import { a,\n b } from 'x'`, `await import('x')`; the specifier is group 1 or 2.
const FIRST_IMPORT = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]|\bimport\s+(?:[^'"`;]*?\bfrom\s*)?['"`]([^'"`]+)['"`]/;
const ENV_ASSIGN = /\b(?:CRETLI|CURSOR_REMOTE)_(?:TEST_)?DATA_DIR\s*(?:=(?!=)|:)/;
// A dataDir handed to code under test: an option key (`dataDir: x`,
// `todoSyncDataDir: x`), a shorthand property (`{ dataDir }`) or a call
// argument (`load(dataDir, ...)`). A bare declaration does not count.
const INJECTED_DIR = /\b\w*[dD]ataDir\s*:|[{,(]\s*dataDir\s*[,})]/;

// file -> reason (class d). Keep empty-ish: new entries need review.
const ALLOWED = new Map([]);

/** Strip block and line comments so commented-out imports do not count. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/**
 * @param {string} source
 * @returns {'helper-first'|'env-first'|'injected'|'unsafe'|'no-persist'}
 */
export function classify(source) {
  const code = stripComments(source);
  const persist = PERSIST_IMPORT.exec(code);
  if (!persist) return 'no-persist';
  const first = FIRST_IMPORT.exec(code);
  if (first && ISOLATING_SPECS.has(first[1] || first[2])) return 'helper-first';
  const env = ENV_ASSIGN.exec(code);
  if (env && env.index < persist.index) return 'env-first';
  if (INJECTED_DIR.test(code)) return 'injected';
  return 'unsafe';
}

function listTests() {
  return fs.readdirSync(TESTS_DIR).filter((n) => n.endsWith('.test.js')).sort();
}

test('classify recognises each isolation class', () => {
  const persist = "import { x } from '../lib/persist/todos-persist.js';\n";
  assert.equal(classify("import './helpers/isolated-data-dir.js';\n" + persist), 'helper-first');
  assert.equal(classify("/** doc */\n// note\nimport './helpers/isolated-data-dir.js';\n" + persist), 'helper-first');
  assert.equal(classify("import fs from 'node:fs';\nimport './helpers/isolated-data-dir.js';\n" + persist), 'unsafe');
  assert.equal(classify("process.env.CRETLI_DATA_DIR = d;\nconst m = await import('../lib/persist/settings.js');\n"), 'env-first');
  assert.equal(classify(persist + 'f({ dataDir });\n'), 'injected');
  assert.equal(classify("// import '../lib/persist/settings.js'\nimport fs from 'fs';\n"), 'no-persist');
});

test('every test importing lib/persist isolates the data dir', () => {
  const offenders = [];
  for (const name of listTests()) {
    if (ALLOWED.has(`tests/${name}`)) continue;
    const verdict = classify(fs.readFileSync(path.join(TESTS_DIR, name), 'utf8'));
    if (verdict === 'unsafe') offenders.push(`tests/${name}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `Tests importing lib/persist without isolating the data dir (add \`import './helpers/isolated-data-dir.js';\` as the FIRST import):\n${offenders.join('\n')}`,
  );
});

test('allow-listed files still exist and still need the exception', () => {
  for (const [rel, reason] of ALLOWED) {
    assert.ok(reason && reason.length > 8, `allow-list entry needs a reason: ${rel}`);
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `stale allow-list entry: ${rel}`);
    assert.equal(classify(fs.readFileSync(abs, 'utf8')), 'unsafe', `no longer needs allow-listing: ${rel}`);
  }
});
