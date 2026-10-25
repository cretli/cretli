#!/usr/bin/env node
/**
 * V9 mixed-load and 20-cycle stability harness (docs/architecture-acceptance.md
 * criteria C8/C9). It boots the real Express app with the real chats, settings
 * and workspace-watcher routes against an isolated synthetic fixture (never the
 * repository `data/` directory), then drives at the same time:
 *
 *   - four read streams (paged list, list sync delta, title history, settings),
 *   - the Workspace Watcher tick (`POST /api/workspace-watcher/tick`),
 *   - periodic status bursts (concurrent `POST /api/chats/:id/seen`),
 *
 * and records the main-thread event-loop delay at 1 ms resolution with
 * perf_hooks.monitorEventLoopDelay (the resolution required by
 * docs/storage-gates.md), per-request latency (n/P50/P95/P99/max) and a
 * memory/listener/timer/subprocess snapshot.
 *
 * The `titleHistory` stream is `GET /api/chats/:id/title-history` (a small
 * JSON payload of ~100 B). The chat event history (`GET /api/chats/:id/history`)
 * is NOT exercised by this harness.
 *
 * Limits, stated explicitly in the report:
 *   - The HTTP client, the Express app and the monitor share one process, so the
 *     event-loop numbers include the driver. They are a conservative estimate
 *     for server-side work, not a whole-app run.
 *   - There are no real agent streams and no browser: "streams" are concurrent
 *     HTTP consumers of the same routes the UI uses.
 *
 * Usage:
 *   node scripts/architecture-mixed-load.mjs --mode mixed --duration-ms 600000 \
 *     --size 5000 --out docs/architecture-acceptance/measurements/mixed-load.json
 *   node scripts/architecture-mixed-load.mjs --mode cycles --cycles 20 --cycle-ms 3000 \
 *     --size 5000 --out docs/architecture-acceptance/measurements/cycles-20.json
 * Smoke profile (fast sanity check):
 *   node scripts/architecture-mixed-load.mjs --mode both --duration-ms 5000 --cycles 2 \
 *     --cycle-ms 1000 --size 500 --profile smoke
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

const STABLE_P99_SAMPLES = 1000;
const EVENT_LOOP_RESOLUTION_MS = 1;
const NS_PER_MS = 1e6;
const BUDGETS = Object.freeze({
  appEventLoopP99Ms: 100,
  appEventLoopMaxMs: 500,
  storageEventLoopP99Ms: 25,
  storageEventLoopMaxMs: 100,
});

/** @param {number} value */
const round = (value) => Math.round(value * 1000) / 1000;

/** @param {number[]} samples */
export function stats(samples) {
  if (samples.length === 0) return { n: 0, p50: null, p95: null, p99: null, p99Label: 'n/a', max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    n: sorted.length,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    p99Label: sorted.length >= STABLE_P99_SAMPLES ? 'stable' : 'exploratory',
    max: round(sorted[sorted.length - 1]),
  };
}

/**
 * @param {number} port
 * @param {'GET'|'POST'} method
 * @param {string} url
 * @param {object} [body]
 * @param {{ parseJson?: boolean }} [options] parse only the small responses (tick) so the
 *   large list payloads stay out of the measurement's own CPU budget
 */
