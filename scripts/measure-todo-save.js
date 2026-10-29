#!/usr/bin/env node
/**
 * Measures server-side layer timings of the TODO status save (PATCH /api/todos/:id).
 *
 * Builds three synthetic TODO trees in a temp data dir (never touches the real
 * data/), then times each layer of the route handler by calling the persist and
 * read-model functions directly, plus an end-to-end run through the real Express
 * route over loopback HTTP. Prints the median / p95 of N runs per layer.
 * Todos are read and written through the async `todos-store.js` facade; the
 * document size is measured from the facade's logical export, not from a file.
 *
 * Usage: node scripts/measure-todo-save.js [runs=7] [--json]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import { performance } from 'perf_hooks';

// The data dir must be redirected BEFORE the lib modules load (paths resolve at import time).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-todo-measure-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.CRETLI_DATA_DIR = dataDir;
const CHAT_COUNT = Number((process.argv.find((a) => a.startsWith('--chats=')) || '--chats=1500').split('=')[1]);
const { listTodos, updateTodo, addTodo, exportSnapshot } = await import('../lib/persist/todos-store.js');
const { checkReviewGateForTodoWrite } = await import('../lib/workspace-watcher-review-gate-guard.js');
const { attachTodoReviewReadModels } = await import('../lib/todo-review-read.js');
const { attachTodoIntegrationReadModels } = await import('../lib/todo-integration-read.js');
const { annotateBatchEligibility } = await import('../lib/integrate-batch.js');
const { slimTodoForList, registerTodosRoutes } = await import('../lib/routes/todos-routes.js');
const { loadChats } = await import('../lib/persist/chats-persist.js');
const { buildTodoChatIndex, enrichTodoItemsWithSourceChat } = await import('../lib/todo-source-chat.js');
const { readWorktreeRegistry } = await import('../lib/persist/worktree-registry-persist.js');
const { fork } = await import('child_process');

const RUNS = Math.max(5, Number(process.argv.find((a) => /^\d+$/.test(a))) || 7);
const AS_JSON = process.argv.includes('--json');


const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';

/**
 * Builds a tree: one root with `children` leaf children; returns the root id.
 *
 * @param {string} cwd
 * @param {{ children: number, bodyLen: number, planLen: number, changelog: number, manifestPaths?: number }} opts
 */
async function buildTree(cwd, { children, bodyLen, planLen, changelog, manifestPaths }) {
  const root = (await addTodo(dataDir, cwd, { title: 'Root', body: lorem.repeat(Math.ceil(bodyLen / lorem.length)).slice(0, bodyLen), status: 'idea' })).item;
  for (let i = 0; i < children; i += 1) {
    await addTodo(dataDir, cwd, { title: `Child ${i}`, body: 'child body', status: 'idea', parentId: root.id });
  }
  if (manifestPaths) {
    // Checkpointed leaves carry per-file hash manifests (project-mode leafMaterial).
    const manifest = Object.fromEntries(Array.from({ length: manifestPaths }, (_, i) => [`src/module-${i}/file.js`, `${i}`.padStart(40, 'a')]));
    const leafMaterial = { mode: 'project', baseCapturedAt: new Date().toISOString(), baseManifest: manifest, lastCheckpoint: { at: new Date().toISOString(), manifest: { ...manifest } } };
    for (const row of (await listTodos(dataDir, cwd)).items) {
      if (row.id === root.id) continue;
      await updateTodo(dataDir, cwd, row.id, { leafMaterial });
    }
  }
  if (planLen) await updateTodo(dataDir, cwd, root.id, { plan: { markdown: lorem.repeat(Math.ceil(planLen / lorem.length)).slice(0, planLen) } });
  for (let i = 0; i < changelog; i += 1) {
    await updateTodo(dataDir, cwd, root.id, { appendChangelog: { kind: 'note', text: lorem.repeat(40).slice(0, 2000) + i } });
  }
  return root.id;
}

