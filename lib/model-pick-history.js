/**
 * Derive the injected rotation history for `model_pick` from local stores.
 *
 * The pick itself is a pure function (`selectModelPick`); this module is the
 * only place that reads delegations, lockouts and plan limits. Every read is
 * best-effort: a missing/corrupt store degrades to an empty history instead of
 * failing the tool call.
 */

import fs from 'node:fs';
import { loadDelegations } from './persist/delegations-persist.js';
import { loadDelegationRatings } from './persist/delegation-ratings-persist.js';
import { summarizeDelegationRatings } from './delegation-ratings.js';
import { getDelegationStoreBackend } from './persist/delegation-store-backend.js';
import { listHarnessUsageLimits, readHarnessUsageLimitHistory, isUsageLimitMessage } from './harness-usage-limits.js';
import { readHarnessPlanLimits } from './usage/harness-health.js';
import { isIncompleteDelegationReport, parseDelegationVerdict } from './delegation-verdict.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { decodeModelValue } from './model-catalog.js';
import { resolveDataPath } from './runtime-paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Usage balance window for one role. */
export const ROLE_USAGE_WINDOW_MS = 7 * DAY_MS;
/** Cold start: no job for the role in this window counts as unexplored. */
export const COLD_START_WINDOW_MS = 14 * DAY_MS;
/** A limit hit inside this window counts as a fresh (penalised) incident. */
export const FRESH_LIMIT_WINDOW_MS = DAY_MS;
/** Reuse a parsed delegations store for this long when its file is unchanged. */
const DELEGATIONS_CACHE_TTL_MS = 2000;

/**
 * `model_pick` runs rarely, but the JSON delegations store can reach several
 * MB and `loadDelegations()` re-parses it (and defaults every row) on each
 * call. Cache the parsed rows keyed by the store file signature: a write
 * rewrites `delegations.json`, bumping the signature so the cache self-heals,
 * while the short TTL bounds staleness for backends with no file to watch.
 *
 * @type {{ signature: string, at: number, rows: object[] } | null}
 */
let delegationsCache = null;

/**
 * @returns {string} Empty when the JSON store cannot be stat'ed (sqlite, or a
 *   first run before the file exists) so the caller reads fresh instead.
 */
function delegationsStoreSignature() {
  if (getDelegationStoreBackend() !== 'json') return '';
  try {
    const stat = fs.statSync(resolveDataPath('delegations.json'));
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '';
  }
}

/**
 * @returns {object[]}
 */
function safeLoadDelegations() {
  const now = Date.now();
  const signature = delegationsStoreSignature();
  if (signature && delegationsCache && delegationsCache.signature === signature
    && now - delegationsCache.at < DELEGATIONS_CACHE_TTL_MS) {
    return delegationsCache.rows;
  }
  try {
    const rows = loadDelegations();
    if (signature) delegationsCache = { signature, at: now, rows };
    return rows;
  } catch {
    // A transient read failure keeps the last good snapshot (if any).
    return delegationsCache && Array.isArray(delegationsCache.rows) ? delegationsCache.rows : [];
  }
}

/**
 * @returns {object[]}
 */
function safeListLockouts() {
  try {
    return listHarnessUsageLimits();
  } catch {
    return [];
  }
}

/**
 * @returns {object[]}
 */
function safeReadPlanLimits() {
  try {
    return readHarnessPlanLimits('');
  } catch {
    return [];
  }
}

/**
 * Fresh limit-hit incidents (last 24 h) grouped per harness, keeping the model
 * so a penalty is scoped instead of blaming the whole harness. A history row
 * without a model (`baseModel('')` collapses to `auto`) means the incident was
 * harness-wide; a row with a model penalises only that model/base.
 *
 * @param {number} now
 * @returns {Record<string, { whole: boolean, models: string[] }>}
 */
