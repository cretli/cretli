/**
 * Glue between `pickModelForPurpose` and the cost policy (plan v10 §2.3-2.7):
 * classify, resolve the effective mode, judge/enforce, count canary outcomes
 * and evaluate the rolling rollback. One entry point shared by `model_pick`,
 * the Watcher orchestrator and the Scout, so all consumers read one policy.
 */

import fs from 'node:fs';
import { classifyTaskComplexity } from './model-pick-complexity.js';
import { modelPickCandidateId } from './model-pick-decisions.js';
import { loadModelPickRecords, MODEL_PICK_DECISIONS_FILE } from './persist/model-pick-decisions-persist.js';
import { loadDelegationsReadonly } from './persist/delegations-persist.js';
import { isInfraDelegationOutcome } from './model-pick-history.js';
import { parseDelegationVerdict } from './delegation-verdict.js';
import {
  applyCostPolicyToPick,
  evaluateCandidatePolicy,
  loadCostPolicyConfig,
  loadCostPolicyState,
  resolveEffectivePolicyMode,
  saveCostPolicyState,
} from './model-pick-cost-policy.js';

/**
 * A persisted model-pick record as the canary join reads it.
 *
 * @typedef {object} ModelPickCostPolicyPickRecord
 * @property {string} [id]
 * @property {string} [role]
 * @property {string} [leafId]
 * @property {string} [createdAt]
 * @property {{ bucket?: string }} [costPolicy]
 */

/**
 * A delegation row as the canary join reads it.
 *
 * @typedef {object} ModelPickCostPolicyDelegationRow
 * @property {string} [pickId]
 * @property {string} [assignment]
 * @property {string} [leafId]
 * @property {string} [todoId]
 * @property {string} [leaf_id]
 * @property {string} [report]
 * @property {string} [createdAt]
 */

/**
 * Outcome counters of one canary bucket.
 *
 * @typedef {object} ModelPickCostPolicyOutcomeSide
 * @property {number} n
 * @property {number} failReview
 * @property {number} infraFail
 * @property {number} [noCandidate]
 */

/**
 * @typedef {{ canary: ModelPickCostPolicyOutcomeSide, control: ModelPickCostPolicyOutcomeSide }} ModelPickCostPolicyOutcomes
 */

/**
 * Pick input (same as `pickModelForPurpose`) as far as the policy layer reads it.
 *
 * @typedef {object} ModelPickCostPolicyLayerInput
 * @property {ReturnType<typeof loadCostPolicyConfig>} [costPolicyConfig]
 * @property {string} [costPolicyFile]
 * @property {boolean} [costPolicy] `false` disables the layer
 * @property {string} [role]
 * @property {string} [leafBody]
 * @property {string | null} [leafSize]
 * @property {boolean} [heavy]
 * @property {boolean} [premium]
 * @property {string} [complexityLevel]
 * @property {string} [complexity]
 * @property {object | null} [history]
 * @property {string} [sourceKind]
 * @property {(relativePath: string) => boolean} [leafExists]
 * @property {boolean} [costPolicyPersist]
 * @property {ReturnType<typeof loadCostPolicyState>} [costPolicyState]
 * @property {string} [costPolicyStateFile]
 * @property {string} [chatId]
 * @property {string} [workspaceFolder]
 * @property {string} [leafId]
 * @property {string} [leaf_id]
 * @property {string} [todoId]
 * @property {string} [todo_id]
 * @property {string} [purpose]
 * @property {number} [now]
 * @property {ModelPickCostPolicyOutcomes | null} [costPolicyMetrics]
 * @property {ModelPickCostPolicyOutcomes | null} [costPolicyOutcomes]
 * @property {ModelPickCostPolicyPickRecord[]} [costPolicyRecords]
 * @property {ModelPickCostPolicyDelegationRow[]} [costPolicyDelegations]
 * @property {string} [file] pick-records file
 * @property {unknown} [excludePairs] pairs the picker must skip (re-run input)
 */

/** Upper bound of picks joined per evaluation, newest first. */
const MAX_OUTCOME_RECORDS = 500;

