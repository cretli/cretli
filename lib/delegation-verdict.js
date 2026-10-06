/**
 * Parent-loop verdict contract. The server does not sequence roles; it only
 * parses the child's report line and aggregates optional review fanout.
 */

import { normalizeDelegationTaskOutcome } from './delegation-status.js';
import { DELEGATION_ADAPTER_INCOMPLETE_CODE } from './delegation-adapter-error.js';

export const DELEGATION_VERDICTS = Object.freeze([
  'PASS',
  'FAIL',
  'BLOCKED',
  'unspecified',
  'conflict',
]);

const VERDICT_LINE = /^VERDICT:\s*(PASS|FAIL|BLOCKED)\s*$/i;
const COMPACT_TASK_VERDICT = /(?:^|[^A-Z])TASK\s*:\s*(?:audit|implement|review)\s*VERDICT\s*:\s*(PASS|FAIL|BLOCKED)(?:$|[^A-Z])/i;
const INCOMPLETE_REPORT_MAX_CHARS = 400;
const INCOMPLETE_REPORT_MIN_SPACE_RATIO = 0.04;

/**
 * A persisted/delivered report is bounded so a token-repetition run cannot push
 * hundreds of kilobytes into the parent context. The cap is a safety net; a
 * report that keeps its usable VERDICT line stays parseable.
 */
export const DELEGATION_REPORT_MAX_CHARS = 64 * 1024;
/** @deprecated Char n-grams; use word-based {@link measureDelegationReportWordRepeatRatio}. */
export const DELEGATION_REPORT_DEGRADED_NGRAM = 4;
export const DELEGATION_REPORT_DEGRADED_WORD_NGRAM = 4;
export const DELEGATION_REPORT_DEGRADED_REPEAT_RATIO = 0.5;
/** Minimum body size before repetition analysis runs (avoids false positives on normal long reports). */
export const DELEGATION_REPORT_REPEAT_DEGRADED_MIN_CHARS = 16 * 1024;
/** @deprecated Use {@link DELEGATION_REPORT_REPEAT_DEGRADED_MIN_CHARS}. */
export const DELEGATION_REPORT_DEGRADED_MIN_CHARS = DELEGATION_REPORT_REPEAT_DEGRADED_MIN_CHARS;
export const DELEGATION_REPORT_DEGRADED_CODE = 'report_degraded';
const DELEGATION_REPORT_REPEAT_SAMPLE_CHARS = 128 * 1024;
const DELEGATION_REPORT_HEAD_CHARS = 4000;
const DELEGATION_REPORT_TAIL_CHARS = 2000;
const DELEGATION_REPORT_VERDICT_LIMIT = 6;
const DELEGATION_REPORT_SUMMARY_CHARS = 280;
const DEGRADED_MARKER = '[report_degraded';
const DEGRADED_REASON_RE = /\[report_degraded\s+reason=([^\s]+)/;

/**
 * @param {unknown} raw
 * @param {{ reason?: string, degraded?: boolean }} assessment
 * @returns {boolean}
 */
function isDelegationReportRepetitionDegraded(raw, assessment) {
  if (!assessment.degraded) return false;
  const reason = String(assessment.reason || '').trim();
  if (reason === 'repetition' || reason === 'size+repetition') return true;
  const match = DEGRADED_REASON_RE.exec(String(raw || '').trimStart());
  const marked = match?.[1] || '';
  return marked === 'repetition' || marked === 'size+repetition';
}

/**
 * Map a skill role onto the server assignment. Plan stays read-only so a
 * planner cannot write the workspace; the parent saves the plan. Fix is a
 * mutating implement follow-up.
 *
 * @param {unknown} role
 * @returns {'review' | 'implement' | ''}
 */
export function mapDelegationRoleToAssignment(role) {
  const raw = String(role || '').trim().toLowerCase();
  if (raw === 'review' || raw === 'plan') return 'review';
  if (raw === 'implement' || raw === 'fix') return 'implement';
  return '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUsableDelegationVerdict(value) {
  const raw = String(value || '').trim().toUpperCase();
  return raw === 'PASS' || raw === 'FAIL' || raw === 'BLOCKED';
}

/**
 * Why a report is incomplete, or `''` when it is usable. Verdict-first: only a
 * real VERDICT line makes a report complete; length/whitespace are secondary
 * signals that only classify the missing-verdict case (one-liner vs thinking
 * dump) for diagnostics.
 *
 * @param {unknown} text
 * @returns {'' | 'empty' | 'verdict_conflict' | 'short_without_verdict' | 'no_whitespace_without_verdict' | 'missing_verdict'}
 */
export function describeIncompleteDelegationReport(text) {
  const raw = String(text || '').trim();
  if (!raw) return 'empty';
  const verdict = parseDelegationVerdict(raw);
  if (verdict === 'conflict') return 'verdict_conflict';
  if (isUsableDelegationVerdict(verdict)) return '';
  if (raw.length < INCOMPLETE_REPORT_MAX_CHARS) return 'short_without_verdict';
  const spaces = (raw.match(/\s/g) || []).length;
  if ((spaces / raw.length) < INCOMPLETE_REPORT_MIN_SPACE_RATIO) return 'no_whitespace_without_verdict';
  return 'missing_verdict';
}

/**
 * Review adapter finished without a usable report (one-liner, empty, compacted
 * thinking dump, or a long body that never declared a VERDICT). A report with a
 * real `VERDICT:` line is never incomplete.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isIncompleteDelegationReport(text) {
  return describeIncompleteDelegationReport(text) !== '';
}

/**
 * Last matching `VERDICT:` line wins unless two distinct values appear.
 *
 * @param {unknown} text
 * @returns {'PASS' | 'FAIL' | 'BLOCKED' | 'unspecified' | 'conflict'}
 */
export function parseDelegationVerdict(text) {
  const hits = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = VERDICT_LINE.exec(line.trim());
    if (!match) continue;
    hits.push(String(match[1] || '').toUpperCase());
  }
  if (hits.length === 0) {
    const compact = COMPACT_TASK_VERDICT.exec(String(text || ''));
    if (compact?.[1]) return /** @type {'PASS' | 'FAIL' | 'BLOCKED'} */ (compact[1].toUpperCase());
    return 'unspecified';
  }
  const unique = [...new Set(hits)];
  if (unique.length > 1) return 'conflict';
  return /** @type {'PASS' | 'FAIL' | 'BLOCKED'} */ (unique[0]);
}

