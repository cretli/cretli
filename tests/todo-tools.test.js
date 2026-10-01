/**
 * MCP todo tools through both clients (in-process and remote HTTP), plus chat
 * history (`chats[]`) and id-prefix resolution.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-tools-data-'));
process.env.CRETLI_DATA_DIR = dataDir;

const { addChat, loadChats } = await import('../lib/persist/chats-persist.js');
const { addTodo, loadTodosData, saveTodosData, updateTodo } = await import('../lib/persist/todos-persist.js');
const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
const { createInProcessMcpClient } = await import('../lib/mcp/mcp-inprocess-client.js');
const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');
const { buildTodoChatIndex, enrichTodoItemsWithSourceChat } = await import('../lib/todo-source-chat.js');
const { CretliApiClient } = await import('../lib/remote-api-client.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

setBuiltinMcpRuntimeDeps({
  dataDir,
  workspaceDirForAgent: () => '',
  taskRuns: new Map(),
  agentRuns: new Map(),
});

const root = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-tools-ws-'));
const wsInProcess = path.join(root, 'in-process');
const wsPrefix = path.join(root, 'prefix');
const wsRemote = path.join(root, 'remote');
const wsRemotePrefix = path.join(root, 'remote-prefix');
for (const dir of [wsInProcess, wsPrefix, wsRemote, wsRemotePrefix]) mkdirSync(dir, { recursive: true });

const chatIp = addChat('sess-ip', 'In-process chat', null, wsInProcess, 'model-ip', { agentTransport: 'opencode', sdkMode: 'agent' });
const chatRemote = addChat('sess-remote', 'Remote chat', null, wsRemote, 'model-r', { agentTransport: 'sdk', sdkMode: 'agent' });

function handlersFor(client, chatId, workspaceFolder, harness) {
  return createCretliMcpToolHandlers(client, {
    chatId,
    workspaceFolder,
    harness,
    mode: 'agent',
    builtinClient: client,
  });
}

const ipClient = createInProcessMcpClient({ harness: 'opencode', chatId: chatIp.id, workspaceFolder: wsInProcess });
const ip = handlersFor(ipClient, chatIp.id, wsInProcess, 'opencode');

// --- In-process: createdByChatId + chats[] ---
const ipCreated = await ip.todo_create({ title: 'In-process task', status: 'ready', idempotency_key: 'ip-1' });
check('in-process todo_create succeeds and records the creator', () => {
  assert.equal(ipCreated.isError, false);
  assert.equal(ipCreated.structuredContent.item.created_by_chat_id, chatIp.id);
});
const ipId = ipCreated.structuredContent.item.id;

const ipShown = await ip.todo_show({ todo_id: ipId });
check('in-process todo_show returns chats[] with the creator role', () => {
  const item = ipShown.structuredContent.item;
  const creator = item.chats.find((row) => row.id === chatIp.id);
  assert.ok(creator, 'chat missing from chats[]');
  assert.ok(creator.roles.includes('creator'));
  assert.equal(creator.deleted, false);
});

// --- In-process: id prefix + update links the calling chat ---
const ipPrefix = ipId.slice(0, 8);
const ipUpdated = await ip.todo_update({
  todo_id: ipPrefix,
  expected_updated_at: ipShown.structuredContent.item.updated_at,
  patch: { status: 'doing' },
});
check('in-process todo_update accepts an id prefix', () => {
  assert.equal(ipUpdated.isError, false);
  assert.equal(ipUpdated.structuredContent.item.id, ipId);
  assert.equal(ipUpdated.structuredContent.item.status, 'doing');
});

const ipShown2 = await ip.todo_show({ todo_id: ipId });
check('in-process todo_update links the caller and logs the status change', () => {
  const item = ipShown2.structuredContent.item;
  const linked = item.chats.find((row) => row.id === chatIp.id);
  assert.ok(linked.roles.includes('linked'));
  assert.ok(item.changelog.some((entry) => String(entry.text).includes('ready→doing')));
});

// --- Prefix resolution: unique / collision / missing (in-process) ---
function seedWorkspace(workspaceFolder, items) {
  saveTodosData(dataDir, workspaceFolder, {
    version: 3,
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: items.map((item) => ({
      status: 'idea',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...item,
    })),
    idempotency: {},
  });
}
seedWorkspace(wsPrefix, [
  { id: 'abcdef12-0000-4000-8000-000000000001', title: 'One' },
  { id: 'abcdef12-0000-4000-8000-000000000002', title: 'Two' },
  { id: 'ffffffff-0000-4000-8000-000000000003', title: 'Three' },
]);
const chatPrefix = addChat('sess-prefix', 'Prefix chat', null, wsPrefix, 'model-p', { agentTransport: 'sdk', sdkMode: 'agent' });
const prefixClient = createInProcessMcpClient({ harness: 'sdk', chatId: chatPrefix.id, workspaceFolder: wsPrefix });
const prefix = handlersFor(prefixClient, chatPrefix.id, wsPrefix, 'sdk');

const prefixUnique = await prefix.todo_show({ todo_id: 'ffffffff' });
check('in-process prefix: a unique 8-char prefix resolves', () => {
  assert.equal(prefixUnique.isError, false);
  assert.equal(prefixUnique.structuredContent.item.id, 'ffffffff-0000-4000-8000-000000000003');
});

const prefixCollision = await prefix.todo_show({ todo_id: 'abcdef12' });
check('in-process prefix: a colliding prefix is VALIDATION_ERROR with candidates', () => {
  assert.equal(prefixCollision.isError, true);
  assert.match(prefixCollision.content[0].text, /VALIDATION_ERROR/);
  assert.match(prefixCollision.content[0].text, /abcdef12-0000-4000-8000-000000000001/);
  assert.match(prefixCollision.content[0].text, /abcdef12-0000-4000-8000-000000000002/);
});

const prefixMissing = await prefix.todo_show({ todo_id: '99999999' });
check('in-process prefix: no match is NOT_FOUND', () => {
  assert.equal(prefixMissing.isError, true);
  assert.match(prefixMissing.content[0].text, /NOT_FOUND/);
});

const prefixTooShort = await prefix.todo_show({ todo_id: 'abc' });
check('in-process prefix: shorter than 8 chars is NOT_FOUND, not a collision', () => {
  assert.equal(prefixTooShort.isError, true);
  assert.match(prefixTooShort.content[0].text, /NOT_FOUND/);
});

// --- Remote client over HTTP ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = () => new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(JSON.parse(raw || '{}')));
  });
  const todosPayload = (cwd) => {
    const data = loadTodosData(dataDir, cwd);
    const index = buildTodoChatIndex(loadChats(), { workspaceFolder: cwd });
    return {
      ok: true,
      cwd,
      version: data.version,
      updatedAt: data.updatedAt,
      items: enrichTodoItemsWithSourceChat(data.items, index, cwd),
    };
  };
  if (req.method === 'POST' && url.pathname === '/api/login') {
    send(200, { ok: true, csrfToken: 'csrf-tools' }, { 'Set-Cookie': 'cr_session=tools; Path=/; HttpOnly' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/todos') {
    send(200, todosPayload(url.searchParams.get('workspaceFolder')));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/todos') {
    readBody().then((body) => {
      const cwd = body.workspaceFolder;
      const saved = addTodo(dataDir, cwd, { ...body, strictStatus: body.strictStatus === true });
      send(200, { ...todosPayload(cwd), item: saved.item, replayed: saved.replayed === true });
    });
    return;
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/todos/')) {
    const todoId = decodeURIComponent(url.pathname.slice('/api/todos/'.length));
    readBody().then((body) => {
      const cwd = body.workspaceFolder;
      const saved = updateTodo(dataDir, cwd, todoId, { ...body, strictStatus: body.strictStatus === true });
      send(200, { ...todosPayload(cwd), item: saved.items.find((row) => row.id === todoId) || null });
    });
    return;
  }
  send(404, { ok: false, error: 'Not found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const remoteClient = new CretliApiClient({ baseUrl, password: 'tools' });
  const remote = handlersFor(remoteClient, chatRemote.id, wsRemote, 'sdk');

  const rCreated = await remote.todo_create({ title: 'Remote task', status: 'ready', idempotency_key: 'r-1' });
  check('remote todo_create succeeds and records the creator', () => {
    assert.equal(rCreated.isError, false);
    assert.equal(rCreated.structuredContent.item.created_by_chat_id, chatRemote.id);
  });
  const rId = rCreated.structuredContent.item.id;

  const rShown = await remote.todo_show({ todo_id: rId });
  check('remote todo_show returns chats[] with the creator role', () => {
    const item = rShown.structuredContent.item;
    const creator = item.chats.find((row) => row.id === chatRemote.id);
    assert.ok(creator, 'chat missing from chats[]');
    assert.ok(creator.roles.includes('creator'));
  });

  const rUpdated = await remote.todo_update({
    todo_id: rId.slice(0, 8),
    expected_updated_at: rShown.structuredContent.item.updated_at,
    patch: { status: 'doing' },
  });
  check('remote todo_update accepts an id prefix and links the caller', () => {
    assert.equal(rUpdated.isError, false);
    assert.equal(rUpdated.structuredContent.item.id, rId);
    assert.equal(rUpdated.structuredContent.item.status, 'doing');
  });

  const rShown2 = await remote.todo_show({ todo_id: rId });
  check('remote todo_show reports the linked caller and the status changelog', () => {
    const item = rShown2.structuredContent.item;
    const linked = item.chats.find((row) => row.id === chatRemote.id);
    assert.ok(linked.roles.includes('linked'));
    assert.ok(item.changelog.some((entry) => String(entry.text).includes('ready→doing')));
  });

  seedWorkspace(wsRemotePrefix, [
    { id: 'abcdef12-1111-4000-8000-000000000001', title: 'Remote one' },
    { id: 'abcdef12-1111-4000-8000-000000000002', title: 'Remote two' },
    { id: 'ffffffff-1111-4000-8000-000000000003', title: 'Remote three' },
  ]);
  const chatRemotePrefix = addChat('sess-rp', 'Remote prefix chat', null, wsRemotePrefix, 'model-rp', { agentTransport: 'sdk', sdkMode: 'agent' });
  const remotePrefix = handlersFor(remoteClient, chatRemotePrefix.id, wsRemotePrefix, 'sdk');

  const rUnique = await remotePrefix.todo_show({ todo_id: 'ffffffff' });
  check('remote prefix: a unique 8-char prefix resolves', () => {
    assert.equal(rUnique.isError, false);
    assert.equal(rUnique.structuredContent.item.id, 'ffffffff-1111-4000-8000-000000000003');
  });

  const rCollision = await remotePrefix.todo_show({ todo_id: 'abcdef12' });
  check('remote prefix: a colliding prefix is VALIDATION_ERROR with candidates', () => {
    assert.equal(rCollision.isError, true);
    assert.match(rCollision.content[0].text, /VALIDATION_ERROR/);
    assert.match(rCollision.content[0].text, /abcdef12-1111-4000-8000-000000000001/);
  });

  const rMissing = await remotePrefix.todo_show({ todo_id: '99999999' });
  check('remote prefix: no match is NOT_FOUND', () => {
    assert.equal(rMissing.isError, true);
    assert.match(rMissing.content[0].text, /NOT_FOUND/);
  });
} finally {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
