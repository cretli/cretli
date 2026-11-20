import { updateTodo } from '../persist/todos-store.js';
import { stalePlanReviewerSessionsForTodoPlanChange } from '../plan-reviewer-cooperation-service.js';
import { syncTodoReviewTarget } from '../todo-review-sync-hooks.js';

/** Shared plan write effects for the todo PATCH route and a decision card. */
export async function afterTodoPlanWrite({ dataDir, workspaceFolder, todoId }) {
  try {
    await stalePlanReviewerSessionsForTodoPlanChange({ dataDir, workspaceFolder, todoId });
  } catch {
    // The todo write succeeds even if cooperation cleanup fails.
  }
  await syncTodoReviewTarget({ todoId, workspaceFolder, dataDir }, { source: 'plan-edit' });
}

/** Approve through the todo store CAS and the same plan effects as the UI PATCH route. */
export async function approveTodoPlanFromDecision({ dataDir, workspaceFolder, todo }) {
  const doc = await updateTodo(dataDir, workspaceFolder, todo.id, {
    plan: { ...todo.plan, approvedAt: new Date().toISOString() }, expectedUpdatedAt: todo.updatedAt,
  });
  await afterTodoPlanWrite({ dataDir, workspaceFolder, todoId: todo.id });
  return doc;
}
