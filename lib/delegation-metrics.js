/**
 * Per-delegation run metrics (task "Metryki per delegacja").
 *
 * Every metric is nullable: absent data is a normal outcome, never an error.
 * The shapes here are the single source of truth for the `metrics` object
 * stored on a delegation record and read back by the observed aggregation in
 * `lib/model-pick-history.js`.
 *
 * Pure helpers (normalize/build/diff) take their inputs injected and touch no
 * I/O, so they are unit-testable in isolation. The git snapshot that shells
 * out lives in `delegation-metrics-git.js`: this module is imported by the
 * browser bundle through `delegation-attempt.js`, so it must not pull
 * `node:child_process`.
 */

/** The exact key set of a metrics record, in storage order. */
export const DELEGATION_METRICS_FIELDS = Object.freeze([
  'tokens_in',
  'tokens_out',
  'tokens_out_per_sec',
  'tool_calls_n',
  'files_changed',
  'lines_added',
  'lines_removed',
]);

/**
 * Optional extension keys. They are absent from `emptyMetrics()` (legacy rows
 * and the seven-key shape stay byte-identical) and only appear when the usage
 * ledger measured them, so `null` always means "not measured", never zero.
 *
 * - `cache_read_tokens` / `cache_write_tokens`: prompt-cache traffic, kept apart
 *   from the ordinary `tokens_in` / `tokens_out`.
 * - `reported_usd`: provider-reported cost; `estimated_usd`: rate-table estimate.
 *   Under `billing_mode: 'subscription'` the estimate is dropped on purpose: an
 *   equivalent price is not a charge.
 * - `billing_mode`: `subscription` | `metered`; `usage_coverage`:
 *   `none` | `partial` | `complete`.
 */
export const DELEGATION_METRICS_OPTIONAL_FIELDS = Object.freeze([
  'cache_read_tokens',
  'cache_write_tokens',
  'reported_usd',
  'estimated_usd',
  'billing_mode',
  'usage_coverage',
]);

const OPTIONAL_COUNT_FIELDS = ['cache_read_tokens', 'cache_write_tokens'];
const OPTIONAL_USD_FIELDS = ['reported_usd', 'estimated_usd'];
const BILLING_MODES = new Set(['subscription', 'metered']);
const USAGE_COVERAGES = new Set(['none', 'partial', 'complete']);

/**
 * Keys whose source of truth is the usage ledger. The ledger is deduplicated
 * and recomputed from absolute events, so a later read replaces the earlier
 * value instead of adding to it (idempotent under replay).
 */
const LEDGER_OWNED_FIELDS = Object.freeze([
  'tokens_in',
  'tokens_out',
  ...OPTIONAL_COUNT_FIELDS,
  ...OPTIONAL_USD_FIELDS,
  'billing_mode',
  'usage_coverage',
]);

