#!/usr/bin/env node
/**
 * Compare the heuristic complexity signal with decision-classifier backends
 * (shadow only) against a reference label derived from what happened to each
 * leaf afterwards.
 *
 * Usage:
 *   node scripts/eval-complexity-classifier.mjs [--dry-run] [--fixtures <dir>] [--json]
 *
 * Inputs (default): the model_pick proposal journal (`data/model-pick-decisions.json`)
 * and the delegation store. `--fixtures <dir>` reads `<dir>/proposals.json` and
 * `<dir>/delegations.json` instead, in the same shape as the data files, with
 * only the fields this script uses:
 *
 *   proposals.json   { "picks": { "<id>": { "createdAt", "leafId", "role",
 *                      "complexity": { "level", "signals" },
 *                      "complexityShadow"?: { "backendId", "level", "levelProbs", "confidenceBucket", ... } } } }
 *   delegations.json { "items": [ { "leafId", "assignment", "requestedRole"?, "executionMode",
 *                      "status", "report", "createdAt", "finishedAt"?, "deadlineAt"? } ] }
 *
 * Both files may also be a bare array. The script never contacts a backend;
 * `--dry-run` additionally skips the process counters (latency, dropped jobs),
 * which only exist inside a running server.
 *
 * Reference label per leaf (leaves without delegations are skipped):
 *   demanding — >= 2 review FAIL, or >= 3 implement/fix rounds, or a run past its deadline
 *   trivial   — exactly 1 implement round and the first review PASSed
 *   standard  — everything else
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { delegationPersistedRole } from '../lib/model-pick-history.js';
import { parseDelegationVerdict } from '../lib/delegation-verdict.js';
import { SHADOW_CONFIDENCE_BUCKETS, SHADOW_LEVELS, normalizeComplexityShadow } from '../lib/model-pick-complexity-classifier.js';
import { normalizeComplexity } from '../lib/model-pick-complexity.js';

const LEVELS = SHADOW_LEVELS;

/**
 * @param {unknown} doc
 * @param {string} key
 * @returns {object[]}
 */
function rowsOf(doc, key) {
  if (Array.isArray(doc)) return doc;
  const inner = doc && typeof doc === 'object' ? /** @type {any} */ (doc)[key] : null;
  if (Array.isArray(inner)) return inner;
  if (inner && typeof inner === 'object') return Object.entries(inner).map(([id, row]) => ({ id, ...row }));
  return [];
}

/**
 * @param {object} row
 * @returns {boolean}
 */
function isPastDeadline(row) {
  const deadline = Date.parse(String(/** @type {any} */ (row).deadlineAt || ''));
  if (!Number.isFinite(deadline)) return false;
  const finished = Date.parse(String(/** @type {any} */ (row).finishedAt || ''));
  return Number.isFinite(finished) && finished > deadline;
}

/**
 * @param {object[]} rows delegations of one leaf
 * @returns {'trivial' | 'standard' | 'demanding'}
 */
export function labelLeaf(rows) {
  const sorted = [...rows].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const reviews = sorted.filter((row) => delegationPersistedRole(row) === 'review');
  const implementRounds = sorted.filter((row) => delegationPersistedRole(row) === 'implement').length;
  const verdicts = reviews.map((row) => parseDelegationVerdict(row.report));
  const fails = verdicts.filter((v) => v === 'FAIL').length;
  if (fails >= 2 || implementRounds >= 3 || sorted.some(isPastDeadline)) return 'demanding';
  if (implementRounds === 1 && verdicts[0] === 'PASS') return 'trivial';
  return 'standard';
}

/**
 * Review FAILs of the leaf recorded before the pick.
 *
 * @param {object[]} rows
 * @param {string} createdAt
 * @returns {number}
 */
function reviewFailsBefore(rows, createdAt) {
  return rows.filter((row) => delegationPersistedRole(row) === 'review'
    && String(row.createdAt || '') < createdAt
    && parseDelegationVerdict(row.report) === 'FAIL').length;
}

