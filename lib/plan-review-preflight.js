/**
 * Plan-review preflight: can two independent reviewers be started at all?
 *
 * `operator_plan_review_start` used to start a coordinator chat that only found
 * out later (via `model_pick`) that fewer than two reviewers qualify, and then
 * stopped silently. This module answers the question up front with the same
 * picker `model_pick` uses (no persistence), and records an explicit,
 * human-visible block on the todo when the answer is "no".
 *
 * Independence rule (documented in docs/mcp/OPERATOR-PLAYBOOK.md): the pick is
 * `diverse`, i.e. one reviewer per harness, over every enabled, ready,
 * delegatable harness. The coordinator's harness never removes a candidate; the
 * only coordinator-derived exclusion is its own base model (it authored/steers
 * the plan, same rule as the implementer), so a harness whose single favorite
 * model is the coordinator model drops out.
 */

import { listHarnessCatalog, listHarnessModelsIncludingLocal } from './harness-catalog.js';
import { pickModelForPurpose } from './model-pick-service.js';
import { markWorkspaceWatcherTodoBlocked } from './workspace-watcher.js';
import { getTodo, updateTodo } from './persist/todos-store.js';

/** Independent reviewers a plan review needs. */
export const PLAN_REVIEW_REQUIRED_REVIEWERS = 2;

/** `blockedReason` and error code used when fewer than two reviewers qualify. */
export const TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS = 'insufficient_independent_reviewers';

/**
 * Count the independent reviewers that qualify right now.
 *
 * @param {{
 *   harnesses: Record<string, any>[],
 *   modelsByHarness: Record<string, Record<string, any>>,
 *   workspaceFolder?: string,
 *   coordinatorModel?: string,
 *   required?: number,
 *   history?: Record<string, any>,
 *   pick?: typeof pickModelForPurpose,
 * }} input
 * @returns {{ available: number, required: number, satisfiable: boolean | null, unknown?: boolean, error?: string, reviewers: Array<{ harness: string, model: string }> }}
 *   `satisfiable: null` + `unknown: true` means the selection itself failed
 *   (exception or a non-"no candidate" refusal): callers must fail open and
 *   never block, notify or refuse on it. Only a successful selection (or the
 *   picker's explicit MODEL_UNAVAILABLE "no candidate at all") is conclusive.
 */
export function evaluatePlanReviewerAvailability(input) {
  const required = Number.isInteger(input.required) && Number(input.required) > 0
    ? Number(input.required)
    : PLAN_REVIEW_REQUIRED_REVIEWERS;
  // An omitted or `auto` coordinator model excludes nothing: the real model is
  // only known once the coordinator chat exists, so the count is an upper bound.
  const coordinatorModel = String(input.coordinatorModel || '').trim();
  const lowered = coordinatorModel.toLowerCase();
  const select = typeof input.pick === 'function' ? input.pick : pickModelForPurpose;
  /** @type {Record<string, any>} */
  let result;
  try {
    result = select({
      role: 'review',
      harnesses: input.harnesses,
      modelsByHarness: input.modelsByHarness,
      workspaceFolder: input.workspaceFolder,
      // One reviewer per harness; the same fanout size as the coordinator asks
      // for, so the picker applies the same two-reviewer independence rule.
      count: required,
      diverse: true,
      // The only coordinator-derived exclusion: its own base model.
      excludeModels: coordinatorModel && lowered !== 'auto' ? [coordinatorModel] : [],
      diagnosisInput: { checkReviewAdapter: true },
      explore: false,
      shadow: false,
      planLimitsRefresh: false,
      ...(input.history ? { history: input.history } : {}),
    });
  } catch (error) {
    return {
      available: 0,
      required,
      satisfiable: null,
      unknown: true,
      error: String(/** @type {any} */ (error)?.message || error || 'reviewer selection failed'),
      reviewers: [],
    };
  }
  if (!result?.ok && String(result?.code || '') !== 'MODEL_UNAVAILABLE') {
    return {
      available: 0,
      required,
      satisfiable: null,
      unknown: true,
      error: String(result?.error || result?.code || 'reviewer selection refused'),
      reviewers: [],
    };
  }
  const picks = result?.ok && Array.isArray(result.picks) ? result.picks : [];
  const reviewers = picks
    .map((/** @type {any} */ row) => ({ harness: String(row?.harness || '').toLowerCase(), model: String(row?.model || '') }))
    .filter((/** @type {{ harness: string, model: string }} */ row) => row.harness && row.model);
  return { available: reviewers.length, required, satisfiable: reviewers.length >= required, reviewers };
}

