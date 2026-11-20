/**
 * Build reviewer-eval cases from history. Pure: todos, delegations and diffs
 * are injected, so the extraction is testable without a data dir or git.
 *
 * A case is a leaf whose code review PASSed and whose area was fixed later:
 * a todo whose `sourceTodoId` is the leaf, or a later leaf touching the same
 * lines within `windowDays` (a later-commit-only variant is not implemented).
 * Ground truth = the fix description plus
 * `file:line` taken from the OLD side of the fixing diff (where the defect was).
 */

import { parseUnifiedDiff } from './diff.js';

export const DEFAULT_FIX_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** @param {any} todo @returns {number} */
function doneAtMs(todo) {
  // Prefer the done transition time; updated_at moves on any later edit.
  const at = Date.parse(String(todo?.doneAt || todo?.finishedAt || todo?.updated_at || todo?.updatedAt || ''));
  return Number.isFinite(at) ? at : 0;
}

/** @param {any} todo @returns {string} */
function sourceOf(todo) {
  return String(todo?.sourceTodoId || todo?.source_todo_id || '').trim();
}

/**
 * @param {ReturnType<typeof parseUnifiedDiff>} fixDiff
 * @returns {Array<{ file: string, line: number, end: number }>}
 */
function truthFromDiff(fixDiff) {
  // Whole old-side range of every hunk (a pure addition is a one-line anchor).
  return fixDiff.flatMap((f) => f.hunks.map((h) => ({ file: f.file, line: h.oldStart, end: h.oldEnd })));
}

/**
 * Does the later change rewrite lines the leaf introduced?
 *
 * @param {ReturnType<typeof parseUnifiedDiff>} leafDiff
 * @param {ReturnType<typeof parseUnifiedDiff>} laterDiff
 * @returns {boolean}
 */
function touchesSameLines(leafDiff, laterDiff) {
  return leafDiff.some((lf) => laterDiff.some((xf) => xf.file === lf.file
    && lf.hunks.some((a) => xf.hunks.some((b) => b.oldStart <= a.newEnd && b.oldEnd >= a.newStart))));
}

/**
 * @param {{
 *   todos: any[],
 *   passedReviewLeafIds: Iterable<string>,
 *   readLeafDiff: (todo: any) => string,
 *   readFixDiff?: (todo: any) => string,
 *   readReviewDiff?: (todo: any) => string,
 *   readPreFixCommit?: (todo: any) => string,
 *   windowDays?: number,
 *   existing?: Array<{ id: string, accepted?: boolean }>,
 * }} input
 * @returns {Array<Record<string, any>>} new and carried-over cases (accepted flag preserved)
 */
export function extractCases(input) {
  const windowMs = (input.windowDays ?? DEFAULT_FIX_WINDOW_DAYS) * DAY_MS;
  const readFix = input.readFixDiff || input.readLeafDiff;
  const passed = new Set([...input.passedReviewLeafIds].map((id) => String(id).toLowerCase()));
  const done = input.todos.filter((t) => String(t?.status) === 'done');
  const known = new Map((input.existing || []).map((c) => [c.id, c]));
  /** @type {Array<Record<string, any>>} */
  const cases = [];
  for (const leaf of done) {
    if (!passed.has(String(leaf.id).toLowerCase())) continue;
    const leafDiffText = input.readLeafDiff(leaf);
    if (!leafDiffText) continue;
    const leafDiff = parseUnifiedDiff(leafDiffText);
    const linked = done.filter((t) => t.id !== leaf.id && sourceOf(t) === leaf.id);
    const later = done.filter((t) => t.id !== leaf.id && !sourceOf(t)
      && doneAtMs(t) > doneAtMs(leaf) && doneAtMs(t) - doneAtMs(leaf) <= windowMs);
    const fixes = [...linked.map((t) => ({ todo: t, via: 'source_todo_id' }))];
    for (const t of later) {
      if (touchesSameLines(leafDiff, parseUnifiedDiff(readFix(t)))) fixes.push({ todo: t, via: 'same-lines' });
    }
    for (const { todo: fix, via } of fixes) {
      const truth = truthFromDiff(parseUnifiedDiff(readFix(fix)));
      if (truth.length === 0) continue;
      const id = `${leaf.id}:${fix.id}`;
      cases.push({
        id,
        leafId: leaf.id,
        fixTodoId: fix.id,
        via,
        description: String(fix.title || '').slice(0, 400),
        truth,
        diff: input.readReviewDiff ? input.readReviewDiff(leaf) : leafDiffText,
        preFixCommit: input.readPreFixCommit ? input.readPreFixCommit(leaf) : '',
        accepted: known.get(id)?.accepted === true,
      });
    }
  }
  // An accepted case that can no longer be regenerated is kept, not dropped.
  const regenerated = new Set(cases.map((c) => c.id));
  for (const old of input.existing || []) {
    if (!regenerated.has(old.id) && old.accepted === true) cases.push({ ...old, stale: true });
  }
  return cases;
}
