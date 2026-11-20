/**
 * Host-verify policy for a delegation start.
 *
 * A `review` child only produces a hard test signal if its harness can execute
 * the host-owned `node scripts/review-verify.js` runner itself. When the
 * effective `review_can_run_tests` trait is false — static prior or observed
 * from real review reports — the parent must call `delegation_verify`, and the
 * workflow cycle treats a missing verify as blocking. The flag is computed once
 * at start so the gate reads a durable field instead of re-deriving traits.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHarnessDelegationTraits } from './delegation-adapter-capabilities.js';
import { summarizeReviewTestObservations } from './model-pick-history.js';
import { selectVerifyTests } from './job-queue/verify-selection.js';

/**
 * @param {{
 *   assignment?: unknown,
 *   executionMode?: unknown,
 *   transport?: unknown,
 *   reviewSubject?: unknown,
 *   hasVerifyTests?: boolean,
 *   rows?: object[],
 *   reviewTestObservations?: Record<string, { positive?: number, negative?: number }>,
 *   now?: number,
 * }} [input]
 * @returns {{
 *   applies: boolean,
 *   required: boolean,
 *   canRunTests: boolean | null,
 *   source: string,
 *   observedPositive: number,
 *   observedNegative: number,
 * }}
 */
export function resolveDelegationReviewVerifyPlan(input = {}) {
  const assignment = String(input.assignment || '').trim().toLowerCase();
  const executionMode = String(input.executionMode || '').trim().toLowerCase();
  const transport = String(input.transport || '').trim().toLowerCase();
  // A plan-mode `review` is a planner, not a reviewer; it has no test duty.
  // A plan review reads a plan, not code, so it has none either.
  const isPlanReview = String(input.reviewSubject || '').trim().toLowerCase() === 'plan';
  const applies = assignment === 'review' && executionMode !== 'plan' && !isPlanReview;
  if (!applies) {
    return {
      applies: false,
      required: false,
      canRunTests: null,
      source: isPlanReview && assignment === 'review' ? 'plan-review' : 'not-review',
      observedPositive: 0,
      observedNegative: 0,
    };
  }
  const observations = input.reviewTestObservations
    || summarizeReviewTestObservations(Array.isArray(input.rows) ? input.rows : [], { now: input.now });
  const counts = (observations && observations[transport]) || { positive: 0, negative: 0 };
  const positive = Number(counts.positive) > 0 ? Math.floor(Number(counts.positive)) : 0;
  const negative = Number(counts.negative) > 0 ? Math.floor(Number(counts.negative)) : 0;
  const traits = resolveHarnessDelegationTraits(transport, { positive, negative });
  const canRunTests = traits.review_can_run_tests === true;
  return {
    applies: true,
    // A project with no review-verify tests has nothing a parent could run.
    required: !canRunTests && input.hasVerifyTests !== false,
    canRunTests,
    source: traits.review_can_run_tests_source,
    observedPositive: positive,
    observedNegative: negative,
  };
}

// ---------------------------------------------------------------------------
// Required-test manifest
//
// Binds the ids a verify run covers to the exact test file contents, the
// attempt, the material revision and the relevant environment. It is evidence
// attached to `verifyResult` (read by the same classification as before); it is
// not a status gate. Ids resolve only through the audited catalog, never from
// model-supplied paths or commands.
// ---------------------------------------------------------------------------

export const VERIFY_MANIFEST_SCHEMA_VERSION = 1;
const VERIFY_MANIFEST_PATH_RE = /^tests\/[A-Za-z0-9._-]+\.test\.js$/;
const VERIFY_MANIFEST_ENV_KEYS = Object.freeze(['NODE_OPTIONS', 'TZ', 'NODE_ENV']);
const VERIFY_MANIFEST_MAX_ENTRIES = 200;

/** @param {string} text */
function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Hash of the environment facts that can change a test outcome.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function computeVerifyEnvKey(env = process.env) {
  const picked = { node: process.version, platform: process.platform, arch: process.arch };
  for (const key of VERIFY_MANIFEST_ENV_KEYS) picked[key] = String(env?.[key] || '');
  return sha256Hex(JSON.stringify(picked));
}

