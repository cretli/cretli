import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCretliMcpToolHandlers } from '../lib/mcp/builtin/catalog.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { registerReviewLessonsRoutes } from '../lib/routes/review-lessons-routes.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { saveChats } from '../lib/persist/chats-persist.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

setBuiltinMcpRuntimeDeps({ dataDir: process.env.CRETLI_TEST_DATA_DIR });
const FOREIGN = `${ISOLATED_DATA_DIR}-foreign`;
// Real chat records: the REST routes and the in-process client resolve scope from them.
saveChats([
  { id: 'remote', title: 'remote', workspaceFolder: ISOLATED_DATA_DIR },
  { id: 'local', title: 'local', workspaceFolder: ISOLATED_DATA_DIR },
  { id: 'foreign', title: 'foreign', workspaceFolder: FOREIGN },
]);
const routes = new Map();
registerReviewLessonsRoutes({ get: (p, fn) => routes.set(`GET ${p}`, fn), post: (p, fn) => routes.set(`POST ${p}`, fn), patch: (p, fn) => routes.set(`PATCH ${p}`, fn), delete: (p, fn) => routes.set(`DELETE ${p}`, fn) }, { dataDir: process.env.CRETLI_TEST_DATA_DIR, getCurrentWorkspace: () => ISOLATED_DATA_DIR });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const key = `${req.method} ${url.pathname.includes('/api/review-lessons/') ? '/api/review-lessons/:id' : url.pathname}`;
  const handler = routes.get(key);
  if (!handler) { res.writeHead(404).end(); return; }
  const out = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { res.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); } };
  await handler({ query: Object.fromEntries(url.searchParams), body, params: { id: decodeURIComponent(url.pathname.split('/').pop()) } }, out);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const client = new CretliApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, bearerToken: 'test' });
  const remoteHandlers = createCretliMcpToolHandlers(client, { mode: 'agent', chatId: 'remote', workspaceFolder: ISOLATED_DATA_DIR });
  const lessonInput = { audience: 'implementer', kind: 'do', text: 'Keep callers aligned with changed contracts.', category: 'caller-not-updated' };
  const remoteResult = await remoteHandlers.lesson_add(lessonInput);
  assert.equal(remoteResult.isError, false);
  const inProcessClient = createInProcessMcpClient({ harness: 'sdk', chatId: 'local', workspaceFolder: ISOLATED_DATA_DIR });
  const localHandlers = createCretliMcpToolHandlers(inProcessClient, { mode: 'agent', chatId: 'local', workspaceFolder: ISOLATED_DATA_DIR });
  const localResult = await localHandlers.lesson_add({ ...lessonInput, text: 'Document new routes with their consumers.' , category: 'docs-not-updated' });
  assert.equal(localResult.isError, false);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/review-lessons?workspaceFolder=${encodeURIComponent(ISOLATED_DATA_DIR)}&chatId=remote`, { headers: { Authorization: 'Bearer test' } });
  const body = await response.json();
  assert.equal(body.lessons.length, 2);
  // A chat of another workspace cannot reach this store through either path, nor name this folder.
  const foreignRemote = createCretliMcpToolHandlers(client, { mode: 'agent', chatId: 'foreign', workspaceFolder: ISOLATED_DATA_DIR });
  assert.equal((await foreignRemote.lesson_add({ ...lessonInput, text: 'Foreign write must be rejected.' })).isError, true);
  const foreignLocal = createCretliMcpToolHandlers(createInProcessMcpClient({ harness: 'sdk', chatId: 'foreign', workspaceFolder: ISOLATED_DATA_DIR }), { mode: 'agent', chatId: 'foreign', workspaceFolder: ISOLATED_DATA_DIR });
  assert.equal((await foreignLocal.lesson_add({ ...lessonInput, text: 'Foreign write must be rejected.' })).isError, true);
  assert.equal((await localHandlers.lesson_add({ ...lessonInput, text: 'Foreign folder must be rejected.', workspace_folder: FOREIGN })).isError, true);
  assert.equal((await remoteHandlers.lesson_add({ ...lessonInput, text: 'Foreign folder must be rejected.', workspace_folder: FOREIGN })).isError, true);
  const after = await (await fetch(`http://127.0.0.1:${server.address().port}/api/review-lessons?workspaceFolder=${encodeURIComponent(ISOLATED_DATA_DIR)}&chatId=remote`)).json();
  assert.equal(after.lessons.length, 2);

  // lesson_update: a status-only patch keeps globs/models/reason, identically on both paths.
  assert.equal((await remoteHandlers.lesson_add({ ...lessonInput, text: 'Keep globs across status updates.', path_globs: ['lib/**'], applies_to_models: ['m1'] })).isError, false);
  const listed = (await (await fetch(`http://127.0.0.1:${server.address().port}/api/review-lessons?workspaceFolder=${encodeURIComponent(ISOLATED_DATA_DIR)}&chatId=remote`)).json()).lessons;
  const target = listed.find((x) => x.text === 'Keep globs across status updates.');
  const viaRemote = await remoteHandlers.lesson_update({ id: target.id, expected_revision: target.revision, patch: { status: 'active' } });
  assert.equal(viaRemote.isError, false);
  const viaLocal = await localHandlers.lesson_update({ id: target.id, expected_revision: target.revision + 1, patch: { retired_reason: 'obsolete', status: 'retired' } });
  assert.equal(viaLocal.isError, false);
  const final = (await (await fetch(`http://127.0.0.1:${server.address().port}/api/review-lessons?workspaceFolder=${encodeURIComponent(ISOLATED_DATA_DIR)}&chatId=remote`)).json()).lessons.find((x) => x.id === target.id);
  assert.deepEqual(final.pathGlobs, ['lib/**']);
  assert.deepEqual(final.appliesToModels, ['m1']);
  assert.equal(final.status, 'retired');
  assert.equal(final.retiredReason, 'obsolete');
  assert.equal('retired_reason' in final, false);
  const textsBefore = body.lessons.map((x) => x.text);
  assert.deepEqual(new Set(textsBefore), new Set([lessonInput.text, 'Document new routes with their consumers.']));
} finally { await new Promise((resolve) => server.close(resolve)); }
console.log('review-lessons-transport tests passed');
