// Second process for the two-process material test: durably adds a done todo carrying leafMaterial.
import { addTodo, updateTodo } from '../../lib/persist/todos-legacy-adapter.js';

const [dataDir, project] = process.argv.slice(2);
const todo = addTodo(dataDir, project, { title: 'from-b', status: 'done' }).item;
updateTodo(dataDir, project, todo.id, { leafMaterial: { mode: 'worktree', baseCommit: 'e'.repeat(40) } });
process.stdout.write(todo.id);
