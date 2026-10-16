/**
 * Deterministic (no LLM) distillation of candidate review lessons from the
 * findings ledger.
 *
 * Findings recurring across distinct leaves are bucketed by category + path
 * prefix:
 * - outcome `fixed` -> implementer `avoid` candidates;
 * - outcome `rejected` with reason `false_positive` -> reviewer `suppress`
 *   candidates. `out_of_scope`, `wont_fix`, `duplicate`, security findings and
 *   P1 findings never feed `suppress`.
 * Output is always a `candidate` written through the lesson service; promotion
 * stays human. Replays are harmless: a bucket already covered by a live lesson
 * is skipped and the store de-duplicates identical text.
 */

import { listReviewFindingsLedgerItems } from './persist/review-findings-ledger-persist.js';
import { containsPrivateData, redactPrivatePaths, scrubFindingFile } from './review-lessons-privacy.js';
import { listLessons, addLesson } from './review-lessons-service.js';
import { subscribeReviewRoundResolved } from './review-round-resolution.js';

export const DISTILL_DEFAULTS = Object.freeze({ minFindings: 3, minLeaves: 2, windowDays: 90 });

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 300;
const MAX_SUMMARY_IN_TEXT = 120;
const PREFIX_SEGMENTS = 2;
const PRIORITY_RANK = { P1: 0, P2: 1, P3: 2 };

/** @param {unknown} value @param {number} fallback @returns {number} */
function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {Record<string, unknown>} [raw]
 * @returns {{ minFindings: number, minLeaves: number, windowDays: number }}
 */
export function resolveDistillOptions(raw = {}) {
  return {
    minFindings: positiveNumber(raw?.minFindings, DISTILL_DEFAULTS.minFindings),
    minLeaves: positiveNumber(raw?.minLeaves, DISTILL_DEFAULTS.minLeaves),
    windowDays: positiveNumber(raw?.windowDays, DISTILL_DEFAULTS.windowDays),
  };
}

/** Repo-relative finding file, or '' (kept as a named export for existing callers and tests). */
export const normalizeFindingFile = scrubFindingFile;

/**
 * Most common leading directory (up to two segments) of an entry's files.
 *
 * @param {object} entry
 * @returns {string} '' when the entry names no usable file
 */