/** @type {Map<string, { mtimeMs: number, size: number, records: ModelPickCostPolicyPickRecord[] }>} */
const recordsCache = new Map();

/** Test hook: drops the per-process pick-records cache. */
export function clearCanaryOutcomeCache() {
  recordsCache.clear();
}

/**
 * Pick records parsed once per (path, mtimeMs, size); a changed file is re-read.
 * A stat failure falls through to an uncached read.
 *
 * @param {string | undefined} file
 * @param {(opts: { file?: string }) => Record<string, ModelPickCostPolicyPickRecord>} reader
 * @returns {ModelPickCostPolicyPickRecord[]}
 */
function readPickRecordsCached(file, reader) {
  const key = String(file || MODEL_PICK_DECISIONS_FILE);
  let stat = null;
  try { stat = fs.statSync(key); } catch { /* uncached read below */ }
  if (!stat) return Object.values(reader({ file }));
  const hit = recordsCache.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.records;
  const records = Object.values(reader({ file }));
  recordsCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, records });
  return records;
}

/**
 * Outcome counters of the canary window read from the durable stores. Bounded
 * (newest records only) and never throws: a failure yields `null` so the pick
 * proceeds without an outcome-based rollback.
 *
 * @param {{ startedAtMs: number, records?: ModelPickCostPolicyPickRecord[], delegations?: ModelPickCostPolicyDelegationRow[], recordsFile?: string, readRecords?: (opts: { file?: string }) => Record<string, ModelPickCostPolicyPickRecord> }} input
 * @returns {ModelPickCostPolicyOutcomes | null}
 */
export function loadCanaryOutcomeCounters(input) {
  try {
    const records = (input.records || readPickRecordsCached(input.recordsFile, input.readRecords || loadModelPickRecords))
      .filter((r) => {
        const b = /** @type {any} */ (r)?.costPolicy?.bucket;
        return (b === 'canary' || b === 'control') && Date.parse(String(/** @type {any} */ (r).createdAt)) >= input.startedAtMs;
      })
      .sort((a, b) => String(/** @type {any} */ (b).createdAt).localeCompare(String(/** @type {any} */ (a).createdAt)))
      .slice(0, MAX_OUTCOME_RECORDS);
    if (records.length === 0) return null;
    const delegations = input.delegations || loadDelegationsReadonly();
    return buildCanaryOutcomeCounters({
      records,
      delegations,
      startedAtMs: input.startedAtMs,
      isInfra: isInfraDelegationOutcome,
      parseVerdict: parseDelegationVerdict,
    });
  } catch {
    return null;
  }
}

/**
 * @param {any} review
 * @param {number | undefined} startedAtMs
 * @param {number} pickMs
 * @returns {boolean}
 */
function reviewInScope(review, startedAtMs, pickMs) {
  if (!Number.isFinite(startedAtMs) && !Number.isFinite(pickMs)) return true;
  const at = Date.parse(String(review?.createdAt || ''));
  if (!Number.isFinite(at)) return false;
  if (Number.isFinite(startedAtMs) && at < /** @type {number} */ (startedAtMs)) return false;
  return !Number.isFinite(pickMs) || at >= pickMs;
}

/**
 * Outcome counters per bucket from persisted pick records + delegations. Used
 * when the caller does not inject metrics; review FAIL is joined through the
 * record's leaf, infra failure through the executed delegation row.
 *
 * @param {{
 *   records: ModelPickCostPolicyPickRecord[],
 *   delegations: ModelPickCostPolicyDelegationRow[],
 *   startedAtMs?: number,
 *   isInfra: (row: ModelPickCostPolicyDelegationRow, role: string) => boolean,
 *   parseVerdict?: (report: string) => string,
 * }} input
 * @returns {ModelPickCostPolicyOutcomes}
 */
