/**
 * todo_update append: body_append keeps the stored body; a stringified-undefined
 * base is refused instead of written over the todo.
 */
import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-append-data-'));
process.env.CRETLI_DATA_DIR = dataDir;

const { addChat } = await import('../lib/persist/chats-legacy-store.js');
const { loadTodosData } = await import('../lib/persist/todos-legacy-adapter.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');

setBuiltinMcpRuntimeDeps({ dataDir, workspaceDirForAgent: () => '', taskRuns: new Map() });
const ws = path.join(dataDir, 'ws');
mkdirSync(ws, { recursive: true });
const chat = addChat('sess-append', 'Append chat', null, ws, 'model', { agentTransport: 'testfake', sdkMode: 'agent' });
const client = createInProcessMcpClient({ harness: 'testfake', chatId: chat.id, workspaceFolder: ws });
const tools = createCretliMcpToolHandlers(client, {
  chatId: chat.id, workspaceFolder: ws, harness: 'testfake', mode: 'agent', builtinClient: client,
});

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

try {
  const created = await tools.todo_create({ title: 'Append me', body: 'original findings', idempotency_key: 'append-base' });
  const id = created.structuredContent.item.id;
  const storedBody = () => loadTodosData(dataDir, ws).items.find((it) => it.id === id).body;

  const appended = await tools.todo_update({
    todo_id: id,
    expected_updated_at: created.structuredContent.item.updated_at,
    patch: { body_append: 'new section' },
  });
  await check('body_append keeps the existing body and adds the note', () => {
    assert.equal(appended.isError, false);
    assert.equal(storedBody(), 'original findings\n\nnew section');
  });

  await check('body starting with "undefined" is refused and the body is untouched', async () => {
    const res = await tools.todo_update({
      todo_id: id,
      expected_updated_at: appended.structuredContent.item.updated_at,
      patch: { body: 'undefined\n\nnew section' },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /undefined/);
    assert.equal(storedBody(), 'original findings\n\nnew section');
  });

  await check('body and body_append together are refused', async () => {
    const res = await tools.todo_update({
      todo_id: id,
      expected_updated_at: appended.structuredContent.item.updated_at,
      patch: { body: 'x', body_append: 'y' },
    });
    assert.equal(res.isError, true);
    assert.equal(storedBody(), 'original findings\n\nnew section');
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
