#!/usr/bin/env node
// Performance benchmark: boots the server against an isolated data directory filled with a
// synthetic dataset, then measures boot time, an idle window and a synthetic request load,
// and prints PASS/FAIL against budgets. It never reads or writes the real data/ directory:
// CRETLI_DATA_DIR and HOME point at a temp directory, and the dataset is generated, not copied.
//
//   node scripts/perf-bench.mjs [--chats 10000] [--delegations 7000] [--todos 2000]
//        [--idle-seconds 60] [--load-seconds 10] [--concurrency 16] [--keep]
//        [--generate-only <dir>] [--budget boot_ms=60000,idle_p99_ms=200,...]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_SIZES = Object.freeze({ chats: 10000, delegations: 7000, todos: 2000 });
export const DEFAULT_BUDGETS = Object.freeze({
  boot_ms: 60000,
  idle_loop_p99_ms: 200,
  idle_elu: 0.25,
  load_latency_p99_ms: 1000,
  load_loop_p99_ms: 500,
  load_error_rate: 0.01,
});

/** Deterministic PRNG so two runs build identical datasets. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Write a synthetic dataset in the legacy JSON layout (chats.json, delegations.json,
 * todos/<workspace-key>.json). Sizes are configurable; content is generic fiction.
 *
 * @param {{ dir: string, workspace: string, chats?: number, delegations?: number, todos?: number, seed?: number, todosFile?: string }} options
 * @returns {{ chats: number, delegations: number, todos: number, files: string[] }}
 */
export function generateDataset({ dir, workspace, chats = DEFAULT_SIZES.chats, delegations = DEFAULT_SIZES.delegations, todos = DEFAULT_SIZES.todos, seed = 1, todosFile }) {
  const rand = mulberry32(seed);
  const base = Date.UTC(2026, 0, 1);
  const iso = (offsetMin) => new Date(base + offsetMin * 60_000).toISOString();
  const id = (prefix, n) => `${prefix}-${String(n).padStart(8, '0')}-0000-4000-8000-${String(Math.floor(rand() * 1e12)).padStart(12, '0')}`;
  fs.mkdirSync(dir, { recursive: true });
  const files = [];

  const chatRows = Array.from({ length: chats }, (_, i) => ({
    id: id('c', i),
    title: `Synthetic chat ${i}`,
    cursorSessionId: '',
    agentTransport: 'sdk',
    workspaceFolder: workspace,
    createdAt: iso(i),
    updatedAt: iso(i + 5),
  }));
  const chatFile = path.join(dir, 'chats.json');
  fs.writeFileSync(chatFile, JSON.stringify({ chats: chatRows }));
  files.push(chatFile);

  const statuses = ['completed', 'completed', 'completed', 'failed', 'cancelled'];
  const delegationRows = Array.from({ length: delegations }, (_, i) => ({
    id: id('d', i),
    parentChatId: chatRows[Math.floor(rand() * Math.max(1, chats))]?.id || '',
    harness: 'sdk',
    model: 'synthetic-model',
    status: statuses[i % statuses.length],
    assignment: i % 3 === 0 ? 'review' : 'implement',
    createdAt: iso(i),
    updatedAt: iso(i + 3),
    report: `Synthetic report ${i}\nVERDICT: PASS`,
  }));
  const delegationFile = path.join(dir, 'delegations.json');
  fs.writeFileSync(delegationFile, JSON.stringify({ v: 2, items: delegationRows }));
  files.push(delegationFile);

  const todoStatuses = ['done', 'done', 'idea', 'ready'];
  const todoRows = Array.from({ length: todos }, (_, i) => ({
    id: id('t', i),
    title: `Synthetic todo ${i}`,
    body: `Body of synthetic todo ${i}.`,
    status: todoStatuses[i % todoStatuses.length],
    parentId: '',
    siblingIndex: i,
    createdAt: iso(i),
    updatedAt: iso(i + 1),
  }));
  const todoPath = todosFile || path.join(dir, 'todos', `${createHash('sha256').update(workspace).digest('hex')}.json`);
  fs.mkdirSync(path.dirname(todoPath), { recursive: true });
  fs.writeFileSync(todoPath, JSON.stringify({ version: 1, updatedAt: iso(0), items: todoRows, idempotency: {} }));
  files.push(todoPath);
  return { chats, delegations, todos, files };
}

/** @param {number[]} values */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * Compare measurements with budgets (every budget is an upper bound).
 *
 * @param {Record<string, number>} measured
 * @param {Record<string, number>} budgets
 * @returns {{ name: string, value: number | null, budget: number, pass: boolean }[]}
 */
export function evaluateBudgets(measured, budgets = DEFAULT_BUDGETS) {
  return Object.entries(budgets).map(([name, budget]) => {
    const value = Number.isFinite(measured[name]) ? measured[name] : null;
    // A missing measurement is a failure: an unmeasured budget must not read as PASS.
    return { name, value, budget, pass: value !== null && value <= budget };
  });
}