export function buildCanaryOutcomeCounters(input) {
  const side = () => ({ n: 0, failReview: 0, infraFail: 0 });
  const out = { canary: side(), control: side() };
  const byPick = new Map();
  for (const row of input.delegations || []) {
    const id = String(row?.pickId || '').trim();
    if (id) byPick.set(id, row);
  }
  for (const record of input.records || []) {
    const bucket = /** @type {any} */ (record)?.costPolicy?.bucket;
    if (bucket !== 'canary' && bucket !== 'control') continue;
    const row = byPick.get(String(/** @type {any} */ (record).id));
    if (!row) continue;
    const target = out[bucket];
    target.n += 1;
    if (input.isInfra(row, String(/** @type {any} */ (record).role || 'implement'))) target.infraFail += 1;
    const leaf = String(/** @type {any} */ (record).leafId || '');
    if (!leaf || typeof input.parseVerdict !== 'function') continue;
    // A review only counts when it started in the canary window and at/after
    // this pick; unknown timing never counts once a window is given.
    const pickMs = Date.parse(String(/** @type {any} */ (record).createdAt || ''));
    const failed = (input.delegations || []).some((d) => String(d?.assignment) === 'review'
      && [d?.leafId, d?.todoId, d?.leaf_id].map((v) => String(v || '')).includes(leaf)
      && reviewInScope(d, input.startedAtMs, pickMs)
      && input.parseVerdict(String(d?.report || '')) === 'FAIL');
    if (failed) target.failReview += 1;
  }
  return out;
}

/**
 * @param {any} state
 * @param {'canary'|'control'|'none'} bucket
 * @param {boolean} noCandidate
 * @returns {any}
 */
function bumpCounters(state, bucket, noCandidate) {
  if (bucket === 'none') return state;
  const counters = state.counters || { canary: { n: 0, noCandidate: 0 }, control: { n: 0, noCandidate: 0 } };
  counters[bucket] = {
    n: (counters[bucket]?.n || 0) + 1,
    noCandidate: (counters[bucket]?.noCandidate || 0) + (noCandidate ? 1 : 0),
  };
  return { ...state, counters };
}

/**
 * Pick-time `n`/`noCandidate` counters merged with stored review-FAIL and
 * infra outcomes. Only read while a canary window is open.
 *
 * @param {ModelPickCostPolicyLayerInput} input
 * @param {ReturnType<typeof loadCostPolicyConfig>} config
 * @param {ReturnType<typeof loadCostPolicyState>} state
 * @returns {ModelPickCostPolicyOutcomes}
 */
function buildMetrics(input, config, state) {
  const side = (key) => ({ ...(state.counters?.[key] || { n: 0 }), failReview: 0, infraFail: 0 });
  const metrics = { canary: side('canary'), control: side('control') };
  const open = config.mode === 'enforce' && config.canary?.enabled && state.canaryStartedAt && !state.rolledBackAt;
  const startedAtMs = Date.parse(String(state.canaryStartedAt || ''));
  if (open && Number.isFinite(startedAtMs)) {
    const stored = input.costPolicyOutcomes
      || loadCanaryOutcomeCounters({
        startedAtMs,
        records: input.costPolicyRecords,
        delegations: input.costPolicyDelegations,
        recordsFile: input.file,
      });
    for (const key of ['canary', 'control']) {
      const o = stored?.[key];
      if (!o) continue;
      metrics[key].failReview = Number(o.failReview) || 0;
      metrics[key].infraFail = Number(o.infraFail) || 0;
      // Outcome-joined samples gate the rate denominators of both outcome rates.
      if (Number(o.n) > metrics[key].n) metrics[key].n = Number(o.n);
    }
  }
  return metrics;
}

/**
 * @param {ModelPickCostPolicyLayerInput} input pick input (same as `pickModelForPurpose`)
 * @param {any} first unconstrained pick result
 * @param {(input: object) => any} runPick re-runs the picker for the same input
 * @returns {any}
 */
