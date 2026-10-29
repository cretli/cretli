// Child process for tests/watcher-todo-command.test.js: runs the command and
// SIGKILLs itself at the requested point, simulating a hard process crash.
import { commitWatcherTodoCommand } from '../../lib/persist/todos-persist.js';

const [dataDir, cwd, todoId, todoUpdatedAt, watcherUpdatedAt, watcherRevision, point] = process.argv.slice(2);
const kill = () => process.kill(process.pid, 'SIGKILL');
commitWatcherTodoCommand(dataDir, cwd, {
  todoId,
  expectedTodoUpdatedAt: todoUpdatedAt,
  expectedWatcherUpdatedAt: watcherUpdatedAt,
  expectedWatcherRevision: Number(watcherRevision),
  decide: () => ({ todoPatch: { status: 'doing' }, watcherPatch: { mode: 'autopilot' } }),
  beforeWatcherWrite: point === 'between' ? kill : undefined,
  afterWatcherWrite: point === 'after' ? kill : undefined,
});
