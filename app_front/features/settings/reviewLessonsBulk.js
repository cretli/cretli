/**
 * Bulk update of review lessons: one PATCH per lesson with its own loaded revision.
 * A failing lesson (revision conflict or error) is counted and the rest still run.
 * Pure logic; the transport is injected.
 */

/**
 * @typedef {{ done: number, total: number, conflicts: number, errors: number, failed: number }} BulkResult
 */

/**
 * @param {object[]} lessons lessons with `id` and `revision`
 * @param {Record<string, unknown>} patch
 * @param {(lesson: object, patch: Record<string, unknown>) => Promise<{ status: number, json: any }>} patchOne
 * @param {(done: number, total: number) => void} [onProgress] called after each lesson, failed or not
 * @returns {Promise<BulkResult>}
 */
export async function runBulkLessonPatch(lessons, patch, patchOne, onProgress) {
  const result = { done: 0, total: lessons.length, conflicts: 0, errors: 0, failed: 0 };
  let seen = 0;
  for (const lesson of lessons) {
    try {
      const { status, json } = await patchOne(lesson, patch);
      if (status === 200 && json?.ok) result.done += 1;
      else if (status === 409 || json?.code === 'CONFLICT') result.conflicts += 1;
      else result.errors += 1;
    } catch {
      result.errors += 1;
    }
    seen += 1;
    onProgress?.(seen, result.total);
  }
  result.failed = result.conflicts + result.errors;
  return result;
}

/**
 * One summary line for the whole run.
 *
 * @param {BulkResult} result
 * @param {(key: string, params?: object) => string} translate
 * @returns {string}
 */
export function summarizeBulkResult(result, translate) {
  if (!result.failed) return translate('settings.reviewLessonsBulkDone', { done: result.done, total: result.total });
  const reasons = [];
  if (result.conflicts) reasons.push(translate('settings.reviewLessonsBulkReasonConflict', { count: result.conflicts }));
  if (result.errors) reasons.push(translate('settings.reviewLessonsBulkReasonError', { count: result.errors }));
  return translate('settings.reviewLessonsBulkPartial', { done: result.done, total: result.total, failed: result.failed, reasons: reasons.join(', ') });
}

/**
 * Single-flight guard: while one run is in progress, further calls are ignored (they resolve
 * to `undefined`), so a double click cannot start a second run on stale revisions.
 *
 * @returns {{ readonly busy: boolean, run: <T>(task: () => Promise<T>) => Promise<T | undefined> }}
 */
export function createSingleFlight() {
  let busy = false;
  return {
    get busy() { return busy; },
    async run(task) {
      if (busy) return undefined;
      busy = true;
      try {
        return await task();
      } finally {
        busy = false;
      }
    },
  };
}
