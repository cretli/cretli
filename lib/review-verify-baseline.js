/**
 * Baseline-aware classification of a host review verify.
 *
 * The raw runner (`runReviewVerify`) stays untouched. After it reports failing
 * ids, this module re-runs ONLY those ids (plus one fast control id) against
 * the leaf's base commit, extracted with `git archive` into a throw-away temp
 * dir (no `git worktree add`, nothing written into the shared .git, the user's
 * working tree and stash are never touched). An id that also fails at the base
 * is `preexisting` and does not block; an id that passes (or is absent) at the
 * base is NEW and always blocks.
 *
 * Fail-safe: when the baseline cannot be trusted (no base commit, extract
 * failure, control id failing, module/ENOENT errors, budget expiry) the result
 * is `baseline.source = 'unavailable'` and the raw outcome stands.
 *
 * Known limitations: a baseline failure of a test file can hide a different new
 * failure inside the same file; a regression in a test that is flaky at base is
 * hidden; project-mode leaves (no `leafMaterial.baseCommit`) are `unavailable`;
 * a test whose normal output mentions ENOENT makes the baseline unavailable.
 *
 * Budgets (inside the existing hard limits: 60 s per file, 5 min pending
 * marker, 60 s bridge ceiling): the synchronous `delegation_verify` tool caps
 * baseline work at min(25 s, remaining call budget); the asynchronous
 * auto-verify path caps it at 90 s so verify + baseline normally finishes
 * inside the 5-minute pending marker.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataPath } from './runtime-paths.js';
import {
  REVIEW_VERIFY_TIMEOUT_MS,
  resolveReviewVerifyCatalog,
  resolveReviewVerifyProjectRoot,
  spawnReviewVerifyFile,
} from './sdk/sdk-review-verify.js';

/** Fast, stable, lib-only catalog id that must pass at the base commit. */
export const BASELINE_CONTROL_ID = 'todo-ref';
export const BASELINE_TEMP_PREFIX = 'cretli-review-verify-base-';
export const BASELINE_SYNC_BUDGET_MS = 25000;
export const BASELINE_ASYNC_BUDGET_MS = 90000;
const BASELINE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const ENVIRONMENT_ERROR_RE = /ERR_MODULE_NOT_FOUND|ENOENT/;
const RESULTS_MAX = 200;
const OUTPUT_TAIL_MAX = 4096;

/** @type {Map<string, Promise<object>>} per-(commit,id) in-flight dedupe */
const inFlightBaselineIds = new Map();

/**
 * @param {string} baseCommit
 * @param {string} [cacheDir]
 * @returns {string}
 */
function cacheFilePath(baseCommit, cacheDir) {
  const dir = cacheDir || path.join(resolveDataPath(), 'review-verify-baseline');
  const safe = createHash('sha1').update(String(baseCommit)).digest('hex');
  return path.join(dir, `${safe}.json`);
}

/**
 * @param {string} file
 * @returns {Record<string, { state: string }>}
 */
function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed.ids === 'object' && parsed.ids ? parsed.ids : {};
  } catch {
    return {};
  }
}

/**
 * Atomic per-id cache write (temp file + rename); only COMPLETED results.
 *
 * @param {string} file
 * @param {string} id
 * @param {{ state: string }} entry
 */
function writeCacheEntry(file, id, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ids = { ...readCache(file), [id]: entry };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ids }));
    fs.renameSync(tmp, file);
  } catch { /* cache is best effort */ }
}

/**
 * Remove leftover base dirs from crashed runs.
 *
 * @param {{ tmpDir?: string, now?: number }} [options]
 */
export function sweepBaselineTempDirs(options = {}) {
  const tmpDir = options.tmpDir || os.tmpdir();
  const now = options.now ?? Date.now();
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      if (!name.startsWith(BASELINE_TEMP_PREFIX)) continue;
      const full = path.join(tmpDir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > BASELINE_TEMP_MAX_AGE_MS) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch { /* raced */ }
    }
  } catch { /* tmp unreadable */ }
}

/**
 * Default extractor: `git archive <commit> | tar -x -C dest`.
 *
 * @param {{ projectRoot: string, baseCommit: string, dest: string }} input
 * @returns {Promise<void>}
 */