/**
 * @param {Array<{ id: string, sha256: string }>} entries
 * @returns {string}
 */
function computeTestSetKey(entries) {
  const lines = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((e) => `${e.id}:${e.sha256}`);
  return sha256Hex(lines.join('\n'));
}

/**
 * Build a manifest for catalog ids. Rejects unknown ids, non-`tests/*.test.js`
 * paths (traversal included) and unreadable files — nothing is skipped.
 *
 * @param {{
 *   ids: unknown,
 *   catalog: Readonly<Record<string, string>>,
 *   curated?: Readonly<Record<string, string>>,
 *   projectRoot: string,
 *   attemptId?: string,
 *   materialRevision?: string,
 *   envKey?: string,
 * }} input
 * @returns {{ ok: true, manifest: Record<string, any> } | { ok: false, error: string, id?: string }}
 */
export function buildVerifyManifest(input) {
  const ids = Array.isArray(input?.ids) ? [...new Set(input.ids.map((id) => String(id || '').trim()))] : [];
  if (ids.length === 0 || ids.length > VERIFY_MANIFEST_MAX_ENTRIES || ids.includes('')) {
    return { ok: false, error: 'invalid_ids' };
  }
  const catalog = input.catalog || {};
  const root = path.resolve(String(input.projectRoot || ''));
  const entries = [];
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) return { ok: false, error: 'unknown_id', id };
    const rel = String(catalog[id] || '').replace(/\\/g, '/');
    const abs = path.resolve(root, rel);
    if (!VERIFY_MANIFEST_PATH_RE.test(rel) || !abs.startsWith(`${path.join(root, 'tests')}${path.sep}`)) {
      return { ok: false, error: 'path_rejected', id };
    }
    let content;
    try { content = fs.readFileSync(abs); } catch { return { ok: false, error: 'file_missing', id }; }
    const origin = input.curated && Object.prototype.hasOwnProperty.call(input.curated, id) ? 'curated' : 'audited';
    entries.push({ id, path: rel, sha256: createHash('sha256').update(content).digest('hex'), origin });
  }
  return {
    ok: true,
    manifest: {
      schemaVersion: VERIFY_MANIFEST_SCHEMA_VERSION,
      attemptId: String(input.attemptId || '').trim(),
      materialRevision: String(input.materialRevision || '').trim(),
      envKey: String(input.envKey || computeVerifyEnvKey()),
      testSetKey: computeTestSetKey(entries),
      entries,
    },
  };
}

/**
 * Is a recorded verify result usable as PASS evidence for a required test set?
 * Missing, stale, failed, foreign-attempt, changed-env or out-of-manifest
 * evidence is never usable. Preexisting / flaky failures stay explicit in the
 * returned lists (the host classification already excluded them from `failed`).
 *
 * @param {{
 *   verifyResult: object | null | undefined,
 *   requiredIds?: string[],
 *   attemptId?: string,
 *   materialRevision?: string,
 *   envKey?: string,
 * }} input
 * @returns {{ usable: boolean, reason: string, preexisting: string[], flaky: string[] }}
 */
export function evaluateVerifyManifestEvidence(input) {
  const verify = /** @type {Record<string, any>} */ (input?.verifyResult);
  const base = {
    preexisting: Array.isArray(verify?.preexistingFailures) ? [...verify.preexistingFailures] : [],
    flaky: Array.isArray(verify?.flakyFailures) ? [...verify.flakyFailures] : [],
  };
  const no = (reason) => ({ usable: false, reason, ...base });
  if (!verify || typeof verify !== 'object') return no('missing');
  const manifest = verify.manifest;
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) return no('no_manifest');
  if (verify.stale === true) return no('stale');
  if (verify.status !== 'passed') return no('failed');
  if (input.attemptId && manifest.attemptId !== input.attemptId) return no('attempt_mismatch');
  if (input.materialRevision && manifest.materialRevision !== input.materialRevision) return no('revision_mismatch');
  if (input.envKey && manifest.envKey !== input.envKey) return no('env_changed');
  const covered = new Set(manifest.entries.map((e) => e.id));
  if ((input.requiredIds || []).some((id) => !covered.has(id))) return no('outside_manifest');
  const ran = Array.isArray(verify.results) ? verify.results.map((r) => r.id) : [];
  if (ran.some((id) => !covered.has(id))) return no('outside_manifest');
  return { usable: true, reason: 'ok', ...base };
}

