#!/usr/bin/env node
/**
 * Run every tests/*.test.js in an isolated Node process.
 * Files that import node:test use --test; standalone assert scripts run as-is.
 * Each file gets a wall-clock budget (CRETLI_TEST_FILE_TIMEOUT_MS, default 5 min): a hung file is killed
 * (SIGTERM, then SIGKILL after a short grace), counted as failed, and the suite continues.
 * `--core-only` runs only tests/*.test.js; `--plugins-only` runs only harnesses/<id>/tests/*.test.js
 * (CI jobs `core` and `optional`). Without either flag both sets run.
 * `--jobs N` (or CRETLI_TEST_JOBS=N) runs N files at once, each with its own temp CRETLI_DATA_DIR and
 * fully buffered output; without it (or with N=1) the original sequential path runs unchanged.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { assertNodeVersion } from './node-version-check.mjs';

/**
 * Child env for a test file. The worktree free-disk floor (20 GB by default)
 * is a production guard; hosted CI runners have less free space than that, so
 * tests run with it off unless the caller sets CRETLI_WORKTREE_MIN_FREE_GB.
 *
 * @param {Record<string, string>} extra
 * @returns {NodeJS.ProcessEnv}
 */
function testEnv(extra) {
  return { CRETLI_WORKTREE_MIN_FREE_GB: '0', ...process.env, ...extra };
}

/**
 * Test files that must not overlap with any other file: they share state outside their own
 * CRETLI_DATA_DIR (the repo tree, fixed ports) or measure timing. With --jobs > 1 they run
 * one at a time after the parallel pool drains.
 */
const SERIAL_ONLY_TEST_FILES = new Set([
  // Both write and delete the same marker files under the real <repo>/data and the repo root.
  'review-verify.test.js',
  'delegation-review-tools.test.js',
  // Bind real OpenCode servers from a fixed OPENCODE_PORT_BASE (26000 / 28000) and sweep listeners.
  'opencode-shutdown.test.js',
  'opencode-instance-limit.test.js',
  // sidebar-chat-row / sidebar-transient-patch now pick a free port per run (kept serial as a belt-and-braces guard)...
  'sidebar-chat-row.test.js',
  'sidebar-transient-patch.test.js',
  // ...and SIDEBAR_WORKSPACE_DOM_PORT (default 3398 here, 3399 in the *-lit tests).
  'sidebar-archive-virtual-dom.test.js',
  'sidebar-lit-lifecycle.test.js',
  // Fixed SIDEBAR_SUBCHAT_GROUP_DOM port.
  'sidebar-subchat-group-dom.test.js',
  'sidebar-workspace-lit.test.js',
  // Wall-clock benchmark: contention from parallel files would skew its timings.
  'storage-chat-history-bench.test.js',
]);

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ jobs: number, fileArgs: string[], selection: 'all' | 'core' | 'plugins' }}
 */
function parseRunnerArgs(argv, env) {
  let rawJobs = env.CRETLI_TEST_JOBS === undefined || env.CRETLI_TEST_JOBS === '' ? undefined : env.CRETLI_TEST_JOBS;
  const fileArgs = [];
  /** @type {'all' | 'core' | 'plugins'} */
  let selection = 'all';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--jobs') {
      if (i + 1 >= argv.length) fail('--jobs requires a value (a positive integer)');
      rawJobs = argv[++i];
    } else if (arg === '--core-only' || arg === '--plugins-only') {
      const next = arg === '--core-only' ? 'core' : 'plugins';
      if (selection !== 'all' && selection !== next) fail('--core-only and --plugins-only cannot be combined');
      selection = next;
    } else if (arg.startsWith('--jobs=')) {
      rawJobs = arg.slice('--jobs='.length);
    } else {
      fileArgs.push(arg);
    }
  }
  if (rawJobs === undefined) return { jobs: 1, fileArgs, selection };
  if (!/^[1-9][0-9]*$/.test(String(rawJobs).trim())) {
    fail(`--jobs must be a positive integer (got ${JSON.stringify(rawJobs)})`);
  }
  return { jobs: Number(String(rawJobs).trim()), fileArgs, selection };
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(message);
  process.exit(1);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assertNodeVersion(path.join(projectRoot, 'package.json'));
// CRETLI_TEST_DIR lets tests/run-unit-tests-runner.test.js point the runner at tiny fixture files.
const testsDir = process.env.CRETLI_TEST_DIR ? path.resolve(process.env.CRETLI_TEST_DIR) : path.join(projectRoot, 'tests');
const { jobs, fileArgs, selection } = parseRunnerArgs(process.argv.slice(2), process.env);
// Persistence tests write real chats/settings/history. Point them at a scratch
// directory so running the suite never touches a contributor's own data/.
const dataDir = jobs > 1 ? null : await mkdtemp(path.join(os.tmpdir(), 'cretli-test-data-'));
// Optional file arguments (`tests/x.test.js` or `x.test.js`) narrow the run;
// scripts/run-affected-tests.mjs passes the tests touched by a change.
const requested = new Set(fileArgs.map((arg) => path.basename(arg)));
const allFiles = selection === 'plugins' ? [] : (await readdir(testsDir))
  .filter((name) => name.endsWith('.test.js'))
  .sort();
