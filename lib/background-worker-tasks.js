/** Pure tasks runnable both inside the background worker and in-process. */
import { listReadyTodoLeaves, filterBlockedTodoBranches } from './todo-tree.js';

const TASKS = {
  /** Ready leaf ids and blocked (non-done) branch ids of a todo list. */
  'todo-readiness': ({ items }) => ({
    readyIds: listReadyTodoLeaves(items).map((row) => String(row?.id ?? '').trim()).filter(Boolean),
    blockedIds: filterBlockedTodoBranches(items, (row) => row.status !== 'done').map((row) => String(row.id)),
  }),
  /** Echo task used by tests. */
  echo: (payload) => payload,
};

export function runBackgroundTask(task, payload) {
  const fn = TASKS[task];
  if (!fn) throw new Error(`Unknown background task: ${task}`);
  return fn(payload);
}
