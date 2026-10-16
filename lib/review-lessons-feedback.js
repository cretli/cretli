/**
 * Lesson effectiveness feedback, driven by resolved review rounds.
 *
 * On every resolved code-review round of a leaf:
 * - each lesson injected into that leaf's implement/fix delegations (within the
 *   ledger cycle the round belongs to) gets `injected++` once per round, then
 *   `recurred++` when a finding of the round has the lesson's category and
 *   matching globs, else `cleanAfterInjection++`;
 * - an active `suppress` lesson injected into a reviewer of the leaf is demoted
 *   to `candidate` (`suppressed_real_issue`) when the pattern it suppresses was
 *   reported by another reviewer and ended `fixed`;
 * - retirement rules run on the same pass: a high recurrence ratio after enough
 *   injections demotes to `candidate` (`ineffective`), globs that match no file
 *   of the workspace retire (`stale_paths`), and a lesson with no evidence and
 *   no injection for a long time retires (`inactive`).
 *
 * Findings are attributed to the ledger cycle of their origin delegation, so a
 * late result still counts for the cycle it belongs to even after it closed.
 * All writes go through the lesson service in one idempotent transaction keyed
 * by the round, so replays never double count. Errors are logged, never thrown
 * into the finish hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getReviewFindingsLedger, deriveFindingOutcome } from './persist/review-findings-ledger-persist.js';
import { listDelegationsForController } from './persist/delegations-persist.js';
import { readDelegationWorkflowLeafIdFromRow } from './delegation-workflow-leaf.js';
import { createScoutGlobMatcher, normalizeScoutPath, scoutGlobMatchesPath } from './workspace-scout-glob.js';
import { applyLessonFeedback, listLessons } from './review-lessons-service.js';
import { subscribeReviewRoundResolved } from './review-round-resolution.js';

export const FEEDBACK_DEFAULTS = Object.freeze({ minInjections: 8, recurrenceRatio: 0.5, inactiveDays: 180 });
export const FEEDBACK_ENV = Object.freeze({
  minInjections: 'CRETLI_REVIEW_LESSONS_RETIRE_MIN_INJECTIONS',
  recurrenceRatio: 'CRETLI_REVIEW_LESSONS_RETIRE_RECURRENCE_RATIO',
  inactiveDays: 'CRETLI_REVIEW_LESSONS_RETIRE_INACTIVE_DAYS',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const WALK_MAX_FILES = 20000;
const WALK_SKIP = new Set(['.git', 'node_modules', 'data', 'dist', '.cretli-worktrees']);

/** @returns {{ minInjections: number, recurrenceRatio: number, inactiveDays: number }} */
export function resolveFeedbackOptions(raw = {}, env = process.env) {
  const pick = (key) => {
    const n = Number(raw?.[key] ?? env?.[FEEDBACK_ENV[key]]);
    return Number.isFinite(n) && n > 0 ? n : FEEDBACK_DEFAULTS[key];
  };
  return { minInjections: pick('minInjections'), recurrenceRatio: pick('recurrenceRatio'), inactiveDays: pick('inactiveDays') };
}

/**
 * True when a glob's first segment is a directory the walk skips at the
 * workspace root (`data/**`, `dist/**`, `.git/**`, ...). Such a glob cannot be
 * verified by this walk, so it must never drive a stale-path retirement.
 *
 * @param {string} glob
 * @returns {boolean}
 */
function globTargetsSkippedRoot(glob) {
  const pattern = normalizeScoutPath(glob);
  if (!pattern) return false;
  return WALK_SKIP.has(pattern.split('/')[0]);
}

/**
 * Bounded walk of workspace-relative file paths (stale-path rule only).
 *
 * Heavy directories (`WALK_SKIP`) are skipped at the workspace root only, so a
 * nested `src/data/` is still walked. Symlinks are never followed: a symlink
 * may hide a match or create a loop, so encountering one while globs are still
 * unmatched makes the listing incomplete. For the same reason an unreadable
 * directory makes the listing incomplete. A glob that targets a skipped root
 * directory is reported in `unverifiableGlobs` instead of being tested, because
 * the walk cannot prove it stale.
 *
 * The walk stops early once every verifiable glob in `globs` has matched a
 * file. A walk cut off by `maxFiles` (or by a read error / symlink) before that
 * returns `files: null`: the listing is incomplete, so nothing may be
 * concluded (and retired) from it.
 *
 * @param {string} workspaceFolder
 * @param {{ globs?: string[], maxFiles?: number }} [options]
 * @returns {{ files: string[] | null, listedGlobs: Set<string>, unverifiableGlobs: Set<string> }}
 */