/**
 * Read the persisted verdict first, then fall back to parsing the report body.
 * Rows written before the field existed keep working.
 *
 * @param {object | null | undefined} row
 * @returns {'PASS' | 'FAIL' | 'BLOCKED' | 'unspecified' | 'conflict'}
 */
export function resolveDelegationRecordVerdict(row) {
  const stored = String(row?.reportVerdict || '').trim();
  if (DELEGATION_VERDICTS.includes(stored)) {
    return /** @type {'PASS' | 'FAIL' | 'BLOCKED' | 'unspecified' | 'conflict'} */ (stored);
  }
  return parseDelegationVerdict(row?.report || '');
}

/**
 * Conservative fanout: any BLOCKED wins, then FAIL, then conflict.
 * PASS only when every review is PASS. Missing lines stay unspecified.
 *
 * @param {unknown[]} verdicts
 * @returns {'PASS' | 'FAIL' | 'BLOCKED' | 'unspecified' | 'conflict'}
 */
export function aggregateReviewFanoutVerdicts(verdicts) {
  const parsed = (Array.isArray(verdicts) ? verdicts : []).map((value) => {
    const raw = String(value || '').trim();
    if (raw === 'PASS' || raw === 'FAIL' || raw === 'BLOCKED' || raw === 'unspecified' || raw === 'conflict') {
      return raw;
    }
    return parseDelegationVerdict(value);
  });
  if (parsed.length === 0) return 'unspecified';
  if (parsed.some((row) => row === 'BLOCKED')) return 'BLOCKED';
  if (parsed.some((row) => row === 'FAIL')) return 'FAIL';
  if (parsed.some((row) => row === 'conflict')) return 'conflict';
  if (parsed.every((row) => row === 'PASS')) return 'PASS';
  return 'unspecified';
}

/**
 * Next-step rule for the parent skill. Conflict is not PASS.
 *
 * @param {unknown} verdict
 * @returns {'continue' | 'fix' | 'stop'}
 */
export function resolveVerdictNextStep(verdict) {
  const value = String(verdict || '').trim();
  if (value === 'PASS') return 'continue';
  if (value === 'FAIL' || value === 'conflict') return 'fix';
  return 'stop';
}

/**
 * Repeated word n-gram ratio. Token-repetition runs reuse the same phrases; varied
 * long prose keeps a low ratio. Samples the head like the char variant.
 *
 * @param {unknown} text
 * @param {number} [n]
 * @returns {number} 0..1
 */