/**
 * Read the live harness catalog and review-role favorites, then count the
 * qualifying reviewers. Same inputs `model_pick` feeds the picker (enabled,
 * ready, delegatable harnesses; Settings favorites for role=review).
 *
 * @param {{ workspaceFolder: string, coordinatorModel?: string, required?: number, deps?: { listHarnessCatalog?: typeof listHarnessCatalog, listHarnessModels?: typeof listHarnessModelsIncludingLocal, pick?: typeof pickModelForPurpose, history?: Record<string, any> } }} input
 * @returns {Promise<ReturnType<typeof evaluatePlanReviewerAvailability>>}
 */
export async function runPlanReviewerPreflight(input) {
  const deps = input.deps || {};
  const listCatalog = deps.listHarnessCatalog || listHarnessCatalog;
  const listModels = deps.listHarnessModels || listHarnessModelsIncludingLocal;
  const harnesses = await listCatalog();
  /** @type {Record<string, Record<string, any>>} */
  const modelsByHarness = {};
  for (const harness of harnesses) {
    if (!harness?.enabled || !harness?.ready || !harness?.can_delegate) continue;
    const id = String(harness.id || '').trim();
    if (!id) continue;
    modelsByHarness[id] = await listModels({
      harness: id,
      enabledOnly: true,
      workspaceFolder: input.workspaceFolder,
      role: 'review',
    });
  }
  return evaluatePlanReviewerAvailability({
    harnesses,
    modelsByHarness,
    workspaceFolder: input.workspaceFolder,
    coordinatorModel: input.coordinatorModel,
    required: input.required,
    pick: deps.pick,
    history: deps.history,
  });
}

/**
 * Record the "not enough reviewers" block on a todo and push one `blocked`
 * notification. The Watcher helper only writes when the todo carries no block
 * yet, so a repeat call neither rewrites the reason nor notifies twice. The
 * reason is cleared by the next `status` change (todos-persist) or by
 * `clearInsufficientReviewersBlock` once a review starts. `todo.review` is
 * server-owned and never touched here.
 *
 * @param {{ dataDir: string, workspaceFolder: string, todoId: string, available: number, required: number, chatId?: string, notify?: Function, notifyDeps?: Record<string, any>, noticeDeps?: Record<string, any> }} input
 * @returns {Promise<boolean>} whether the todo was newly blocked
 */
export async function blockTodoForInsufficientReviewers(input) {
  return markWorkspaceWatcherTodoBlocked({
    dataDir: input.dataDir,
    workspaceFolder: input.workspaceFolder,
    todoId: input.todoId,
    chatId: input.chatId,
    reasonText: TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS,
    noticeText: `plan review needs ${input.required} independent reviewers but only ${input.available} qualify (${TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS})`,
    notify: /** @type {any} */ (input.notify),
    notifyDeps: input.notifyDeps,
    noticeDeps: input.noticeDeps,
  });
}

/**
 * Drop the insufficient-reviewers block after a review started successfully.
 * Any other block reason is left alone.
 *
 * @param {{ dataDir: string, workspaceFolder: string, todoId: string }} input
 * @returns {Promise<boolean>} whether a block was cleared
 */
export async function clearInsufficientReviewersBlock(input) {
  try {
    const current = await getTodo(input.dataDir, input.workspaceFolder, input.todoId);
    if (String(current?.blockedReason || '').trim() !== TODO_BLOCKED_REASON_INSUFFICIENT_REVIEWERS) return false;
    const updated = await updateTodo(input.dataDir, input.workspaceFolder, input.todoId, /** @type {object} */ ({
      expectedUpdatedAt: current.updatedAt,
      blockedReason: '',
    }));
    return Boolean(updated?.items);
  } catch {
    return false;
  }
}