function request(port, method, url, body, options = {}) {
  const { parseJson = false } = options;
  return new Promise((resolve) => {
    const started = performance.now();
    const payload = body === undefined ? null : JSON.stringify(body);
    const chunks = [];
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: url,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : { 'content-type': 'application/json' },
      },
      (res) => {
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (parseJson) chunks.push(chunk);
        });
        res.on('end', () => {
          let json = null;
          if (parseJson) {
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              json = null;
            }
          }
          resolve({ ms: performance.now() - started, bytes, status: res.statusCode, json });
        });
      },
    );
    req.on('error', (err) => resolve({ ms: performance.now() - started, bytes: 0, status: 0, error: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** @param {import('node:perf_hooks').IntervalHistogram} histogram */
function summarizeEventLoop(histogram) {
  const ms = (ns) => round(ns / NS_PER_MS);
  return {
    resolutionMs: EVENT_LOOP_RESOLUTION_MS,
    p50: ms(histogram.percentile(50)),
    p95: ms(histogram.percentile(95)),
    p99: ms(histogram.percentile(99)),
    max: ms(histogram.max),
  };
}

/**
 * Listener counts on the long-lived emitters this harness owns. `activeHandles`
 * is NOT a listener count, so C9 needs a real one: sum `listenerCount` over
 * every registered event name of the HTTP server, the Express app and the
 * process. Scope is these three emitters, not every emitter in the process.
 *
 * @param {{ server?: import('node:http').Server, app?: import('express').Express }} owners
 */
function listenerSnapshot({ server, app }) {
  const count = (emitter) => {
    if (!emitter || typeof emitter.eventNames !== 'function') return 0;
    return emitter.eventNames()
      .reduce((sum, name) => sum + emitter.listenerCount(name), 0);
  };
  const httpServer = count(server);
  const expressApp = count(app);
  const processListeners = count(process);
  return {
    httpServer,
    expressApp,
    process: processListeners,
    total: httpServer + expressApp + processListeners,
  };
}

/**
 * Memory, listener, timer and subprocess snapshot.
 *
 * @param {{ server?: import('node:http').Server, app?: import('express').Express }} [owners]
 */
function resourceSnapshot({ server, app } = {}) {
  const memory = process.memoryUsage();
  const resources = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  const resourceCounts = {};
  for (const name of resources) resourceCounts[name] = (resourceCounts[name] || 0) + 1;
  const proc = /** @type {any} */ (process);
  const handles = typeof proc._getActiveHandles === 'function' ? proc._getActiveHandles() : [];
  return {
    rssMb: round(memory.rss / 1048576),
    heapUsedMb: round(memory.heapUsed / 1048576),
    externalMb: round(memory.external / 1048576),
    activeHandles: handles.length,
    childProcesses: handles.filter((handle) => handle?.constructor?.name === 'ChildProcess').length,
    timers: resourceCounts.Timeout || 0,
    listeners: listenerSnapshot({ server, app }),
    resources: resourceCounts,
  };
}

/** One real subprocess create-close cycle so the child-process delta is meaningful. */
function runSubprocessCycle() {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('error', (err) => resolve({ ok: false, ms: round(performance.now() - started), error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, ms: round(performance.now() - started) }));
  });
}

/**
 * Runs the four read streams plus the Watcher tick until `deadline`.
 * @param {{ port: number, deadline: number, ids: string[], titleHistoryId: string, workspaceFolder?: string, burstFirst?: boolean, onSample?: (name: string, ms: number, status: number) => void }} options
 */
async function runMixedWindow({ port, deadline, ids, titleHistoryId, workspaceFolder, burstFirst = false, onSample }) {
  const samples = {
    page: [],
    sync: [],
    titleHistory: [],
    settings: [],
    watcherTick: [],
    statusBurst: [],
  };
  const errors = {};
  const watcherActions = {};
  const record = (name, result) => {
    samples[name].push(result.ms);
    if (result.status < 200 || result.status >= 300) {
      const key = `${name}:${result.status || 'network'}`;
      errors[key] = (errors[key] || 0) + 1;
    }
    onSample?.(name, result.ms, result.status);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const loops = [];

  loops.push((async () => {
    while (performance.now() < deadline) {
      record('page', await request(port, 'GET', '/api/chats/page?limit=100'));
      await sleep(50);
    }
  })());
  loops.push((async () => {
    while (performance.now() < deadline) {
      record('sync', await request(port, 'GET', '/api/chats/sync?since=bench-epoch.1'));
      await sleep(100);
    }
  })());
  loops.push((async () => {
    while (performance.now() < deadline) {
      record('titleHistory', await request(port, 'GET', `/api/chats/${titleHistoryId}/title-history`));
      await sleep(200);
    }
  })());
  loops.push((async () => {
    while (performance.now() < deadline) {
      record('settings', await request(port, 'GET', '/api/settings'));
      await sleep(200);
    }
  })());
  loops.push((async () => {
    while (performance.now() < deadline) {
      const result = await request(port, 'POST', '/api/workspace-watcher/tick', { workspaceFolder }, { parseJson: true });
      // The route spreads the control result, so the tick action is nested.
      const action = typeof result.json?.tick?.action === 'string'
        ? result.json.tick.action
        : (typeof result.json?.action === 'string' ? result.json.action : 'unparsed');
      watcherActions[action] = (watcherActions[action] || 0) + 1;
      // HTTP 200 alone does not prove the Watcher ran: a workspace without a
      // watcher row answers `no_watcher` and an `off` row is a no-op. Both are
      // recorded as failed tick evidence for C8.
      if (result.status >= 200 && result.status < 300 && (action === 'no_watcher' || action === 'off' || action === 'unparsed')) {
        const key = `watcherTick:${action}`;
        errors[key] = (errors[key] || 0) + 1;
      }
      record('watcherTick', result);
      await sleep(1000);
    }
  })());
  loops.push((async () => {
    const burst = () => Promise.all(Array.from({ length: 20 }, (_, i) => {
      const chatId = ids[i % ids.length];
      return request(port, 'POST', `/api/chats/${chatId}/seen`, {}).then((result) => record('statusBurst', result));
    }));
    let first = true;
    while (performance.now() < deadline) {
      if (!first) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await sleep(Math.min(15_000, remaining));
      }
      first = false;
      if (performance.now() >= deadline) break;
      await burst();
      if (burstFirst) break;
    }
  })());

  await Promise.all(loops);
  const result = { streams: {}, errors, watcherActions };
  for (const [name, values] of Object.entries(samples)) result.streams[name] = stats(values);
  return result;
}

/** One request per endpoint before the measured window (steady state, not startup). */
async function warmUp({ port, ids, titleHistoryId, workspaceFolder }) {
  await request(port, 'GET', '/api/chats/page?limit=100');
  await request(port, 'GET', '/api/chats/sync?since=bench-epoch.1');
  await request(port, 'GET', `/api/chats/${titleHistoryId}/title-history`);
  await request(port, 'GET', '/api/settings');
  await request(port, 'POST', '/api/workspace-watcher/tick', { workspaceFolder });
  await request(port, 'POST', `/api/chats/${ids[0]}/seen`, {});
}

async function runCycles({ port, cycles, cycleMs, ids, titleHistoryId, workspaceFolder, server, app }) {
  const snapshots = [];
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
    histogram.enable();
    const started = performance.now();
    const window = await runMixedWindow({ port, deadline: started + cycleMs, ids, titleHistoryId, workspaceFolder, burstFirst: true });
    // Real create-close cycle: without it a `childProcesses 0 -> 0` delta only
    // proves that nothing ever spawned.
    const subprocess = await runSubprocessCycle();
    histogram.disable();
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (typeof global.gc === 'function') global.gc();
    snapshots.push({
      cycle,
      durationMs: round(performance.now() - started),
      eventLoop: summarizeEventLoop(histogram),
      resources: resourceSnapshot({ server, app }),
      subprocess,
      requests: Object.fromEntries(Object.entries(window.streams).map(([name, value]) => [name, value.n])),
      watcherActions: window.watcherActions,
      errors: window.errors,
    });
  }
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const delta = (key) => round((last.resources[key] || 0) - (first.resources[key] || 0));
  const listenerDelta = (key) => round((last.resources.listeners?.[key] || 0) - (first.resources.listeners?.[key] || 0));
  return {
    cycles: snapshots,
    summary: {
      firstCycle: first.resources,
      lastCycle: last.resources,
      delta: {
        rssMb: delta('rssMb'),
        heapUsedMb: delta('heapUsedMb'),
        externalMb: delta('externalMb'),
        activeHandles: delta('activeHandles'),
        timers: delta('timers'),
        childProcesses: delta('childProcesses'),
        listenersTotal: listenerDelta('total'),
        listenersHttpServer: listenerDelta('httpServer'),
        listenersExpressApp: listenerDelta('expressApp'),
        listenersProcess: listenerDelta('process'),
      },
      subprocessCycles: {
        attempted: snapshots.length,
        ok: snapshots.filter((row) => row.subprocess?.ok === true).length,
      },
      eventLoopMaxOfCycles: round(Math.max(...snapshots.map((row) => row.eventLoop.max))),
      eventLoopP99MaxOfCycles: round(Math.max(...snapshots.map((row) => row.eventLoop.p99))),
    },
  };
}

