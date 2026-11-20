#!/usr/bin/env node
/**
 * Synthetic before/after benchmark for a five-cycle model-pick workload. Runs
 * in a temp directory only (never `data/`); the numbers are NOT production
 * measurements. The baseline performs the former full snapshot rewrite after
 * each mutation. The current path uses the journal implementation.
 *
 * Usage: node scripts/bench-model-pick-persist.js [existingPicks=20000]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic, resetWriteStats, getWriteStats } from '../lib/persist/atomic-write.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-pick-'));
process.env.CURSOR_REMOTE_DATA_DIR = dir;
const file = path.join(dir, 'model-pick-decisions.json');
const persist = await import('../lib/persist/model-pick-decisions-persist.js');
const seed = Number(process.argv[2]) || 5000;
const picks = {};
for (let n = 0; n < seed; n += 1) {
  picks[`seed-${n}`] = { id: `seed-${n}`, createdAt: new Date().toISOString(), chatId: 'c', purpose: 'model_pick', role: 'implement',
    candidates: Array.from({ length: 8 }, (_, i) => ({ harness: 'h', model: `m${i}`, candidateId: `h/m${i}` })), picks: [{ harness: 'h', model: 'm0' }] };
}
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, picks }));
const snapshotBytes = fs.statSync(file).size;

// One cycle = plan + implement + review + fix + review picks; each pick is
// saved, reserved and (for one in four) released.
const CYCLES = 5;
const PICKS_PER_CYCLE = 5;
const MUTATIONS_PER_PICK = 2.25;
const mutationCount = CYCLES * PICKS_PER_CYCLE * MUTATIONS_PER_PICK;
const baselineDoc = JSON.parse(fs.readFileSync(file, 'utf8'));
const baselineBlockMs = [];
resetWriteStats();
const baselineStart = process.hrtime.bigint();
let baselineMutation = 0;
for (let c = 0; c < CYCLES; c += 1) {
  for (let p = 0; p < PICKS_PER_CYCLE; p += 1) {
    const id = `cycle-${c}-${p}`;
    const row = { id, chatId: `cycle-${c}`, purpose: 'model_pick', role: 'implement', createdAt: new Date().toISOString(), picks: [{ harness: 'h', model: 'm0' }] };
    for (const phase of ['save', 'reserve', ...(p % 4 === 0 ? ['release'] : [])]) {
      if (phase === 'release') delete baselineDoc.picks[id].reservedAt;
      else baselineDoc.picks[id] = { ...row, ...(phase === 'reserve' ? { reservedAt: new Date().toISOString() } : {}) };
      const start = process.hrtime.bigint();
      writeJsonAtomic(file, baselineDoc, 'utf8', { compact: true });
      baselineBlockMs.push(Number(process.hrtime.bigint() - start) / 1e6);
      baselineMutation += 1;
    }
  }
}
const baselineElapsedMs = Number(process.hrtime.bigint() - baselineStart) / 1e6;
const baselineStats = getWriteStats().rows.find((r) => r.key === 'model-pick-decisions.json');
const baselineBytes = baselineStats?.bytes ?? 0;
const baselineMaxBlockMs = Math.max(0, ...baselineBlockMs);

// Restore the seed snapshot so the new implementation sees the same fixture.
fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, picks }));
resetWriteStats();
const t0 = process.hrtime.bigint();
let mutations = 0;
for (let c = 0; c < CYCLES; c += 1) {
  for (let p = 0; p < PICKS_PER_CYCLE; p += 1) {
    const rec = persist.createModelPickRecord({ file, chatId: `cycle-${c}`, purpose: 'model_pick', role: 'implement',
      picks: [{ harness: 'h', model: 'm0' }], candidates: [{ harness: 'h', model: 'm1' }] });
    mutations += 1;
    await persist.reserveModelPickSlot({ pickId: rec.id, selectionSlot: 0, delegationId: `d${c}-${p}`, idempotencyKey: `k${c}-${p}`, file });
    mutations += 1;
    if (p % 4 === 0) {
      persist.releaseModelPickSlotsForDelegation({ pickId: rec.id, delegationId: `d${c}-${p}`, file });
      mutations += 1;
    }
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const s = persist.modelPickDocumentStats;
const journalBytes = s.journalBytes;
const currentStats = getWriteStats().rows.find((r) => r.key === 'model-pick-decisions.json');
const compactedSnapshotBytes = currentStats?.bytes ?? 0;
const journalStats = getWriteStats().rows.find((r) => r.key === 'model-pick-decisions.json.journal');
const currentMaxSyncWriteMs = Math.max(currentStats?.maxMs ?? 0, journalStats?.maxMs ?? 0);
const bytesWrittenCurrent = journalBytes + s.snapshotWrites * snapshotBytes;
console.log(JSON.stringify({
  note: 'synthetic temp-dir measurement; not a production workload measurement',
  seedPicks: seed,
  snapshotBytes,
  workloadMutations: mutations,
  before: { mutations: baselineMutation, bytesWritten: baselineBytes, elapsedMs: Math.round(baselineElapsedMs), maxSynchronousWriteMs: Number(baselineMaxBlockMs.toFixed(2)) },
  after: { journalAppends: s.journalAppends, journalBytes, snapshotWrites: s.snapshotWrites, snapshotBytesWritten: compactedSnapshotBytes,
    bytesWritten: bytesWrittenCurrent, elapsedMs: Math.round(ms), maxSynchronousWriteMs: Number(currentMaxSyncWriteMs.toFixed(2)),
    writesPerMinuteAtThisRate: Math.round(mutations / (ms / 60000)) },
  writeVolumeReduction: Number((baselineBytes / Math.max(1, bytesWrittenCurrent)).toFixed(1)),
}, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