function safeFreshLimitHits(now) {
  try {
    const rows = readHarnessUsageLimitHistory({
      from: new Date(now - FRESH_LIMIT_WINDOW_MS).toISOString(),
      limit: 5000,
    });
    /** @type {Record<string, { whole: boolean, models: string[] }>} */
    const hits = {};
    for (const row of rows) {
      const harness = String(row?.harness || '').trim().toLowerCase();
      if (!harness) continue;
      const model = String(row?.model || '').trim().toLowerCase();
      const entry = hits[harness] || { whole: false, models: [] };
      if (!model || model === 'auto') entry.whole = true;
      else if (!entry.models.includes(model)) entry.models.push(model);
      hits[harness] = entry;
    }
    return hits;
  } catch {
    return {};
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseTime(value) {
  const ts = Date.parse(String(value || ''));
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Persisted assignments are only `implement` / `review`; `executionMode`
 * separates a read-only plan from a review.
 *
 * @param {string} role
 * @param {object} row
 * @returns {boolean}
 */
function rowMatchesRole(role, row) {
  const assignment = String(row?.assignment || '').trim().toLowerCase();
  const mode = String(row?.executionMode || '').trim().toLowerCase();
  if (role === 'plan') return assignment === 'review' && mode === 'plan';
  if (role === 'review') return assignment === 'review' && mode !== 'plan';
  // `implement` and `fix` share the persisted assignment.
  return assignment === 'implement';
}

/**
 * @param {object} row
 * @returns {{ harness: string, model: string }}
 */
function rowExecutor(row) {
  const executor = row?.executor && typeof row.executor === 'object' ? row.executor : {};
  return {
    harness: String(executor.transport || '').trim().toLowerCase(),
    model: String(executor.model || '').trim(),
  };
}

/**
 * Models whose newest implement→review cycle in this chat ended in PASS
 * ("do not rotate away").
 *
 * The workflow is a chronological stream of implement/fix jobs (assignment
 * `implement`) and their reviews (non-plan `review`). One cycle is an implement
 * plus every review that follows it before the next implement/fix — a review
 * fanout attaches several reviews to the same implement. Only the newest cycle
 * of a model counts, and its verdict is aggregated conservatively: PASS
 * requires at least one review and ALL reviews of that cycle to be PASS
 * (FAIL/BLOCKED wins, regardless of order). A newer implement/fix, a missing
 * review, or any non-PASS sibling clears an earlier PASS. Plan-mode reviews are
 * ignored.
 *
 * @param {object[]} chatRows
 * @param {string} role
 * @returns {Set<string>}
 */
function nextReviewPassedModels(chatRows, role) {
  const passed = new Set();
  if (role !== 'implement' && role !== 'fix') return passed;
  /** @type {{ at: number, kind: number, key: string, report: string }[]} */
  const events = [];
  for (const row of chatRows) {
    const assignment = String(row?.assignment || '').toLowerCase();
    const mode = String(row?.executionMode || '').toLowerCase();
    const at = parseTime(row?.createdAt || row?.startedAt);
    if (assignment === 'implement') {
      const { harness, model } = rowExecutor(row);
      if (!model) continue;
      events.push({ at, kind: 0, key: `${harness}/${model}`, report: '' });
    } else if (assignment === 'review' && mode !== 'plan') {
      events.push({ at, kind: 1, key: '', report: String(row?.report || '') });
    }
  }
  events.sort((left, right) => (left.at - right.at) || (left.kind - right.kind));
  /** @type {Map<string, boolean>} key -> verdict of its newest cycle */
  const latestCyclePassed = new Map();
  let openImplementKey = '';
  /** @type {string[]} */
  let openVerdicts = [];
  // Close the cycle the previous implement opened: all (at least one) reviews
  // must be PASS. A later implement of the same model simply overwrites this.
  const closeCycle = () => {
    if (!openImplementKey) return;
    latestCyclePassed.set(
      openImplementKey,
      openVerdicts.length > 0 && openVerdicts.every((verdict) => verdict === 'PASS'),
    );
  };
  for (const event of events) {
    if (event.kind === 0) {
      closeCycle();
      openImplementKey = event.key;
      openVerdicts = [];
      continue;
    }
    openVerdicts.push(parseDelegationVerdict(event.report));
  }
  closeCycle();
  for (const [key, didPass] of latestCyclePassed) {
    if (didPass) passed.add(key);
  }
  return passed;
}

/** Observed-outcome window (task 3): 30 days of delegation history. */
export const OBSERVED_WINDOW_MS = 30 * DAY_MS;

/** Successful `review-verify` trace: the runner is named and a success token
 * (`exit 0` / `OK`) follows on the same line. Prose that only mentions or quotes
 * the runner without a result line does not match. */
const REVIEW_TEST_SUCCESS_PATTERN = /review-verify[^\n]{0,200}?(?:exit\s*(?:code\s*)?0\b|\bOK\b)/i;
/**
 * Explicit inability to run the runner itself in a review report. A bare
 * "blocked" is deliberately scoped to a runner/shell context: an unscoped match
 * would count the `VERDICT: PASS|FAIL|BLOCKED` boilerplate copied into almost
 * every report and turn genuine successes into negatives.
 */
const REVIEW_TEST_BLOCKED_PATTERNS = Object.freeze([
  /nie uruchamiałem/i,
  /nie mogłem uruchomić/i,
  /no shell/i,
  /nie ma shella/i,
  /(?:review-verify|native shell|runner)[^\n]{0,80}\bblocked\b/i,
  /\bblocked\b[^\n]{0,80}(?:review-verify|native shell)/i,
]);

/**
 * Count per-harness `review_can_run_tests` signals over a trailing window.
 *
 * Positive: a review report that carries a successful `review-verify` trace
 * (`REVIEW_TEST_SUCCESS_PATTERN`). Negative: a review report that explicitly
 * says the runner was not/could not be run (`REVIEW_TEST_BLOCKED_PATTERNS`).
 * Both can match one report; the effective trait resolver compares the totals
 * and requires a strict majority (see `resolveHarnessDelegationTraits`). Pure:
 * `rows` is injected, there is no I/O here.
 *
 * @param {object[]} rows
 * @param {{ now?: number, windowMs?: number }} [input]
 * @returns {Record<string, { positive: number, negative: number }>}
 */
export function summarizeReviewTestObservations(rows, input = {}) {
  const at = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const windowMs = Number.isFinite(Number(input.windowMs)) && Number(input.windowMs) > 0
    ? Number(input.windowMs)
    : OBSERVED_WINDOW_MS;
  const cutoff = at - windowMs;
  /** @type {Record<string, { positive: number, negative: number }>} */
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (delegationPersistedRole(row) !== 'review') continue;
    const ts = parseTime(row?.createdAt || row?.startedAt);
    if (!(ts > 0 && ts >= cutoff)) continue;
    const { harness } = rowExecutor(row);
    if (!harness) continue;
    const report = String(row?.report || '');
    const positive = REVIEW_TEST_SUCCESS_PATTERN.test(report);
    const negative = REVIEW_TEST_BLOCKED_PATTERNS.some((pattern) => pattern.test(report));
    if (!positive && !negative) continue;
    const entry = out[harness] || { positive: 0, negative: 0 };
    if (positive) entry.positive += 1;
    if (negative) entry.negative += 1;
    out[harness] = entry;
  }
  return out;
}

/**
 * Error substrings that mark a delegation as an infrastructure failure, not a
 * model-quality signal. Usage/session limits are matched separately through
 * `isUsageLimitMessage`.
 */
const INFRA_ERROR_PATTERNS = Object.freeze([
  /adapter_incomplete/i,
  /timed?\s*out|timeout/i,
  /server restarted|run was lost|grace period|inactive context/i,
  /aborted/i,
  /exited with code/i,
  /no payment method|insufficient balance|subscription plan does not/i,
  /ai model not found|invalid parameters for registry model/i,
]);

/** Terminal statuses that can carry an infra failure. */
const TERMINAL_FAIL_STATUSES = new Set(['failed', 'cancelled', 'interrupted']);

/**
 * Persisted role of a row: `plan` is a read-only plan mode, `review` a real
 * review, `implement` covers implement and fix. Everything else is ignored.
 *
 * Exported so the rating writer stores the same role key the aggregation
 * groups by (`lib/delegation-service.js`).
 *
 * @param {object} row
 * @returns {'plan' | 'implement' | 'review' | ''}
 */
export function delegationPersistedRole(row) {
  const assignment = String(row?.assignment || '').trim().toLowerCase();
  const mode = String(row?.executionMode || '').trim().toLowerCase();
  if (assignment === 'review') return mode === 'plan' ? 'plan' : 'review';
  if (assignment === 'implement') return 'implement';
  return '';
}

/**
 * @param {object} row
 * @returns {string} Lower-cased base model id (`::params` stripped).
 */
function baseModelOfRow(row) {
  const { model } = rowExecutor(row);
  if (!model) return '';
  const decoded = decodeModelValue(model);
  return String(decoded.modelId || model).trim().toLowerCase();
}

/**
 * Error text of a durable row: the legacy `error` string plus every entry of
 * the structured `errors` array (code + message). The report body is
 * deliberately excluded — a review that merely *mentions* a rate limit is not
 * an infrastructure failure. `adapter_after_terminal` entries are skipped: the
 * adapter emits them after the job already finished (late "Aborted" / "ended
 * without a VERDICT" noise on completed jobs that do carry a report).
 *
 * @param {object} row
 * @returns {string}
 */
function delegationErrorText(row) {
  /** @type {string[]} */
  const parts = [];
  const direct = String(row?.error || '').trim();
  if (direct) parts.push(direct);
  const errors = Array.isArray(row?.errors) ? row.errors : [];
  for (const entry of errors) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      parts.push(entry);
      continue;
    }
    if (typeof entry !== 'object') continue;
    const code = String(entry.code || '').trim();
    if (code === 'adapter_after_terminal') continue;
    const message = String(entry.message || '').trim();
    if (code) parts.push(code);
    if (message) parts.push(message);
  }
  return parts.join('\n');
}