/** @param {string} spec e.g. "boot_ms=30000,idle_elu=0.1" */
export function parseBudgetOverrides(spec) {
  const out = { ...DEFAULT_BUDGETS };
  for (const part of String(spec || '').split(',').filter(Boolean)) {
    const [key, raw] = part.split('=');
    if (!(key in DEFAULT_BUDGETS)) throw new Error(`Unknown budget: ${key}`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid budget value for ${key}: ${raw}`);
    out[key] = value;
  }
  return out;
}

function parseArgs(argv) {
  const opts = { ...DEFAULT_SIZES, idleSeconds: 60, loadSeconds: 10, concurrency: 16, keep: false, generateOnly: '', budget: '', bootTimeoutSeconds: 180 };
  const numeric = { '--chats': 'chats', '--delegations': 'delegations', '--todos': 'todos', '--idle-seconds': 'idleSeconds', '--load-seconds': 'loadSeconds', '--concurrency': 'concurrency', '--boot-timeout-seconds': 'bootTimeoutSeconds' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (numeric[arg]) {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} needs a non-negative number`);
      opts[numeric[arg]] = value;
    } else if (arg === '--keep') opts.keep = true;
    else if (arg === '--generate-only') opts.generateOnly = String(argv[++i] || '');
    else if (arg === '--budget') opts.budget = String(argv[++i] || '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function metricsWindow(health, key) {
  return health?.load?.hostResources?.serverMetrics?.windows?.[key] || {};
}

async function run(opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-perf-bench-'));
  const dataDir = path.join(tmp, 'data');
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const real = fs.realpathSync(workspace);
  const started = Date.now();
  const generated = generateDataset({ dir: dataDir, workspace: real, chats: opts.chats, delegations: opts.delegations, todos: opts.todos });
  console.log(`dataset: ${generated.chats} chats, ${generated.delegations} delegations, ${generated.todos} todos (${Date.now() - started} ms) in ${dataDir}`);

  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, CRETLI_DATA_DIR: dataDir, CURSOR_REMOTE_DATA_DIR: dataDir, HOME: tmp, PORT: String(port), CRETLI_BIND: '127.0.0.1', USE_HTTPS: '0', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log = (log + chunk).slice(-4000); });
  child.stderr.on('data', (chunk) => { log = (log + chunk).slice(-4000); });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const measured = {};
  try {
    const bootStart = Date.now();
    for (;;) {
      if (exited) throw new Error(`server exited during boot:\n${log}`);
      if (Date.now() - bootStart > opts.bootTimeoutSeconds * 1000) throw new Error(`boot timeout:\n${log}`);
      try { await getHealth(port); break; } catch { await sleep(100); }
    }
    measured.boot_ms = Date.now() - bootStart;
    console.log(`boot: ${measured.boot_ms} ms`);

    await sleep(opts.idleSeconds * 1000);
    const idle = await getHealth(port);
    const idleWindow = metricsWindow(idle, '1m');
    measured.idle_loop_p99_ms = idleWindow.eventLoopDelayMs?.p99;
    measured.idle_elu = idleWindow.elu;
    console.log(`idle ${opts.idleSeconds}s: loop p99 ${measured.idle_loop_p99_ms} ms, ELU ${measured.idle_elu}, heapUsed ${idleWindow.heapUsedBytes?.last}`);

    const latencies = [];
    let errors = 0;
    const deadline = Date.now() + opts.loadSeconds * 1000;
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
      while (Date.now() < deadline) {
        const t0 = performance.now();
        try { await getHealth(port); latencies.push(performance.now() - t0); } catch { errors += 1; }
      }
    }));
    const after = await getHealth(port);
    measured.load_latency_p99_ms = Math.round(percentile(latencies, 99) * 10) / 10;
    measured.load_loop_p99_ms = metricsWindow(after, '1m').eventLoopDelayMs?.p99;
    measured.load_error_rate = errors / Math.max(1, errors + latencies.length);
    console.log(`load ${opts.loadSeconds}s x${opts.concurrency}: ${latencies.length} ok, ${errors} errors, p50 ${Math.round(percentile(latencies, 50))} ms, p99 ${measured.load_latency_p99_ms} ms`);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(10_000)]);
    if (!exited) child.kill('SIGKILL');
    if (!opts.keep) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`kept ${tmp}`);
  }
  return measured;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.generateOnly) {
    const dir = path.resolve(opts.generateOnly);
    // Refuse the project data dir: the benchmark only writes into directories it was handed explicitly.
    if (dir === path.join(REPO_ROOT, 'data')) throw new Error('Refusing to write into the real data/ directory');
    const result = generateDataset({ dir, workspace: path.join(dir, 'workspace'), chats: opts.chats, delegations: opts.delegations, todos: opts.todos });
    console.log(`generated ${result.files.length} files in ${dir}`);
    return 0;
  }
  const budgets = parseBudgetOverrides(opts.budget);
  const results = evaluateBudgets(await run(opts), budgets);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}: ${r.value ?? 'n/a'} (budget <= ${r.budget})`);
  const ok = results.every((r) => r.pass);
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => { console.error(error?.message || error); process.exit(2); });
}