export function extractBaseCommit({ projectRoot, baseCommit, dest }) {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['-C', projectRoot, 'archive', '--format=tar', baseCommit], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let gitFailed = '';
    git.stderr.on('data', (c) => { gitFailed += c.toString(); });
    git.stdout.pipe(tar.stdin);
    let gitCode = null;
    let tarCode = null;
    const done = () => {
      if (gitCode === null || tarCode === null) return;
      if (gitCode === 0 && tarCode === 0) resolve();
      else reject(new Error(gitFailed.trim() || `archive failed (git ${gitCode}, tar ${tarCode})`));
    };
    git.on('error', reject);
    tar.on('error', reject);
    git.on('close', (c) => { gitCode = c; done(); });
    tar.on('close', (c) => { tarCode = c; done(); });
  });
}

/**
 * @param {string} baseCommit
 * @param {string} id
 * @param {() => Promise<object>} compute
 * @returns {Promise<object>}
 */
function dedupeBaselineId(baseCommit, id, compute) {
  const key = `${baseCommit}\n${id}`;
  const existing = inFlightBaselineIds.get(key);
  if (existing) return existing;
  const run = compute().finally(() => {
    if (inFlightBaselineIds.get(key) === run) inFlightBaselineIds.delete(key);
  });
  inFlightBaselineIds.set(key, run);
  return run;
}

/**
 * Compute baseline states for ids at the base commit.
 *
 * @param {{
 *   projectRoot: string, baseCommit: string, ids: string[], budgetMs: number,
 *   deps?: { extract?: Function, spawnFile?: Function, cacheDir?: string, now?: () => number, tmpDir?: string },
 * }} input
 * @returns {Promise<{ ok: true, states: Record<string, string> } | { ok: false, reason: string }>}
 *   state per id: `fail` | `pass` | `flaky` | `absent`
 */
