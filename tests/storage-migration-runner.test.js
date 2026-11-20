import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { openStorageDb } from '../lib/storage/db-lifecycle.js';
import { StorageError } from '../lib/storage/errors.js';
import {
  computeStepChecksum,
  MIGRATION_JOURNAL_TABLE,
  planMigrations,
  resetFailedStep,
  runMigrations,
  SWITCH_OWNER_MARKER_FILE,
  stepFromMigration,
  switchMigrationTarget,
} from '../lib/storage/migration-runner.js';
import { CORE_MIGRATIONS } from '../lib/storage/migrations.js';

/** @type {string} */
let dir;
/** @type {Array<ReturnType<typeof openStorageDb>>} */
let handles;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-storage-migrate-'));
  handles = [];
});

afterEach(() => {
  for (const handle of handles) {
    try { handle.close(); } catch { /* already closed */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function open() {
  const handle = openStorageDb({ dir });
  handles.push(handle);
  return handle;
}

const writable = () => {};

const CREATE_ITEMS = Object.freeze({
  id: 'create-items', kind: 'sql', version: '1',
  sql: 'CREATE TABLE mig_items (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT; CREATE TABLE mig_out (id INTEGER PRIMARY KEY) STRICT;',
});

/**
 * Chunked copy mig_items -> mig_out, `maxItems`-bounded, cursor = last id.
 *
 * @param {{ onChunk?: (ctx: any) => void, version?: string, touchesUserData?: boolean }} [extra]
 */
function copyStep(extra = {}) {
  return {
    id: 'copy-items', kind: 'chunked', version: extra.version || '1', touchesUserData: extra.touchesUserData,
    run(ctx) {
      extra.onChunk?.(ctx);
      const after = ctx.cursor === null ? 0 : ctx.cursor.lastId;
      const rows = ctx.db.prepare('SELECT id FROM mig_items WHERE id > ? ORDER BY id LIMIT ?').all(after, 3);
      for (const row of rows) ctx.db.prepare('INSERT INTO mig_out (id) VALUES (?)').run(row.id);
      if (rows.length < 3) return { done: true, cursor: null };
      return { done: false, cursor: { lastId: rows[rows.length - 1].id } };
    },
  };
}

function seedItems(db, n) {
  const insert = db.prepare('INSERT INTO mig_items (id, v) VALUES (?, ?)');
  for (let i = 1; i <= n; i += 1) insert.run(i, `v${i}`);
}

function journal(db) {
  return Object.fromEntries(db.prepare(`SELECT * FROM ${MIGRATION_JOURNAL_TABLE}`).all().map((r) => [r.step_id, { ...r }]));
}

function outCount(db) {
  return Number(db.prepare('SELECT count(*) AS n FROM mig_out').get().n);
}

/** Fault hook that throws once at `point` (optionally from chunk `chunkIndex`). */
function crashAt(point, match = {}) {
  let fired = false;
  return (p, info) => {
    if (fired || p !== point) return;
    if (Object.entries(match).some(([k, v]) => info[k] !== v)) return;
    fired = true;
    throw new Error(`crash at ${point}`);
  };
}

describe('migration runner (A2 S7)', () => {
  it('runs sql, atomic and chunked steps in order and journals them', () => {
    const { db } = open();
    const events = [];
    const steps = [
      CREATE_ITEMS,
      { id: 'seed', kind: 'atomic', version: '1', apply(d) { seedItems(d, 8); } },
      copyStep(),
    ];
    const result = runMigrations(db, steps, { assertWritable: writable, onProgress: (e) => events.push(e.type) });
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.applied, ['create-items', 'seed', 'copy-items']);
    assert.equal(outCount(db), 8);
    const rows = journal(db);
    assert.equal(rows['create-items'].state, 'done');
    assert.equal(rows['copy-items'].state, 'done');
    assert.equal(rows['copy-items'].chunks, 3);
    assert.equal(rows['copy-items'].checksum, computeStepChecksum(copyStep()));
    assert.ok(events.includes('chunk') && events.includes('step-done') && events[0] === 'plan');
  });

  it('is idempotent: a second run applies nothing', () => {
    const { db } = open();
    const steps = [CREATE_ITEMS, copyStep()];
    runMigrations(db, steps, { assertWritable: writable });
    const before = journal(db);
    const second = runMigrations(db, steps, { assertWritable: writable });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(journal(db), before);
  });

  it('wraps a CORE_MIGRATIONS-style entry as a step', () => {
    const step = stepFromMigration(CORE_MIGRATIONS[0]);
    assert.equal(step.kind, 'sql');
    assert.match(step.id, /^schema-0001-/);
  });

  it('resumes after a crash between chunks from the last committed chunk (file DB reopened)', () => {
    const steps = [CREATE_ITEMS, SEED8, copyStep()];
    const first = open();
    assert.throws(
      () => runMigrations(first.db, steps, { assertWritable: writable, faultHook: crashAt('chunk-committed', { chunkIndex: 0 }) }),
      /crash at chunk-committed/,
    );
    assert.equal(outCount(first.db), 3);
    assert.equal(journal(first.db)['copy-items'].state, 'started');
    assert.equal(journal(first.db)['copy-items'].cursor, JSON.stringify({ lastId: 3 }));
    first.close();
    const second = open();
    const seenCursors = [];
    const result = runMigrations(second.db, [CREATE_ITEMS, SEED8, copyStep({ onChunk: (ctx) => seenCursors.push(ctx.cursor) })], { assertWritable: writable });
    assert.deepEqual(result.applied, ['copy-items']);
    assert.deepEqual(seenCursors[0], { lastId: 3 });
    assert.equal(outCount(second.db), 8);
    assert.equal(journal(second.db)['copy-items'].resumes, 1);
    assert.equal(journal(second.db)['copy-items'].attempts, 1);
  });

  it('a crash inside a chunk before COMMIT rolls back the chunk and its cursor', () => {
    const { db } = open();
    const steps = [CREATE_ITEMS, SEED8, copyStep()];
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable, faultHook: crashAt('before-commit', { }) }), /crash/);
    // The crash hit the very first transaction (create-items): nothing journalled as done.
    assert.equal(journal(db)['create-items'], undefined);
    let fired = 0;
    const hook = (point, info) => {
      if (point === 'before-commit' && (fired += 1) === 4) throw new Error('crash mid chunk');
      void info;
    };
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable, faultHook: hook }), /crash mid chunk/);
    const row = journal(db)['copy-items'];
    assert.equal(row.state, 'started');
    assert.equal(outCount(db), 3 * Number(row.chunks));
    runMigrations(db, steps, { assertWritable: writable });
    assert.equal(outCount(db), 8);
  });

  it('never re-applies a done step and never skips one after a crash before the step journal', () => {
    const { db } = open();
    let applied = 0;
    const counted = { id: 'counted', kind: 'atomic', version: '1', apply() { applied += 1; } };
    const steps = [CREATE_ITEMS, counted];
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable, faultHook: crashAt('step-before-commit', { stepId: 'counted' }) }), /crash/);
    assert.equal(journal(db).counted, undefined);
    assert.equal(journal(db)['create-items'].state, 'done');
    runMigrations(db, steps, { assertWritable: writable });
    runMigrations(db, steps, { assertWritable: writable });
    assert.equal(applied, 2, 'rolled-back attempt plus exactly one committed apply');
  });

  it('fails closed with conflict when a done step checksum no longer matches', () => {
    const { db } = open();
    runMigrations(db, [CREATE_ITEMS], { assertWritable: writable });
    const changed = [{ ...CREATE_ITEMS, sql: CREATE_ITEMS.sql + ' -- edited' }];
    assert.throws(() => runMigrations(db, changed, { assertWritable: writable }), (err) => {
      assert.ok(err instanceof StorageError);
      assert.equal(err.code, 'conflict');
      assert.equal(err.details.conflictKind, 'migration_checksum_mismatch');
      return true;
    });
    assert.throws(() => planMigrations(db, changed), /changed after it started/);
  });

  it('fails closed on a journal step this build does not know and on a done step after a gap', () => {
    const { db } = open();
    runMigrations(db, [CREATE_ITEMS, SEED8], { assertWritable: writable });
    assert.throws(() => runMigrations(db, [CREATE_ITEMS], { assertWritable: writable }), (err) => err.details.conflictKind === 'migration_unknown_step');
    db.exec(`UPDATE ${MIGRATION_JOURNAL_TABLE} SET state = 'failed' WHERE step_id = 'create-items'`);
    assert.throws(() => runMigrations(db, [CREATE_ITEMS, SEED8], { assertWritable: writable }), (err) => err.code === 'corrupt');
  });

  it('refuses a touchesUserData step without a backup callback, before running anything', () => {
    const { db } = open();
    const steps = [CREATE_ITEMS, SEED8, copyStep({ touchesUserData: true })];
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable }), (err) => {
      assert.equal(err.code, 'conflict');
      assert.equal(err.details.conflictKind, 'migration_backup_required');
      return true;
    });
    assert.equal(journal(db)['create-items'], undefined, 'no earlier step ran');
  });

  it('calls the backup callback once per touchesUserData step, not again on resume', () => {
    const first = open();
    const calls = [];
    const backupBeforeStep = ({ stepId }) => { calls.push(stepId); return `fake-${stepId}`; };
    const steps = [CREATE_ITEMS, SEED8, copyStep({ touchesUserData: true })];
    assert.throws(() => runMigrations(first.db, steps, { assertWritable: writable, backupBeforeStep, faultHook: crashAt('chunk-committed', { chunkIndex: 0 }) }), /crash/);
    assert.deepEqual(calls, ['copy-items']);
    assert.equal(journal(first.db)['copy-items'].backup_ref, 'fake-copy-items');
    runMigrations(first.db, steps, { assertWritable: writable, backupBeforeStep });
    assert.deepEqual(calls, ['copy-items']);
  });

  it('a failing backup callback leaves the step untouched', () => {
    const { db } = open();
    const steps = [CREATE_ITEMS, SEED8, copyStep({ touchesUserData: true })];
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable, backupBeforeStep() { throw new Error('disk gone'); } }), StorageError);
    assert.equal(journal(db)['copy-items'], undefined);
    assert.equal(outCount(db), 0);
  });

  it('refuses while the coordinator says not writable (fenced / restore paused), before and mid-step', () => {
    const { db } = open();
    const fenced = () => { throw new StorageError('conflict', 'fenced', { details: { conflictKind: 'fenced' } }); };
    assert.throws(() => runMigrations(db, [CREATE_ITEMS], { assertWritable: fenced }), (err) => err.details.conflictKind === 'fenced');
    assert.equal(hasTable(db, MIGRATION_JOURNAL_TABLE), false, 'nothing was written');
    let calls = 0;
    const lostMidStep = () => { calls += 1; if (calls === 4) throw new StorageError('busy', 'restore paused', { details: { conflictKind: 'restore_paused' } }); };
    assert.throws(() => runMigrations(db, [CREATE_ITEMS], { assertWritable: lostMidStep }), (err) => err.code === 'busy');
    assert.equal(journal(db)['create-items'], undefined, 'the step rolled back when writability was lost before COMMIT');
    assert.equal(hasTable(db, 'mig_items'), false);
    assert.throws(() => runMigrations(db, [CREATE_ITEMS], {}), TypeError);
  });

  it('persists the cursor per chunk and pauses after maxChunksPerRun', () => {
    const { db } = open();
    const steps = [CREATE_ITEMS, SEED8, copyStep()];
    const first = runMigrations(db, steps, { assertWritable: writable, maxChunksPerRun: 2 });
    assert.equal(first.status, 'paused');
    assert.equal(journal(db)['copy-items'].cursor, JSON.stringify({ lastId: 6 }));
    assert.equal(first.pending[0].id, 'copy-items');
    assert.deepEqual(first.pending[0].cursor, { lastId: 6 });
    assert.equal(outCount(db), 6);
    const second = runMigrations(db, steps, { assertWritable: writable, maxChunksPerRun: 2 });
    assert.equal(second.status, 'complete');
    assert.equal(outCount(db), 8);
  });

  it('retries a failed step with a bounded attempts counter', () => {
    const { db } = open();
    let failures = 2;
    const flaky = { id: 'flaky', kind: 'atomic', version: '1', apply(d) { d.exec('CREATE TABLE flaky_t (x INTEGER) STRICT'); if (failures > 0) { failures -= 1; throw new Error('boom'); } } };
    const steps = [flaky];
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable, maxAttempts: 3 }), StorageError);
    assert.deepEqual([journal(db).flaky.state, journal(db).flaky.attempts, journal(db).flaky.error_code], ['failed', 1, 'io']);
    assert.equal(hasTable(db, 'flaky_t'), false, 'failed step rolled back');
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable, maxAttempts: 3 }), StorageError);
    assert.equal(journal(db).flaky.attempts, 2);
    runMigrations(db, steps, { assertWritable: writable, maxAttempts: 3 });
    assert.deepEqual([journal(db).flaky.state, journal(db).flaky.attempts], ['done', 3]);
  });

  it('refuses once attempts are exhausted until the operator resets the step', () => {
    const { db } = open();
    const bad = { id: 'bad', kind: 'sql', version: '1', sql: 'INSERT INTO no_such_table VALUES (1)' };
    for (let i = 0; i < 2; i += 1) assert.throws(() => runMigrations(db, [bad], { assertWritable: writable, maxAttempts: 2 }), StorageError);
    assert.equal(journal(db).bad.attempts, 2);
    assert.throws(() => runMigrations(db, [bad], { assertWritable: writable, maxAttempts: 2 }), (err) => err.details.conflictKind === 'migration_attempts_exhausted');
    assert.equal(journal(db).bad.attempts, 2, 'refusal does not run the step');
    assert.equal(resetFailedStep(db, 'bad', { assertWritable: writable }), true);
    assert.equal(journal(db).bad, undefined);
    assert.throws(() => runMigrations(db, [bad], { assertWritable: writable, maxAttempts: 2 }), StorageError);
    assert.equal(journal(db).bad.attempts, 1);
  });

  it('a failing chunk keeps earlier committed chunks and retries from the cursor', () => {
    const { db } = open();
    let blow = true;
    const steps = [CREATE_ITEMS, SEED8, copyStep({ onChunk: (ctx) => { if (blow && ctx.chunkIndex === 1) { blow = false; throw new Error('bad chunk'); } } })];
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable }), StorageError);
    assert.equal(journal(db)['copy-items'].state, 'failed');
    assert.equal(outCount(db), 3);
    runMigrations(db, steps, { assertWritable: writable });
    assert.equal(outCount(db), 8);
    assert.equal(journal(db)['copy-items'].attempts, 2);
  });

  it('rejects a chunk step that makes no progress and a step that commits itself', () => {
    const { db } = open();
    const stuck = { id: 'stuck', kind: 'chunked', version: '1', run: () => ({ done: false, cursor: 1 }) };
    assert.throws(() => runMigrations(db, [stuck], { assertWritable: writable }), (err) => err.details.conflictKind === 'migration_no_progress');
    for (const verb of ['COMMIT', 'ROLLBACK']) {
      const rude = { id: `rude-${verb.toLowerCase()}`, kind: 'atomic', version: '1', apply(d) { d.exec(verb); } };
      const memory = new DatabaseSync(':memory:');
      assert.throws(() => runMigrations(memory, [rude], { assertWritable: writable }), (err) => err.details.conflictKind === 'migration_step_committed');
      assert.equal(memory.isTransaction, false);
      const row = journal(memory)[rude.id];
      assert.equal(row.state, 'failed', `${verb}: step must be journalled failed, not done`);
      assert.equal(row.error_code, 'conflict');
      assert.equal(planMigrations(memory, [rude])[0].state, 'failed', `${verb}: step stays pending`);
      memory.close();
    }
    const rudeChunk = { id: 'rude-chunk', kind: 'chunked', version: '1', run(ctx) { ctx.db.exec('COMMIT'); return { done: true }; } };
    const chunkDb = new DatabaseSync(':memory:');
    assert.throws(() => runMigrations(chunkDb, [rudeChunk], { assertWritable: writable }), (err) => err.details.conflictKind === 'migration_step_committed');
    assert.notEqual(journal(chunkDb)['rude-chunk'].state, 'done');
    chunkDb.close();
  });

  it('resetFailedStep keeps cursor and chunks of a chunked step unless discardProgress', () => {
    const { db } = open();
    let blow = true;
    const steps = [CREATE_ITEMS, SEED8, copyStep({ onChunk: (ctx) => { if (blow && ctx.chunkIndex === 1) throw new Error('bad chunk'); } })];
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable }), StorageError);
    const failed = journal(db)['copy-items'];
    assert.equal(failed.state, 'failed');
    assert.equal(failed.chunks, 1);
    assert.equal(outCount(db), 3);
    assert.equal(resetFailedStep(db, 'copy-items', { assertWritable: writable }), true);
    const rearmed = journal(db)['copy-items'];
    assert.equal(rearmed.state, 'started');
    assert.equal(rearmed.attempts, 1);
    assert.equal(rearmed.chunks, 1);
    assert.equal(rearmed.cursor, failed.cursor);
    assert.equal(rearmed.error_code, null);
    blow = false;
    const seen = [];
    runMigrations(db, [CREATE_ITEMS, SEED8, copyStep({ onChunk: (ctx) => seen.push(ctx.chunkIndex) })], { assertWritable: writable });
    assert.deepEqual(seen, [1, 2], 'resumes at the stored chunk, committed chunks are not replayed');
    assert.equal(outCount(db), 8);
  });

  it('resetFailedStep with discardProgress forgets chunk progress; refuses done rows; checks writable', () => {
    const { db } = open();
    const steps = [CREATE_ITEMS, SEED8, copyStep({ onChunk: (ctx) => { if (ctx.chunkIndex === 1) throw new Error('bad chunk'); } })];
    assert.throws(() => runMigrations(db, steps, { assertWritable: writable }), StorageError);
    assert.equal(resetFailedStep(db, 'copy-items', { assertWritable: writable, discardProgress: true }), true);
    assert.equal(journal(db)['copy-items'], undefined);
    assert.equal(resetFailedStep(db, 'create-items', { assertWritable: writable }), false, 'done rows are not touched');
    assert.equal(journal(db)['create-items'].state, 'done');
    assert.throws(() => resetFailedStep(db, 'copy-items', {}), TypeError);
  });

  it('resetFailedStep and journal creation re-check writable right before COMMIT', () => {
    const { db } = open();
    const bad = { id: 'bad', kind: 'atomic', version: '1', apply() { throw new Error('boom'); } };
    assert.throws(() => runMigrations(db, [bad], { assertWritable: writable }), StorageError);
    let calls = 0;
    const lostAfterBegin = () => { calls += 1; if (calls === 2) throw new StorageError('fenced', 'lost ownership'); };
    assert.throws(() => resetFailedStep(db, 'bad', { assertWritable: lostAfterBegin }), (err) => err instanceof StorageError);
    assert.equal(journal(db).bad.state, 'failed', 'rolled back, row untouched');
    assert.equal(db.isTransaction, false);
    const fresh = new DatabaseSync(':memory:');
    let n = 0;
    const lostBeforeDdlCommit = () => { n += 1; if (n === 3) throw new StorageError('fenced', 'lost ownership'); };
    assert.throws(() => runMigrations(fresh, [CREATE_ITEMS], { assertWritable: lostBeforeDdlCommit }), StorageError);
    assert.equal(hasTable(fresh, MIGRATION_JOURNAL_TABLE), false, 'journal DDL rolled back');
    fresh.close();
  });

  it('dry-run lists pending steps with state and cursor and writes nothing', () => {
    const { db } = open();
    const steps = [CREATE_ITEMS, SEED8, copyStep({ touchesUserData: true })];
    const dry = runMigrations(db, steps, { dryRun: true });
    assert.equal(dry.status, 'dry_run');
    assert.deepEqual(dry.pending.map((p) => [p.id, p.state, p.touchesUserData]), [['create-items', 'pending', false], ['seed8', 'pending', false], ['copy-items', 'pending', true]]);
    assert.equal(hasTable(db, MIGRATION_JOURNAL_TABLE), false);
    runMigrations(db, [CREATE_ITEMS, SEED8], { assertWritable: writable });
    const after = planMigrations(db, steps);
    assert.deepEqual(after.map((p) => p.id), ['copy-items']);
  });

  it('bounds chunk size and time options and exposes the budget to the step', () => {
    const { db } = open();
    assert.throws(() => runMigrations(db, [CREATE_ITEMS], { assertWritable: writable, maxChunkMs: 0 }), TypeError);
    assert.throws(() => runMigrations(db, [CREATE_ITEMS], { assertWritable: writable, maxChunkItems: 10001 }), TypeError);
    assert.throws(() => runMigrations(db, [CREATE_ITEMS], { assertWritable: writable, maxAttempts: 11 }), TypeError);
    const seen = [];
    let t = 0;
    const steps = [CREATE_ITEMS, SEED8, copyStep({ onChunk: (ctx) => seen.push([ctx.maxItems, ctx.deadlineMs, ctx.shouldYield()]) })];
    const events = [];
    runMigrations(db, steps, { assertWritable: writable, maxChunkMs: 20, maxChunkItems: 7, monotonicNow: () => (t += 5), onProgress: (e) => events.push(e) });
    assert.equal(seen[0][0], 7);
    assert.ok(events.some((e) => e.type === 'chunk' && 'overran' in e));
  });

  it('observer errors do not affect the run', () => {
    const { db } = open();
    const result = runMigrations(db, [CREATE_ITEMS], { assertWritable: writable, onProgress() { throw new Error('observer'); } });
    assert.equal(result.status, 'complete');
  });

  it('validates the step list', () => {
    const { db } = open();
    assert.throws(() => runMigrations(db, [CREATE_ITEMS, CREATE_ITEMS], { dryRun: true }), /Duplicate/);
    assert.throws(() => runMigrations(db, [{ id: 'X', kind: 'sql', version: '1', sql: '' }], { dryRun: true }), TypeError);
    assert.throws(() => runMigrations(db, [{ id: 'a', kind: 'sql', version: '1', sql: 'select 1', apply() {} }], { dryRun: true }), TypeError);
    assert.throws(() => runMigrations(db, [{ id: 'a', kind: 'sql', sql: 'select 1' }], { dryRun: true }), /version/);
  });
});