export function applyCostPolicyLayer(input, first, runPick) {
  const config = input.costPolicyConfig ?? loadCostPolicyConfig({ filePath: input.costPolicyFile });
  if (input.costPolicy === false || config.mode === 'off') return first;
  const role = String(input.role || '').trim().toLowerCase();
  const complexity = first.complexity || classifyTaskComplexity({
    role,
    leafBody: input.leafBody,
    leafSize: input.leafSize,
    heavy: input.heavy === true,
    complexity: input.complexityLevel ?? input.complexity,
    history: input.history,
    sourceKind: input.sourceKind,
    exists: input.leafExists,
  });
  const persist = input.costPolicyPersist !== false && !input.costPolicyState;
  let state = input.costPolicyState || loadCostPolicyState({ file: input.costPolicyStateFile });
  const writeState = (next) => {
    state = next;
    if (persist) {
      try { saveCostPolicyState(next, { file: input.costPolicyStateFile }); } catch { /* best effort */ }
    }
  };
  // The watcher/scout pass no chat or leaf id, so the workspace and the
  // purpose keep the key from collapsing into one constant bucket.
  const pickKey = [
    input.chatId,
    input.workspaceFolder,
    input.leafId ?? input.leaf_id ?? input.todoId ?? input.todo_id,
    role,
    input.purpose,
  ].map((v) => String(v || '')).join('|');
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const effective = resolveEffectivePolicyMode({
    config,
    state,
    role,
    level: complexity.level,
    pickKey,
    now,
    metrics: input.costPolicyMetrics ?? buildMetrics(input, config, state),
    persistState: writeState,
  });
  if (effective.mode === 'off') return first;
  const heavy = input.heavy === true || complexity.signals.includes('explicit_heavy');
  const premium = input.premium === true;
  const ctx = { role, level: complexity.level, heavy, premium, config };
  const idOf = (row) => (row ? modelPickCandidateId(row.harness, row.model) : '');
  const finish = (result, extra) => {
    const rejected = (extra.rejected || []).map((row) => ({
      candidateId: modelPickCandidateId(row.harness, row.model),
      reasons: row.reasons,
    }));
    const record = {
      mode: effective.mode,
      configured: effective.configured,
      bucket: effective.bucket,
      phase: effective.phase,
      wouldChange: extra.wouldChange === true,
      applied: effective.mode === 'enforce',
      qualityRelaxed: extra.qualityRelaxed === true,
      pickReasons: extra.pickReasons || [],
      policyPick: idOf(extra.policyPick),
      counterfactualPick: idOf(first.ok ? first.pick : null),
      rejected,
      rollbackReasons: effective.rollbackReasons,
    };
    // Keep the hint so callers report cost_ceiling and ask for an explicit premium re-run.
    if (result?.cost_policy?.premium_hint) record.premium_hint = result.cost_policy.premium_hint;
    if (effective.bucket !== 'none') {
      writeState(bumpCounters(state, effective.bucket, result.ok !== true));
    }
    return { ...result, complexity, cost_policy: record };
  };
  if (!first.ok) return finish(first, {});
  const pickVerdict = evaluateCandidatePolicy({ ...ctx, candidate: first.pick });
  if (effective.mode === 'shadow') {
    const rows = [first.pick, ...(Array.isArray(first.candidates) ? first.candidates : [])];
    const rejected = [];
    let policyPick = null;
    for (const row of rows) {
      if (!row) continue;
      const v = evaluateCandidatePolicy({ ...ctx, candidate: row });
      if (v.allowed) {
        if (!policyPick) policyPick = row;
      } else {
        rejected.push({ harness: row.harness, model: row.model, reasons: v.reasons });
      }
    }
    return finish(first, {
      rejected,
      policyPick,
      pickReasons: pickVerdict.reasons,
      wouldChange: !pickVerdict.allowed,
    });
  }
  const applied = applyCostPolicyToPick({
    select: runPick,
    selectInput: input,
    picked: first,
    role,
    level: complexity.level,
    heavy,
    premium,
    config,
  });
  const result = applied.result;
  return finish(result, {
    rejected: applied.rejected,
    policyPick: result.ok ? result.pick : null,
    pickReasons: pickVerdict.reasons,
    qualityRelaxed: applied.qualityRelaxed,
    wouldChange: result.ok ? idOf(result.pick) !== idOf(first.pick) : true,
  });
}
