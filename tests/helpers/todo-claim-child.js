import { claimWorkspaceTodo } from '../../lib/workspace-watcher.js';
import { updateTodo } from '../../lib/persist/todos-persist.js';

const [dataDir, workspaceFolder, id, revision, mode, name] = process.argv.slice(2);
const result = mode === 'edit'
  ? updateTodo(dataDir, workspaceFolder, id, { appendChangelog: { kind: 'note', text: name } })
  : claimWorkspaceTodo({ dataDir, workspaceFolder, todoId: id, expectedUpdatedAt: revision, claimedByChatId: name });
console.log(JSON.stringify(mode === 'edit' ? { edited: true } : result));