async function main() {
  const mode = option('--mode', 'mixed');
  const size = Number(option('--size', '5000'));
  const profile = option('--profile', 'full');
  const seed = Number(option('--seed', '20261017'));
  const durationMs = Number(option('--duration-ms', '600000'));
  const cycles = Number(option('--cycles', '20'));
  const cycleMs = Number(option('--cycle-ms', '3000'));
  const out = option('--out', '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-mixed-load-'));
  const fixtureDir = path.join(dir, 'data');
  const report = {
    schema: 1,
    mode,
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model || '',
      cpuCount: os.cpus().length,
      totalMemMb: Math.round(os.totalmem() / 1048576),
      eventLoopResolutionMs: EVENT_LOOP_RESOLUTION_MS,
      listenerScope: 'HTTP server, Express app and process: sum of listenerCount over eventNames; not every emitter instance in the app',
      note: 'HTTP driver, Express app and event-loop monitor share one process; numbers include the driver. No real agent streams and no browser.',
      budgets: BUDGETS,
    },
    fixture: null,
    mixed: null,
    cycles: null,
  };
  try {
    const { populateFixture } = await import('./architecture-http-fixture.mjs');
    report.fixture = await populateFixture({ dir: fixtureDir, size, profile, seed });
    const { default: express } = await import('express');
    const { registerChatsRoutes } = await import('../lib/routes/chats-routes.js');
    const { registerSettingsRoutes } = await import('../lib/routes/settings-routes.js');
    const { registerWorkspaceWatcherRoutes } = await import('../lib/routes/workspace-watcher-routes.js');
    const app = express();
    app.use(express.json());
    registerChatsRoutes(app, { dataDir: fixtureDir });
    registerSettingsRoutes(app, {
      getLanHost: () => null,
      getConfiguredWorkspaceSelection: () => ({ workspaceFile: '', workspaceFolder: '' }),
      isSessionSyncEnabled: () => false,
      useHttps: false,
      port: 0,
      serverInstanceToken: 'mixed-load',
      frontHotFallbackEnabled: false,
    });
    const chats = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'chats.json'), 'utf8')).chats;
    const hotFolder = chats[0].workspaceFolder;
    registerWorkspaceWatcherRoutes(app, { dataDir: fixtureDir, getCurrentCwd: () => hotFolder });
    // C8 is about the Watcher, not about generic HTTP bursts: a workspace
    // without a watcher row answers `no_watcher` (a no-op), so configure a real
    // observe-mode row first and reject `no_watcher`/`off` ticks below.
    const { applyWorkspaceWatcherPatch } = await import('../lib/workspace-watcher-control.js');
    applyWorkspaceWatcherPatch({
      dataDir: fixtureDir,
      workspaceFolder: hotFolder,
      patch: { mode: 'observe', enabled: true },
    });
    report.watcher = { configured: true, mode: 'observe' };
    const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const port = server.address().port;
    const ids = chats.slice(0, 50).map((chat) => chat.id);
    const titleHistoryId = chats[0].id; // the fixture seeds title history for the first HISTORY_CHATS rows
    await warmUp({ port, ids, titleHistoryId, workspaceFolder: hotFolder });
    if (mode === 'mixed' || mode === 'both') {
      const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
      histogram.enable();
      const startedAt = performance.now();
      const window = await runMixedWindow({ port, deadline: startedAt + durationMs, ids, titleHistoryId, workspaceFolder: hotFolder });
      histogram.disable();
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (typeof global.gc === 'function') global.gc();
      const eventLoop = summarizeEventLoop(histogram);
      report.mixed = {
        durationMs: round(performance.now() - startedAt),
        eventLoop,
        eventLoopBudgets: {
          appP99Ok: eventLoop.p99 < BUDGETS.appEventLoopP99Ms,
          appMaxOk: eventLoop.max < BUDGETS.appEventLoopMaxMs,
          storageP99Ok: eventLoop.p99 <= BUDGETS.storageEventLoopP99Ms,
          storageMaxOk: eventLoop.max <= BUDGETS.storageEventLoopMaxMs,
        },
        ...window,
        resources: resourceSnapshot({ server, app }),
      };
    }
    if (mode === 'cycles' || mode === 'both') {
      const startedAt = performance.now();
      report.cycles = await runCycles({ port, cycles, cycleMs, ids, titleHistoryId, workspaceFolder: hotFolder, server, app });
      report.cycles.durationMs = round(performance.now() - startedAt);
    }
    await new Promise((resolve) => server.close(resolve));
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(path.resolve(out), json);
    } else {
      process.stdout.write(json);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  await main();
}
