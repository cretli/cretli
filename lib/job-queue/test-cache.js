/**
 * Test-result cache keyed by content hash.
 *
 * The key covers the environment fact set, the shared non-import inputs
 * (lockfile, package.json, test fixtures), the test file and every file in its
 * import closure, so a test untouched by a change keeps its key and its stored
 * PASS is reused instead of re-running. Only passing results are cached: a
 * failure is always re-run, so a flaky or fixed test never sticks as red.
 *
 * Known limit: reads the import graph cannot see (computed paths, git state,
 * files outside the shared inputs) are invisible to the key, which is why
 * integration mode never reads or writes the cache.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { collectDependencies } from './import-graph.js';

/** Non-import inputs that still change a test outcome (files or directories, repo-relative). */
export const SHARED_INPUT_PATHS = Object.freeze(['package.json', 'package-lock.json', 'tests/fixtures']);
const SHARED_INPUT_MAX_FILES = 5000;

/** @param {Buffer | string} content */
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string[]} out
 */
function collectSharedFiles(root, rel, out) {
  if (out.length >= SHARED_INPUT_MAX_FILES) return;
  const absolute = path.join(root, rel);
  if (!existsSync(absolute)) return;
  if (!statSync(absolute).isDirectory()) {
    out.push(rel);
    return;
  }
  for (const dirent of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    collectSharedFiles(root, `${rel}/${dirent.name}`, out);
  }
}

/**
 * Digest of the inputs every test shares (lockfile, package.json, fixtures).
 * Compute once per verify run and pass it to {@link computeTestHash}.
 *
 * @param {string} root
 * @param {readonly string[]} [paths]
 * @returns {string}
 */
export function computeSharedInputsKey(root, paths = SHARED_INPUT_PATHS) {
  /** @type {string[]} */
  const files = [];
  for (const rel of paths) collectSharedFiles(root, rel, files);
  const h = createHash('sha256');
  for (const file of files) {
    let content;
    try { content = readFileSync(path.join(root, file)); } catch { content = Buffer.from('<unreadable>'); }
    h.update(`${file}\0${sha256(content)}\n`);
  }
  return h.digest('hex');
}

/**
 * @param {{ root: string, test: string, index: Map<string, string[]>, envKey: string, sharedKey?: string }} input
 *   `envKey` is the verify environment fact hash (computeVerifyEnvKey); it is
 *   required so a key can never silently ignore the environment.
 * @returns {{ hash: string, deps: string[] }} deps are repo-relative, sorted
 */
export function computeTestHash({ root, test, index, envKey, sharedKey }) {
  if (typeof envKey !== 'string' || !envKey) throw new TypeError('envKey is required for the test-result cache key');
  const deps = collectDependencies(index, test);
  const h = createHash('sha256');
  h.update(`env:${envKey}\nnode:${process.version}\nshared:${sharedKey ?? computeSharedInputsKey(root)}\n`);
  for (const dep of deps) {
    let content;
    try { content = readFileSync(path.join(root, dep)); } catch { content = Buffer.from('<missing>'); }
    h.update(`${dep}\0${sha256(content)}\n`);
  }
  return { hash: h.digest('hex'), deps };
}

/**
 * Run `tests`, serving unchanged passing tests from `store`.
 *
 * @param {{
 *   root: string,
 *   tests: string[],
 *   index: Map<string, string[]>,
 *   store: { get(test: string, hash: string): object | null, put(test: string, hash: string, row: object): void },
 *   run: (test: string) => Promise<{ ok: boolean, durationMs?: number, outputTail?: string }>,
 *   envKey: string,
 *   mode?: 'leaf' | 'integration',
 *   onCache?: (event: 'hit' | 'miss') => void,
 * }} input `mode: 'integration'` proves the whole suite fresh: the cache is neither read nor written.
 * @returns {Promise<Array<{ test: string, ok: boolean, cached: boolean, hash: string, durationMs: number, outputTail: string, detail: any }>>}
 */
export async function runTestsWithCache({ root, tests, index, store, run, envKey, mode, onCache }) {
  if (mode === 'integration') {
    return Promise.all(tests.map(async (test) => {
      const result = await run(test);
      return { test, ok: result?.ok === true, cached: false, hash: '', durationMs: Number(result?.durationMs) || 0, outputTail: String(result?.outputTail || ''), detail: result };
    }));
  }
  const sharedKey = computeSharedInputsKey(root);
  // Misses start together so a queue-backed `run` can spread them over the pool.
  return Promise.all(tests.map(async (test) => {
    const { hash } = computeTestHash({ root, test, index, envKey, sharedKey });
    if (store.get(test, hash)) {
      onCache?.('hit');
      return { test, ok: true, cached: true, hash, durationMs: 0, outputTail: '', detail: null };
    }
    onCache?.('miss');
    const result = await run(test);
    const ok = result?.ok === true;
    const durationMs = Number(result?.durationMs) || 0;
    if (ok) store.put(test, hash, { durationMs });
    return { test, ok, cached: false, hash, durationMs, outputTail: String(result?.outputTail || ''), detail: result };
  }));
}
