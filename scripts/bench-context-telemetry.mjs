#!/usr/bin/env node
/**
 * Benchmark for recordHarnessContextSample (lib/usage/harness-context-telemetry.ts).
 *
 * Works on a synthetic store in a temp directory; it never reads or writes the real data/ folder.
 * Cost is measured end to end around the public call, so the same script gives before/after numbers.
 *
 *   node scripts/bench-context-telemetry.mjs [--runs 3] [--rows 5000]
 *
 * Phases: (a) writes without compaction, (b) writes with compaction, (c) pathological store
 * above the 8 MB size threshold, (d) isolated cost of the old filter/sort/stringify/I-O phases
 * (a copy of that logic, for comparison only; it is not a contract of the production code).
 * For a function-level profile run it as: node --cpu-prof scripts/bench-context-telemetry.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { recordHarnessContextSample } from '../lib/usage/harness-context-telemetry.ts';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? Number(argv[i + 1]) : fallback; };
const RUNS = argValue('runs', 3);
const ROWS = argValue('rows', 5000);
const WARMUP = 20;
const MINUTE = 60000;

function makeRow(i, base, padBytes) {
  return {
    v: 1, id: `seed-${i}`, harness: 'codex', prefixFingerprint: null, prefixEvidenceSource: null, measurementId: null, turnId: null,
    contextEpochReason: '', chatId: `chat-${i % 50}`, runId: `run-${i}`, delegationId: '', attemptId: '', workspaceFile: '', workspaceFolder: 'example-workspace',
    role: 'chat', model: 'test-model', contextEpoch: 0, observedAt: new Date(base + i * MINUTE).toISOString(), source: 'harness-event', provenance: 'reported',
    inputTokens: 1000 + i, outputTokens: 100, totalTokens: 1100 + i, reasoningTokens: null, sessionUsage: null, cacheReadTokens: 800, cacheWriteTokens: null,
    cacheWrite5mTokens: null, cacheWrite1hTokens: null, contextWindowTokens: 10000,
    breakdown: { estimated: true, complete: true, rows: ['messages', 'instructions', 'skills', 'memory', 'systemPrompt', 'toolCalls', 'toolResults', 'reasoning'].map((id) => ({ id, tokens: 123, count: 3, estimated: true })) },
    pad: 'x'.repeat(padBytes),
  };
}

function seed(dataDir, rowBytes) {
  const probe = JSON.stringify(makeRow(0, Date.now(), 0)).length + 1;
  const padBytes = Math.max(0, rowBytes - probe);
  // Seed rows end 1 day in the past, so measured writes append at the tail.
  const base = Date.now() - (ROWS + 1440) * MINUTE;
  const lines = Array.from({ length: ROWS }, (_, i) => JSON.stringify(makeRow(i, base, padBytes)));
  fs.mkdirSync(path.join(dataDir, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'usage', 'context-samples.jsonl'), `${lines.join('\n')}\n`);
}

function stats(values) {
  if (!values.length) return { n: 0, min: 0, median: 0, p99: 0, max: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, min: sorted[0], median: at(0.5), p99: at(0.99), max: sorted[sorted.length - 1] };
}
const fmt = (s) => `n=${s.n} min=${s.min.toFixed(3)} median=${s.median.toFixed(3)} p99=${s.p99.toFixed(3)} max=${s.max.toFixed(3)} ms`;

/** Run `count` writes; return per-write durations split by whether the file was atomically replaced. */
function drive(dataDir, count, counter) {
  const file = path.join(dataDir, 'usage', 'context-samples.jsonl');
  const plain = []; const compacted = [];
  let inode = fs.statSync(file).ino;
  for (let i = 0; i < count; i++) {
    const n = counter.n++;
    const room = { chatId: `bench-chat-${n}`, _runId: 'bench-run', cwd: 'example-workspace', modelId: 'test-model' };
    const event = {
      observedAt: new Date(Date.now() + n).toISOString(), model: 'test-model',
      usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 800 }, contextWindowTokens: 10000,
      breakdown: { complete: true, rows: [{ id: 'messages', tokens: 900, count: 3 }, { id: 'toolCalls', tokens: 50, count: 2 }] },
    };
    const t0 = performance.now();
    recordHarnessContextSample({ room, harness: 'codex', event, dataDir });
    const dt = performance.now() - t0;
    const nextInode = fs.statSync(file).ino;
    (nextInode !== inode ? compacted : plain).push(dt);
    inode = nextInode;
  }
  return { plain, compacted };
}

