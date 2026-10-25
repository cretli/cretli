#!/usr/bin/env node
/**
 * Stage 1 baseline (docs/architecture-baseline.md): cost of the chat-list read path
 * on synthetic fixtures of 500 / 5000 / 20000 chats. Measures the CURRENT code, with
 * no runtime change, in an isolated temporary data directory (never `data/`).
 *
 * Measured per fixture size (n / P50 / P95 / P99 / max, milliseconds):
 * - loadWarm      loadChats() with a warm signature cache (full per-call copy)
 * - loadCold      loadChats() after the file signature changed (JSON.parse + copy)
 * - scopeLegacy   one request doing SCOPE_CHECKS lookups as `loadChats().find(...)`
 *                 (the pre-fix delegations-routes pattern)
 * - scopeIndexed  the same request with one request-local Map (the current pattern)
 *
 * Usage: node scripts/architecture-chat-list-bench.mjs [--sizes 500,5000,20000]
 *          [--seed 20261017] [--out report.json]
 * Fixtures are fictional and deterministic for a given seed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const SIZES = option('--sizes', '500,5000,20000').split(',').map(Number);
const SEED = Number(option('--seed', '20261017'));
const OUT = option('--out', '');
const SCOPE_CHECKS = 50;
const WARM_SAMPLES = 1000;
const COLD_SAMPLES = 30;
const SCOPE_SAMPLES = { legacy: 30, indexed: 1000 };
const WORKSPACES = 24;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-arch-bench-'));
process.env.CRETLI_DATA_DIR = dataDir;
process.env.CURSOR_REMOTE_DATA_DIR = dataDir;
const { loadChats } = await import('../lib/persist/chats-persist.js');

/** @param {number} seed */
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

/** @param {number} count @param {() => number} rand */
function buildChats(count, rand) {
  const transports = ['sdk', 'opencode', 'claude', 'codex', 'qwen', 'deepseek'];
  const chats = [];
  for (let i = 0; i < count; i += 1) {
    const hasParent = i > 10 && rand() < 0.35;
    chats.push({
      id: `chat-${String(i).padStart(6, '0')}`,
      title: `Fixture chat ${i}`,
      cursorSessionId: `session-${i}`,
      workspaceFolder: `/work/ws-${i % WORKSPACES}`,
      model: 'fixture/model',
      agentTransport: transports[Math.floor(rand() * transports.length)],
      createdAt: new Date(1.7e12 + i * 60000).toISOString(),
      parentChatId: hasParent ? `chat-${String(Math.floor(rand() * i)).padStart(6, '0')}` : undefined,
      archived: rand() < 0.4,
    });
  }
  return chats;
}

/** @param {number[]} samples */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const round = (v) => Math.round(v * 1000) / 1000;
  return { n: sorted.length, p50: round(at(50)), p95: round(at(95)), p99: round(at(99)), max: round(sorted[sorted.length - 1]) };
}

/** @param {() => void} fn @param {number} times */
function sample(fn, times) {
  const out = [];
  for (let i = 0; i < times; i += 1) {
    const start = performance.now();
    fn();
    out.push(performance.now() - start);
  }
  return out;
}

/** @param {string[]} gitArgs */
function git(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const report = { schema: 1, seed: SEED, sizes: {} };
const dataFile = path.join(dataDir, 'chats.json');
for (const size of SIZES) {
  const rand = mulberry32(SEED + size);
  const chats = buildChats(size, rand);
  fs.writeFileSync(dataFile, JSON.stringify({ chats }));
  const ids = chats.map((chat) => chat.id);
  const pickIds = () => Array.from({ length: SCOPE_CHECKS }, () => ids[Math.floor(rand() * ids.length)]);
  loadChats();
  const loadWarm = sample(() => loadChats(), WARM_SAMPLES);
  let bump = 0;
  const loadCold = sample(() => {
    bump += 1;
    fs.utimesSync(dataFile, new Date(), new Date(Date.now() + bump * 1000));
    loadChats();
  }, COLD_SAMPLES);
  const scopeLegacy = sample(() => {
    for (const id of pickIds()) loadChats().find((chat) => chat.id === id);
  }, SCOPE_SAMPLES.legacy);
  const scopeIndexed = sample(() => {
    const index = new Map();
    for (const chat of loadChats()) if (!index.has(chat.id)) index.set(chat.id, chat);
    for (const id of pickIds()) index.get(id);
  }, SCOPE_SAMPLES.indexed);
  report.sizes[size] = {
    fileBytes: fs.statSync(dataFile).size,
    loadWarm: stats(loadWarm),
    loadCold: stats(loadCold),
    scopeLegacy: stats(scopeLegacy),
    scopeIndexed: stats(scopeIndexed),
  };
}
report.environment = {
  node: process.version,
  sqlite: process.versions.sqlite || '',
  platform: `${os.platform()} ${os.release()}`,
  cpu: os.cpus()[0]?.model || '',
  cpuCount: os.cpus().length,
  totalMemMb: Math.round(os.totalmem() / 1048576),
  commit: git(['rev-parse', 'HEAD']),
  scopeChecksPerRequest: SCOPE_CHECKS,
  samples: { warm: WARM_SAMPLES, cold: COLD_SAMPLES, ...SCOPE_SAMPLES },
};
fs.rmSync(dataDir, { recursive: true, force: true });
const json = `${JSON.stringify(report, null, 2)}\n`;
if (OUT) fs.writeFileSync(OUT, json);
else process.stdout.write(json);
