/**
 * Per-delegation run metrics (task "Metryki per delegacja").
 *
 * Every metric is nullable: absent data is a normal outcome, never an error.
 * The shapes here are the single source of truth for the `metrics` object
 * stored on a delegation record and read back by the observed aggregation in
 * `lib/model-pick-history.js`.
 *
 * Pure helpers (normalize/build/diff) take their inputs injected and touch no
 * I/O, so they are unit-testable in isolation. `captureGitSnapshot` is the one
 * function that shells out to git; it degrades to `null` on any failure (not a
 * repo, no HEAD, git missing) so a caller can store "no data" instead of a
 * wrong zero.
 */

import { execFileSync } from 'node:child_process';

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
 * @returns {Record<string, number | null>}
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
  return out;
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
  return DELEGATION_METRICS_FIELDS.every((field) => normalized[field] == null);
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
 * }} [input]
 * @returns {Record<string, number | null>}
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
 * Snapshot the working tree so a later diff can attribute exactly this run's
 * edits, ignoring the other people's changes already sitting in the shared
 * tree. Returns `null` when git is unavailable or the folder is not a repo.
 *
 * @param {string} cwd
 * @returns {{ files: Record<string, { added: number | null, removed: number | null }>, untracked: string[] } | null}
 */
export function captureGitSnapshot(cwd) {
  const folder = String(cwd || '').trim();
  if (!folder) return null;
  try {
    const inside = execFileSync('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside !== 'true') return null;
    // `--numstat` against HEAD captures every tracked change (staged + unstaged)
    // relative to the last commit, which is the shared baseline the run edits on.
    const numstat = execFileSync('git', ['-C', folder, 'diff', 'HEAD', '--no-renames', '--numstat'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untrackedOut = execFileSync('git', ['-C', folder, 'ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untracked = String(untrackedOut || '')
      .split('\n')
      .map((row) => row.trim())
      .filter(Boolean);
    return { files: parseNumstat(numstat), untracked };
  } catch {
    return null;
  }
}

/**
 * Count only the changes the run introduced: for each tracked path, the delta
 * between the head and base numstat (so pre-existing dirty edits are excluded);
 * for untracked paths, only files that newly appear or disappear. Returns
 * `null` when either snapshot is missing (non-repo, restart lost the baseline).
 *
 * @param {ReturnType<typeof captureGitSnapshot>} base
 * @param {ReturnType<typeof captureGitSnapshot>} head
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
