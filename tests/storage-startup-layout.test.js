import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  FROZEN_THRESHOLDS, buildPendingFixture, candidatePageSizes, copyStoreFiles, createStream, diffExports, generateStore, inputHash,
  interleavedOrder, logicalExport, readLayout, summarize, thresholdsSha256, DB_FILENAME,
} from '../scripts/storage-layout-lib.mjs';
import { runExperiment, verdictFor } from '../scripts/storage-layout-experiment.mjs';

const CHILD = fileURLToPath(new URL('../scripts/storage-layout-child.mjs', import.meta.url));
const BENCH = fileURLToPath(new URL('../scripts/storage-chat-history-bench.mjs', import.meta.url));
const DOC = fileURLToPath(new URL('../docs/storage-a1-layout-experiment.md', import.meta.url));
const SMALL = { chats: 6, eventsPerChat: 12, appendRounds: 1 };
const child = (mode, dir, env = {}) => {
  const r = spawnSync(process.execPath, ['--no-warnings', CHILD, mode, dir], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  return { status: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()) };
};

/** @type {string} */
let root;
let cleanDir;
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-layout-test-'));
  cleanDir = path.join(root, 'clean');
  await generateStore({ dir: cleanDir, pageSize: 8192, shape: SMALL });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('A1 layout experiment: generator and bookkeeping', () => {
  it('uses the A1 bench generator logic verbatim', () => {
    const src = fs.readFileSync(BENCH, 'utf8');
    const rng = /function createRng\(seed\) \{[\s\S]*?\n\}\n/.exec(src)[0];
    const stream = /function createStream\(shape\) \{[\s\S]*?\n\}\n/.exec(src)[0];
    const benchStream = new Function('SEED', `${rng}\n${stream}\nreturn createStream;`)(20261013);
    const mine = createStream(SMALL);
    const theirs = benchStream(SMALL);
    assert.equal(mine.total, theirs.total);
    const hash = (s) => crypto.createHash('sha256').update(Array.from({ length: s.total }, (_, i) => JSON.stringify(s.at(i))).join('\n')).digest('hex');
    assert.equal(hash(mine), hash(theirs));
    assert.equal(inputHash(SMALL), hash(mine) === hash(theirs) ? inputHash(SMALL) : '');
  });

  it('skips a candidate equal to the baseline and never substitutes another size', () => {
    assert.deepEqual(candidatePageSizes(4096), [8192, 16384]);
    assert.deepEqual(candidatePageSizes(8192), [16384]);
    assert.deepEqual(candidatePageSizes(16384), [8192]);
  });

  it('treats NaN / missing samples as invalid and interleaves deterministically', () => {
    assert.equal(summarize([1, NaN, 3]).valid, false);
    assert.equal(summarize([]).valid, false);
    assert.equal(summarize([1, 2, 3]).median, 2);
    const a = interleavedOrder(['x', 'y', 'z'], 4);
    assert.deepEqual(a, interleavedOrder(['x', 'y', 'z'], 4));
    for (let r = 0; r < 4; r += 1) assert.deepEqual(a.filter((e) => e.round === r).map((e) => e.item).sort(), ['x', 'y', 'z']);
  });

  it('keeps the frozen thresholds hash in the report document', () => {
    assert.ok(fs.readFileSync(DOC, 'utf8').includes(thresholdsSha256()));
    assert.ok(Object.isFrozen(FROZEN_THRESHOLDS));
  });

  it('verdict is UNVERIFIED, never GO, for missing denominators, NaN samples or n below the minimum', () => {
    const ok = summarize(Array.from({ length: 15 }, () => 5));
    const kase = { n: 15, checks: { allSamplesCompleted: true, pendingProven: true }, a1OpenBarrierColdPage: ok, e2eSpawnToReadyPlusColdPage: ok };
    const gen = {
      appendLatencyMs: { p95: 1, p99: 2 }, workerRequestMs: { p95: 1, p99: 2 }, queryLatencyMs: { p95: 1, p99: 2 }, eventLoopDelayMs: { p99: 1, max: 2 },
      queueAgeMs: { p95: 1 }, bytesWritten: 10, fullCheckpoint: { n: 1 },
    };
    const rec = { layout: { pageSize: 4096 }, expectedPageSize: 4096, identity: { pass: true, cleanDiff: [], pendingDiff: [] }, cases: { clean: kase, pendingWal: kase }, generation: gen };
    const result = { json: { rewriteBytes: 1000 } };
    assert.equal(verdictFor(rec, result, 100, 15).verdict, 'GO (screening shortlist only)');
    assert.equal(verdictFor(rec, result, NaN, 15).verdict, 'UNVERIFIED');
    const nan = { ...rec, cases: { clean: { ...kase, a1OpenBarrierColdPage: summarize([NaN]) }, pendingWal: kase } };
    assert.equal(verdictFor(nan, result, 100, 15).verdict, 'UNVERIFIED');
    const few = { ...rec, cases: { clean: { ...kase, n: 3 }, pendingWal: kase } };
    assert.equal(verdictFor(few, result, 100, 15).verdict, 'UNVERIFIED');
    assert.equal(verdictFor(rec, result, 1, 15).verdict, 'NO-GO');
    const wrongSize = { ...rec, layout: { pageSize: 4096 }, expectedPageSize: 8192 };
    assert.equal(verdictFor(wrongSize, result, 100, 15).verdict, 'UNVERIFIED');
  });
});

