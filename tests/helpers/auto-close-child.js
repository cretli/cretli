/**
 * Child process for the cross-process auto-close race test: closes one leaf
 * through `closeTodoLeafAfterReview` and prints the result as JSON.
 * Input comes from env: CRETLI_DATA_DIR (set by the parent), AC_PROJECT, AC_LEAF,
 * AC_ROWS (JSON), AC_START_AT (epoch ms to spin until, to align the processes).
 */
import { closeTodoLeafAfterReview } from '../../lib/todo-review-sync-hooks.js';

const startAt = Number(process.env.AC_START_AT || 0);
while (Date.now() < startAt) { /* spin */ }
const result = closeTodoLeafAfterReview({
  dataDir: process.env.CRETLI_DATA_DIR,
  workspaceFolder: process.env.AC_PROJECT,
  todoId: process.env.AC_LEAF,
  rows: JSON.parse(process.env.AC_ROWS || '[]'),
});
process.stdout.write(JSON.stringify(result));