/**
 * Is this row an infrastructure outcome rather than a model-quality signal?
 *
 * Covered: `failed` / `cancelled` / `interrupted` without a meaningful report;
 * `[adapter_incomplete]`; a review report without a usable VERDICT; usage or
 * session limits in the row's error fields; timeouts; server restarts / lost
 * runs; credential and invalid-model errors. Parent cancellations cannot be
 * told apart from an executor fault in the durable row, so every `cancelled`
 * job counts as infra.
 *
 * Only terminal rows reach this function (`summarizeDelegationOutcomes` drops
 * `queued` / `starting` / `running` / `waiting_for_input` / `cancelling`), so
 * an in-flight job can never inflate the infra rate.
 *
 * Implement self-verdicts are deliberately ignored: the plan calls them
 * meaningless, so a missing VERDICT in an implement report is not infra. Plan
 * reports never carry a VERDICT, so plan-mode jobs are exempt from that rule.
 *
 * @param {object} row
 * @param {string} role
 * @returns {boolean}
 */
function isInfraDelegationOutcome(row, role) {
  const error = delegationErrorText(row);
  const report = String(row?.report || '');
  const status = String(row?.status || '').trim().toLowerCase();
  if (isUsageLimitMessage(error)) return true;
  if (INFRA_ERROR_PATTERNS.some((pattern) => pattern.test(error))) return true;
  if (status === 'cancelled') return true;
  const meaningful = report.trim().length > 0 && !isIncompleteDelegationReport(report);
  if (TERMINAL_FAIL_STATUSES.has(status) && !meaningful) return true;
  if (role === 'review') {
    if (!meaningful) return true;
    const verdict = parseDelegationVerdict(report);
    if (verdict === 'unspecified' || verdict === 'conflict') return true;
  }
  return false;
}

