import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createCretliMcpToolHandlers } from '../lib/mcp/builtin/catalog.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { CretliApiClient } from '../lib/remote-api-client.js';
import { registerReviewLessonsRoutes } from '../lib/routes/review-lessons-routes.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';
import { saveChats } from '../lib/persist/chats-persist.js';
import { recordReviewFindings } from '../lib/persist/review-findings-ledger-persist.js';
import { listLessons } from '../lib/review-lessons-service.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';

setBuiltinMcpRuntimeDeps({ dataDir: process.env.CRETLI_TEST_DATA_DIR });
const WS_A = `${ISOLATED_DATA_DIR}/ws-a`;
const WS_B = `${ISOLATED_DATA_DIR}/ws-b`;
const FOREIGN = `${ISOLATED_DATA_DIR}-foreign`;
saveChats([
  { id: 'remote', title: 'remote', workspaceFolder: WS_A },
  { id: 'local', title: 'local', workspaceFolder: WS_B },
  { id: 'foreign', title: 'foreign', workspaceFolder: FOREIGN },
]);
function seed(workspaceFolder, category) {
  for (const count of [2, 1]) {
    recordReviewFindings({
      workspaceFolder, leafId: crypto.randomUUID(), delegationId: crypto.randomUUID(), attemptId: 'a', mode: 'audit',
      findings: Array.from({ length: count }, (_, i) => ({ id: `F${i + 1}`, status: 'FIXED', priority: 'P2', category, files: ['lib/x/a.js'], summary: `s${i}` })),
    });
  }
}
seed(WS_A, 'docs-not-updated');
seed(WS_B, 'caller-not-updated');

const routes = new Map();
registerReviewLessonsRoutes({ get: (p, fn) => routes.set(`GET ${p}`, fn), post: (p, fn) => routes.set(`POST ${p}`, fn), patch: (p, fn) => routes.set(`PATCH ${p}`, fn), delete: (p, fn) => routes.set(`DELETE ${p}`, fn) }, { dataDir: process.env.CRETLI_TEST_DATA_DIR, getCurrentWorkspace: () => [WS_A, WS_B] });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const handler = routes.get(`${req.method} ${url.pathname}`);
  if (!handler) { res.writeHead(404).end(); return; }
  const out = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { res.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); } };
  await handler({ query: Object.fromEntries(url.searchParams), body, params: {} }, out);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const client = new CretliApiClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, bearerToken: 'test' });
  const remote = createCretliMcpToolHandlers(client, { mode: 'agent', chatId: 'remote', workspaceFolder: WS_A });
  const local = createCretliMcpToolHandlers(createInProcessMcpClient({ harness: 'sdk', chatId: 'local', workspaceFolder: WS_B }), { mode: 'agent', chatId: 'local', workspaceFolder: WS_B });

  // Dry run writes nothing on either path.
  assert.equal((await remote.lesson_distill({ dry_run: true })).isError, false);
  assert.equal((await local.lesson_distill({ dry_run: true })).isError, false);
  assert.equal(listLessons(WS_A).length, 0);
  assert.equal(listLessons(WS_B).length, 0);

  // Both transports write candidates into the same server store (the one the routes list).
  const viaHttp = await remote.lesson_distill({});
  assert.equal(viaHttp.isError, false);
  const viaLocal = await local.lesson_distill({});
  assert.equal(viaLocal.isError, false);
  for (const [ws, category] of [[WS_A, 'docs-not-updated'], [WS_B, 'caller-not-updated']]) {
    const stored = listLessons(ws);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].category, category);
    assert.equal(stored[0].status, 'candidate');
    assert.equal(stored[0].origin, 'distilled');
  }
  const listed = await (await fetch(`http://127.0.0.1:${server.address().port}/api/review-lessons?workspaceFolder=${encodeURIComponent(WS_A)}&chatId=remote`)).json();
  assert.equal(listed.lessons.length, 1);
  // Repeating is idempotent on both paths.
  await remote.lesson_distill({});
  await local.lesson_distill({});
  assert.equal(listLessons(WS_A).length, 1);
  assert.equal(listLessons(WS_B).length, 1);

  // Scope: a foreign chat, or a folder outside the caller's workspace, is rejected on both paths.
  const foreignRemote = createCretliMcpToolHandlers(client, { mode: 'agent', chatId: 'foreign', workspaceFolder: WS_A });
  const foreignLocal = createCretliMcpToolHandlers(createInProcessMcpClient({ harness: 'sdk', chatId: 'foreign', workspaceFolder: WS_A }), { mode: 'agent', chatId: 'foreign', workspaceFolder: WS_A });
  assert.equal((await foreignRemote.lesson_distill({})).isError, true);
  assert.equal((await foreignLocal.lesson_distill({})).isError, true);
  assert.equal((await remote.lesson_distill({ workspace_folder: WS_B })).isError, true);
  assert.equal((await local.lesson_distill({ workspace_folder: WS_A })).isError, true);
  // The raw route also enforces scope.
  const denied = await fetch(`http://127.0.0.1:${server.address().port}/api/review-lessons/distill`, { method: 'POST', body: JSON.stringify({ workspaceFolder: WS_B, chatId: 'remote' }) });
  assert.equal(denied.status, 403);
} finally { await new Promise((resolve) => server.close(resolve)); }
console.log('review-lessons-distill-transport tests passed');
