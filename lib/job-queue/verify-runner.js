/**
 * Queue-backed host verify runner: the production replacement for a direct
 * `runReviewVerify` call. Every catalog id becomes one job on the persistent
 * queue (priority class `cycle`, spread over the core-scaled pool); ids whose
 * test file and import closure are unchanged since a stored PASS are served
 * from the hash cache instead of running again. The result keeps the
 * `runReviewVerify` shape, so the verify contract (classification against the
 * leaf baseline, `preexisting`, manifest evidence) is untouched.
 *
 * `mode: 'integration'` runs every id fresh and bypasses the cache; so do the
 * ids in `freshIds` (selected through a path the id's import closure does not
 * cover, e.g. a file the test reads with fs), because the hash cannot see it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeVerifyEnvKey } from '../delegation-review-verify-plan.js';
import { buildImportIndex } from './import-graph.js';
import { runTestsWithCache } from './test-cache.js';

export const REVIEW_VERIFY_JOB_KIND = 'review-verify-test';
const DATA_DIR_PREFIX = 'cretli-review-verify-data-';
const NOT_APPLICABLE = 'No review-verify tests are configured for this project';

/**
 * @typedef {{
 *   ok: boolean,
 *   notApplicable?: boolean,
 *   output: string,
 *   error?: string,
 *   dataDir: string,
 *   results?: Array<{ id: string, ok: boolean, durationMs: number, outputTail: string, cached?: boolean, timedOut?: boolean }>,
 *   timing?: object,
 * }} VerifyRunResult
 */

/** @param {string} dataDir */
function removeVerifyDataDir(dataDir) {
  if (!dataDir || !path.basename(dataDir).startsWith(DATA_DIR_PREFIX) || path.dirname(dataDir) !== os.tmpdir()) return;
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp dir; best effort */ }
}

/**
 * @param {{
 *   queue: { enqueue(job: object): { done: Promise<any> }, registerHandler(kind: string, fn: Function, opts?: object): void, metrics?: () => { concurrency: number }, testStore: any, recordCache(event: 'hit' | 'miss'): void, start(): void },
 *   runStep: (input: { ids: string[], projectRoot: string, materialRevision?: string }) => Promise<VerifyRunResult>,
 *   resolveCatalog: (projectRoot: string) => Record<string, string>,
 *   envKey?: () => string,
 *   buildIndex?: (root: string) => Map<string, string[]>,
 *   priority?: 'interactive' | 'cycle' | 'maintenance',
 * }} deps `runStep` executes ONE id (the raw `runReviewVerify`).
 * @returns {(input: { ids?: string[], projectRoot?: string, materialRevision?: string, mode?: 'leaf' | 'integration', freshIds?: string[] }) => Promise<VerifyRunResult>}
 */
