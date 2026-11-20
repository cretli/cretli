import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/storage-chats-helpers.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const LIMIT = 64 * 1024;
// Owner decisions of 2026-11-02 (second and third): the amortized p95 limit is 96 KiB for widget, folderFile,
// archive and add; every other scope (global, folder, title, newBucket, zeroBucket) stays at 64 KiB.
const WIDE_LIMIT = 96 * 1024;
const WIDE_SCOPES = new Set(['widget', 'folderFile', 'archive', 'add']);
const limitFor = (scope) => (WIDE_SCOPES.has(scope) ? WIDE_LIMIT : LIMIT);
const SIZES = [1000, 50000];
const SAMPLES = 20;
const samplesOf = (kind) => Array.from({ length: SAMPLES }, (_, i) => `${kind}:${i}`);
/**
 * Each dirty index costs two pages (old and new position of last_activity_at) and every dirty page is written
 * twice (WAL frame + checkpoint). Kinds by number of list indexes: global = 1, folder = 2, folderFile = 3,
 * widget = 4 (the plan's worst case).
 */
const KINDS = ['global', 'folder', 'folderFile', 'widget'];
const NAMED = ['title', 'archive', 'newBucket', 'zeroBucket', 'add'];
const HAS_GCC = spawnSync('gcc', ['--version'], { stdio: 'ignore' }).status === 0;

/**
 * Sum the positive bytes of every logged write between `<name>-start` and `<name>-end` markers.
 *
 * @param {string} logText
 * @param {string} name
 */
function windowTotals(logText, rawName) {
  const name = rawName.replace(':', '_');
  let active = false;
  const totals = { db: 0, wal: 0, other: 0 };
  for (const line of logText.split('\n')) {
    const [, bytes, file] = line.split('\t');
    if (!file) continue;
    if (file.endsWith(`${name}-start`)) { active = true; continue; }
    if (file.endsWith(`${name}-end`)) { active = false; continue; }
    if (!active) continue;
    const n = Number(bytes);
    if (file.endsWith('chats.sqlite')) totals.db += n;
    else if (file.endsWith('chats.sqlite-wal')) totals.wal += n;
    else if (file.endsWith('control.bin')) totals.other += n;
  }
  return { dbWrittenBytes: totals.db, walWrittenBytes: totals.wal, totalWrittenBytes: totals.db + totals.wal, controlBytes: totals.other };
}

/**
 * Amortized cost per change of a `batch:<kind>` scenario: the WAL bytes of each change's own commit plus the
 * database bytes of the one checkpoint of the batch divided by the batch size.
 *
 * @param {string} logText
 * @param {string} kind
 * @param {string[]} labels
 */
function amortized(logText, kind, labels) {
  const wal = labels.map((l) => windowTotals(logText, `bw_${kind}_${l}`).totalWrittenBytes);
  const ck = windowTotals(logText, `bck_${kind}`);
  assert.ok(ck.dbWrittenBytes > 0, `${kind}: the batch checkpoint wrote no database bytes`);
  const share = Math.ceil((ck.dbWrittenBytes + ck.walWrittenBytes) / labels.length);
  return { wal, share, perChange: wal.map((w) => w + share) };
}