/**
 * @returns {{ n: number, predicted: number, correct: number, confusion: Record<string, Record<string, number>>, brierSum: number, calibration: Record<string, { n: number, confidenceSum: number, correct: number }> }}
 */
function emptyStats() {
  /** @type {Record<string, Record<string, number>>} */
  const confusion = {};
  for (const actual of LEVELS) confusion[actual] = Object.fromEntries(LEVELS.map((p) => [p, 0]));
  return {
    n: 0,
    predicted: 0,
    correct: 0,
    confusion,
    brierSum: 0,
    calibration: Object.fromEntries(SHADOW_CONFIDENCE_BUCKETS.map((b) => [b, { n: 0, confidenceSum: 0, correct: 0 }])),
  };
}

/**
 * @param {ReturnType<typeof emptyStats>} stats
 * @param {string} label
 * @param {{ level: string, levelProbs?: Record<string, number>, confidenceBucket?: string } | null} prediction
 */
function addSample(stats, label, prediction) {
  stats.n += 1;
  if (!prediction) return;
  stats.predicted += 1;
  stats.confusion[label][prediction.level] += 1;
  const hit = prediction.level === label;
  if (hit) stats.correct += 1;
  if (prediction.levelProbs) {
    // Multi-class Brier score: squared distance to the one-hot label.
    stats.brierSum += LEVELS.reduce((sum, level) => sum + ((prediction.levelProbs[level] - (level === label ? 1 : 0)) ** 2), 0);
    const bucket = stats.calibration[prediction.confidenceBucket || 'low'];
    bucket.n += 1;
    bucket.confidenceSum += prediction.levelProbs[prediction.level];
    if (hit) bucket.correct += 1;
  }
}

/**
 * @param {number} value
 * @returns {number}
 */
function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * @param {ReturnType<typeof emptyStats>} stats
 * @param {boolean} probabilistic
 */
function summarize(stats, probabilistic) {
  return {
    n: stats.n,
    predicted: stats.predicted,
    accuracy: stats.predicted ? round4(stats.correct / stats.predicted) : null,
    missingRate: stats.n ? round4((stats.n - stats.predicted) / stats.n) : null,
    confusion: stats.confusion,
    ...(probabilistic
      ? {
        brier: stats.predicted ? round4(stats.brierSum / stats.predicted) : null,
        calibration: Object.fromEntries(Object.entries(stats.calibration).map(([bucket, b]) => [bucket, {
          n: b.n,
          meanConfidence: b.n ? round4(b.confidenceSum / b.n) : null,
          accuracy: b.n ? round4(b.correct / b.n) : null,
        }])),
      }
      : {}),
  };
}

/**
 * Build the comparison report.
 *
 * @param {{ proposals: object[], delegations: object[], counters?: object | null }} input
 */