function entryPrefix(entry) {
  const counts = new Map();
  for (const file of Array.isArray(entry.files) ? entry.files : []) {
    const parts = normalizeFindingFile(file).split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const prefix = parts.slice(0, Math.min(PREFIX_SEGMENTS, parts.length - 1)).join('/');
    counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return ranked[0]?.[0] || '';
}

/** @param {object} entry @returns {number} 0.5 for low-confidence / backfilled, else 1 */
function entryWeight(entry) {
  return entry.confidence === 'low' || entry.source === 'backfill' ? 0.5 : 1;
}

/** @param {object} bucket @returns {string} candidate text; summaries are already redacted, this is a last guard */
function buildSafeText(bucket) {
  const text = buildText(bucket, true);
  return containsPrivateData(text) ? buildText(bucket, false) : text;
}

/**
 * @param {object} item ledger item
 * @param {object} entry
 * @returns {number} ms timestamp of the recording delegation (item update as fallback)
 */
function entryTimeMs(item, entry) {
  const recorded = item.delegations?.[entry.origin?.delegationId]?.recordedAt;
  const at = Date.parse(String(recorded || item.updatedAt || ''));
  return Number.isFinite(at) ? at : 0;
}

/**
 * @param {object} entry
 * @returns {'avoid'|'suppress'|''} the lesson kind the entry may feed
 */
function entryKind(entry) {
  if (entry.outcome === 'fixed') return 'avoid';
  const eligible = entry.outcome === 'rejected'
    && entry.rejection?.reason === 'false_positive'
    && entry.category !== 'security'
    && entry.priority !== 'P1';
  return eligible ? 'suppress' : '';
}

/**
 * Group eligible ledger entries into candidate buckets (pure).
 *
 * @param {object[]} items
 * @param {{ minFindings: number, minLeaves: number, windowDays: number }} options
 * @param {number} nowMs
 * @returns {object[]} buckets that reach the threshold
 */
export function bucketLedgerFindings(items, options, nowMs) {
  const cutoff = nowMs - options.windowDays * DAY_MS;
  const buckets = new Map();
  for (const item of items) {
    for (const entry of Array.isArray(item.entries) ? item.entries : []) {
      const kind = entryKind(entry);
      if (!kind || entryTimeMs(item, entry) < cutoff) continue;
      const prefix = entryPrefix(entry);
      const key = `${kind}|${entry.category}|${prefix}`;
      const bucket = buckets.get(key) || { kind, category: entry.category, prefix, weight: 0, leaves: new Set(), entries: [] };
      bucket.weight += entryWeight(entry);
      bucket.leaves.add(item.leafId);
      bucket.entries.push({ leafId: item.leafId, entry });
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()]
    .filter((b) => b.weight >= options.minFindings && b.leaves.size >= options.minLeaves)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.category.localeCompare(b.category) || a.prefix.localeCompare(b.prefix));
}

/**
 * @param {object} lesson
 * @param {object} bucket
 * @returns {boolean} an active/candidate lesson already addresses the bucket
 */
function isCovered(lesson, bucket) {
  if (lesson.status === 'retired' || lesson.category !== bucket.category || lesson.kind !== bucket.kind) return false;
  const globs = Array.isArray(lesson.pathGlobs) ? lesson.pathGlobs : [];
  if (!globs.length || !bucket.prefix) return true;
  return globs.some((glob) => {
    const stem = String(glob).replace(/\*.*$/, '').replace(/\/+$/, '');
    return !stem || bucket.prefix === stem || bucket.prefix.startsWith(`${stem}/`) || stem.startsWith(`${bucket.prefix}/`);
  });
}

/** @param {string} value @returns {string} */
const normalizeText = (value) => String(value).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * @param {object[]} existing
 * @param {object} bucket
 * @returns {boolean} a human already retired a lesson with the text this bucket would produce
 */
function hasRetiredTwin(existing, bucket) {
  const texts = [buildText(bucket, true), buildText(bucket, false)].map(normalizeText);
  return existing.some((lesson) => lesson.status === 'retired' && lesson.category === bucket.category
    && texts.includes(normalizeText(lesson.text)));
}

/** @param {object} bucket @returns {object} the representative finding (highest priority, then key) */
function representative(bucket) {
  return [...bucket.entries]
    .sort((a, b) => (PRIORITY_RANK[a.entry.priority] ?? 3) - (PRIORITY_RANK[b.entry.priority] ?? 3)
      || String(a.entry.key).localeCompare(String(b.entry.key)))[0].entry;
}

/**
 * @param {object} bucket
 * @param {boolean} withSummary
 * @returns {string} one-line template text; the human edits it on approval
 */
function buildText(bucket, withSummary) {
  const where = bucket.prefix ? ` in ${bucket.prefix}/` : '';
  const label = bucket.category.replace(/-/g, ' ');
  const lead = bucket.kind === 'suppress'
    ? `Do not raise recurring ${label} findings${where}; they were rejected as false positives`
    : `Avoid recurring ${label} findings${where}`;
  // Redact before truncating so a cut can never leave half a private path behind.
  const summary = redactPrivatePaths(String(representative(bucket).summary || '').replace(/\s+/g, ' ').trim())
    .slice(0, MAX_SUMMARY_IN_TEXT);
  const text = withSummary && summary ? `${lead} (e.g. ${summary}).` : `${lead}.`;
  return text.slice(0, MAX_TEXT);
}

/**
 * @param {string} workspaceFolder
 * @param {object} bucket
 * @param {{ dataDir?: string }} storeOptions
 * @returns {object} the stored lesson
 */
function writeCandidate(workspaceFolder, bucket, storeOptions) {
  const base = {
    audience: bucket.kind === 'suppress' ? 'reviewer' : 'implementer',
    kind: bucket.kind,
    category: bucket.category,
    pathGlobs: bucket.prefix ? [`${bucket.prefix}/**`] : [],
    origin: 'distilled',
    evidence: bucket.entries.map(({ leafId, entry }) => ({
      ledgerKey: entry.key, leafId, outcome: entry.outcome, actor: '',
    })),
  };
  return addLesson(workspaceFolder, { ...base, text: buildSafeText(bucket) }, storeOptions);
}

/**
 * Distil candidate lessons for one workspace.
 *
 * @param {string} workspaceFolder
 * @param {{ minFindings?: number, minLeaves?: number, windowDays?: number, dryRun?: boolean,
 *   now?: number, dataDir?: string }} [input]
 * @returns {{ candidates: object[], skipped: { category: string, kind: string, prefix: string, reason: string }[], dryRun: boolean }}
 */
export function distillReviewLessons(workspaceFolder, input = {}) {
  const options = resolveDistillOptions(input);
  const storeOptions = input.dataDir ? { dataDir: input.dataDir } : {};
  const nowMs = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const buckets = bucketLedgerFindings(listReviewFindingsLedgerItems(workspaceFolder), options, nowMs);
  const dryRun = input.dryRun === true;
  const candidates = [];
  const skipped = [];
  for (const bucket of buckets) {
    const existing = listLessons(workspaceFolder, storeOptions);
    const note = { category: bucket.category, kind: bucket.kind, prefix: bucket.prefix };
    if (existing.some((lesson) => isCovered(lesson, bucket))) {
      skipped.push({ ...note, reason: 'covered' });
      continue;
    }
    if (hasRetiredTwin(existing, bucket)) {
      skipped.push({ ...note, reason: 'retired' });
      continue;
    }
    if (dryRun) {
      candidates.push({ ...note, text: buildSafeText(bucket), findings: bucket.entries.length, leaves: bucket.leaves.size });
      continue;
    }
    try {
      const stored = writeCandidate(workspaceFolder, bucket, storeOptions);
      if (stored.status === 'retired') skipped.push({ ...note, reason: 'retired' });
      else candidates.push(stored);
    } catch (err) {
      skipped.push({ ...note, reason: `rejected: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { candidates, skipped, dryRun };
}

/** Distillations scheduled by the finish hooks that have not settled yet. */
const pending = new Set();

/**
 * Round-resolution listener: distil once per resolved PASS round. The work is
 * deferred to a microtask so the caller's synchronous follow-ups (rejected
 * findings applied right after the announcement) are already in the ledger.
 * Errors are logged, never thrown into the finish hook.
 *
 * @param {{ workspaceFolder?: string }} leaf
 * @param {{ verdict?: string }} round
 */
function onRoundResolved(leaf, round) {
  if (round?.verdict !== 'PASS') return;
  const workspaceFolder = String(leaf?.workspaceFolder || '').trim();
  if (!workspaceFolder) return;
  const task = Promise.resolve().then(() => {
    try {
      distillReviewLessons(workspaceFolder);
    } catch (err) {
      console.error('[review-lessons] distillation failed:', err instanceof Error ? err.message : err);
    }
  }).finally(() => pending.delete(task));
  pending.add(task);
}

/**
 * Idempotent: the listener is a stable reference, so repeated calls (and a
 * `resetReviewRoundResolutionState()` followed by a call) keep one subscription.
 *
 * @returns {() => void} unsubscribe
 */
export function installLessonDistillation() {
  return subscribeReviewRoundResolved(onRoundResolved);
}

/** @returns {Promise<void>} resolves once scheduled distillations have settled (tests, shutdown). */
export async function drainLessonDistillation() {
  while (pending.size) await Promise.all([...pending]);
}