export function collectWorkspaceListing(workspaceFolder, options = {}) {
  const maxFiles = Number.isFinite(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : WALK_MAX_FILES;
  const requested = [...new Set((Array.isArray(options.globs) ? options.globs : []).map((glob) => String(glob)).filter(Boolean))];
  const listedGlobs = new Set(requested);
  const unverifiableGlobs = new Set();
  // Compile each glob once: the matcher holds on to the memoized RegExp.
  const matchers = new Map();
  const unmatched = new Set();
  for (const glob of requested) {
    if (globTargetsSkippedRoot(glob)) { unverifiableGlobs.add(glob); continue; }
    matchers.set(glob, createScoutGlobMatcher(glob));
    unmatched.add(glob);
  }
  const watching = unmatched.size > 0;
  const out = [];
  let truncated = false;
  let incomplete = false;
  const done = () => truncated || incomplete || (watching && unmatched.size === 0);
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { incomplete = true; return; }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of names) {
      if (done()) return;
      if (!rel && WALK_SKIP.has(entry.name)) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { incomplete = true; continue; }
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), next); continue; }
      if (!entry.isFile()) continue;
      if (out.length >= maxFiles) { truncated = true; return; }
      out.push(next);
      for (const [glob, match] of matchers) if (match && match(next)) unmatched.delete(glob);
    }
  };
  walk(path.resolve(workspaceFolder), '');
  const complete = !truncated && !incomplete;
  const files = complete || (watching && unmatched.size === 0) ? out : null;
  return { files, listedGlobs, unverifiableGlobs };
}

/**
 * @param {string} workspaceFolder
 * @param {{ globs?: string[], maxFiles?: number }} [options]
 * @returns {string[] | null} null when the listing is incomplete
 */
export function listWorkspaceFiles(workspaceFolder, options = {}) {
  return collectWorkspaceListing(workspaceFolder, options).files;
}

/** @returns {boolean} the finding matches the lesson (same category, glob overlap when the lesson has globs) */
export function findingMatchesLesson(entry, lesson) {
  if (entry.category !== lesson.category) return false;
  const globs = Array.isArray(lesson.pathGlobs) ? lesson.pathGlobs : [];
  if (!globs.length) return true;
  return (entry.files || []).some((file) => globs.some((glob) => scoutGlobMatchesPath(String(file), glob)));
}

const ms = (value) => Date.parse(String(value || '')) || 0;

/**
 * Ledger cycle a round belongs to, plus the end of the previous cycle, both
 * derived from the ledger records of the round's members.
 */
function resolveCycleWindow(ledger, memberIds) {
  const records = ledger?.delegations || {};
  const cycles = memberIds.map((id) => records[id]?.cycle).filter((c) => Number.isFinite(c));
  const cycle = cycles.length ? Math.min(...cycles) : null;
  let lowerBound = 0;
  if (cycle !== null) {
    for (const rec of Object.values(records)) if (rec.cycle < cycle) lowerBound = Math.max(lowerBound, ms(rec.recordedAt));
  }
  return { cycle, lowerBound };
}

/**
 * Pure planning step: which lessons a round touches.
 *
 * @returns {{ injected: Set<string>, recurred: Set<string>, exposedSuppress: Set<string>, realIssue: Set<string> }}
 */