async function computeBaselineStates(input) {
  const deps = input.deps || {};
  const now = deps.now || Date.now;
  const deadline = now() + input.budgetMs;
  const tmpDir = deps.tmpDir || os.tmpdir();
  const cacheFile = cacheFilePath(input.baseCommit, deps.cacheDir);
  const cached = readCache(cacheFile);
  const states = {};
  const missing = [];
  for (const id of input.ids) {
    if (cached[id] && typeof cached[id].state === 'string') states[id] = cached[id].state;
    else missing.push(id);
  }
  if (missing.length === 0) return { ok: true, states };
  sweepBaselineTempDirs({ tmpDir });
  const catalog = resolveReviewVerifyCatalog(input.projectRoot);
  const baseDir = fs.mkdtempSync(path.join(tmpDir, BASELINE_TEMP_PREFIX));
  try {
    try {
      await (deps.extract || extractBaseCommit)({ projectRoot: input.projectRoot, baseCommit: input.baseCommit, dest: baseDir });
    } catch (err) {
      return { ok: false, reason: `base_extract_failed: ${String(err?.message || err).slice(0, 200)}` };
    }
    const modules = path.join(input.projectRoot, 'node_modules');
    if (fs.existsSync(modules) && !fs.existsSync(path.join(baseDir, 'node_modules'))) {
      fs.symlinkSync(modules, path.join(baseDir, 'node_modules'), 'dir');
    }
    const dataDir = fs.mkdtempSync(path.join(baseDir, 'data-'));
    const workDir = fs.mkdtempSync(path.join(baseDir, 'cwd-'));
    const spawnFile = deps.spawnFile || spawnReviewVerifyFile;
    for (const id of missing) {
      if (now() >= deadline) return { ok: false, reason: 'baseline_budget_expired' };
      const relative = catalog[id];
      const filePath = relative ? path.resolve(baseDir, relative) : '';
      if (!filePath || !fs.existsSync(filePath)) {
        states[id] = 'absent';
        continue;
      }
      const state = await dedupeBaselineId(input.baseCommit, id, async () => {
        const runs = [];
        for (let i = 0; i < 2; i += 1) {
          if (now() >= deadline) return { reason: 'baseline_budget_expired' };
          const remaining = Math.max(1000, deadline - now());
          runs.push(await spawnFile({ filePath, workDir, dataDir, timeoutMs: Math.min(REVIEW_VERIFY_TIMEOUT_MS, remaining) }));
        }
        if (runs.some((r) => !r.ok && ENVIRONMENT_ERROR_RE.test(`${r.output || ''}\n${r.error || ''}`))) {
          return { reason: 'baseline_environment_error' };
        }
        const failed = runs.filter((r) => !r.ok).length;
        return { state: failed === 2 ? 'fail' : failed === 0 ? 'pass' : 'flaky' };
      });
      if (!state.state) return { ok: false, reason: state.reason };
      states[id] = state.state;
      writeCacheEntry(cacheFile, id, { state: state.state, at: new Date().toISOString() });
    }
    return { ok: true, states };
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

/**
 * Classify a raw verify result against the base commit. Never mutates `raw`.
 *
 * @param {{
 *   raw: { ok: boolean, results?: Array<{ id: string, ok: boolean }>, output?: string, error?: string, dataDir?: string },
 *   projectRoot?: string,
 *   baseCommit?: string,
 *   budgetMs?: number,
 *   deps?: object,
 * }} input
 * @returns {Promise<{
 *   status: 'passed' | 'failed', rawOk: boolean,
 *   newFailures: string[], preexistingFailures: string[], flakyFailures: string[],
 *   baseline: { source: 'not-needed' | 'base-commit' | 'unavailable', baseCommit: string, reason: string },
 * }>}
 */
export async function classifyReviewVerify(input) {
  const raw = input.raw || { ok: false };
  const baseCommit = String(input.baseCommit || '').trim();
  const empty = { newFailures: [], preexistingFailures: [], flakyFailures: [] };
  const unavailable = (reason, failing = []) => ({
    status: raw.ok === true ? 'passed' : 'failed',
    rawOk: raw.ok === true,
    ...empty,
    newFailures: failing,
    baseline: { source: 'unavailable', baseCommit, reason },
  });
  if (raw.ok === true) {
    return { status: 'passed', rawOk: true, ...empty, baseline: { source: 'not-needed', baseCommit, reason: '' } };
  }
  const failing = Array.isArray(raw.results) ? raw.results.filter((r) => !r.ok).map((r) => r.id) : [];
  if (failing.length === 0) return unavailable('no_failing_ids');
  if (!baseCommit) return unavailable('no_base_commit', failing);
  const projectRoot = resolveReviewVerifyProjectRoot(input.projectRoot);
  const budgetMs = Number.isFinite(input.budgetMs) ? Number(input.budgetMs) : BASELINE_ASYNC_BUDGET_MS;
  let computed;
  try {
    computed = await computeBaselineStates({
      projectRoot,
      baseCommit,
      ids: [...new Set([BASELINE_CONTROL_ID, ...failing])],
      budgetMs,
      deps: input.deps,
    });
  } catch (err) {
    return unavailable(`baseline_error: ${String(err?.message || err).slice(0, 200)}`, failing);
  }
  if (!computed.ok) return unavailable(computed.reason, failing);
  if (computed.states[BASELINE_CONTROL_ID] !== 'pass') return unavailable('baseline_control_not_passing', failing);
  const newFailures = [];
  const preexistingFailures = [];
  const flakyFailures = [];
  for (const id of failing) {
    const state = computed.states[id];
    if (state === 'fail') preexistingFailures.push(id);
    else if (state === 'flaky') flakyFailures.push(id);
    else newFailures.push(id);
  }
  return {
    status: newFailures.length === 0 ? 'passed' : 'failed',
    rawOk: false,
    newFailures,
    preexistingFailures,
    flakyFailures,
    baseline: { source: 'base-commit', baseCommit, reason: '' },
  };
}

/**
 * Shape persisted on `verifyResult` (caps applied).
 *
 * @param {Awaited<ReturnType<typeof classifyReviewVerify>>} classification
 * @param {{ results?: Array<{ id: string, ok: boolean, durationMs: number, outputTail: string }> }} raw
 * @returns {object}
 */
export function buildVerifyClassificationFields(classification, raw) {
  return {
    rawOk: classification.rawOk,
    newFailures: classification.newFailures,
    preexistingFailures: classification.preexistingFailures,
    flakyFailures: classification.flakyFailures,
    baseline: classification.baseline,
    results: (Array.isArray(raw?.results) ? raw.results : []).slice(0, RESULTS_MAX).map((r) => ({
      id: r.id,
      ok: r.ok === true,
      durationMs: Number(r.durationMs) || 0,
      outputTail: String(r.outputTail || '').slice(-OUTPUT_TAIL_MAX),
    })),
  };
}