describe('A1 layout experiment: fixtures', () => {
  it('pre-created page size is effective after the production open path and migrations', () => {
    assert.equal(readLayout(path.join(cleanDir, DB_FILENAME)).pageSize, 8192);
  });

  it('builds a real pending-WAL fixture: committed rows exist only in the WAL', async () => {
    const out = path.join(root, 'pending');
    const proof = await buildPendingFixture({ cleanDir, workDir: path.join(root, 'pending-work'), outDir: out, shape: SMALL, tailPerChat: 3 });
    assert.equal(proof.proven, true);
    assert.ok(proof.walFrames > 0 && proof.walPageSize === 8192);
    assert.equal(proof.pendingEvents, SMALL.chats * 3 + Math.min(20, SMALL.chats));
    assert.equal(proof.mainOnlyEvents, SMALL.chats * SMALL.eventsPerChat);
    assert.ok(fs.existsSync(path.join(out, `${DB_FILENAME}-wal`)));
    assert.ok(!fs.existsSync(path.join(out, `${DB_FILENAME}-shm`)), 'the -shm is never copied');
  });

  it('a precheckpointed WAL has no pending rows and is not counted as pending', () => {
    const dir = path.join(root, 'prechk');
    copyStoreFiles(cleanDir, dir);
    const db = new DatabaseSync(path.join(dir, DB_FILENAME));
    db.exec('PRAGMA wal_autocheckpoint = 0');
    db.exec('BEGIN IMMEDIATE'); // a write that leaves a WAL file behind...
    db.exec("INSERT INTO schema_version (version, name, applied_at) VALUES (9999, 'probe', 0)");
    db.exec('ROLLBACK');
    db.prepare('PRAGMA wal_checkpoint(FULL)').get(); // ...with every frame already in the main file
    const probe = path.join(root, 'prechk-main');
    copyStoreFiles(dir, probe, ['']);
    const count = (d) => { const c = new DatabaseSync(path.join(d, DB_FILENAME)); try { return Number(c.prepare('SELECT COUNT(*) n FROM chat_history_events').get().n); } finally { c.close(); } };
    assert.equal(count(probe) - count(dir), 0);
    db.close();
  });
});