/**
 * The review at `reviewIndex` (a FAIL) is justified when the next implement/fix
 * in the chat opened a cycle whose usable reviews are all PASS. A fanout with a
 * FAIL anywhere is not justified.
 *
 * @param {{ kind: number, infra: boolean, report: string }[]} events
 * @param {number} reviewIndex
 * @returns {boolean}
 */
function reviewJustifiedByNextCycle(events, reviewIndex) {
  let i = reviewIndex + 1;
  while (i < events.length && events[i].kind !== 0) i += 1;
  if (i >= events.length) return false;
  i += 1;
  /** @type {string[]} */
  const verdicts = [];
  for (; i < events.length && events[i].kind !== 0; i += 1) {
    const event = events[i];
    if (event.infra) continue;
    const verdict = parseDelegationVerdict(event.report);
    if (verdict === 'PASS' || verdict === 'FAIL' || verdict === 'BLOCKED') verdicts.push(verdict);
  }
  return verdicts.length > 0 && verdicts.every((verdict) => verdict === 'PASS');
}

/**
 * @param {number[]} sorted
 * @param {number} p
 * @returns {number | null}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + ((sorted[hi] - sorted[lo]) * (pos - lo));
}

/**
 * @param {number | null} value
 * @returns {number | null}
 */
function round2(value) {
  return Number.isFinite(value) ? Math.round(/** @type {number} */ (value) * 100) / 100 : null;
}

/**
 * @param {number | null} value
 * @returns {number | null}
 */
function round4(value) {
  return Number.isFinite(value) ? Math.round(/** @type {number} */ (value) * 10000) / 10000 : null;
}

/**
 * Per (harness, base model, role) outcome statistics over a trailing window.
 * Pure: `rows` is injected, there is no I/O here (`buildDelegationOutcomes`
 * supplies the loader).
 *
 * Rate semantics:
 * - `pass_rate` — implement: share of implement/fix jobs whose following
 *   review cycle PASSed (all reviews of the cycle PASS; a missing review is
 *   excluded from the denominator, so self-verdicts never count). Review: the
 *   productive-verdict share (PASS, or FAIL confirmed by a fix + PASS). Plan:
 *   completed-with-report share of non-infra jobs.
 * - `verdict_fail_rate` / `useful_rate` — review only. `useful_rate` is the
 *   share of FAIL verdicts that were followed by a fix and a PASSing next
 *   review; it is `null` when the reviewer never FAILed, so a lenient reviewer
 *   gets no positive or negative signal from it. Records carry no
 *   `material_revision`, so this is a heuristic proxy for "the findings were
 *   real", not proof that the fix changed anything.
 * - `median_min` / `p95_min` — startedAt -> finishedAt over completed jobs.
 * - `median_tokens_per_sec` / `median_tool_calls` / `median_files_changed` —
 *   per-run efficiency from the delegation `metrics` field. Speed is sampled
 *   for every role; tool calls and file churn are `null` outside implement/fix
 *   (those runs report no such metric). Each is `null` when no run in the window
 *   carried the value, so "no data" stays distinct from "zero".
 * - `quality` — observed quality on the 1-5 tier scale: `1 + 4 * pass_rate`
 *   (for review that is the productive-verdict share; a PASS counts as a
 *   correct approval, which cannot be distinguished from leniency in a record).
 * - `rating_avg` / `rating_n` — user/parent stars over the same window,
 *   aggregated per (harness, base model, role) from `input.ratings`. The mean
 *   is weighted (user = 2, parent = 1), `rating_n` is the raw record count.
 *   A rating whose key has no terminal job in the window is dropped: without
 *   the job there is no stats row to attach it to.
 *
 * @param {{
 *   rows?: object[],
 *   ratings?: object[],
 *   now?: number,
 *   windowMs?: number,
 * }} [input]
 * @returns {{
 *   window_ms: number,
 *   generated_at: string,
 *   min_jobs: number,
 *   roles: Record<'plan' | 'implement' | 'review', Record<string, object>>,
 *   list: object[],
 * }}
 */