export function computeRoundFeedback({ leafId, round, delegations, ledger, lessons }) {
  const wanted = String(leafId || '').trim().toLowerCase();
  const rows = (Array.isArray(delegations) ? delegations : []).filter((row) => readDelegationWorkflowLeafIdFromRow(row).toLowerCase() === wanted);
  const members = new Set(round.memberIds || []);
  const { cycle, lowerBound } = resolveCycleWindow(ledger, [...members]);
  const memberRows = rows.filter((row) => members.has(row.id));
  const upperBound = memberRows.length ? Math.min(...memberRows.map((row) => ms(row.createdAt)).filter(Boolean)) : Infinity;
  const entries = (ledger?.entries || []).filter((entry) => members.has(entry.origin?.delegationId) && !entry.unlinked && (cycle === null || entry.cycle === cycle));
  const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]));
  const injected = new Set();
  const recurred = new Set();
  for (const row of rows) {
    if (row.assignment !== 'implement' && row.assignment !== 'fix') continue;
    const created = ms(row.createdAt);
    if (created <= lowerBound || created > upperBound) continue;
    for (const id of row.injectedLessonIds || []) {
      const lesson = byId.get(id);
      if (!lesson || lesson.status === 'retired') continue;
      injected.add(id);
      if (entries.some((entry) => findingMatchesLesson(entry, lesson))) recurred.add(id);
    }
  }
  // Reviewer exposure: a suppressed pattern that another delegation reported and that ended `fixed`.
  const exposedSuppress = new Set();
  const realIssue = new Set();
  const fixed = (ledger?.entries || []).filter((entry) => deriveFindingOutcome(entry) === 'fixed');
  const recordedAt = (entry) => ms(entry.recordedAt || ledger?.delegations?.[entry.origin?.delegationId]?.recordedAt);
  for (const row of rows) {
    if (row.assignment !== 'review') continue;
    // Only findings recorded after this reviewer was created can be "suppressed" by its lesson.
    const seenFrom = ms(row.createdAt);
    for (const id of row.injectedLessonIds || []) {
      const lesson = byId.get(id);
      if (!lesson || lesson.kind !== 'suppress' || lesson.status !== 'active') continue;
      exposedSuppress.add(id);
      if (fixed.some((entry) => entry.origin?.delegationId !== row.id && recordedAt(entry) > seenFrom && findingMatchesLesson(entry, lesson))) realIssue.add(id);
    }
  }
  return { injected, recurred, exposedSuppress, realIssue };
}

/**
 * Retirement / demotion decision for one lesson after this round's counters.
 *
 * @returns {{ status: 'candidate'|'retired', reason: string } | null}
 */
export function decideLessonTransition(lesson, stats, ctx) {
  if (lesson.status === 'retired') return null;
  const basis = Math.max(ms(lesson.lastEvidenceAt), ms(lesson.lastInjectedAt), ms(lesson.createdAt));
  if (basis && ctx.now - basis > ctx.options.inactiveDays * DAY_MS) return { status: 'retired', reason: 'inactive' };
  const globs = Array.isArray(lesson.pathGlobs) ? lesson.pathGlobs : [];
  if (ctx.files && globs.length) {
    // A listing only proves staleness for the globs it was built for. A lesson
    // whose globs changed after the listing (cross-process race) or that targets
    // a skipped root directory is left alone.
    const covered = !ctx.listedGlobs || globs.every((glob) => ctx.listedGlobs.has(glob));
    const verifiable = !ctx.unverifiableGlobs || globs.every((glob) => !ctx.unverifiableGlobs.has(glob));
    if (covered && verifiable && !ctx.files.some((file) => globs.some((glob) => scoutGlobMatchesPath(file, glob)))) {
      return { status: 'retired', reason: 'stale_paths' };
    }
  }
  if (lesson.status === 'active' && stats.injected >= ctx.options.minInjections && stats.recurred / stats.injected > ctx.options.recurrenceRatio) {
    return { status: 'candidate', reason: 'ineffective' };
  }
  return null;
}

let demotionNotifier = (lesson, reason) => console.warn(`[review-lessons] lesson ${lesson.id} demoted to candidate: ${reason}`);
/** @param {((lesson: object, reason: string) => void) | null} fn replace the demotion notification (null restores the log default) */
export function setLessonDemotionNotifier(fn) {
  demotionNotifier = typeof fn === 'function' ? fn : (lesson, reason) => console.warn(`[review-lessons] lesson ${lesson.id} demoted to candidate: ${reason}`);
}

/**
 * Apply the feedback of one resolved round.
 *
 * @param {{ leafId: string, parentChatId?: string, workspaceFolder?: string }} leaf
 * @param {{ id: string, verdict: string, memberIds: string[] }} round
 * @param {{ delegations?: object[], files?: string[] | null, now?: number, options?: object, dataDir?: string }} [deps]
 * @returns {{ applied: boolean, replayed?: boolean, skipped?: string, changes?: object[] }}
 */