/** Run the child under the write meter. Returns the raw log. */
function runMetered(dir, n, scenarios) {
  const so = path.join(dir, 'meter.so');
  execFileSync('gcc', ['-shared', '-fPIC', '-O2', '-o', so, path.join(FIXTURES, 'storage-chats-write-meter.c'), '-ldl']);
  const log = path.join(dir, 'meter.log');
  fs.writeFileSync(log, '');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  // METER_DIR is resolved: descriptors resolve through /proc/self/fd to real paths.
  const meterDir = fs.realpathSync(work);
  execFileSync(process.execPath, [path.join(FIXTURES, 'storage-chats-write-child.mjs'), meterDir, String(n), JSON.stringify(scenarios)], {
    env: { ...process.env, LD_PRELOAD: so, METER_LOG: log, METER_DIR: meterDir, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'], timeout: 280000,
  });
  return fs.readFileSync(log, 'utf8');
}

describe('bytes written per change (database + WAL, forced checkpoint attributed to the change)', { skip: !HAS_GCC && 'gate unconfirmed: no gcc to build the write meter and no strace' }, () => {
  it('the harness counts overwrites and short writes exactly (self-check)', () => {
    const dir = tempDir('cretli-chats-meter-');
    try {
      const totals = windowTotals(runMetered(dir, 200, ['control', 'folder:0']), 'control');
      assert.equal(totals.controlBytes, 2037, 'two overwrites of one offset and a short tail are all counted');
      // The real measurement window must see positive database writes even though the file does not grow.
      const activity = windowTotals(fs.readFileSync(path.join(dir, 'meter.log'), 'utf8'), 'folder:0');
      assert.ok(activity.dbWrittenBytes > 0 && activity.walWrittenBytes > 0, JSON.stringify(activity));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  const p95 = (values) => [...values].sort((x, y) => x - y)[Math.ceil(values.length * 0.95) - 1];

  for (const n of SIZES) {
    it(`measures p95 per change at N=${n}; a chat in one list index and a title change stay within 64 KiB`, { timeout: 290000 }, () => {
      const dir = tempDir('cretli-chats-bytes-');
      try {
        const log = runMetered(dir, n, [...KINDS.flatMap(samplesOf), ...NAMED]);
        const report = {};
        for (const kind of KINDS) {
          const totals = samplesOf(kind).map((name) => windowTotals(log, name));
          for (const t of totals) {
            assert.ok(t.dbWrittenBytes > 0 && t.walWrittenBytes > 0, `${kind}: incomplete measurement ${JSON.stringify(t)}`);
          }
          const sums = totals.map((t) => t.totalWrittenBytes);
          report[kind] = { p95: p95(sums), max: Math.max(...sums), median: sums.sort((x, y) => x - y)[Math.floor(sums.length / 2)] };
        }
        for (const name of NAMED) report[name] = windowTotals(log, name).totalWrittenBytes;
        console.log(`# chats write bytes N=${n} (db+wal): ${JSON.stringify(report)}`);
        assert.ok(report.global.p95 <= LIMIT, `global p95 at N=${n}: ${JSON.stringify(report.global)} exceeds ${LIMIT}`);
        assert.ok(report.title <= LIMIT, `title change at N=${n}: ${report.title}`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    // The plan's gate for records in two to four list indexes (a folder chat is the p50 record of the profile,
    // folder + file the next most common, the widget chat is the plan's worst case). Under the owner decision of
    // 2026-11-02 (ADR 2.2) the gate counts WAL bytes plus the amortized checkpoint share of one change: the WAL
    // bytes of its own commit plus the database bytes of one forced checkpoint covering a batch of commits,
    // divided by the batch size. The raw definition (the whole checkpoint attributed to one change) is reported
    // next to it but is not the gate.
    it(`amortized p95 of chats in two to four list indexes stays within 64 KiB at N=${n}`, { timeout: 290000 }, () => {
      const dir = tempDir('cretli-chats-bytes-');
      try {
        const kinds = ['folder', 'folderFile', 'widget'];
        const raw = runMetered(dir, n, [...kinds.flatMap(samplesOf), ...NAMED]);
        const report = {};
        const overLimit = [];
        for (const kind of kinds) {
          const rawSums = samplesOf(kind).map((name) => windowTotals(raw, name).totalWrittenBytes);
          report[kind] = { rawDbWal: { p95: p95(rawSums) } };
        }
        const dirB = tempDir('cretli-chats-bytes-batch-');
        try {
          const batch = runMetered(dirB, n, kinds.map((k) => `batch:${k}`));
          for (const kind of kinds) {
            const a = amortized(batch, kind, Array.from({ length: SAMPLES }, (_, i) => String(i)));
            report[kind].amortized = { p95: p95(a.perChange), checkpointShare: a.share, walP95: p95(a.wal) };
            report[kind].limit = limitFor(kind);
            if (p95(a.perChange) > limitFor(kind)) overLimit.push(`${kind} amortized p95 at N=${n}: ${p95(a.perChange)} exceeds ${limitFor(kind)}`);
          }
        } finally { fs.rmSync(dirB, { recursive: true, force: true }); }
        const dirN = tempDir('cretli-chats-bytes-named-');
        try {
          const namedLog = runMetered(dirN, n, ['batch:named']);
          const a = amortized(namedLog, 'named', NAMED);
          report.named = {};
          NAMED.forEach((name, i) => {
            const rawBytes = windowTotals(raw, name).totalWrittenBytes;
            report.named[name] = { rawDbWal: rawBytes, amortized: a.perChange[i], limit: limitFor(name) };
            if (a.perChange[i] > limitFor(name)) overLimit.push(`${name} amortized at N=${n}: ${a.perChange[i]} exceeds ${limitFor(name)}`);
          });
          report.namedCheckpointShare = a.share;
        } finally { fs.rmSync(dirN, { recursive: true, force: true }); }
        console.log(`# chats write bytes N=${n} (per scope: rawDbWal, amortized, applied limit): ${JSON.stringify(report)}`);
        // Hard gate: asserted after the report is printed so every scope's numbers stay visible on failure.
        assert.deepEqual(overLimit, []);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
