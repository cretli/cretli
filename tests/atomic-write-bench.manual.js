// Manual micro-benchmark (not run by CI): node tests/atomic-write-bench.manual.js
// Median of 15 runs writing ~10 MB with counters on vs off.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setWriteStatsEnabled, writeJsonAtomic } from '../lib/persist/atomic-write.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cretli-bench-'));
const data = { rows: Array.from({ length: 80000 }, (_, i) => ({ i, s: 'x'.repeat(60) })) };
const file = path.join(dir, 'bench.json');
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
function run(enabled) {
  setWriteStatsEnabled(enabled);
  const t = [];
  for (let i = 0; i < 15; i += 1) {
    const s = process.hrtime.bigint();
    writeJsonAtomic(file, data);
    t.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  return median(t);
}
run(true);
const off = run(false);
const on = run(true);
console.log({ offMs: off, onMs: on, overheadPct: ((on - off) / off) * 100 });
rmSync(dir, { recursive: true, force: true });