const SCENARIOS = [
  { name: 'small (1 root + 2 children)', opts: { children: 2, bodyLen: 200, planLen: 0, changelog: 0 } },
  { name: 'large body/plan (8000 B body, 32000 B plan, 100 changelog)', opts: { children: 2, bodyLen: 8000, planLen: 32000, changelog: 100 } },
  { name: 'wide (1 root + 30 children)', opts: { children: 30, bodyLen: 500, planLen: 0, changelog: 0 } },
  { name: 'wide+manifests (1 root + 30 children, 2 x 2500-path manifests each)', opts: { children: 30, bodyLen: 500, planLen: 0, changelog: 0, manifestPaths: 2500 } },
  { name: 'wide+large (1 root + 60 children, big body/plan)', opts: { children: 60, bodyLen: 8000, planLen: 32000, changelog: 100 } },
];

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
const time = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };

function httpPatch(port, id, cwd, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ ...body, workspaceFolder: cwd });
    const t0 = performance.now();
    const req = http.request({ host: '127.0.0.1', port, path: `/api/todos/${id}`, method: 'PATCH', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ ms: performance.now() - t0, status: res.statusCode, bytes: Buffer.concat(chunks).length }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const app = express();
app.use(express.json({ limit: '5mb' }));
const ctx = {
  dataDir,
  getCurrentCwd: () => tmp,
  getLocalCallbackBaseUrl: () => 'http://127.0.0.1',
  worktreeDeps: {},
};
let routesOk = true;
try { registerTodosRoutes(app, /** @type {any} */ (ctx)); } catch (e) { routesOk = false; console.error('registerTodosRoutes failed:', e.message); }
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;

// Synthetic global chat store (chats.json) so the payload's chat index has realistic work.
function writeChats(cwd, todoIds) {
  const chats = Array.from({ length: CHAT_COUNT }, (_, i) => ({
    id: `chat-${i}`, title: `Chat ${i}`, cursorSessionId: `s-${i}`, workspaceFolder: i % 3 ? cwd : '/other/ws',
    createdAt: new Date().toISOString(), agentTransport: 'sdk',
    ...(i < todoIds.length ? { todoId: todoIds[i] } : {}),
  }));
  fs.writeFileSync(path.join(dataDir, 'chats.json'), JSON.stringify({ chats }));
}

/** Replays the response-building half of the handler (jsonTodosPayload). */
function buildPayload(cwd, data) {
  const t = {};
  let t0 = performance.now();
  const chats = loadChats(); t.loadChats = performance.now() - t0;
  t0 = performance.now();
  const index = buildTodoChatIndex(chats, { workspaceFolder: cwd });
  const enriched = enrichTodoItemsWithSourceChat(data.items, index, cwd); t.chatEnrich = performance.now() - t0;
  t0 = performance.now();
  try { readWorktreeRegistry({ dataDir }); } catch { /* absent registry */ }
  const withRm = attachTodoIntegrationReadModels(attachTodoReviewReadModels(enriched)); t.readModels = performance.now() - t0;
  t0 = performance.now();
  const items = annotateBatchEligibility({ dataDir, workspaceFolder: cwd, items: withRm }).map((item) => slimTodoForList(item)); t.batchElig = performance.now() - t0;
  t0 = performance.now();
  const json = JSON.stringify({ ok: true, items }); t.serialize = performance.now() - t0;
  return { t, bytes: json.length };
}

const LAYERS = ['gate', 'updateTodo', 'reloadAfterWrite', 'loadChats', 'chatEnrich', 'readModels', 'batchElig', 'serialize', 'e2eHttp'];
const results = [];
for (const sc of SCENARIOS) {
  const cwd = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const rootId = await buildTree(cwd, sc.opts);
  writeChats(cwd, (await listTodos(dataDir, cwd)).items.map((r) => r.id));
  const size = Buffer.byteLength(JSON.stringify(await exportSnapshot(dataDir, cwd)));
  const layers = Object.fromEntries(LAYERS.map((k) => [k, []]));
  let payloadBytes = 0;
  const statuses = ['ready', 'idea'];
  for (let i = 0; i < RUNS + 1; i += 1) {
    const status = statuses[i % 2];
    const [gateMs] = await time(() => checkReviewGateForTodoWrite({ dataDir, workspaceFolder: cwd, todoId: rootId, patch: { status }, caller: { kind: 'session' } }));
    const [updMs] = await time(() => updateTodo(dataDir, cwd, rootId, { status }));
    const [loadMs, data] = await time(() => listTodos(dataDir, cwd));
    // A chat write between saves invalidates the chats.json cache (as live agent runs do).
    writeChats(cwd, data.items.map((r) => r.id));
    const pl = buildPayload(cwd, data);
    payloadBytes = pl.bytes;
    const e2e = routesOk ? await httpPatch(port, rootId, cwd, { status: statuses[(i + 1) % 2] }) : { ms: NaN };
    if (i === 0) continue; // warm-up
    const vals = { gate: gateMs, updateTodo: updMs, reloadAfterWrite: loadMs, ...pl.t, e2eHttp: e2e.ms };
    for (const k of LAYERS) layers[k].push(vals[k]);
  }
  const row = { scenario: sc.name, docBytes: size, items: (await listTodos(dataDir, cwd)).items.length, payloadBytes, runs: RUNS };
  for (const [k, v] of Object.entries(layers)) row[k] = { p50: +median(v).toFixed(2), p95: +p95(v).toFixed(2) };
  results.push(row);
}

// Lock contention: another process holds the shared workspace-watchers lock for HOLD_MS.
const HOLD_MS = 400;
{
  const cwd = fs.mkdtempSync(path.join(tmp, 'ws-'));
  const rootId = await buildTree(cwd, SCENARIOS[2].opts);
  const holder = path.join(tmp, 'holder.mjs');
  fs.writeFileSync(holder, `process.env.CRETLI_DATA_DIR=${JSON.stringify(dataDir)};
const { withWorkspaceWatchersFileLock } = await import(${JSON.stringify(new URL('../lib/persist/workspace-watchers-persist.js', import.meta.url).href)});
process.on('message', () => { withWorkspaceWatchersFileLock(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${HOLD_MS}); }, { dataDir: ${JSON.stringify(dataDir)} }); process.send('done'); });
process.send('ready');`);
  const child = fork(holder, [], { silent: true });
  await new Promise((r) => child.once('message', r));
  const waits = [];
  for (let i = 0; i < RUNS; i += 1) {
    const done = new Promise((r) => child.once('message', r));
    child.send('go');
    await new Promise((r) => setTimeout(r, 40)); // let the holder take the lock
    const [ms] = await time(() => updateTodo(dataDir, cwd, rootId, { status: i % 2 ? 'idea' : 'ready' }));
    waits.push(ms);
    await done;
  }
  child.kill();
  results.push({ scenario: `lock contention (holder keeps lock ${HOLD_MS} ms)`, updateTodo: { p50: +median(waits).toFixed(1), p95: +p95(waits).toFixed(1) }, runs: RUNS });
}
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (AS_JSON) console.log(JSON.stringify(results, null, 2));
else {
  console.log(`runs per scenario: ${RUNS} (+1 warm-up), ${CHAT_COUNT} synthetic chats. Values: p50 / p95 ms`);
  for (const r of results) {
    console.log(`\n${r.scenario}${r.docBytes ? `  [doc ${r.docBytes} B, ${r.items} items, response ${r.payloadBytes} B]` : ''}`);
    for (const k of LAYERS) if (r[k]) console.log(`  ${k.padEnd(18)} ${r[k].p50} / ${r[k].p95}`);
  }
}
process.exit(0);