/**
 * May `prior` evidence stand in for a fresh run of `next`? Same revision, same
 * test-set hash, same environment, a non-stale pass that covers every id.
 *
 * @param {{ prior: Record<string, any> | null | undefined, next: { materialRevision?: string, envKey?: string, testSetKey?: string, ids?: string[] } }} input
 * @returns {{ reuse: boolean, reason: string }}
 */
export function decideVerifyReuse({ prior, next }) {
  const manifest = prior?.manifest;
  if (!prior || !manifest) return { reuse: false, reason: 'no_prior' };
  if (prior.status !== 'passed' || prior.stale === true) return { reuse: false, reason: 'prior_not_passed' };
  if (!next?.materialRevision || prior.materialRevision !== next.materialRevision) return { reuse: false, reason: 'revision_mismatch' };
  if (manifest.envKey !== next.envKey) return { reuse: false, reason: 'env_changed' };
  if (manifest.testSetKey !== next.testSetKey) return { reuse: false, reason: 'tests_changed' };
  const covered = new Set((manifest.entries || []).map((e) => e.id));
  if ((next.ids || []).some((id) => !covered.has(id))) return { reuse: false, reason: 'outside_manifest' };
  return { reuse: true, reason: 'ok' };
}

/**
 * Rebind accepted prior evidence to a new attempt (explicit `reused` source).
 *
 * @param {Record<string, any>} prior
 * @param {string} attemptId
 * @returns {Record<string, any>}
 */
export function rebindVerifyEvidence(prior, attemptId) {
  return {
    ...prior,
    source: 'reused_manifest',
    attemptId,
    manifest: { ...prior.manifest, attemptId },
  };
}

/**
 * Choose which catalog ids a verify run covers: tests the change can reach
 * through the import graph plus the control set for a leaf; every id at
 * integration. Only ids already in the audited catalog are ever returned. An
 * empty `changed` list selects the whole catalog (nothing to narrow by), so a
 * missing change set never shrinks verification.
 *
 * @param {{
 *   catalog: Readonly<Record<string, string>>,
 *   changed: string[],
 *   controlIds?: string[],
 *   mode?: 'leaf' | 'integration',
 *   root?: string,
 *   index?: Map<string, string[]>,
 * }} input
 * @returns {{ ids: string[], mode: string, affectedIds: string[], controlIds: string[], skippedIds: string[] }}
 */
export function selectVerifyIdsForChange(input) {
  const catalog = input.catalog || {};
  /** @type {Map<string, string[]>} */
  const idsByPath = new Map();
  for (const [id, rel] of Object.entries(catalog)) {
    const normalized = String(rel).replace(/\\/g, '/');
    idsByPath.set(normalized, [...(idsByPath.get(normalized) || []), id]);
  }
  const toIds = (/** @type {string[]} */ paths) => paths.flatMap((p) => idsByPath.get(p) || []);
  const control = (input.controlIds || []).map((id) => catalog[id]).filter(Boolean).map((p) => String(p).replace(/\\/g, '/'));
  const mode = input.mode === 'integration' || !Array.isArray(input.changed) || input.changed.length === 0 ? 'integration' : 'leaf';
  const picked = selectVerifyTests({
    root: input.root,
    index: input.index,
    tests: [...idsByPath.keys()],
    changed: input.changed || [],
    control,
    mode,
  });
  return {
    ids: toIds(picked.selected),
    mode: picked.mode,
    affectedIds: toIds(picked.affected),
    controlIds: toIds(picked.control),
    skippedIds: toIds(picked.skipped),
  };
}