export function measureDelegationReportWordRepeatRatio(text, n = DELEGATION_REPORT_DEGRADED_WORD_NGRAM) {
  const raw = String(text || '');
  const size = Math.max(1, Math.floor(Number(n) || DELEGATION_REPORT_DEGRADED_WORD_NGRAM));
  const sample = raw.length > DELEGATION_REPORT_REPEAT_SAMPLE_CHARS
    ? raw.slice(0, DELEGATION_REPORT_REPEAT_SAMPLE_CHARS)
    : raw;
  const words = sample.toLowerCase().split(/\s+/).filter(Boolean);
  const total = words.length - size + 1;
  if (total <= 0) return 0;
  const seen = new Set();
  let repeats = 0;
  for (let i = 0; i < total; i += 1) {
    const gram = words.slice(i, i + size).join(' ');
    if (seen.has(gram)) repeats += 1;
    else seen.add(gram);
  }
  return repeats / total;
}

/**
 * Repeated character n-gram ratio (legacy). Prefer word n-grams for degradation.
 *
 * @param {unknown} text
 * @param {number} [n]
 * @returns {number} 0..1
 */
export function measureDelegationReportRepeatRatio(text, n = DELEGATION_REPORT_DEGRADED_NGRAM) {
  const raw = String(text || '');
  const size = Math.max(1, Math.floor(Number(n) || DELEGATION_REPORT_DEGRADED_NGRAM));
  if (raw.length - size + 1 <= 0) return 0;
  const sample = raw.length > DELEGATION_REPORT_REPEAT_SAMPLE_CHARS
    ? raw.slice(0, DELEGATION_REPORT_REPEAT_SAMPLE_CHARS)
    : raw;
  const total = sample.length - size + 1;
  if (total <= 0) return 0;
  const seen = new Set();
  let repeats = 0;
  for (let i = 0; i < total; i += 1) {
    const gram = sample.slice(i, i + size);
    if (seen.has(gram)) repeats += 1;
    else seen.add(gram);
  }
  return repeats / total;
}

/**
 * Collect the strict `VERDICT:` lines (and the compact `TASK: … VERDICT: …`
 * form) so a bounded report keeps its verdict, including a conflict pair.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function extractDelegationVerdictLines(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const strict = VERDICT_LINE.exec(trimmed);
    if (strict) {
      out.push(`VERDICT: ${String(strict[1]).toUpperCase()}`);
    } else {
      const compact = COMPACT_TASK_VERDICT.exec(trimmed);
      if (compact?.[1]) out.push(`VERDICT: ${String(compact[1]).toUpperCase()}`);
    }
    if (out.length >= DELEGATION_REPORT_VERDICT_LIMIT) break;
  }
  return out;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function buildDelegationReportSummary(raw) {
  const collapsed = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > DELEGATION_REPORT_SUMMARY_CHARS
    ? `${collapsed.slice(0, DELEGATION_REPORT_SUMMARY_CHARS)}…`
    : collapsed;
}

/**
 * Build the bounded replacement for a degraded report: a machine-readable
 * header, the verdict lines, and a head/tail excerpt. The original body is
 * never delivered to the parent verbatim.
 *
 * @param {string} raw
 * @param {{ reason: string, repeatRatio: number, maxChars: number }} meta
 * @returns {string}
 */
function buildBoundedDelegationReport(raw, meta) {
  const verdictLines = extractDelegationVerdictLines(raw);
  const head = raw.slice(0, DELEGATION_REPORT_HEAD_CHARS);
  const tail = raw.slice(-DELEGATION_REPORT_TAIL_CHARS);
  const elided = Math.max(0, raw.length - head.length - tail.length);
  const header = `${DEGRADED_MARKER} reason=${meta.reason} original_chars=${raw.length} repeat_ratio=${meta.repeatRatio.toFixed(4)}]`;
  const parts = [header];
  if (verdictLines.length > 0) parts.push(verdictLines.join('\n'));
  parts.push(head.trimEnd());
  if (elided > 0) {
    parts.push(`[... ${elided} chars elided ...]`);
    parts.push(tail.trimStart());
  }
  const bounded = parts.filter(Boolean).join('\n\n');
  return bounded.length > meta.maxChars ? bounded.slice(0, meta.maxChars) : bounded;
}