export function createQueuedVerifyRunner(deps) {
  const { queue, runStep, resolveCatalog } = deps;
  const envKey = deps.envKey || (() => computeVerifyEnvKey());
  const buildIndex = deps.buildIndex || buildImportIndex;
  const priority = deps.priority || 'cycle';

  // Interrupted verify jobs have no caller after a restart; do not re-run them.
  queue.registerHandler(REVIEW_VERIFY_JOB_KIND, async (/** @type {{ id: string, projectRoot: string, materialRevision?: string }} */ payload) => {
    const raw = await runStep({ ids: [payload.id], projectRoot: payload.projectRoot, materialRevision: payload.materialRevision || undefined });
    const step = raw.results?.[0];
    const ok = raw.ok === true && raw.notApplicable !== true;
    if (ok) removeVerifyDataDir(raw.dataDir);
    return {
      ok,
      durationMs: Number(step?.durationMs) || 0,
      outputTail: String(step?.outputTail || ''),
      output: String(raw.output || ''),
      error: raw.error ? String(raw.error) : '',
      dataDir: ok ? '' : String(raw.dataDir || ''),
      timedOut: step?.timedOut === true,
    };
  }, { recover: false });
  queue.start();

  return async function runQueuedVerify(input = {}) {
    const startedAt = Date.now();
    const projectRoot = String(input.projectRoot || '');
    const catalog = resolveCatalog(projectRoot);
    const ids = Array.isArray(input.ids) && input.ids.length > 0 ? [...new Set(input.ids)] : Object.keys(catalog);
    if (ids.length === 0) return { ok: false, notApplicable: true, output: '', error: NOT_APPLICABLE, dataDir: '' };
    for (const id of ids) {
      if (!Object.prototype.hasOwnProperty.call(catalog, id)) {
        return { ok: false, output: '', error: `Unknown review verify id: ${id}`, dataDir: '' };
      }
    }
    /** @type {Map<string, string>} test path -> id (catalog paths are unique per id in practice) */
    const idByPath = new Map(ids.map((id) => [String(catalog[id]).replace(/\\/g, '/'), id]));
    const fresh = new Set((input.freshIds || []).map((id) => String(catalog[id] || '').replace(/\\/g, '/')));
    const forceFresh = input.mode === 'integration';
    const execute = (/** @type {string[]} */ tests, /** @type {'leaf' | 'integration'} */ mode) => (tests.length === 0 ? [] : runTestsWithCache({
      root: projectRoot,
      tests,
      index: buildIndex(projectRoot),
      store: queue.testStore,
      envKey: envKey(),
      mode,
      onCache: (event) => queue.recordCache(event),
      run: async (testPath) => {
        const id = /** @type {string} */ (idByPath.get(testPath));
        try {
          return await queue.enqueue({
            kind: REVIEW_VERIFY_JOB_KIND,
            priority,
            payload: { id, projectRoot, materialRevision: input.materialRevision || '' },
          }).done;
        } catch (error) {
          // A queue failure must read as a failed step, never as a hung or lost verify.
          const message = String(/** @type {any} */ (error)?.message || error);
          return { ok: false, durationMs: 0, outputTail: message, output: '', error: message, dataDir: '' };
        }
      },
    }));
    const allTests = [...idByPath.keys()];
    const rows = (await Promise.all([
      execute(allTests.filter((t) => !forceFresh && !fresh.has(t)), 'leaf'),
      execute(allTests.filter((t) => forceFresh || fresh.has(t)), 'integration'),
    ])).flat();
    const byId = new Map(rows.map((row) => [/** @type {string} */ (idByPath.get(row.test)), row]));
    const ordered = ids.map((id) => ({ id, row: /** @type {any} */ (byId.get(id)) }));
    const results = ordered.map(({ id, row }) => ({
      id,
      ok: row.ok,
      durationMs: row.durationMs,
      outputTail: row.cached ? '(unchanged since last pass; result from cache)' : row.outputTail,
      ...(row.cached ? { cached: true } : {}),
      ...(row.detail?.timedOut ? { timedOut: true } : {}),
    }));
    const failed = ordered.find(({ row }) => !row.ok);
    // Only the first failing run's data dir is reported; drop the others.
    for (const { row } of ordered) if (!row.ok && row.detail?.dataDir && row.detail.dataDir !== failed?.row.detail?.dataDir) removeVerifyDataDir(row.detail.dataDir);
    const outputs = ordered.filter(({ row }) => row.detail?.output).map(({ id, row }) => `==> ${id}\n${row.detail.output}`.trim());
    const finishedAt = Date.now();
    return {
      ok: !failed,
      output: outputs.join('\n\n') || (failed ? '' : '(no output)'),
      ...(failed ? { error: failed.row.detail?.error || `${failed.id} failed` } : {}),
      dataDir: String(failed?.row.detail?.dataDir || ''),
      results,
      timing: {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        concurrency: typeof queue.metrics === 'function' ? queue.metrics().concurrency : 0,
        sumStepMs: results.reduce((sum, r) => sum + r.durationMs, 0),
        cached: results.filter((r) => r.cached).length,
      },
    };
  };
}