function median(values) { return stats(values).median; }

/** Copy of the old per-write phases, timed in isolation (comparison only). */
function legacyPhases(dataDir) {
  const file = path.join(dataDir, 'usage', 'context-samples.jsonl');
  const timeIt = (fn) => { const t0 = performance.now(); const out = fn(); return [performance.now() - t0, out]; };
  const [readMs, rows] = timeIt(() => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  const sample = { ...rows[rows.length - 1], id: 'phase-sample', observedAt: new Date().toISOString() };
  const [filterMs, kept] = timeIt(() => rows.filter((row) => Date.parse(row.observedAt) >= Date.now() - 92 * 86400000));
  const [sortMs, next] = timeIt(() => kept.filter((row) => row.id !== sample.id).concat(sample).sort((a, b) => a.observedAt.localeCompare(b.observedAt)).slice(-5000));
  const [stringifyMs, text] = timeIt(() => `${next.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const [ioMs] = timeIt(() => { fs.writeFileSync(`${file}.bench.tmp`, text); fs.renameSync(`${file}.bench.tmp`, `${file}.bench`); });
  return { readParseMs: readMs, filterMs, sortMs, stringifyMs, writeRenameMs: ioMs, bytes: text.length };
}

const results = [];
for (let run = 1; run <= RUNS; run++) {
  const out = { run };
  const dirs = [];
  const mk = (rowBytes) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-bench-')); dirs.push(dir); seed(dir, rowBytes); return dir; };
  try {
    // (a) + (b): realistic ~1.4 KB rows.
    const dir = mk(1400);
    const counter = { n: 0 };
    drive(dir, WARMUP, counter);
    const first = drive(dir, 200, counter);
    const second = drive(dir, 500, counter);
    out.a = stats(first.plain.concat(second.plain));
    out.b = stats(first.compacted.concat(second.compacted));
    // (c): 5000 rows above the 8 MB threshold; count atomic replacements over 50 writes.
    const big = mk(Math.ceil((8 * 1024 * 1024 + 200000) / ROWS));
    const bigCounter = { n: 0 };
    drive(big, WARMUP, bigCounter);
    const patho = drive(big, 50, bigCounter);
    out.c = { writes: 50, compactions: patho.compacted.length, perWrite: stats(patho.plain.concat(patho.compacted)), bytes: fs.statSync(path.join(big, 'usage', 'context-samples.jsonl')).size };
    // (d)
    out.d = legacyPhases(mk(1400));
  } finally { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); }
  results.push(out);
  console.log(`run ${run}`);
  console.log(`  (a) no compaction : ${fmt(out.a)}`);
  console.log(`  (b) with compaction: ${fmt(out.b)}`);
  console.log(`  (c) pathological   : compactions=${out.c.compactions}/${out.c.writes} file=${(out.c.bytes / 1048576).toFixed(2)} MB ${fmt(out.c.perWrite)}`);
  console.log(`  (d) legacy phases  : ${Object.entries(out.d).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`).join(' ')}`);
}
console.log('median across runs');
console.log(`  (a) median ${median(results.map((r) => r.a.median)).toFixed(3)} ms, p99 ${median(results.map((r) => r.a.p99)).toFixed(3)} ms`);
console.log(`  (b) median ${median(results.map((r) => r.b.median)).toFixed(3)} ms, max ${median(results.map((r) => r.b.max)).toFixed(3)} ms`);
console.log(`  (c) compactions ${median(results.map((r) => r.c.compactions))}/50, per-write median ${median(results.map((r) => r.c.perWrite.median)).toFixed(3)} ms`);
const spread = (vals) => (Math.max(...vals) - Math.min(...vals)) / (median(vals) || 1);
if (spread(results.map((r) => r.a.median)) > 0.3) console.log('  note: run-to-run spread of (a) exceeds 30%; repeat on a quiet machine');