/**
 * Bound a report body and flag token-repetition degeneracy. The returned
 * `report` is safe to persist and to hand to the parent; `degraded` marks that
 * the body was replaced by a summary. The marker makes the assessment
 * idempotent, so re-assessing a bounded body keeps the flag.
 *
 * @param {unknown} text
 * @param {{ maxChars?: number }} [options]
 * @returns {{
 *   report: string,
 *   degraded: boolean,
 *   reason: string,
 *   verdict: 'PASS' | 'FAIL' | 'BLOCKED' | 'unspecified' | 'conflict',
 *   repeatRatio: number,
 *   originalChars: number,
 *   storedChars: number,
 *   summary: string,
 * }}
 */
export function assessDelegationReport(text, options = {}) {
  const raw = String(text || '');
  const maxChars = Number(options.maxChars) > 0
    ? Math.floor(Number(options.maxChars))
    : DELEGATION_REPORT_MAX_CHARS;
  const verdict = parseDelegationVerdict(raw);
  const alreadyMarked = raw.trimStart().startsWith(DEGRADED_MARKER);
  const oversized = raw.length > maxChars;
  const repeatRatio = !alreadyMarked && raw.length >= DELEGATION_REPORT_REPEAT_DEGRADED_MIN_CHARS
    ? measureDelegationReportWordRepeatRatio(raw)
    : 0;
  const repetitive = repeatRatio >= DELEGATION_REPORT_DEGRADED_REPEAT_RATIO;
  const degraded = alreadyMarked || oversized || repetitive;
  if (!degraded) {
    return {
      report: raw,
      degraded: false,
      reason: '',
      verdict,
      repeatRatio,
      originalChars: raw.length,
      storedChars: raw.length,
      summary: buildDelegationReportSummary(raw),
    };
  }
  if (alreadyMarked && !oversized && !repetitive) {
    return {
      report: raw,
      degraded: true,
      reason: 'flagged',
      verdict,
      repeatRatio,
      originalChars: raw.length,
      storedChars: raw.length,
      summary: buildDelegationReportSummary(raw),
    };
  }
  const reason = oversized && repetitive ? 'size+repetition' : oversized ? 'size' : 'repetition';
  const bounded = buildBoundedDelegationReport(raw, { reason, repeatRatio, maxChars });
  return {
    report: bounded,
    degraded: true,
    reason,
    verdict,
    repeatRatio,
    originalChars: raw.length,
    storedChars: bounded.length,
    summary: buildDelegationReportSummary(raw),
  };
}

/**
 * Shared finish decision for a report. Both the adapter run-finish path and the
 * `delegation_reply final_report` mailbox path must use this so a review can
 * never be finalized as `completed`/`success` without a usable VERDICT.
 *
 * `implement` (and plan) self-verdicts stay meaningless: only `review` requires
 * a verdict, so implement reports are not reclassified.
 *
 * @param {{
 *   assignment?: unknown,
 *   report?: unknown,
 *   taskOutcome?: unknown,
 *   status?: unknown,
 *   error?: unknown,
 * }} input
 * @returns {{
 *   report: string,
 *   degraded: boolean,
 *   reason: string,
 *   verdict: string,
 *   repeatRatio: number,
 *   originalChars: number,
 *   storedChars: number,
 *   summary: string,
 *   isReview: boolean,
 *   incomplete: boolean,
 *   status: string,
 *   error: string,
 *   taskOutcome: string,
 * }}
 */
export function resolveDelegationFinishReport(input = {}) {
  const assessment = assessDelegationReport(input.report);
  const isReview = String(input.assignment || '').trim().toLowerCase() === 'review';
  const incomplete = isReview && isIncompleteDelegationReport(assessment.report);
  let status = String(input.status || 'completed').trim() || 'completed';
  let error = String(input.error || '').trim();
  let taskOutcome = normalizeDelegationTaskOutcome(input.taskOutcome);
  if (incomplete) {
    if (status === 'completed') {
      status = 'failed';
      if (!error) error = `[${DELEGATION_ADAPTER_INCOMPLETE_CODE}] Review ended without a VERDICT report.`;
    }
    // A missing verdict is never success.
    if (taskOutcome === 'success') taskOutcome = 'unspecified';
  }
  const degradedRepetition = isDelegationReportRepetitionDegraded(input.report, assessment);
  if (isReview && degradedRepetition) {
    if (taskOutcome === 'success') taskOutcome = 'unspecified';
    if (status === 'completed') {
      status = 'failed';
      if (!error) {
        error = `[${DELEGATION_REPORT_DEGRADED_CODE}] Review report was flagged for repetitive output; a PASS line cannot be treated as success.`;
      }
    }
  }
  return {
    ...assessment,
    isReview,
    incomplete,
    status,
    error,
    taskOutcome,
  };
}