export function applyRoundFeedback(leaf, round, deps = {}) {
  const workspaceFolder = String(leaf?.workspaceFolder || '').trim();
  const leafId = String(leaf?.leafId || '').trim().toLowerCase();
  if (!workspaceFolder || !leafId || !round?.id) return { applied: false, skipped: 'no_scope' };
  if (round.verdict !== 'PASS' && round.verdict !== 'FAIL') return { applied: false, skipped: 'verdict' };
  const storeOptions = deps.dataDir ? { dataDir: deps.dataDir } : {};
  const lessons = listLessons(workspaceFolder, storeOptions);
  if (!lessons.length) return { applied: false, skipped: 'no_lessons' };
  const delegations = deps.delegations || listDelegationsForController(String(leaf.parentChatId || ''));
  const ledger = getReviewFindingsLedger(workspaceFolder, leafId);
  const plan = computeRoundFeedback({ leafId, round, delegations, ledger, lessons });
  const options = resolveFeedbackOptions(deps.options);
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  let files = deps.files === undefined ? undefined : deps.files;
  let listedGlobs = null;
  let unverifiableGlobs = null;
  if (files === undefined && lessons.some((l) => l.status !== 'retired' && (l.pathGlobs || []).length)) {
    const globs = [...new Set(lessons.filter((l) => l.status !== 'retired').flatMap((l) => l.pathGlobs || []))];
    const listing = collectWorkspaceListing(workspaceFolder, { globs, maxFiles: deps.maxFiles });
    files = listing.files;
    // The listing only covers these globs; a lesson whose globs changed after it
    // was built (cross-process race) is never retired from this run.
    listedGlobs = listing.listedGlobs;
    unverifiableGlobs = listing.unverifiableGlobs;
  } else if (deps.files !== undefined && Array.isArray(deps.listedGlobs)) {
    listedGlobs = new Set(deps.listedGlobs);
  }
  // An empty listing means the folder is unreadable, not that every path is stale.
  if (Array.isArray(files) && !files.length) files = null;
  const stamp = new Date(now).toISOString();
  const result = applyLessonFeedback(workspaceFolder, `${leafId}:${round.id}`, (fresh) => fresh.filter((l) => l.status !== 'retired').flatMap((lesson) => {
    const delta = { injected: plan.injected.has(lesson.id) ? 1 : 0, recurred: plan.recurred.has(lesson.id) ? 1 : 0, cleanAfterInjection: 0 };
    delta.cleanAfterInjection = delta.injected && !delta.recurred ? 1 : 0;
    const stats = {
      injected: Number(lesson.stats?.injected || 0) + delta.injected,
      recurred: Number(lesson.stats?.recurred || 0) + delta.recurred,
    };
    const update = { id: lesson.id, stats: delta };
    if (delta.injected) update.lastInjectedAt = stamp;
    const decided = plan.realIssue.has(lesson.id) && lesson.status === 'active'
      ? { status: 'candidate', reason: 'suppressed_real_issue' }
      : decideLessonTransition({ ...lesson, ...(delta.injected ? { lastInjectedAt: stamp } : {}) }, stats, { now, options, files, listedGlobs, unverifiableGlobs });
    if (decided) { update.status = decided.status; update.statusReason = decided.reason; update.retiredReason = decided.reason; }
    // Untouched lessons keep their revision.
    return delta.injected || decided ? [update] : [];
  }), storeOptions);
  for (const { before, after } of result.changes || []) {
    if (before.status !== after.status && after.statusReason === 'suppressed_real_issue') {
      try { demotionNotifier(after, after.statusReason); } catch (err) { console.error('[review-lessons] notifier failed:', err instanceof Error ? err.message : err); }
    }
  }
  return result;
}

/** Feedback runs scheduled by the finish hooks that have not settled yet. */
const pending = new Set();

function onRoundResolved(leaf, round) {
  // Capture the delegation snapshot now: the finish hook's follow-ups may add rows later.
  let delegations;
  try { delegations = listDelegationsForController(String(leaf?.parentChatId || '')); } catch { delegations = undefined; }
  const task = Promise.resolve().then(() => {
    try {
      applyRoundFeedback(leaf, round, delegations ? { delegations } : {});
    } catch (err) {
      console.error('[review-lessons] feedback failed:', err instanceof Error ? err.message : err);
    }
  }).finally(() => pending.delete(task));
  pending.add(task);
}

/** Idempotent: a stable listener reference keeps one subscription however often it is installed. */
export function installLessonFeedback() {
  return subscribeReviewRoundResolved(onRoundResolved);
}

/** @returns {Promise<void>} resolves once scheduled feedback runs have settled (tests, shutdown) */
export async function drainLessonFeedback() {
  while (pending.size) await Promise.all([...pending]);
}
