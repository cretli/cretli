/**
 * Triage queue configuration and stored-format normalizers. Dependency-free so
 * the watcher persistence layer can import it without an import cycle.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Stored format version of `triageQueue`; bump together with a read-time migration. */
export const TRIAGE_QUEUE_VERSION = 1;
/** Hard cap on stored entries so a runaway tree cannot bloat the watcher row. */
export const TRIAGE_QUEUE_MAX_ENTRIES = 500;
/** Max worktree records probed with Git per refresh. */
export const TRIAGE_MAX_BASE_PROBES = 20;

export const TRIAGE_SIGNALS = Object.freeze([
  'stale_doing_tree',
  'tree_done_unintegrated',
  'leaf_done_unconfirmed',
  'worktree_base_behind',
  'worktree_patch_conflict',
  'plan_draft_unreviewed',
  'plan_review_unapproved',
  'leaf_needs_human',
  'leaf_needs_rescope',
  'integration_ready_idle',
]);

/** Default thresholds (ms, except `baseBehindCommits`). A signal fires strictly above its threshold. */
export const DEFAULT_TRIAGE_THRESHOLDS = Object.freeze({
  staleDoingTreeMs: 7 * DAY_MS,
  doneUnintegratedMs: 48 * HOUR_MS,
  baseBehindCommits: 20,
  planUnreviewedMs: 24 * HOUR_MS,
  planUnapprovedMs: 12 * HOUR_MS,
  needsHumanMs: 24 * HOUR_MS,
  integrationReadyMs: 24 * HOUR_MS,
});

/** @param {unknown} v */
const text = (v) => String(v ?? '').trim();

/** @param {unknown} value @param {number} fallback */
function nonNegative(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * @param {unknown} raw `policy.triage`
 * @returns {Record<string, number>}
 */
export function normalizeTriageThresholds(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_TRIAGE_THRESHOLDS)) out[key] = nonNegative(source[key], fallback);
  return out;
}

/**
 * @typedef {{ key: string, todoId: string, signal: string, revision: string, since: string, firstSeenAt: string, evidence: Record<string, any> }} TriageEntry
 */

/**
 * Tolerant read of the stored queue (missing / foreign version → empty).
 * @param {unknown} raw
 * @returns {{ v: number, entries: TriageEntry[], updatedAt: string }}
 */
export function normalizeTriageQueue(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const entries = [];
  const seen = new Set();
  for (const e of source.v === TRIAGE_QUEUE_VERSION && Array.isArray(source.entries) ? source.entries : []) {
    if (!e || typeof e !== 'object') continue;
    const todoId = text(e.todoId);
    const signal = text(e.signal);
    const revision = text(e.revision);
    if (!todoId || !TRIAGE_SIGNALS.includes(signal)) continue;
    const key = `${todoId}|${signal}|${revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      key, todoId, signal, revision, since: text(e.since), firstSeenAt: text(e.firstSeenAt),
      evidence: e.evidence && typeof e.evidence === 'object' && !Array.isArray(e.evidence) ? e.evidence : {},
    });
    if (entries.length >= TRIAGE_QUEUE_MAX_ENTRIES) break;
  }
  return { v: TRIAGE_QUEUE_VERSION, entries, updatedAt: text(source.updatedAt) };
}

