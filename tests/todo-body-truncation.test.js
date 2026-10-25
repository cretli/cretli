/**
 * Todo body cap (8000 chars): truncation must be signalled, never silent.
 */
import assert from 'node:assert/strict';
import './fixtures/fake-transport.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-body-data-'));
process.env.CRETLI_DATA_DIR = dataDir;

const { addChat } = await import('../lib/persist/chats-persist.js');
const { MAX_BODY_LEN, describeBodyTruncation, loadTodosData } = await import('../lib/persist/todos-persist.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');

setBuiltinMcpRuntimeDeps({ dataDir, workspaceDirForAgent: () => '', taskRuns: new Map(), agentRuns: new Map() });
const ws = path.join(dataDir, 'ws');
mkdirSync(ws, { recursive: true });
const chat = addChat('sess-body', 'Body chat', null, ws, 'model', { agentTransport: 'testfake', sdkMode: 'agent' });
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
  await check('describeBodyTruncation counts the cut characters', () => {
    assert.deepEqual(describeBodyTruncation('x'.repeat(MAX_BODY_LEN)), { truncated: false, truncated_chars: 0, max_body_len: MAX_BODY_LEN });
    assert.equal(describeBodyTruncation('x'.repeat(MAX_BODY_LEN + 25)).truncated_chars, 25);
    assert.equal(describeBodyTruncation(undefined).truncated, false);
  });

  const exact = 'a'.repeat(MAX_BODY_LEN);
  const created = await tools.todo_create({ title: 'Exact body', body: exact, idempotency_key: 'body-exact' });
  await check('todo_create: body at the limit is stored unchanged, no truncation flag', () => {
    assert.equal(created.structuredContent.truncated, false);
    assert.doesNotMatch(created.content[0].text, /truncated/);
    assert.equal(created.structuredContent.item.id.length > 0, true);
  });

  const long = 'b'.repeat(MAX_BODY_LEN + 123);
  const createdLong = await tools.todo_create({ title: 'Long body', body: long, idempotency_key: 'body-long' });
  await check('todo_create: oversized body reports truncated=true and the cut count', () => {
    assert.equal(createdLong.isError, false);
    assert.equal(createdLong.structuredContent.truncated, true);
    assert.equal(createdLong.structuredContent.truncated_chars, 123);
    assert.match(createdLong.content[0].text, /truncated to 8000 chars \(123 chars cut\)/);
  });

  await check('stored body is cut to the limit; at-limit body is unchanged', () => {
    const items = loadTodosData(dataDir, ws).items;
    assert.equal(items.find((it) => it.id === createdLong.structuredContent.item.id).body.length, MAX_BODY_LEN);
    assert.equal(items.find((it) => it.id === created.structuredContent.item.id).body, exact);
  });

  const upd = await tools.todo_update({
    todo_id: created.structuredContent.item.id,
    expected_updated_at: created.structuredContent.item.updated_at,
    patch: { body: 'c'.repeat(MAX_BODY_LEN + 7) },
  });
  await check('todo_update: oversized body reports truncated=true and the cut count', () => {
    assert.equal(upd.isError, false);
    assert.equal(upd.structuredContent.truncated, true);
    assert.equal(upd.structuredContent.truncated_chars, 7);
    assert.match(upd.content[0].text, /WARNING: body truncated/);
  });

  const upd2 = await tools.todo_update({
    todo_id: created.structuredContent.item.id,
    expected_updated_at: upd.structuredContent.item.updated_at,
    patch: { body: 'short body' },
  });
  await check('todo_update: short body and non-body patches carry no truncation flag', () => {
    assert.equal(upd2.structuredContent.truncated, false);
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
