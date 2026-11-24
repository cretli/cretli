// Child for the crash test. Commits one update (the "committed" version), then starts a second write and is
// SIGKILLed from inside it: after the temp file was written but before the rename (mode "mid-write"), or right
// after a completed update with the fsync still owed (mode "after-commit").
import fs from 'node:fs';
import { addTodo, updateTodo } from '../../lib/persist/todos-legacy-adapter.js';

const [dataDir, project, mode] = process.argv.slice(2);
const todo = addTodo(dataDir, project, { title: 'crash', body: 'before', status: 'ready' }).item;
updateTodo(dataDir, project, todo.id, { body: 'committed' });
if (mode === 'mid-write') {
  const rename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (String(args[1]).includes('todos')) process.kill(process.pid, 'SIGKILL');
    return rename(...args);
  };
  updateTodo(dataDir, project, todo.id, { body: 'never-renamed' });
} else {
  updateTodo(dataDir, project, todo.id, { body: 'after-commit' });
  process.kill(process.pid, 'SIGKILL');
}