/** Assignments that edit files and therefore carry git-diff metrics. */
const EXECUTE_ASSIGNMENTS = new Set(['implement', 'fix']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isExecuteAssignment(value) {
  return EXECUTE_ASSIGNMENTS.has(String(value || '').trim().toLowerCase());
}

/**
 * Coerce to a non-negative integer, or `null` when absent/invalid.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function asCount(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

/**
 * Coerce to a non-negative rate rounded to 4 decimals, or `null`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function asRate(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 10000) / 10000;
}

/**
 * Coerce to a non-negative USD amount rounded to 6 decimals, or `null`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function asUsd(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * 1e6) / 1e6;
}

/**
 * A metrics object with every field present and `null`.
 *
 * @returns {Record<string, number | null>}
 */
export function emptyMetrics() {
  return {
    tokens_in: null,
    tokens_out: null,
    tokens_out_per_sec: null,
    tool_calls_n: null,
    files_changed: null,
    lines_added: null,
    lines_removed: null,
  };
}

/**
 * Validate/normalize any input into exactly the seven metric keys. Unknown
 * fields are dropped; non-numeric or negative values collapse to `null` so a
 * corrupt stored value can never poison the aggregation.
 *
 * @param {unknown} value
 * @returns {Record<string, number | string | null>}
 */
export function normalizeMetrics(value) {
  const out = emptyMetrics();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const rec = /** @type {Record<string, unknown>} */ (value);
  out.tokens_in = asCount(rec.tokens_in);
  out.tokens_out = asCount(rec.tokens_out);
  out.tokens_out_per_sec = asRate(rec.tokens_out_per_sec);
  out.tool_calls_n = asCount(rec.tool_calls_n);
  out.files_changed = asCount(rec.files_changed);
  out.lines_added = asCount(rec.lines_added);
  out.lines_removed = asCount(rec.lines_removed);
  for (const field of OPTIONAL_COUNT_FIELDS) {
    const count = asCount(rec[field]);
    if (count != null) out[field] = count;
  }
  for (const field of OPTIONAL_USD_FIELDS) {
    const usd = asUsd(rec[field]);
    if (usd != null) out[field] = usd;
  }
  const billingMode = String(rec.billing_mode ?? '').trim().toLowerCase();
  if (BILLING_MODES.has(billingMode)) out.billing_mode = billingMode;
  const coverage = String(rec.usage_coverage ?? '').trim().toLowerCase();
  if (USAGE_COVERAGES.has(coverage)) out.usage_coverage = coverage;
  return out;
}

/**
 * A patch that clears every metric, optional ones included. The record patch
 * merges shallowly, so a retry must name the optional keys explicitly to wipe
 * the previous attempt's values.
 *
 * @returns {Record<string, number | string | null>}
 */
export function resetMetricsPatch() {
  const patch = emptyMetrics();
  for (const field of DELEGATION_METRICS_OPTIONAL_FIELDS) patch[field] = null;
  return patch;
}

/**
 * Merge metrics that arrived after the attempt was closed. Ledger-owned keys
 * take the incoming value when it is known (recomputed absolutely, so replay is
 * a no-op); every other key only fills a `null`. Unknown incoming values never
 * erase known ones. Pure and idempotent: `merge(merge(a, b), b)` equals
 * `merge(a, b)`.
 *
 * @param {unknown} existing
 * @param {unknown} incoming
 * @returns {Record<string, number | string | null>}
 */
export function mergeLateMetrics(existing, incoming) {
  const base = normalizeMetrics(existing);
  const next = normalizeMetrics(incoming);
  const merged = { ...base };
  const keys = new Set([...DELEGATION_METRICS_FIELDS, ...DELEGATION_METRICS_OPTIONAL_FIELDS]);
  for (const key of keys) {
    const incomingValue = next[key] ?? null;
    if (incomingValue == null) continue;
    if (LEDGER_OWNED_FIELDS.includes(key) || base[key] == null) merged[key] = incomingValue;
  }
  return merged;
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function areMetricsEqual(left, right) {
  return JSON.stringify(normalizeMetrics(left)) === JSON.stringify(normalizeMetrics(right));
}

/**
 * Compact DTO view: only the keys that carry a value, or `null` when the
 * attempt has no metric signal at all.
 *
 * @param {unknown} metrics
 * @returns {Record<string, number | string> | null}
 */
export function compactMetrics(metrics) {
  const normalized = normalizeMetrics(metrics);
  const out = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (key === 'usage_coverage' && value === 'none') continue;
    if (value != null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * True when every field is null — i.e. the run produced no metric signal at
 * all. Callers may store this to keep a uniform shape without implying data.
 *
 * @param {Record<string, number | null>} metrics
 * @returns {boolean}
 */
export function isMetricsEmpty(metrics) {
  const normalized = normalizeMetrics(metrics);
  // Coverage `none` states that nothing was measured; it is not a signal.
  return [...DELEGATION_METRICS_FIELDS, ...DELEGATION_METRICS_OPTIONAL_FIELDS]
    .every((field) => normalized[field] == null
      || (field === 'usage_coverage' && normalized[field] === 'none'));
}

/**
 * Assemble one run's metrics from already-extracted primitives. This keeps the
 * derived `tokens_out_per_sec` (output tokens over the run wall-clock) in one
 * place. Any missing primitive stays `null`; a zero/absent duration suppresses
 * the rate rather than dividing by zero.
 *
 * @param {{
 *   tokensIn?: number | null,
 *   tokensOut?: number | null,
 *   toolCalls?: number | null,
 *   filesChanged?: number | null,
 *   linesAdded?: number | null,
 *   linesRemoved?: number | null,
 *   startedAtMs?: number | null,
 *   finishedAtMs?: number | null,
 *   extras?: Record<string, unknown> | null,
 * }} [input]
 * @returns {Record<string, number | string | null>}
 */
export function buildRunMetrics(input = {}) {
  const metrics = emptyMetrics();
  metrics.tokens_in = asCount(input.tokensIn);
  metrics.tokens_out = asCount(input.tokensOut);
  metrics.tool_calls_n = asCount(input.toolCalls);
  metrics.files_changed = asCount(input.filesChanged);
  metrics.lines_added = asCount(input.linesAdded);
  metrics.lines_removed = asCount(input.linesRemoved);
  const start = Number(input.startedAtMs);
  const end = Number(input.finishedAtMs);
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    const durationSec = (end - start) / 1000;
    if (durationSec > 0 && metrics.tokens_out != null) {
      metrics.tokens_out_per_sec = asRate(metrics.tokens_out / durationSec);
    }
  }
  // Optional ledger-owned keys pass through the same validator as storage.
  if (input.extras && typeof input.extras === 'object') {
    const extras = normalizeMetrics(input.extras);
    // Nothing measured: do not attach optional keys that would only say so.
    if (!isMetricsEmpty(extras)) {
      for (const field of DELEGATION_METRICS_OPTIONAL_FIELDS) {
        if (extras[field] != null) metrics[field] = extras[field];
      }
    }
  }
  return metrics;
}

/**
 * Parse `git diff --numstat` output into a path -> { added, removed } map.
 * A binary file reports `-` for both counts; it is kept with `null` counts so
 * the caller still sees the path changed.
 *
 * @param {string} output
 * @returns {Record<string, { added: number | null, removed: number | null }>}
 */
export function parseNumstat(output) {
  /** @type {Record<string, { added: number | null, removed: number | null }>} */
  const files = {};
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // "<added>\t<removed>\t<path>"; the path may contain spaces, so split on
    // the first two tabs only.
    const firstTab = line.indexOf('\t');
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const addedRaw = line.slice(0, firstTab).trim();
    const removedRaw = line.slice(firstTab + 1, secondTab).trim();
    let filePath = line.slice(secondTab + 1).trim();
    // Renames report `old => new` (or `{a => b}/path`); key on the whole raw
    // path so a rename shows as changed without trying to reconstruct it.
    if (!filePath) continue;
    files[filePath] = {
      added: addedRaw === '-' ? null : asCount(addedRaw),
      removed: removedRaw === '-' ? null : asCount(removedRaw),
    };
  }
  return files;
}

/**
 * Count only the changes the run introduced: for each tracked path, the delta
 * between the head and base numstat (so pre-existing dirty edits are excluded);
 * for untracked paths, only files that newly appear or disappear. Returns
 * `null` when either snapshot is missing (non-repo, restart lost the baseline).
 *
 * @param {{ files: Record<string, { added: number | null, removed: number | null }>, untracked: string[] } | null} base
 * @param {{ files: Record<string, { added: number | null, removed: number | null }>, untracked: string[] } | null} head
 * @returns {{ files_changed: number, lines_added: number, lines_removed: number } | null}
 */
export function diffGitSnapshots(base, head) {
  if (!base || !head || !base.files || !head.files) return null;
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  const paths = new Set([...Object.keys(base.files), ...Object.keys(head.files)]);
  for (const path of paths) {
    const before = base.files[path] || { added: 0, removed: 0 };
    const after = head.files[path] || { added: 0, removed: 0 };
    const addedDelta = (after.added ?? 0) - (before.added ?? 0);
    const removedDelta = (after.removed ?? 0) - (before.removed ?? 0);
    if (addedDelta !== 0 || removedDelta !== 0) {
      filesChanged += 1;
      if (addedDelta > 0) linesAdded += addedDelta;
      if (removedDelta > 0) linesRemoved += removedDelta;
    }
  }

  const baseUntracked = new Set(base.untracked || []);
  const headUntracked = new Set(head.untracked || []);
  for (const path of headUntracked) {
    if (!baseUntracked.has(path)) filesChanged += 1;
  }
  for (const path of baseUntracked) {
    if (!headUntracked.has(path)) filesChanged += 1;
  }

  return {
    files_changed: filesChanged,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  };
}