// Repo harness plugins keep their tests next to the plugin (harnesses/<id>/tests/*.test.js).
// They are addressed relative to testsDir so the rest of the runner treats them like any other file.
// CRETLI_TEST_PLUGINS_DIR points the plugin scan at fixtures (tests/run-unit-tests-runner.test.js).
const pluginsDir = process.env.CRETLI_TEST_PLUGINS_DIR ? path.resolve(process.env.CRETLI_TEST_PLUGINS_DIR) : path.join(projectRoot, 'harnesses');
if (selection !== 'core' && (!process.env.CRETLI_TEST_DIR || process.env.CRETLI_TEST_PLUGINS_DIR)) {
  for (const entry of await readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const pluginTests = await readdir(path.join(pluginsDir, entry.name, 'tests')).catch(() => []);
    for (const name of pluginTests.filter((file) => file.endsWith('.test.js')).sort()) {
      allFiles.push(path.relative(testsDir, path.join(pluginsDir, entry.name, 'tests', name)));
    }
  }
}
const unknown = [...requested].filter((name) => !allFiles.some((file) => path.basename(file) === name));
if (unknown.length > 0) {
  console.error(`Unknown test file(s): ${unknown.join(', ')}`);
  process.exit(1);
}
const files = requested.size > 0 ? allFiles.filter((name) => requested.has(path.basename(name))) : allFiles;

const DEFAULT_FILE_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const rawTimeout = process.env.CRETLI_TEST_FILE_TIMEOUT_MS;
const fileTimeoutMs = rawTimeout === undefined || rawTimeout === '' ? DEFAULT_FILE_TIMEOUT_MS : Number(rawTimeout);
if (!Number.isFinite(fileTimeoutMs) || fileTimeoutMs <= 0) {
  console.error(`CRETLI_TEST_FILE_TIMEOUT_MS must be a positive number of milliseconds (got ${JSON.stringify(rawTimeout)})`);
  process.exit(1);
}

if (files.length === 0) {
  console.error('No tests/*.test.js files found');
  process.exit(1);
}

/**
 * Runs one test file with buffered output and its own data dir; resolves with the full report.
 * @param {string} name
 * @returns {Promise<{ name: string, output: string, failure: string }>}
 */
async function runFileBuffered(name) {
  const filePath = path.join(testsDir, name);
  const usesNodeTest = /from ['"]node:test['"]/.test(readFileSync(filePath, 'utf8'));
  const args = usesNodeTest ? ['--test', filePath] : [filePath];
  const fileDataDir = await mkdtemp(path.join(os.tmpdir(), 'cretli-test-data-'));
  const chunks = [];
  let timedOut = false;
  try {
    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: testEnv({ CRETLI_DATA_DIR: fileDataDir }),
      });
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => chunks.push(chunk));
      let killTimer = null;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      }, fileTimeoutMs);
      child.on('error', () => resolve(1));
      child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve(code ?? 1);
      });
    });
    let failure = '';
    if (timedOut) failure = `FAILED ${name} (timeout after ${Math.round(fileTimeoutMs / 1000)}s)`;
    else if (exitCode !== 0) failure = `FAILED ${name} (exit ${exitCode})`;
    return { name, output: Buffer.concat(chunks).toString('utf8'), failure };
  } finally {
    await rm(fileDataDir, { recursive: true, force: true });
  }
}

/**
 * Prints a finished file's whole report in one write so parallel files never interleave.
 * @param {{ name: string, output: string, failure: string }} result
 * @returns {boolean} true when the file failed
 */
function printResult(result) {
  process.stdout.write(`\n==> ${result.name}\n${result.output}`);
  if (result.failure) console.error(result.failure);
  return Boolean(result.failure);
}

/**
 * @param {string[]} names
 * @param {number} limit
 * @returns {Promise<number>} number of failed files
 */
async function runPool(names, limit) {
  let failedCount = 0;
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      if (printResult(await runFileBuffered(name))) failedCount += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, names.length) }, worker));
  return failedCount;
}

let failed = 0;
if (jobs > 1) {
  const parallelNames = files.filter((name) => !SERIAL_ONLY_TEST_FILES.has(name));
  const serialNames = files.filter((name) => SERIAL_ONLY_TEST_FILES.has(name));
  failed += await runPool(parallelNames, jobs);
  failed += await runPool(serialNames, 1);
} else {
  for (const name of files) {
    const filePath = path.join(testsDir, name);
    const source = readFileSync(filePath, 'utf8');
    const usesNodeTest = /from ['"]node:test['"]/.test(source);
    const args = usesNodeTest ? ['--test', filePath] : [filePath];
    process.stdout.write(`\n==> ${name}\n`);
    let timedOut = false;
    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: projectRoot,
        stdio: 'inherit',
        env: testEnv({ CRETLI_DATA_DIR: dataDir }),
      });
      let killTimer = null;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      }, fileTimeoutMs);
      child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve(code ?? 1);
      });
    });
    if (timedOut) {
      failed += 1;
      console.error(`FAILED ${name} (timeout after ${Math.round(fileTimeoutMs / 1000)}s)`);
    } else if (exitCode !== 0) {
      failed += 1;
      console.error(`FAILED ${name} (exit ${exitCode})`);
    }
  }
}

if (dataDir) await rm(dataDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed}/${files.length} test file(s) failed`);
  process.exit(1);
}
console.log(`\n${files.length} test file(s) passed`);
