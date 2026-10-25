#!/usr/bin/env node
/**
 * V9 HTTP harness (docs/architecture-http-baseline.md). For each fixture size it
 * generates an isolated data directory (scripts/architecture-http-fixture.mjs), boots
 * a real Express app with the real chats routes on 127.0.0.1:<ephemeral> against that
 * directory (never the repository data/), and measures list / page / scope / title /
 * seen-style endpoints over real HTTP. Each size runs in its own child process because
 * persistence paths bind to the data dir at first import.
 *
 * Reported per endpoint: n, P50, P95, P99, max (ms) and response bytes. P99 is only
 * labelled stable from >= 1000 samples; otherwise it is marked exploratory.
 *
 * Endpoints include GET /api/settings (V7, target P95 <= 100 ms) and the list sync/DTO reads (V2).
 *
 * Usage:
 *   node scripts/architecture-http-bench.mjs [--sizes 500,5000,20000] [--profile full|smoke]
 *     [--samples 200] [--seed 20261017] [--out docs/architecture-http-baseline.json]
 * Reproduction of the committed baseline:
 *   node scripts/architecture-http-bench.mjs --sizes 500,5000,20000 --profile full --samples 200 --out docs/architecture-http-baseline.json
 * Smoke profile (used by tests): --sizes 200 --profile smoke --samples 20
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const STABLE_P99_SAMPLES = 1000;

/** @param {number[]} samples */
export function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const round = (v) => Math.round(v * 1000) / 1000;
  const n = sorted.length;
  return {
    n,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    p99Label: n >= STABLE_P99_SAMPLES ? 'stable' : 'exploratory',
    max: round(sorted[n - 1]),
  };
}

/** @param {number} port @param {string} method @param {string} url */
function request(port, method, url) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'content-type': 'application/json' } }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => resolve({ ms: performance.now() - start, bytes, status: res.statusCode }));
    });
    req.on('error', reject);
    if (method === 'POST') req.write('{}');
    req.end();
  });
}

async function runChild() {
  const size = Number(option('--child-size', '0'));
  const profile = option('--profile', 'full');
  const samples = Number(option('--samples', '200'));
  const seed = Number(option('--seed', '20261017'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-http-bench-'));
  const fixtureDir = path.join(dir, 'data');
  try {
    const { populateFixture } = await import('./architecture-http-fixture.mjs');
    const fixtureStats = await populateFixture({ dir: fixtureDir, size, profile, seed });
    const { default: express } = await import('express');
    const { registerChatsRoutes } = await import('../lib/routes/chats-routes.js');
    const app = express();
    app.use(express.json());
    registerChatsRoutes(app, { dataDir: fixtureDir });
    // Settings/boot read (V7). Stub context: only the host-owned callbacks the route reads.
    const { registerSettingsRoutes } = await import('../lib/routes/settings-routes.js');
    registerSettingsRoutes(app, {
      getLanHost: () => null,
      getConfiguredWorkspaceSelection: () => ({ workspaceFile: '', workspaceFolder: '' }),
      isSessionSyncEnabled: () => false,
      resolveFrontHmrEnabledFromSettings: () => false,
      useHttps: false,
      port: 0,
      serverInstanceToken: 'bench',
      frontHmrEnabled: false,
      frontHmrForcedByEnv: false,
      frontHotFallbackEnabled: false,
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = server.address().port;
    const chats = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'chats.json'), 'utf8')).chats;
    const hotFolder = encodeURIComponent(chats[0].workspaceFolder);
    const midId = chats[Math.floor(chats.length / 2)].id;
    const endpoints = {
      listLive: ['GET', '/api/chats'],
      listFullIndex: ['GET', '/api/chats?includeArchived=1'],
      pageFirst: ['GET', '/api/chats/page?limit=100'],
      pageScopedHotGroup: ['GET', `/api/chats/page?limit=100&workspaceFolder=${hotFolder}`],
      pageArchivedOnly: ['GET', '/api/chats/page?limit=100&archived=only'],
      listSyncResync: ['GET', '/api/chats/sync?since=bench-epoch.1'],
      pageListDto: ['GET', '/api/chats/page?limit=100&view=list&archived=tree'],
      settings: ['GET', '/api/settings'],
      titleHistory: ['GET', `/api/chats/${midId}/title-history`],
      seenNoop: ['POST', `/api/chats/${midId}/seen`],
    };
    const result = { fixture: fixtureStats, fileBytes: fs.statSync(path.join(fixtureDir, 'chats.json')).size, endpoints: {} };
    for (const [name, [method, url]] of Object.entries(endpoints)) {
      await request(port, method, url);
      const times = [];
      let bytes = 0;
      let status = 0;
      for (let i = 0; i < samples; i += 1) {
        const r = await request(port, method, url);
        times.push(r.ms);
        bytes = r.bytes;
        status = r.status;
      }
      result.endpoints[name] = { method, url: url.replace(hotFolder, '<hot-workspace>'), status, responseBytes: bytes, ...stats(times) };
    }
    await new Promise((resolve) => server.close(resolve));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runParent() {
  const sizes = option('--sizes', '500,5000,20000').split(',').map(Number);
  const profile = option('--profile', 'full');
  const samples = option('--samples', '200');
  const seed = option('--seed', '20261017');
  const out = option('--out', '');
  const report = { schema: 1, profile, seed, samplesPerEndpoint: Number(samples), sizes: {} };
  for (const size of sizes) {
    const stdout = execFileSync(process.execPath, [
      '--no-warnings', SELF, '--child-size', String(size), '--profile', profile, '--samples', samples, '--seed', seed,
    ], { encoding: 'utf8', maxBuffer: 1 << 26 });
    report.sizes[size] = JSON.parse(stdout.trim().split('\n').pop());
  }
  let commit = '';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  report.environment = {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpu: os.cpus()[0]?.model || '',
    cpuCount: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    commit,
    note: 'Real Express + real chats routes over loopback HTTP; auth/widget middleware is not mounted. Isolated temp data dir.',
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) fs.writeFileSync(out, json);
  else process.stdout.write(json);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (args.includes('--child-size')) await runChild();
  else runParent();
}
