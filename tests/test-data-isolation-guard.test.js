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

import './helpers/isolated-data-dir.js';
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
// Transitive-only offenders pending a fix (file -> reason). Must stay empty.
const TRANSITIVE_ALLOWED = new Map([]);

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

const IMPORT_SPEC_G = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]|\b(?:import|export)\s+(?:[^'"`;]*?\bfrom\s*)?['"`]([^'"`]+)['"`]/g;

/**
 * Relative import specifiers of a source file (static, re-export and dynamic).
 * @param {string} source
 * @returns {string[]}
 */
export function relativeImports(source) {
  const out = [];
  for (const m of stripComments(source).matchAll(IMPORT_SPEC_G)) {
    const spec = m[1] || m[2];
    if (spec && spec.startsWith('.')) out.push(spec);
  }
  return out;
}

const SOURCE_EXT = /\.(?:js|mjs|cjs|ts|mts|cts|tsx)$/;
const defaultRead = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

/** @param {string} file */
const isPersistFile = (file) => file.split(path.sep).join('/').includes('/lib/persist/');

/**
 * Whether `file` reaches a module matching `target` through any chain of
 * relative imports (static or dynamic, from .js and .ts sources). A `./x.js`
 * specifier whose file is missing falls back to `./x.ts`. `read` is injectable
 * for the unit test.
 *
 * @param {string} file absolute path
 * @param {(f: string) => string | null} [read]
 * @param {Set<string>} [seen]
 * @param {(f: string) => boolean} [target]
 * @returns {boolean}
 */
export function reachesPersist(file, read = defaultRead, seen = new Set(), target = isPersistFile) {
  if (seen.has(file)) return false;
  seen.add(file);
  if (target(file)) return true;
  let source = read(file);
  if (source == null && /\.js$/.test(file)) source = read(file.replace(/\.js$/, '.ts'));
  if (source == null || !SOURCE_EXT.test(file)) return false;
  for (const spec of relativeImports(source)) {
    if (reachesPersist(path.resolve(path.dirname(file), spec), read, seen, target)) return true;
  }
  return false;
}

const STATIC_IMPORT_G = /\b(?:import|export)\s+(?:[^'"`;()]*?\bfrom\s*)?['"`]([^'"`]+)['"`]/g;
const DYNAMIC_IMPORT_G = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g;

/**
 * Isolation violations of one test file, whatever its class (helper-first,
 * env-first, injected or none): a module that resolves the data dir at load
 * and is reachable from the test must be loaded after the data dir is
 * redirected. Static imports are hoisted, so an in-body CRETLI_DATA_DIR
 * assignment can never precede them; only an isolating import placed before
 * them helps. Dynamic imports must follow the assignment (or an isolating import).
 *
 * @param {string} source test source
 * @param {string} abs absolute path of the test file
 * @param {(f: string) => string | null} [read]
 * @returns {string[]} human-readable violations (empty = safe)
 */
export function isolationViolations(source, abs, read = defaultRead) {
  const code = stripComments(source);
  const dir = path.dirname(abs);
  const isolatingTails = [...ISOLATING_SPECS].map((spec) => `/tests/${spec.slice(2)}`);
  const isIsolating = (resolved) => isolatingTails.some((tail) => resolved.split(path.sep).join('/').endsWith(tail));
  const envAt = ENV_ASSIGN.exec(code)?.index ?? Infinity;
  // With an env assignment the data dir matters to anything that resolves it
  // (runtime-paths); without one only persist modules are a hazard.
  const target = isPersistFile;
  const imports = [];
  for (const m of code.matchAll(STATIC_IMPORT_G)) imports.push({ spec: m[1], index: m.index, dynamic: false });
  for (const m of code.matchAll(DYNAMIC_IMPORT_G)) imports.push({ spec: m[1], index: m.index, dynamic: true });
  imports.sort((x, y) => x.index - y.index);
  const out = [];
  let isolated = false;
  // Static imports evaluate first, in order; dynamic ones run in body order.
  const ordered = [...imports.filter((i) => !i.dynamic), ...imports.filter((i) => i.dynamic)];
  for (const imp of ordered) {
    if (!imp.spec.startsWith('.')) continue;
    const resolved = path.resolve(dir, imp.spec);
    if (isIsolating(resolved)) {
      isolated = true;
      continue;
    }
    if (isolated) continue;
    if (imp.dynamic && envAt < imp.index) continue;
    if (reachesPersist(resolved, read, new Set(), target)) {
      out.push(`${imp.dynamic ? 'dynamic' : 'static'} import '${imp.spec}' reaches the data-dir modules before the data dir is isolated`);
    }
  }
  return out;
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

test('reachesPersist follows transitive and dynamic imports', () => {
  const files = {
    '/r/tests/a.test.js': "import { x } from '../lib/mid.js';",
    '/r/tests/b.test.js': "const m = await import('../lib/mid2.js');",
    '/r/tests/c.test.js': "import fs from 'node:fs';",
    '/r/lib/mid.js': "export * from './persist/chats-persist.js';",
    '/r/lib/mid2.js': "import './mid.js';",
    '/r/lib/persist/chats-persist.js': '',
  };
  const read = (f) => files[f] ?? null;
  assert.equal(reachesPersist('/r/tests/a.test.js', read), true);
  assert.equal(reachesPersist('/r/tests/b.test.js', read), true);
  assert.equal(reachesPersist('/r/tests/c.test.js', read), false);
});

test('isolationViolations reproduces the todo-tools incident shape', () => {
  const abs = '/r/tests/x.test.js';
  const files = {
    '/r/tests/fixtures/fake-transport.js': "import { saveChats } from '../../lib/persist/chats-legacy-store.js';",
    '/r/tests/helpers/isolated-data-dir.js': '',
    '/r/lib/persist/chats-persist.js': "import { resolveDataPath } from '../runtime-paths.js';",
    '/r/lib/runtime-paths.js': '',
    '/r/lib/tsmod.ts': "import { x } from './persist/chats-persist.js';",
  };
  const read = (f) => files[f] ?? null;
  // Env assignment after a hoisted static import that reaches persist: unsafe.
  const incident = "import test from 'node:test';\nimport './fixtures/fake-transport.js';\nprocess.env.CRETLI_DATA_DIR = d;\n";
  assert.equal(isolationViolations(incident, abs, read).length, 1);
  // Isolation helper first: safe.
  assert.deepEqual(isolationViolations("import './helpers/isolated-data-dir.js';\n" + incident, abs, read), []);
  // Env assignment before a dynamic import: safe; after it: unsafe.
  assert.deepEqual(isolationViolations("process.env.CRETLI_DATA_DIR = d;\nawait import('./fixtures/fake-transport.js');\n", abs, read), []);
  assert.equal(isolationViolations("await import('./fixtures/fake-transport.js');\nprocess.env.CRETLI_DATA_DIR = d;\n", abs, read).length, 1);
  // Injected dataDir does not excuse a static import that reaches persist.
  assert.equal(isolationViolations("import './fixtures/fake-transport.js';\nf({ dataDir });\n", abs, read).length, 1);
  // Chain through a .ts source is followed; unrelated imports are fine.
  assert.equal(isolationViolations("import '../lib/tsmod.js';\n", abs, read).length, 1);
  assert.equal(reachesPersist('/r/lib/tsmod.ts', read), true);
  assert.deepEqual(isolationViolations("import fs from 'node:fs';\n", abs, read), []);
});

test('every test importing lib/persist directly isolates the data dir', () => {
  const offenders = listTests()
    .filter((n) => !ALLOWED.has(`tests/${n}`) && classify(fs.readFileSync(path.join(TESTS_DIR, n), 'utf8')) === 'unsafe')
    .map((n) => `tests/${n}`);
  assert.deepEqual(offenders, [], `Add \`import './helpers/isolated-data-dir.js';\` as the FIRST import:\n${offenders.join('\n')}`);
});

// Ratchet for the transitive check: these tests predate it and are NOT edited here. They are protected at
// runtime instead (resolveDataPath throws for the real <repo>/data under node --test). The count may only shrink.
const TRANSITIVE_BASELINE = 335;

test('every test that reaches the data-dir modules isolates the data dir first', () => {
  const offenders = [];
  const files = new Set();
  for (const name of listTests()) {
    const rel = `tests/${name}`;
    if (ALLOWED.has(rel) || TRANSITIVE_ALLOWED.has(rel)) continue;
    const abs = path.join(TESTS_DIR, name);
    for (const v of isolationViolations(fs.readFileSync(abs, 'utf8'), abs)) {
      offenders.push(`${rel}: ${v}`);
      files.add(rel);
    }
  }
  assert.ok(
    files.size <= TRANSITIVE_BASELINE,
    `${files.size} tests load data-dir modules before isolating (baseline ${TRANSITIVE_BASELINE}); add \`import './helpers/isolated-data-dir.js';\` as the FIRST import of new tests:\n${offenders.join('\n')}`,
  );
});

test('todo sync tests isolate module-level stores before importing dependencies', () => {
  // Injected todo dataDir options do not isolate history and delegation stores.
  for (const name of ['todo-plan-sync.test.js', 'todo-review-sync.test.js']) {
    assert.equal(classify(fs.readFileSync(path.join(TESTS_DIR, name), 'utf8')), 'helper-first', name);
  }
});

test('allow-listed files still exist and still need the exception', () => {
  for (const [rel, reason] of ALLOWED) {
    assert.ok(reason && reason.length > 8, `allow-list entry needs a reason: ${rel}`);
    const abs = path.join(ROOT, rel);
    assert.ok(fs.existsSync(abs), `stale allow-list entry: ${rel}`);
    assert.equal(classify(fs.readFileSync(abs, 'utf8')), 'unsafe', `no longer needs allow-listing: ${rel}`);
  }
});