describe('A1 layout experiment: full checks stay in force', () => {
  it('reopen of a healthy copy reports verified page size, full checks and a complete F29 barrier', () => {
    const dir = path.join(root, 'healthy');
    copyStoreFiles(cleanDir, dir);
    const r = child('reopen', dir);
    assert.equal(r.status, 0);
    assert.equal(r.out.ok, true);
    assert.equal(r.out.effective.page_size, 8192);
    assert.equal(r.out.effective.journal_mode, 'wal');
    assert.equal(r.out.effective.synchronous, 2);
    assert.deepEqual(r.out.verify, { integrityOk: true, foreignKeyViolations: 0 });
    assert.equal(r.out.f29.busy, 0);
    assert.ok([r.out.openMs, r.out.barrierMs, r.out.coldReadMs, r.out.totalMs].every(Number.isFinite));
  });

  it('rejects a corrupt database without ready or a cold page (reopen and e2e)', () => {
    const dir = path.join(root, 'corrupt');
    copyStoreFiles(cleanDir, dir);
    const file = path.join(dir, DB_FILENAME);
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, crypto.randomBytes(8192).fill(0xff), 0, 8192, 8192 * 3); // wipe a mid-file b-tree page
    fs.closeSync(fd);
    for (const mode of ['reopen', 'e2e']) {
      const r = child(mode, dir);
      assert.equal(r.status, 3, mode);
      assert.equal(r.out.ok, false);
      assert.ok(!('coldReadMs' in r.out) && !('totalMs' in r.out), `${mode} must not report a start`);
    }
  });

  it('rejects a foreign-key violation that integrity_check alone would not see', () => {
    const dir = path.join(root, 'fk');
    copyStoreFiles(cleanDir, dir);
    const db = new DatabaseSync(path.join(dir, DB_FILENAME));
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`INSERT INTO chat_history_events (dataset_generation, chat_id, seq, chat_epoch, producer_id, client_seq, kind, payload_json, created_at, revision)
      VALUES ('medium', 'ghost-chat', 1, 'epoch-1', 'p', 1, 'localUser', '{}', 0, 1)`);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const r = child('reopen', dir);
    assert.equal(r.status, 3);
    assert.equal(r.out.ok, false);
    assert.equal(r.out.stage, 'open');
    assert.ok(!('coldReadMs' in r.out));
  });

  it('a failed F29 barrier produces no ready marker and no cold page', () => {
    const dir = path.join(root, 'barrier');
    copyStoreFiles(cleanDir, dir);
    const r = child('reopen', dir, { CRETLI_LAYOUT_BARRIER_FAULT: '1' });
    assert.equal(r.status, 3);
    assert.equal(r.out.stage, 'barrier');
    assert.ok(!('coldReadMs' in r.out) && !('totalMs' in r.out));
  });
});

describe('A1 layout experiment: end-to-end at small scale', () => {
  it('keeps the logical export identical across page sizes and never reports GO below 15 samples', async () => {
    const result = await runExperiment({ samples: 2, chats: 6, events: 12, tail: 2 });
    assert.deepEqual(Object.keys(result.variants), ['baseline', 'page8192', 'page16384']);
    assert.equal(result.shape.mediumDefinition, false);
    for (const [name, v] of Object.entries(result.variants)) {
      assert.equal(v.layout.pageSize, v.expectedPageSize, name);
      assert.equal(v.identity.pass, true, `${name} logical export must equal baseline`);
      assert.equal(v.fixture.pending.proven, true, name);
      assert.ok(v.fixture.pending.pendingEvents > 0, name);
      assert.ok(Object.keys(v.fixture.tables).length >= 8 && v.fixture.maskedColumns.length > 0);
      assert.ok(v.fixture.tables.command_receipts.rows > 0 && v.fixture.tables.chat_history_dedupe.rows > 0);
      for (const cas of ['clean', 'pendingWal']) {
        const c = v.cases[cas];
        assert.equal(c.n, 2);
        assert.ok(Object.values(c.checks).every(Boolean), `${name}/${cas} ${JSON.stringify(c.checks)}`);
        assert.ok(c.a1OpenBarrierColdPage.valid && Number.isFinite(c.a1OpenBarrierColdPage.median));
        assert.ok(c.e2eSpawnToReadyPlusColdPage.valid);
      }
      assert.notEqual(v.verdict.verdict, 'GO (screening shortlist only)', 'n=2 can never be GO');
      assert.ok(v.verdict.unverified.some((m) => /n=2 < 15/.test(m)));
    }
    const base = result.variants.baseline.fixture.cleanExportSha256;
    assert.equal(result.variants.page8192.fixture.cleanExportSha256, base);
    assert.equal(result.variants.page16384.fixture.cleanExportSha256, base);
    assert.deepEqual(diffExports({ tables: {}, schemaSha256: 'a' }, { tables: {}, schemaSha256: 'b' }), ['<schema>']);
    assert.ok(result.json.coldLoad.valid);
    assert.ok(!JSON.stringify(result).includes(os.homedir()), 'no private paths in the report');
    assert.ok(logicalExport.length === 1);
  });
});
