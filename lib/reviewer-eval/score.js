/**
 * Reviewer-eval scoring. A finding is a hit when it is `same` as a ground-truth
 * entry, a possibleHit when only `ambiguous`; a case with neither is a miss;
 * a finding `distinct` from every truth entry is a false alarm.
 *
 * Three levels per run: `raw` (every parsed finding), `verified` (findings not
 * rejected) and `final` (verified view, only when the report ends with
 * VERDICT: FAIL). A rejected finding therefore counts at the raw level only.
 * Runs that ended in an infrastructure failure carry `infra` instead of scores
 * and are excluded from every count.
 */

import { matchFindings } from '../review-finding-match.js';
import { parseReviewFindings } from '../review-findings-parse.js';
import { parseDelegationVerdict } from '../delegation-verdict.js';

export const EVAL_LEVELS = Object.freeze(['raw', 'verified', 'final']);

/** @param {any} finding @returns {boolean} */
function isRejected(finding) {
  return finding?.rejected === true || finding?.outcome === 'rejected';
}

/**
 * @param {any[]} findings
 * @param {Array<{ file: string, line?: number }>} truth
 * @param {string} description
 * @returns {{ hit: boolean, possibleHit: boolean, miss: boolean, falseAlarms: number }}
 */
function scoreFindings(findings, truth, description) {
  const truthFinding = (/** @type {any} */ t) => ({
    category: 'other',
    files: [t.line ? `${t.file}:${t.line}${t.end && t.end !== t.line ? `-${t.end}` : ''}` : t.file],
    summary: description,
  });
  let hit = false;
  let possibleHit = false;
  let falseAlarms = 0;
  for (const f of findings) {
    const classes = truth.map((t) => matchFindings(f, truthFinding(t)));
    if (classes.includes('same')) hit = true;
    else if (classes.includes('ambiguous')) possibleHit = true;
    else if (classes.length > 0 && classes.every((c) => c === 'distinct')) falseAlarms += 1;
  }
  return { hit, possibleHit: !hit && possibleHit, miss: !hit && !possibleHit, falseAlarms };
}

/**
 * @param {{ truth: Array<{ file: string, line?: number, end?: number }>, description?: string }} testCase
 * @param {{ report?: string, findings?: any[] }} run `findings` overrides parsing (carries `rejected`)
 * @returns {Record<'raw'|'verified'|'final', ReturnType<typeof scoreFindings>> & { rejections: number }}
 */
export function scoreCase(testCase, run) {
  const findings = Array.isArray(run.findings) ? run.findings : parseReviewFindings(run.report).findings;
  const verified = findings.filter((f) => !isRejected(f));
  const failed = parseDelegationVerdict(run.report) === 'FAIL';
  const desc = String(testCase.description || '');
  return {
    rejections: findings.length - verified.length,
    raw: scoreFindings(findings, testCase.truth, desc),
    verified: scoreFindings(verified, testCase.truth, desc),
    final: scoreFindings(failed ? verified : [], testCase.truth, desc),
  };
}

/**
 * @param {Array<{ harness: string, model: string, scores?: ReturnType<typeof scoreCase>, infra?: unknown }> | Array<Record<string, any>>} results
 * @returns {Array<Record<string, any>>} one row per harness+model with per-level counts
 */
export function aggregateScores(results) {
  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const r of results) {
    const key = `${r.harness}/${r.model}`;
    const row = rows.get(key) || { harness: r.harness, model: r.model, cases: 0, infra: 0, hasRejections: false };
    rows.set(key, row);
    if (r.infra || !r.scores) {
      row.infra += 1;
      continue;
    }
    row.cases += 1;
    if (r.scores.rejections > 0) row.hasRejections = true;
    for (const level of EVAL_LEVELS) {
      const s = r.scores[level];
      const acc = row[level] || { hits: 0, possibleHits: 0, misses: 0, falseAlarms: 0 };
      acc.hits += s.hit ? 1 : 0;
      acc.possibleHits += s.possibleHit ? 1 : 0;
      acc.misses += s.miss ? 1 : 0;
      acc.falseAlarms += s.falseAlarms;
      row[level] = acc;
    }
  }
  return [...rows.values()];
}

/**
 * The `verified` row is omitted when no run carried rejection data (it would
 * only repeat `raw`).
 *
 * @param {Array<Record<string, any>>} rows
 * @returns {string}
 */
export function formatScoreTable(rows) {
  const head = ['harness/model', 'cases', 'infra', 'level', 'hits', 'possibleHit', 'misses', 'falseAlarms'];
  const lines = [head.join('\t')];
  for (const row of rows) {
    for (const level of EVAL_LEVELS) {
      if (level === 'verified' && !row.hasRejections) continue;
      const s = row[level] || { hits: 0, possibleHits: 0, misses: 0, falseAlarms: 0 };
      lines.push([`${row.harness}/${row.model}`, row.cases, row.infra, level, s.hits, s.possibleHits, s.misses, s.falseAlarms].join('\t'));
    }
  }
  return lines.join('\n');
}
