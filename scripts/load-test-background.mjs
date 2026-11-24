#!/usr/bin/env node
/**
 * Background-load test for the interactive process.
 *
 * N background cycles run while a running Cretli server is probed. Each cycle:
 *   1. computes real todo readiness (lib/background-worker-tasks `todo-readiness`,
 *      the Watcher snapshot computation) on a synthetic list of >= 200 todos,
 *      either in this process (--mode inproc) or via the background worker
 *      (--mode worker, lib/background-worker.js);
 *   2. spawns a real child process (niced via lib/process-priority.js) running a
 *      bounded verify-like CPU command and checks its exit code.
 * Only successful cycles count; failures are tracked separately.
 *
 * Probed concurrently: UI routes and /login (only 2xx counts; 3xx only for
 * /login redirects), plus optional chat start/stream measurement.
 *
 * Chat start/stream is OPT-IN (needs auth and creates chat data on the server,
 * so it is never done implicitly). Set LOAD_CHAT_ENDPOINT (path of a POST
 * endpoint that streams, e.g. an SSE/NDJSON chat route of your deployment),
 * optionally LOAD_CHAT_BODY (JSON string) and LOAD_AUTH_HEADER ("Cookie: ..."
 * or "Authorization: ..."). Start latency = time to first body byte, stream
 * latency = time to last byte. Without it the output says "chat: skipped (...)".
 *
 * Event-loop lag: the server's p99 is not exposed by /api/health, so the JSON
 * reports (a) `loadGeneratorLoopLagP99Ms`, the lag of THIS process (it grows in
 * inproc mode and stays low in worker mode — the before/after signal), and
 * (b) `serverLoopLagP99Ms` only if LOAD_LAG_ENDPOINT returns a JSON number or
 * {p99Ms}. Route p95 is the primary server-side comparison.
 *
 * Usage: node scripts/load-test-background.mjs [--mode inproc|worker]
 *   [--cycles 20] [--concurrency 4] [--todos 300] [--base http://127.0.0.1:3011]
 *   [--duration-ms 20000] [--routes /,/login,/api/health] [--max-error-rate 0.05]
 * Env: LOAD_BASE_URL, LOAD_MODE, LOAD_CYCLES, LOAD_CONCURRENCY, LOAD_TODOS,
 *   LOAD_DURATION_MS, LOAD_ROUTES, LOAD_MAX_ERROR_RATE, LOAD_CHAT_ENDPOINT,
 *   LOAD_CHAT_BODY, LOAD_AUTH_HEADER, LOAD_LAG_ENDPOINT.
 * Exit: 0 ok, 1 error rate above threshold, 2 server unreachable.
 * Read-only for the repo: never touches data/.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { runBackgroundTask } from '../lib/background-worker-tasks.js';
import { runInBackgroundWorker, resetBackgroundWorker } from '../lib/background-worker.js';
import { applyBackgroundPriority } from '../lib/process-priority.js';
import { buildSyntheticTodos, classifyChatResponse, exitCodeFor, isSuccessStatus, percentile, summarizeRoute } from './load-test-lib.mjs';

function arg(name, env, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[env] ?? fallback;
}
const base = String(arg('base', 'LOAD_BASE_URL', `http://127.0.0.1:${process.env.PORT || 3011}`)).replace(/\/$/, '');
const mode = String(arg('mode', 'LOAD_MODE', 'worker'));
const cycles = Number(arg('cycles', 'LOAD_CYCLES', 20));
const concurrency = Math.max(1, Number(arg('concurrency', 'LOAD_CONCURRENCY', Math.max(2, os.cpus().length - 1))));
const todoCount = Math.max(200, Number(arg('todos', 'LOAD_TODOS', 300)));
const durationMs = Number(arg('duration-ms', 'LOAD_DURATION_MS', 20000));
const maxErrorRate = Number(arg('max-error-rate', 'LOAD_MAX_ERROR_RATE', 0.05));
const routes = String(arg('routes', 'LOAD_ROUTES', '/,/login,/api/health')).split(',').filter(Boolean);
const chatEndpoint = process.env.LOAD_CHAT_ENDPOINT || '';
const authHeader = process.env.LOAD_AUTH_HEADER || '';
const lagEndpoint = process.env.LOAD_LAG_ENDPOINT || '';
if (!['inproc', 'worker'].includes(mode)) { console.error('--mode must be inproc or worker'); process.exit(64); }

function headers(extra = {}) {
  const out = { ...extra };
  const idx = authHeader.indexOf(':');
  if (idx > 0) out[authHeader.slice(0, idx).trim()] = authHeader.slice(idx + 1).trim();
  return out;
}

async function probe(route) {
  const t = performance.now();
  const res = await fetch(base + route, { redirect: 'manual', headers: headers(), signal: AbortSignal.timeout(10000) });
  await res.arrayBuffer();
  const ms = performance.now() - t;
  // Redirects are legitimate only for /login (already-authenticated sessions).
  return { ok: isSuccessStatus(res.status, route === '/login', res.headers.get('location')), status: res.status, ms };
}

/** Opt-in chat start (first byte) and stream (last byte) latency. */
async function chatProbe() {
  const t = performance.now();
  // redirect: 'manual' so a bounce to the login page is an error, not a 200.
  const res = await fetch(base + chatEndpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: headers({ 'content-type': 'application/json' }),
    body: process.env.LOAD_CHAT_BODY || '{}',
    signal: AbortSignal.timeout(60000),
  });
  if (!res.body) return classifyChatResponse(res.status, []);
  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push({ atMs: performance.now() - t, bytes: value?.length || 0 });
  }
  return classifyChatResponse(res.status, chunks);
}

