/**
 * Static import graph for test-result hashing and affected-test selection.
 *
 * Mirrors the specifier patterns of scripts/run-affected-tests.mjs (relative
 * literals only; bare package specifiers are ignored). Computed paths and
 * env-driven behaviour are invisible here, which is why the full suite still
 * runs at integration.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SCAN_ROOTS = ['server.js', 'lib', 'app_front', 'scripts', 'tests', 'harnesses'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.tmp', '.vendor']);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g,
];

/** @param {string} root @param {string} entry */
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
 * @returns {string | null} repo-relative target
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
 * Forward import index: file -> direct relative imports. Build once per
 * verify planning pass and reuse it for every test closure.
 *
 * @param {string} root
 * @returns {Map<string, string[]>}
 */
export function buildImportIndex(root) {
  /** @type {Map<string, string[]>} */
  const index = new Map();
  for (const file of SCAN_ROOTS.flatMap((entry) => listSourceFiles(root, entry))) {
    const text = readFileSync(path.join(root, file), 'utf8');
    const targets = new Set();
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const target = resolveSpecifier(root, file, match[1]);
        if (target && target !== file) targets.add(target);
      }
    }
    index.set(file, [...targets]);
  }
  return index;
}

/**
 * Transitive dependency closure of a file (the file itself included), sorted.
 *
 * @param {Map<string, string[]>} index
 * @param {string} file repo-relative
 * @returns {string[]}
 */
export function collectDependencies(index, file) {
  const seen = new Set([file]);
  const stack = [file];
  while (stack.length > 0) {
    for (const next of index.get(/** @type {string} */ (stack.pop())) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return [...seen].sort();
}
