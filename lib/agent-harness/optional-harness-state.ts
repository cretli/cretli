/**
 * Ids of the repo harness plugins registered at boot. A state-only module with
 * no imports, so light code (settings routes) can read it without joining the
 * heavy import graph of optional-harness-plugins.js.
 *
 * The value is owned by the boot load: it is committed once, frozen, and a
 * later commit is refused so nothing can silently swap the list the browser
 * reads from GET /api/settings.
 */

let loadedIds: readonly string[] = Object.freeze([]);
let committed = false;

/**
 * Commit the boot load result. A second call is ignored with a warning.
 *
 * @returns true when stored, false when refused.
 */
export function setLoadedOptionalHarnessIds(ids: readonly string[]): boolean {
  if (committed) {
    console.warn('[cretli] optional harness state is already committed; ignoring a second update');
    return false;
  }
  loadedIds = Object.freeze([...ids]);
  committed = true;
  return true;
}

/**
 * Test-only: allow the next commit. Refused in production like the other
 * test-only hooks.
 */
export function resetOptionalHarnessStateForTests(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetOptionalHarnessStateForTests is not available in production');
  }
  loadedIds = Object.freeze([]);
  committed = false;
}

/**
 * @returns Frozen ids registered by the boot load.
 */
export function getLoadedOptionalHarnessIds(): readonly string[] {
  return loadedIds;
}

/**
 * @returns true once the boot load committed its result. Before that
 *   (a test, a tool that never loads plugins) "not loaded" carries no meaning.
 */
export function isOptionalHarnessStateCommitted(): boolean {
  return committed;
}