export function summarizeDelegationOutcomes(input = {}) {
  const at = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const windowMs = Number.isFinite(Number(input.windowMs)) && Number(input.windowMs) > 0
    ? Number(input.windowMs)
    : OBSERVED_WINDOW_MS;
  const cutoff = at - windowMs;
  const allRows = Array.isArray(input.rows) ? input.rows : [];
  // Only terminal rows count: a `queued` / `starting` / `running` /
  // `waiting_for_input` / `cancelling` row has no outcome yet, so it must not
  // inflate the infra rate or any denominator.
  const inWindow = allRows.filter((row) => {
    const ts = parseTime(row?.createdAt || row?.startedAt);
    if (!(ts > 0 && ts >= cutoff)) return false;
    return isTerminalDelegationStatus(row?.status);
  });

  // Ratings share the observed window. They are grouped by the exact stats key
  // (harness, base model, role) and only read back for keys the terminal jobs
  // above created, so an orphan rating can never invent a stats row with n = 0.
  /** @type {Map<string, object[]>} */
  const ratingsByKey = new Map();
  for (const rating of Array.isArray(input.ratings) ? input.ratings : []) {
    const ts = parseTime(rating?.ts);
    if (!(ts > 0 && ts >= cutoff)) continue;
    const harness = String(rating?.harness || '').trim().toLowerCase();
    const model = String(rating?.model || '').trim().toLowerCase();
    const role = String(rating?.role || '').trim().toLowerCase();
    if (!harness || !model || !role) continue;
    const key = `${role}:${harness}/${model}`;
    const bucket = ratingsByKey.get(key);
    if (bucket) bucket.push(rating);
    else ratingsByKey.set(key, [rating]);
  }

  /** @type {Record<'plan' | 'implement' | 'review', Map<string, object>>} */
  const stats = { plan: new Map(), implement: new Map(), review: new Map() };
  /**
   * @param {'plan' | 'implement' | 'review'} role
   * @param {string} harness
   * @param {string} model
   * @returns {object}
   */
  const statFor = (role, harness, model) => {
    const key = `${harness}/${model}`;
    const map = stats[role];
    let stat = map.get(key);
    if (!stat) {
      stat = {
        harness,
        model,
        role,
        n: 0,
        infra_fails: 0,
        non_infra_jobs: 0,
        completed_with_report: 0,
        passed_cycles: 0,
        decided_cycles: 0,
        pass_verdicts: 0,
        fail_verdicts: 0,
        blocked_verdicts: 0,
        justified_fails: 0,
        decided_reviews: 0,
        durations: [],
        tokensPerSec: [],
        toolCalls: [],
        filesChanged: [],
        last_at: 0,
      };
      map.set(key, stat);
    }
    return stat;
  };

  for (const row of inWindow) {
    const role = delegationPersistedRole(row);
    if (!role) continue;
    const { harness } = rowExecutor(row);
    const model = baseModelOfRow(row);
    if (!harness || !model) continue;
    const stat = statFor(role, harness, model);
    stat.n += 1;
    stat.last_at = Math.max(stat.last_at, parseTime(row?.createdAt || row?.startedAt));
    const infra = isInfraDelegationOutcome(row, role);
    if (infra) stat.infra_fails += 1;
    else {
      stat.non_infra_jobs += 1;
      if (String(row?.report || '').trim()) stat.completed_with_report += 1;
    }
    if (String(row?.status || '').trim().toLowerCase() === 'completed') {
      const start = parseTime(row?.startedAt);
      const end = parseTime(row?.finishedAt);
      if (start > 0 && end >= start) stat.durations.push((end - start) / 60000);
    }
    // Per-run efficiency metrics (task "Metryki per delegacja"). Each field is
    // nullable, so a run without a metric simply adds nothing to the sample.
    // `tokens_out_per_sec` is collected for every role (a plan/review still
    // streams output tokens); tool calls and file churn only make sense for the
    // execute role, which is the only one that writes them.
    const metrics = row?.metrics && typeof row.metrics === 'object' ? row.metrics : null;
    if (metrics) {
      const tsp = Number(metrics.tokens_out_per_sec);
      if (Number.isFinite(tsp) && tsp >= 0) stat.tokensPerSec.push(tsp);
      if (role === 'implement') {
        const toolCalls = Number(metrics.tool_calls_n);
        if (Number.isFinite(toolCalls) && toolCalls >= 0) stat.toolCalls.push(toolCalls);
        const filesChanged = Number(metrics.files_changed);
        if (Number.isFinite(filesChanged) && filesChanged >= 0) stat.filesChanged.push(filesChanged);
      }
    }
  }

  // Implement pass_rate and review usefulness are chat-scoped: an implement is
  // judged by the review cycle that follows it in the same parent chat.
  /** @type {Map<string, object[]>} */
  const chatRows = new Map();
  for (const row of inWindow) {
    const role = delegationPersistedRole(row);
    if (role !== 'implement' && role !== 'review') continue;
    const chat = String(row?.parentChatId || '').trim();
    if (!chat) continue;
    const { harness } = rowExecutor(row);
    const model = baseModelOfRow(row);
    if (!harness || !model) continue;
    if (!chatRows.has(chat)) chatRows.set(chat, []);
    chatRows.get(chat).push(row);
  }
  for (const rowsInChat of chatRows.values()) {
    const events = rowsInChat.map((row) => {
      const role = delegationPersistedRole(row);
      const { harness } = rowExecutor(row);
      return {
        at: parseTime(row?.createdAt || row?.startedAt),
        kind: role === 'implement' ? 0 : 1,
        harness,
        model: baseModelOfRow(row),
        report: String(row?.report || ''),
        infra: isInfraDelegationOutcome(row, role),
      };
    }).sort((left, right) => (left.at - right.at) || (left.kind - right.kind));

    let openImplement = null;
    /** @type {string[]} */
    let openReviews = [];
    const closeCycle = () => {
      if (!openImplement) return;
      if (openReviews.length > 0) {
        const stat = statFor('implement', openImplement.harness, openImplement.model);
        stat.decided_cycles += 1;
        if (openReviews.every((verdict) => verdict === 'PASS')) stat.passed_cycles += 1;
      }
      openImplement = null;
      openReviews = [];
    };
    for (const event of events) {
      if (event.kind === 0) {
        closeCycle();
        // An infra-failed implement cannot be judged by a review.
        openImplement = event.infra ? null : event;
        continue;
      }
      if (!openImplement || event.infra) continue;
      const verdict = parseDelegationVerdict(event.report);
      if (verdict === 'PASS' || verdict === 'FAIL' || verdict === 'BLOCKED') openReviews.push(verdict);
    }
    closeCycle();

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event.kind !== 1 || event.infra) continue;
      const verdict = parseDelegationVerdict(event.report);
      if (verdict !== 'PASS' && verdict !== 'FAIL' && verdict !== 'BLOCKED') continue;
      const stat = statFor('review', event.harness, event.model);
      stat.decided_reviews += 1;
      if (verdict === 'PASS') {
        stat.pass_verdicts += 1;
      } else if (verdict === 'BLOCKED') {
        stat.blocked_verdicts += 1;
      } else {
        stat.fail_verdicts += 1;
        if (reviewJustifiedByNextCycle(events, i)) stat.justified_fails += 1;
      }
    }
  }

  /** @type {Record<'plan' | 'implement' | 'review', Record<string, object>>} */
  const roles = { plan: {}, implement: {}, review: {} };
  /** @type {object[]} */
  const list = [];
  for (const role of /** @type {const} */ (['plan', 'implement', 'review'])) {
    for (const stat of stats[role].values()) {
      const durations = stat.durations.slice().sort((a, b) => a - b);
      const tokensPerSec = stat.tokensPerSec.slice().sort((a, b) => a - b);
      const toolCalls = stat.toolCalls.slice().sort((a, b) => a - b);
      const filesChanged = stat.filesChanged.slice().sort((a, b) => a - b);
      const infraFailRate = stat.n > 0 ? stat.infra_fails / stat.n : 0;
      const decided = role === 'implement'
        ? stat.decided_cycles
        : role === 'review'
          ? stat.decided_reviews
          : stat.non_infra_jobs;
      /** @type {number | null} */
      let rawRate = null;
      if (role === 'implement' && stat.decided_cycles > 0) {
        rawRate = stat.passed_cycles / stat.decided_cycles;
      } else if (role === 'review' && stat.decided_reviews > 0) {
        // Observed review quality is the share of verdicts that were productive:
        // a PASS (correct approval) or a FAIL confirmed by a fix + PASS.
        rawRate = (stat.pass_verdicts + stat.justified_fails) / stat.decided_reviews;
      } else if (role === 'plan' && stat.non_infra_jobs > 0) {
        rawRate = stat.completed_with_report / stat.non_infra_jobs;
      }
      const ratingSummary = summarizeDelegationRatings(
        ratingsByKey.get(`${role}:${stat.harness}/${stat.model}`) || [],
      );
      /** @type {object} */
      const row = {
        harness: stat.harness,
        model: stat.model,
        role,
        n: stat.n,
        infra_fails: stat.infra_fails,
        infra_fail_rate: round4(infraFailRate),
        decided,
        pass_rate: round4(rawRate),
        verdict_fail_rate: role === 'review' && stat.decided_reviews > 0
          ? round4(stat.fail_verdicts / stat.decided_reviews)
          : null,
        // Share of FAILs that were followed by a fix and a PASSing review.
        // `null` when the reviewer never FAILed (no signal either way).
        useful_rate: role === 'review' && stat.fail_verdicts > 0
          ? round4(stat.justified_fails / stat.fail_verdicts)
          : null,
        median_min: round2(percentile(durations, 0.5)),
        p95_min: round2(percentile(durations, 0.95)),
        // Per-run efficiency medians from delegation `metrics`. `null` when no
        // run in the window carried the signal. Exposed on `model_pick`
        // candidates for readout; ranking still uses heuristic tiers only
        // (unlike `pass_rate`, which feeds the observed quality blend).
        // Speed applies to every role; tool calls and file churn are implement
        // only, so the arrays stay empty (and the median null) for plan/review.
        median_tokens_per_sec: round2(percentile(tokensPerSec, 0.5)),
        median_tool_calls: role === 'implement' ? round2(percentile(toolCalls, 0.5)) : null,
        median_files_changed: role === 'implement' ? round2(percentile(filesChanged, 0.5)) : null,
        quality: rawRate == null ? null : round4(1 + (4 * Math.max(0, Math.min(1, rawRate)))),
        // Weighted star mean (user = 2, parent = 1) + raw record count.
        rating_avg: ratingSummary.rating_avg == null ? null : round2(ratingSummary.rating_avg),
        rating_n: ratingSummary.rating_n,
        last_used_at: stat.last_at > 0 ? new Date(stat.last_at).toISOString() : '',
      };
      roles[role][`${stat.harness}/${stat.model}`] = row;
      list.push(row);
    }
  }
  list.sort((left, right) => (right.n - left.n)
    || left.role.localeCompare(right.role)
    || left.harness.localeCompare(right.harness)
    || left.model.localeCompare(right.model));
  return {
    window_ms: windowMs,
    generated_at: new Date(at).toISOString(),
    // The blend is continuous (w = n/(n+halfLife)); one job already contributes,
    // so the minimum job count for any observed influence is 1.
    min_jobs: 1,
    roles,
    list,
  };
}