const SEED8 = Object.freeze({ id: 'seed8', kind: 'atomic', version: '1', apply(d) { seedItems(d, 8); } });

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}

describe('switch phase (directory publish)', () => {
  const OPTS = (extra) => ({ opId: 'op1', ...extra });

  function makeWork(name = 'work') {
    const work = path.join(dir, name);
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(work, 'store.txt'), 'new');
    return work;
  }

  it('publishes onto a missing target and stamps the ownership marker', () => {
    const work = makeWork();
    const target = path.join(dir, 'target');
    const result = switchMigrationTarget(OPTS({ workDir: work, target }));
    assert.equal(result.backup, null);
    assert.equal(fs.readFileSync(path.join(target, 'store.txt'), 'utf8'), 'new');
    assert.ok(fs.existsSync(path.join(target, SWITCH_OWNER_MARKER_FILE)));
  });

  it('refuses an existing target without the ownership marker and leaves it untouched', () => {
    const work = makeWork();
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'precious.txt'), 'keep');
    assert.throws(() => switchMigrationTarget(OPTS({ workDir: work, target })),
      (error) => error instanceof StorageError && error.details.conflictKind === 'switch_target_unowned');
    assert.equal(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(work, 'store.txt')), true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['target', 'work']);
  });

  it('backs up an owned target before replacing it', () => {
    const target = path.join(dir, 'target');
    switchMigrationTarget(OPTS({ workDir: makeWork('w1'), target }));
    fs.writeFileSync(path.join(makeWork('w2'), 'extra.txt'), 'x');
    const result = switchMigrationTarget({ opId: 'op2', workDir: path.join(dir, 'w2'), target });
    assert.equal(result.backup, `${target}.backup-op2`);
    assert.equal(fs.readFileSync(path.join(result.backup, 'store.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(target, 'extra.txt'), 'utf8'), 'x');
    assert.ok(fs.existsSync(path.join(target, SWITCH_OWNER_MARKER_FILE)));
  });

  it('refuses a work directory inside a restore path', () => {
    const restoreRoot = path.join(dir, 'restore');
    fs.mkdirSync(path.join(restoreRoot, 'scratch'), { recursive: true });
    const work = path.join(restoreRoot, 'scratch');
    assert.throws(() => switchMigrationTarget(OPTS({ workDir: work, target: path.join(dir, 'target'), restorePaths: [restoreRoot] })),
      (error) => error.code === 'workdir_in_restore_path');
    assert.equal(fs.existsSync(path.join(dir, 'target')), false);
  });
});