export function buildEvaluationReport(input) {
  /** @type {Map<string, object[]>} */
  const byLeaf = new Map();
  for (const row of input.delegations) {
    const leafId = String(row?.leafId || '').trim();
    if (!leafId) continue;
    if (!byLeaf.has(leafId)) byLeaf.set(leafId, []);
    /** @type {object[]} */ (byLeaf.get(leafId)).push(row);
  }
  const labels = new Map([...byLeaf].map(([leafId, rows]) => [leafId, labelLeaf(rows)]));
  const backendIds = new Set();
  /** @type {{ label: string, heuristic: any, shadow: any, cleanHistory: boolean }[]} */
  const samples = [];
  for (const proposal of input.proposals) {
    const leafId = String(proposal?.leafId || '').trim();
    const label = labels.get(leafId);
    if (!label) continue;
    const shadow = normalizeComplexityShadow(proposal.complexityShadow);
    if (shadow) backendIds.add(shadow.backendId);
    samples.push({
      label,
      heuristic: normalizeComplexity(proposal.complexity),
      shadow,
      cleanHistory: reviewFailsBefore(/** @type {object[]} */ (byLeaf.get(leafId)), String(proposal.createdAt || '')) === 0,
    });
  }
  /**
   * @param {(s: typeof samples[number]) => boolean} filter
   */
  const scoreAll = (filter) => {
    const heuristic = emptyStats();
    /** @type {Record<string, ReturnType<typeof emptyStats>>} */
    const backends = Object.fromEntries([...backendIds].sort().map((id) => [id, emptyStats()]));
    for (const sample of samples.filter(filter)) {
      addSample(heuristic, sample.label, sample.heuristic);
      for (const [id, stats] of Object.entries(backends)) {
        addSample(stats, sample.label, sample.shadow?.backendId === id ? sample.shadow : null);
      }
    }
    return {
      heuristic: summarize(heuristic, false),
      backends: Object.fromEntries(Object.entries(backends).map(([id, stats]) => [id, summarize(stats, true)])),
    };
  };
  const counters = input.counters ?? null;
  return {
    leaves: labels.size,
    samples: samples.length,
    all: scoreAll(() => true),
    // The heuristic reads `review_fail_history`, which overlaps with the label.
    // This subset keeps only picks made before any review FAIL of the leaf.
    noPriorReviewFail: scoreAll((s) => s.cleanHistory),
    counters,
    dropped: counters && typeof counters === 'object' ? Number(/** @type {any} */ (counters).dropped ?? 0) : null,
    note: 'The heuristic reads review_fail_history, which overlaps with the reference label; compare on noPriorReviewFail as well.',
  };
}

/**
 * @param {ReturnType<typeof buildEvaluationReport>} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const fmt = (v) => (v == null ? '—' : String(v));
  const lines = [`Leaves: ${report.leaves}, labelled picks: ${report.samples}`, ''];
  for (const [title, block] of [['All picks', report.all], ['Picks with no prior review FAIL', report.noPriorReviewFail]]) {
    lines.push(`### ${title}`, '', '| Predictor | n | predicted | accuracy | missing | Brier |', '| --- | --- | --- | --- | --- | --- |');
    lines.push(`| heuristic | ${block.heuristic.n} | ${block.heuristic.predicted} | ${fmt(block.heuristic.accuracy)} | ${fmt(block.heuristic.missingRate)} | — |`);
    for (const [id, b] of Object.entries(block.backends)) {
      lines.push(`| ${id} | ${b.n} | ${b.predicted} | ${fmt(b.accuracy)} | ${fmt(b.missingRate)} | ${fmt(b.brier)} |`);
    }
    lines.push('');
  }
  lines.push(`Dropped classifications: ${fmt(report.dropped)}`, '', `Note: ${report.note}`);
  return lines.join('\n');
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string[]} argv
 */
async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const asJson = argv.includes('--json');
  const fixturesIndex = argv.indexOf('--fixtures');
  const fixtures = fixturesIndex >= 0 ? argv[fixturesIndex + 1] : '';
  let proposals;
  let delegations;
  if (fixtures) {
    proposals = rowsOf(readJson(path.join(fixtures, 'proposals.json')), 'picks');
    delegations = rowsOf(readJson(path.join(fixtures, 'delegations.json')), 'items');
  } else {
    const { loadModelPickRecords } = await import('../lib/persist/model-pick-decisions-persist.js');
    const { loadDelegations } = await import('../lib/persist/delegations-persist.js');
    proposals = Object.values(loadModelPickRecords());
    delegations = loadDelegations();
  }
  let counters = null;
  if (!dryRun) {
    const { getComplexityShadowStats } = await import('../lib/model-pick-complexity-classifier.js');
    counters = getComplexityShadowStats();
  }
  const report = buildEvaluationReport({ proposals, delegations, counters });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderMarkdown(report)}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(String(err?.message || err));
    process.exit(1);
  });
}
