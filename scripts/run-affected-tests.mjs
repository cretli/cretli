#!/usr/bin/env node
/**
 * Run only the unit tests a change can affect: the fast loop between full runs.
 *
 * Builds a reverse import graph over server.js, lib/, app_front/, scripts/ and
 * tests/ (static `import`/`export … from`, `import('…')`, `require('…')` and
 * `new URL('…', import.meta.url)` with relative literals). A top-level
 * tests/*.test.js is selected when it transitively reaches a changed file, or
 * when it names a changed file's basename in a string literal (source-pinning
 * tests read files through path.join). Selected files run through
 * scripts/run-unit-tests.mjs, so timeouts and the data dir behave the same.
 *
 *   node scripts/run-affected-tests.mjs                # changes vs HEAD, incl. untracked
 *   node scripts/run-affected-tests.mjs --base <ref>   # changes vs <ref>
 *   node scripts/run-affected-tests.mjs --list         # print the selection only
 *   node scripts/run-affected-tests.mjs lib/a.js ...   # explicit changed files
 *
 * The full suite (`npm test`) stays the gate before pushing: computed paths,
 * env-driven behaviour and shared on-disk state are invisible to a static graph.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = ['server.js', 'lib', 'app_front', 'scripts', 'tests'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.tmp', '.vendor']);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g,
];
// Changes here can alter any test without an import edge; suggest a full run.
const GLOBAL_FILES = new Set(['package.json', 'package-lock.json', 'scripts/run-unit-tests.mjs']);

/**
 * @param {string} root
 * @param {string} entry repo-relative
 * @returns {string[]} repo-relative source files
 */
function listSourceFiles(root, entry) {
  const absolute = path.join(root, entry);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return SOURCE_EXTENSIONS.has(path.extname(entry)) ? [entry] : [];
  /** @type {string[]} */
  const files = [];
  for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
    if (dirent.isDirectory() && SKIP_DIRS.has(dirent.name)) continue;
    files.push(...listSourceFiles(root, `${entry}/${dirent.name}`));
  }
  return files;
}

/**
 * @param {string} root
 * @param {string} fromFile repo-relative importer
 * @param {string} specifier
 * @returns {string | null} repo-relative target, or null for bare/unresolvable specifiers
 */
function resolveSpecifier(root, fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = path.resolve(path.dirname(path.join(root, fromFile)), specifier.split('?')[0]);
  for (const candidate of [target, `${target}.js`, `${target}.ts`, path.join(target, 'index.js'), path.join(target, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return path.relative(root, candidate).split(path.sep).join('/');
    }
  }
  return null;
}

/**
 * @param {{ root?: string, changed: string[] }} input changed paths are repo-relative
 * @returns {{ tests: string[], global: string[] }}
 */
export function findAffectedTests({ root = projectRoot, changed }) {
  const sources = SCAN_ROOTS.flatMap((entry) => listSourceFiles(root, entry));
  /** @type {Map<string, Set<string>>} target -> importers */
  const importers = new Map();
  /** @type {Map<string, string>} */
  const contents = new Map();
  for (const file of sources) {
    const text = readFileSync(path.join(root, file), 'utf8');
    contents.set(file, text);
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const target = resolveSpecifier(root, file, match[1]);
        if (!target || target === file) continue;
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target)?.add(file);
      }
    }
  }

  const reached = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift());
    for (const importer of importers.get(file) || []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }

  const isRunnableTest = (/** @type {string} */ file) => /^tests\/[^/]+\.test\.js$/.test(file);
  const tests = new Set([...reached].filter(isRunnableTest));

  // Source-pinning tests: a quoted basename of a changed file. Ambiguous
  // basenames (several files share it, e.g. index.js) would select noise.
  const basenameCounts = new Map();
  for (const file of sources) {
    const base = path.basename(file);
    basenameCounts.set(base, (basenameCounts.get(base) || 0) + 1);
  }
  const pinnedNames = changed
    .map((file) => path.basename(file))
    .filter((base) => SOURCE_EXTENSIONS.has(path.extname(base)) && basenameCounts.get(base) === 1);
  if (pinnedNames.length > 0) {
    for (const [file, text] of contents) {
      if (!isRunnableTest(file) || tests.has(file)) continue;
      if (pinnedNames.some((base) => text.includes(`'${base}'`) || text.includes(`/${base}'`) || text.includes(`"${base}"`))) {
        tests.add(file);
      }
    }
  }

  return {
    tests: [...tests].sort(),
    global: changed.filter((file) => GLOBAL_FILES.has(file)),
  };
}

/**
 * @param {string} root
 * @param {string} base
 * @returns {string[]}
 */
function gitChangedFiles(root, base) {
  const git = (/** @type {string[]} */ args) => {
    const result = spawnSync('git', ['-c', `safe.directory=${root}`, ...args], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  };
  return [...new Set([
    ...git(['diff', '--name-only', base]),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ])].sort();
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  const baseIndex = args.indexOf('--base');
  const base = baseIndex >= 0 ? args[baseIndex + 1] : 'HEAD';
  if (baseIndex >= 0 && !base) {
    console.error('--base needs a git ref');
    process.exit(1);
  }
  const explicit = args.filter((arg, index) => !arg.startsWith('--') && index !== baseIndex + 1);
  const changed = explicit.length > 0 ? explicit : gitChangedFiles(projectRoot, base);
  if (changed.length === 0) {
    console.log('[affected] no changed files');
    return;
  }
  const { tests, global } = findAffectedTests({ changed });
  console.log(`[affected] ${changed.length} changed file(s) -> ${tests.length} test file(s)`);
  if (global.length > 0) {
    console.warn(`[affected] ${global.join(', ')} changed: run the full suite (npm test) as well`);
  }
  if (listOnly) {
    for (const test of tests) console.log(test);
    return;
  }
  if (tests.length === 0) return;
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'run-unit-tests.mjs'), ...tests], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  child.on('close', (code) => process.exit(code ?? 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