/** One background cycle; resolves { ok } and never throws. */
async function cycle(items) {
  try {
    const readiness = mode === 'worker'
      ? await runInBackgroundWorker('todo-readiness', { items })
      : runBackgroundTask('todo-readiness', { items });
    if (!Array.isArray(readiness?.readyIds) || !readiness.readyIds.length) return { ok: false };
  } catch { return { ok: false }; }
  const code = 'const t=Date.now();let x=0;while(Date.now()-t<300){for(let i=0;i<1e5;i++)x+=Math.sqrt(i)}process.exit(x>0?0:3)';
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    applyBackgroundPriority(child.pid);
    child.on('exit', (c) => resolve({ ok: c === 0 }));
    child.on('error', () => resolve({ ok: false }));
  });
}

try {
  const first = await probe('/login');
  if (first.status >= 500) throw new Error(`/login returned ${first.status}`);
} catch (error) {
  console.error(`Cannot reach ${base}: ${error.message}. Start Cretli or pass --base.`);
  process.exit(2);
}

const ok = Object.fromEntries(routes.map((r) => [r, []]));
const errs = Object.fromEntries(routes.map((r) => [r, 0]));
const chat = { start: [], stream: [], errors: 0 };
const serverLag = [];
const hist = monitorEventLoopDelay({ resolution: 10 });
hist.enable();
let stop = false;
const sampler = (async () => {
  while (!stop) {
    for (const r of routes) {
      try {
        const s = await probe(r);
        if (s.ok) ok[r].push(s.ms); else errs[r] += 1;
      } catch { errs[r] += 1; }
    }
    if (chatEndpoint) {
      try {
        const c = await chatProbe();
        if (c.ok) { chat.start.push(c.startMs); chat.stream.push(c.streamMs); } else chat.errors += 1;
      } catch { chat.errors += 1; }
    }
    if (lagEndpoint) {
      try {
        const j = await (await fetch(base + lagEndpoint, { headers: headers(), signal: AbortSignal.timeout(5000) })).json();
        const v = typeof j === 'number' ? j : j?.p99Ms;
        if (Number.isFinite(v)) serverLag.push(v);
      } catch { /* optional */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
})();

const items = buildSyntheticTodos(todoCount);
const started = performance.now();
let next = 0;
let done = 0;
let failed = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < cycles && performance.now() - started < durationMs) {
    next += 1;
    const r = await cycle(items);
    if (r.ok) done += 1; else failed += 1;
  }
}));
const elapsed = (performance.now() - started) / 1000;
stop = true;
await sampler;
hist.disable();
await resetBackgroundWorker();

const routeStats = Object.fromEntries(routes.map((r) => [r, summarizeRoute({ ok: ok[r], errors: errs[r] })]));
const attempted = done + failed;
const bgErrorRate = attempted ? failed / attempted : 0;
const chatStats = chatEndpoint
  ? { startP95Ms: percentile(chat.start, 0.95), streamP95Ms: percentile(chat.stream, 0.95), samples: chat.start.length, errors: chat.errors }
  : 'chat: skipped (set LOAD_CHAT_ENDPOINT and LOAD_AUTH_HEADER to measure chat start/stream; needs auth and creates chat data)';
const chatAttempts = chat.start.length + chat.errors;
const chatErrorRate = chatEndpoint && chatAttempts ? chat.errors / chatAttempts : 0;
const code = exitCodeFor([...Object.values(routeStats).map((s) => s.errorRate), bgErrorRate, chatErrorRate], maxErrorRate);
console.log(JSON.stringify({
  base, mode, todos: items.length, cycles, concurrency,
  background: {
    successfulCycles: done, failedCycles: failed, errorRate: Math.round(bgErrorRate * 1000) / 1000,
    throughputPerSec: Math.round((done / elapsed) * 100) / 100, elapsedSec: Math.round(elapsed * 100) / 100,
  },
  routes: routeStats,
  chat: chatStats,
  loadGeneratorLoopLagP99Ms: Math.round((hist.percentile(99) / 1e6) * 100) / 100,
  serverLoopLagP99Ms: serverLag.length ? percentile(serverLag, 0.99) : 'not measured (set LOAD_LAG_ENDPOINT)',
  maxErrorRate, exitCode: code,
}, null, 2));
process.exit(code);
