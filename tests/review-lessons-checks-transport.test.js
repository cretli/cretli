import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createCretliMcpToolHandlers } from '../lib/mcp/builtin/catalog.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { registerReviewLessonsRoutes } from '../lib/routes/review-lessons-routes.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { saveChats } from '../lib/persist/chats-persist.js';
import { loadTodosData } from '../lib/persist/todos-persist.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

const DATA_DIR = process.env.CRETLI_TEST_DATA_DIR;
setBuiltinMcpRuntimeDeps({ dataDir: DATA_DIR });
const FOREIGN = `${ISOLATED_DATA_DIR}-foreign`;
fs.mkdirSync(FOREIGN, { recursive: true });
saveChats([
  { id: 'remote', title: 'remote', workspaceFolder: ISOLATED_DATA_DIR },
  { id: 'local', title: 'local', workspaceFolder: ISOLATED_DATA_DIR },
  { id: 'foreign', title: 'foreign', workspaceFolder: FOREIGN },
]);
const routes = new Map();
registerReviewLessonsRoutes({ get: (p, fn) => routes.set(`GET ${p}`, fn), post: (p, fn) => routes.set(`POST ${p}`, fn), patch: (p, fn) => routes.set(`PATCH ${p}`, fn), delete: (p, fn) => routes.set(`DELETE ${p}`, fn) }, { dataDir: DATA_DIR, getCurrentWorkspace: () => ISOLATED_DATA_DIR });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const parts = url.pathname.split('/');
  const route = parts.length === 5 && parts[4] === 'propose-check' ? '/api/review-lessons/:id/propose-check' : (url.pathname.includes('/api/review-lessons/') && parts[3] !== 'distill' ? '/api/review-lessons/:id' : url.pathname);
  const handler = routes.get(`${req.method} ${route}`);
  if (!handler) { res.writeHead(404).end(); return; }
  const out = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { res.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); } };
  await handler({ query: Object.fromEntries(url.searchParams), body, params: { id: decodeURIComponent(parts[3] || '') } }, out);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const todos = () => loadTodosData(DATA_DIR, ISOLATED_DATA_DIR).items;
try {
  const remote = createCretliMcpToolHandlers(new CretliApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, bearerToken: 'test' }), { mode: 'agent', chatId: 'remote', workspaceFolder: ISOLATED_DATA_DIR });
  const local = createCretliMcpToolHandlers(createInProcessMcpClient({ harness: 'sdk', chatId: 'local', workspaceFolder: ISOLATED_DATA_DIR }), { mode: 'agent', chatId: 'local', workspaceFolder: ISOLATED_DATA_DIR });
  const foreignRemote = createCretliMcpToolHandlers(new CretliApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, bearerToken: 'test' }), { mode: 'agent', chatId: 'foreign', workspaceFolder: ISOLATED_DATA_DIR });
  const foreignLocal = createCretliMcpToolHandlers(createInProcessMcpClient({ harness: 'sdk', chatId: 'foreign', workspaceFolder: ISOLATED_DATA_DIR }), { mode: 'agent', chatId: 'foreign', workspaceFolder: ISOLATED_DATA_DIR });
  const input = { audience: 'implementer', kind: 'avoid', category: 'missing-test', checkable: true, check_hint: 'Add a lint rule' };
  const lessonOf = (result) => result.structuredContent?.lesson;

  for (const [name, handlers, other] of [['remote', remote, local], ['local', local, remote]]) {
    const added = await handlers.lesson_add({ ...input, text: `Register new tests in the catalog (${name}).` });
    assert.equal(added.isError, false, `${name} add`);
    const id = lessonOf(added).id;
    const firstCall = await handlers.lesson_check_idea({ id });
    assert.equal(firstCall.isError, false, `${name} propose: ${JSON.stringify(firstCall.content)}`);
    assert.equal(firstCall.structuredContent.created, true);
    // Twice (and through the other client) -> still one todo.
    const second = await handlers.lesson_check_idea({ id });
    const crossed = await other.lesson_check_idea({ id });
    assert.equal(second.structuredContent.created, false);
    assert.equal(crossed.structuredContent.created, false);
    assert.equal(second.structuredContent.todo.id, firstCall.structuredContent.todo.id);
    assert.equal(crossed.structuredContent.todo.id, firstCall.structuredContent.todo.id);
    // Editing the lesson after the proposal must not turn a repeat into a CONFLICT, through either client.
    const current = await handlers.lesson_get?.({ id });
    const revision = current?.structuredContent?.lesson?.revision ?? lessonOf(added).revision;
    const edited = await handlers.lesson_update({ id, expected_revision: revision, patch: { check_hint: `Add a stricter lint rule (${name})` } });
    assert.equal(edited.isError, false, `${name} edit: ${JSON.stringify(edited.content)}`);
    for (const client of [handlers, other]) {
      const again = await client.lesson_check_idea({ id });
      assert.equal(again.isError, false, `${name} propose after edit: ${JSON.stringify(again.content)}`);
      assert.equal(again.structuredContent.created, false);
      assert.equal(again.structuredContent.todo.id, firstCall.structuredContent.todo.id);
    }
    const mine = todos().filter((row) => row.body.includes(`(${name})`));
    assert.equal(mine.length, 1, `${name}: exactly one todo`);
    assert.equal(mine[0].status, 'idea');
    // Foreign chats and foreign folders are rejected on both paths.
    assert.equal((await foreignRemote.lesson_check_idea({ id })).isError, true);
    assert.equal((await foreignLocal.lesson_check_idea({ id })).isError, true);
    assert.equal((await handlers.lesson_check_idea({ id, workspace_folder: FOREIGN })).isError, true);
    assert.equal((await other.lesson_check_idea({ id, workspace_folder: FOREIGN })).isError, true);
    // Not checkable -> error through the tool.
    const plain = await handlers.lesson_add({ audience: 'implementer', kind: 'avoid', category: 'perf', text: `Not checkable ${name}.` });
    assert.equal((await handlers.lesson_check_idea({ id: lessonOf(plain).id })).isError, true);
    assert.equal((await handlers.lesson_check_idea({ id: 'missing' })).isError, true);
  }
  assert.equal(todos().length, 2);

  // The committed-rule guard applies identically through both clients.
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'CLAUDE.md'), '- Always keep comments in English across the whole repository.\n');
  for (const [name, handlers] of [['remote', remote], ['local', local]]) {
    const refused = await handlers.lesson_add({ ...input, text: `Always keep comments in English across the whole repository.`, activate: true });
    assert.equal(refused.isError, true, `${name} guard`);
    assert.match(JSON.stringify(refused.content), /committed rule/);
  }
  const candidate = await remote.lesson_add({ ...input, text: 'Always keep comments in English across the whole repository.' });
  assert.equal(candidate.isError, false);
  const activation = await local.lesson_update({ id: lessonOf(candidate).id, expected_revision: lessonOf(candidate).revision, patch: { status: 'active' } });
  assert.equal(activation.isError, true);
} finally { await new Promise((resolve) => server.close(resolve)); }
console.log('review-lessons-checks-transport tests passed');
