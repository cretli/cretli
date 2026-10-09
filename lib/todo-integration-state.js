/**
 * TODO integration state vocabulary (contract §8.1, O2).
 *
 * A worktree-backed leaf that passed review keeps `status = doing` and carries
 * `integration.state = ready` until a human confirms or rejects the result.
 * The state is stored on the todo (not derived from the worktree registry) so
 * the ready-leaf selection and the recovery classifier can read it without
 * touching the Git registry. `docs/todo-worktree-contract.md` §8.1/§8.13
 * documents the representation chosen by this leaf.
 *
 * This module stays dependency-free: both the pure todo tree helpers and the
 * persistence normalizer import it, so it must not import either of them.
 */

/** Integration states a stored todo integration object may carry. */
export const TODO_INTEGRATION_STATES = Object.freeze(['ready', 'integrated', 'rejected']);

/** @type {Set<string>} */
const TODO_INTEGRATION_STATE_SET = new Set(TODO_INTEGRATION_STATES);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTodoIntegrationState(value) {
  return TODO_INTEGRATION_STATE_SET.has(String(value ?? '').trim());
}

/**
 * True when the leaf passed review in a worktree and is waiting for a human to
 * integrate it. Such a todo stays `doing`; it must never be picked by the
 * watcher or auto-released by recovery.
 *
 * @param {object | null | undefined} todo
 * @returns {boolean}
 */
export function isTodoAwaitingIntegration(todo) {
  return String(todo?.integration?.state ?? '').trim() === 'ready';
}

/**
 * True when integration was decided (confirmed or rejected). A rejected leaf is
 * back in the ready pool; an integrated one is done.
 *
 * @param {object | null | undefined} todo
 * @returns {boolean}
 */
export function isTodoIntegrationSettled(todo) {
  const state = String(todo?.integration?.state ?? '').trim();
  return state === 'integrated' || state === 'rejected';
}