/**
 * Role-level prior for infra shrinkage: the job-weighted mean of
 * `infra_fail_rate` over every (harness, base model) pair of the role with at
 * least one job in the window. `0` when the role has no data, so an empty role
 * simply keeps the observed rate unshrunk (and n=0 candidates stay unpenalised).
 *
 * @param {Record<string, object>} roleStats
 * @returns {number}
 */
export function rolePriorInfra(roleStats) {
  let weighted = 0;
  let total = 0;
  for (const row of Object.values(roleStats || {})) {
    const n = Number(/** @type {{ n?: unknown }} */ (row)?.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    const rate = Number(/** @type {{ infra_fail_rate?: unknown }} */ (row)?.infra_fail_rate);
    if (!Number.isFinite(rate)) continue;
    weighted += Math.max(0, Math.min(1, rate)) * n;
    total += n;
  }
  return total > 0 ? weighted / total : 0;
}

/**
 * Best-effort ratings read: a missing/corrupt file degrades to no ratings, so
 * the ranking keeps its current behavior instead of failing the tool call.
 *
 * @returns {object[]}
 */
function safeLoadDelegationRatings() {
  try {
    return loadDelegationRatings();
  } catch {
    return [];
  }
}

/**
 * Loader wrapper for `summarizeDelegationOutcomes`: the only I/O is the cached
 * `loadDelegations()` snapshot plus the ratings JSONL, so the summary stays
 * cheap to reuse (task 6 UI).
 *
 * When `rows` are injected without `ratings`, the ratings read is scoped to
 * the injected job ids — a caller that filters rows by workspace/widget must
 * not pick up stars from jobs it cannot see.
 *
 * @param {{ rows?: object[], ratings?: object[], now?: number, windowMs?: number }} [input]
 * @returns {ReturnType<typeof summarizeDelegationOutcomes>}
 */
export function buildDelegationOutcomes(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : safeLoadDelegations();
  let ratings = Array.isArray(input.ratings) ? input.ratings : safeLoadDelegationRatings();
  if (!Array.isArray(input.ratings) && Array.isArray(input.rows)) {
    const scoped = new Set(
      rows.map((row) => String(row?.id || '').trim()).filter(Boolean),
    );
    ratings = ratings.filter((rating) => scoped.has(String(rating?.delegationId || '').trim()));
  }
  return summarizeDelegationOutcomes({ rows, ratings, now: input.now, windowMs: input.windowMs });
}

/**
 * @param {{
 *   role?: string,
 *   chatId?: string,
 *   harnesses?: unknown[],
 *   delegations?: object[],
 *   extraUses?: { harness?: string, model?: string, createdAt?: string }[],
 *   ratings?: object[],
 *   lockouts?: object[],
 *   planLimits?: object[],
 *   now?: number,
 *   outcomes?: ReturnType<typeof summarizeDelegationOutcomes>,
 * }} [input]
 * @returns {{
 *   roleUsage7d: { harness: Record<string, number>, model: Record<string, number>, lastAt: Record<string, string> },
 *   chatUsage: { harnesses: Record<string, number>, models: Record<string, { count: number, lastAt: string, next_review_passed: boolean }> },
 *   coldStartHarnesses14d: string[],
 *   lockouts: object[],
 *   planLimits: object[],
 *   freshLimitHits: Record<string, { whole: boolean, models: string[] }>,
 *   excludeModels: string[],
 *   pickIndex: number,
 *   prior: { infra_fail_rate: number, role: string },
 *   observed: Record<string, object>,
 *   reviewTestObservations: Record<string, { positive: number, negative: number }>,
 * }}
 */
export function buildModelPickHistory(input = {}) {
  const role = String(input.role || '').trim().toLowerCase();
  const chatId = String(input.chatId || '').trim();
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const rows = Array.isArray(input.delegations) ? input.delegations : safeLoadDelegations();
  const roleRows = rows.filter((row) => rowMatchesRole(role, row));

  /** @type {Record<string, number>} */
  const harnessUses = {};
  /** @type {Record<string, number>} */
  const modelUses = {};
  /** @type {Record<string, string>} */
  const lastAt = {};
  let harnesses14d = new Set();
  const usageCutoff = now - ROLE_USAGE_WINDOW_MS;
  const coldCutoff = now - COLD_START_WINDOW_MS;
  let roleJobs7d = 0;
  // Non-delegation uses of the same role (e.g. Scout / watcher chats) count
  // toward the balance exactly like delegation jobs.
  const usageRows = [
    ...roleRows.map((row) => ({ at: parseTime(row?.createdAt || row?.startedAt), ...rowExecutor(row) })),
    ...(Array.isArray(input.extraUses) ? input.extraUses : []).map((use) => ({
      at: parseTime(use?.createdAt),
      harness: String(use?.harness || '').trim().toLowerCase(),
      model: String(use?.model || '').trim(),
    })),
  ];
  for (const { at, harness, model } of usageRows) {
    if (harness && at >= coldCutoff) harnesses14d.add(harness);
    if (at < usageCutoff) continue;
    roleJobs7d += 1;
    if (harness) {
      harnessUses[harness] = (harnessUses[harness] || 0) + 1;
      const harnessAt = at ? new Date(at).toISOString() : '';
      if (harnessAt && (!lastAt[harness] || harnessAt > lastAt[harness])) lastAt[harness] = harnessAt;
    }
    if (harness && model) {
      const key = `${harness}/${model}`;
      modelUses[key] = (modelUses[key] || 0) + 1;
      const modelAt = at ? new Date(at).toISOString() : '';
      if (modelAt && (!lastAt[key] || modelAt > lastAt[key])) lastAt[key] = modelAt;
    }
  }

  const chatRows = chatId
    ? rows.filter((row) => String(row?.parentChatId || '') === chatId)
    : [];
  const chatRoleRows = chatRows.filter((row) => rowMatchesRole(role, row));
  const nextPassed = nextReviewPassedModels(chatRows, role);
  /** @type {Record<string, number>} */
  const chatHarnesses = {};
  /** @type {Record<string, { count: number, lastAt: string, next_review_passed: boolean }>} */
  const chatModels = {};
  for (const row of chatRoleRows) {
    const { harness, model } = rowExecutor(row);
    if (harness) chatHarnesses[harness] = (chatHarnesses[harness] || 0) + 1;
    if (!harness || !model) continue;
    const key = `${harness}/${model}`;
    const current = chatModels[key] || { count: 0, lastAt: '', next_review_passed: false };
    const at = parseTime(row?.createdAt || row?.startedAt);
    const atIso = at ? new Date(at).toISOString() : '';
    chatModels[key] = {
      count: current.count + 1,
      lastAt: atIso && atIso > current.lastAt ? atIso : current.lastAt,
      next_review_passed: current.next_review_passed || nextPassed.has(key),
    };
  }

  /** @type {string[]} */
  const catalogHarnesses = (Array.isArray(input.harnesses) ? input.harnesses : [])
    .map((row) => String(typeof row === 'string' ? row : row?.id || '').trim().toLowerCase())
    .filter(Boolean);
  const coldStartHarnesses14d = catalogHarnesses.filter((id) => !harnesses14d.has(id));

  // Review keeps the old "reviewer != last implementer / last reviewer" rule,
  // scoped with the same role distinction as elsewhere: a plan-mode `review`
  // (a planner) is not a reviewer, so it must not widen the exclusion set.
  let excludeModels = [];
  if (role === 'review') {
    const ordered = [...chatRows].sort(
      (left, right) => parseTime(left?.createdAt || left?.startedAt) - parseTime(right?.createdAt || right?.startedAt),
    );
    const lastOfRole = (wantedRole) => {
      for (let i = ordered.length - 1; i >= 0; i -= 1) {
        const row = ordered[i];
        if (!rowMatchesRole(wantedRole, row)) continue;
        const { model } = rowExecutor(row);
        if (model) return model;
      }
      return '';
    };
    excludeModels = [...new Set([lastOfRole('implement'), lastOfRole('review')].filter(Boolean))];
  }

  // Observed outcomes are per (harness, base model, role). `fix` shares the
  // persisted `implement` assignment, so it reads the implement stats.
  const outcomes = input.outcomes && typeof input.outcomes === 'object'
    ? input.outcomes
    : buildDelegationOutcomes({ rows, ratings: input.ratings, now });
  const observedRole = role === 'fix' ? 'implement' : role;
  const observed = outcomes.roles && outcomes.roles[observedRole] ? outcomes.roles[observedRole] : {};
  // Role-level prior used by the score shrinkage in `applyObservedOutcome`.
  // Job-weighted so a pair with many jobs anchors the prior more than a pair
  // with one, and computed from the same 30d window as `observed`.
  const priorInfra = round4(rolePriorInfra(observed));

  return {
    roleUsage7d: { harness: harnessUses, model: modelUses, lastAt },
    chatUsage: { harnesses: chatHarnesses, models: chatModels },
    coldStartHarnesses14d,
    lockouts: Array.isArray(input.lockouts) ? input.lockouts : safeListLockouts(),
    planLimits: Array.isArray(input.planLimits) ? input.planLimits : safeReadPlanLimits(),
    freshLimitHits: safeFreshLimitHits(now),
    excludeModels,
    // Cold-start explore fires on every Nth role job across all chats, not the
    // count in this chat (a new chat must not always explore, and a missing
    // chat_id must not force it). Deterministic for the same store snapshot.
    pickIndex: roleJobs7d,
    prior: { infra_fail_rate: priorInfra == null ? 0 : priorInfra, role: observedRole },
    observed,
    reviewTestObservations: summarizeReviewTestObservations(rows, { now }),
  };
}
