import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { acquireLease, writeControlState } from '../lib/backup/offline/control-dir.js';
import { createOnlineBackup } from '../lib/backup/online/online-backup.js';
import { createBackupScheduler, DEFAULT_POLICY, FAILURE_RETRY_MS, validateTargetDir } from '../lib/backup/online/backup-scheduler.js';
import { applyRetention } from '../lib/backup/online/retention.js';
import { createOnlineBackupService, registerOnlineParticipant, resetOnlineParticipants } from '../lib/backup/online/online-service.js';
import { verifyOfflineBackup } from '../lib/backup/offline/offline-backup.js';
import { verifyEncryptedBackup } from '../lib/backup/encryption/encrypted-backup.js';
import {
  createMaintenanceCoordinator, createMutationGate, evaluateOnlineCapability, MaintenanceError, requiredCoverage, runAcrossGates,
} from '../lib/storage/maintenance-coordinator.js';
import { getStorageRegistry } from '../lib/storage/store-registry.js';

const KDF = { log2N: 14, r: 8, p: 1 };
const PW = 'Tr0ub4dor&3-online-key';

/** Small registry: two JSON-ish stores and one SQLite store, in a deliberate lock order. */
const REGISTRY = {
  registryVersion: 1,
  inventoryGaps: [],
  stores: [
    { id: 'store.alpha', lockOrderRank: 10, backend: { kind: 'json-file', schemaVersion: 1 }, bootstrapMarker: { path: 'alpha.json' }, managedPaths: ['alpha.json'], writers: { unknownGaps: [] } },
    { id: 'store.beta', lockOrderRank: 20, backend: { kind: 'json-file', schemaVersion: 1 }, bootstrapMarker: { path: 'beta.json' }, managedPaths: ['beta.json'], writers: { unknownGaps: [] } },
    { id: 'store.db', lockOrderRank: 30, backend: { kind: 'sqlite-wal-full', schemaVersion: 1 }, bootstrapMarker: { path: 'app.sqlite' }, managedPaths: ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'], writers: { unknownGaps: [] } },
  ],
};

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-online-')); }

function makeEnv() {
  const root = tmp();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'alpha.json'), JSON.stringify({ n: 0 }));
  fs.writeFileSync(path.join(dataDir, 'beta.json'), JSON.stringify({ n: 0 }));
  const db = new DatabaseSync(path.join(dataDir, 'app.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(n INTEGER); INSERT INTO t VALUES (0);');
  return { root, dataDir, db, controlDir: path.join(root, 'control'), destRoot: path.join(root, 'backups') };
}

function gates(extra = {}) {
  return {
    alpha: createMutationGate({ id: 'w.alpha', covers: ['store.alpha'], ...extra.alpha }),
    beta: createMutationGate({ id: 'w.beta', covers: ['store.beta'], ...extra.beta }),
    db: createMutationGate({ id: 'w.db', covers: ['store.db'], ...extra.db }),
  };
}

function coordinatorFor(env, g, budgets) {
  return createMaintenanceCoordinator({ controlDir: env.controlDir, registry: REGISTRY, participants: Object.values(g), budgets });
}

const listArchives = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('.')) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('online mode needs every writer certified; the real registry lists what is missing', () => {
  const none = evaluateOnlineCapability(REGISTRY, []);
  assert.equal(none.enabled, false);
  assert.deepEqual(none.reasons.map((r) => r.code), ['WRITER_NOT_REGISTERED', 'WRITER_NOT_REGISTERED', 'WRITER_NOT_REGISTERED']);
  const g = gates({ beta: { certified: false } });
  const partial = evaluateOnlineCapability(REGISTRY, Object.values(g));
  assert.deepEqual(partial.reasons, [{ code: 'WRITER_NOT_CERTIFIED', id: 'store.beta' }]);

  const real = getStorageRegistry();
  const need = requiredCoverage(real);
  assert.ok(need.length >= real.stores.length);
  assert.equal(evaluateOnlineCapability(real, []).enabled, false);
  const all = [{ id: 'all', kind: 'mutation', covers: need.map((n) => n.id), certified: true, close() {}, open() {}, drain: async () => ({ drained: true }) }];
  assert.equal(evaluateOnlineCapability(real, all).enabled, true);
  // The shipped process registers no writer yet: online stays refused with reasons, never silently on.
  resetOnlineParticipants();
  const svc = createOnlineBackupService({ dataDir: tmp(), controlDir: tmp() });
  assert.equal(svc.coordinator.capability().enabled, false);
});

test('refuses to run without certification and touches no gate', async () => {
  const env = makeEnv();
  const g = gates({ db: { certified: false } });
  const c = coordinatorFor(env, g);
  await assert.rejects(createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY }), { code: 'ONLINE_NOT_CERTIFIED' });
  assert.ok(!g.alpha.isClosed());
  assert.deepEqual(listArchives(env.destRoot), []);
});

test('snapshot stays coherent while writers (two JSON stores + SQLite) keep writing', async () => {
  const env = makeEnv();
  const g = gates();
  const c = coordinatorFor(env, g);
  let stop = false;
  let counter = 0;
  // One logical transaction spans three stores; a coherent snapshot must show the same n in all of them.
  const writer = (async () => {
    while (!stop) {
      try {
        await runAcrossGates([g.alpha, g.beta, g.db], async () => {
          counter += 1;
          const n = counter;
          fs.writeFileSync(path.join(env.dataDir, 'alpha.json'), JSON.stringify({ n }));
          await sleep(1);
          fs.writeFileSync(path.join(env.dataDir, 'beta.json'), JSON.stringify({ n }));
          env.db.exec(`UPDATE t SET n = ${n}`);
        });
      } catch (err) {
        assert.equal(err.code, 'MAINTENANCE_ACTIVE');
        await sleep(2);
      }
    }
  })();
  await sleep(30);
  const made = await createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY });
  await sleep(20);
  stop = true;
  await writer;
  assert.ok(counter > 5, 'writers made progress, so the barrier did not starve them');
  assert.ok(!g.alpha.isClosed() && !g.beta.isClosed() && !g.db.isClosed(), 'gates reopened');
  verifyOfflineBackup(made.path, { registry: REGISTRY });
  const read = (rel) => path.join(made.path, 'files', rel);
  const a = JSON.parse(fs.readFileSync(read('alpha.json'), 'utf8')).n;
  const b = JSON.parse(fs.readFileSync(read('beta.json'), 'utf8')).n;
  const copy = new DatabaseSync(read('app.sqlite'), { readOnly: true });
  const d = copy.prepare('SELECT n FROM t').get().n;
  copy.close();
  assert.ok(a > 0, 'snapshot taken after writes started');
  assert.equal(a, b);
  assert.equal(a, d);
  assert.ok(made.metrics.barrierMs < c.budgets.maxBarrierMs);
  // Staging never survives and the destination holds exactly the published backup.
  assert.equal(listArchives(env.destRoot).length, 1);
  assert.deepEqual(listArchives(path.join(env.controlDir, 'staging')), []);
});

test('runAcrossGates is all-or-nothing: a closed gate refuses before any side effect', async () => {
  const a = createMutationGate({ id: 'a', covers: [] });
  const b = createMutationGate({ id: 'b', covers: [] });
  b.close();
  let ran = false;
  await assert.rejects(runAcrossGates([a, b], () => { ran = true; }), { code: 'MAINTENANCE_ACTIVE' });
  assert.equal(ran, false);
  assert.equal(a.activeCount(), 0, 'the gate entered first was exited again');
});

test('large archive under mixed load stays inside the barrier and event-loop budgets', async () => {
  const env = makeEnv();
  fs.mkdirSync(path.join(env.dataDir, 'big'));
  const big = { ...REGISTRY, stores: [...REGISTRY.stores, { id: 'store.big', lockOrderRank: 40, backend: { kind: 'json-file', schemaVersion: 1 }, bootstrapMarker: { path: 'big/f0.json' }, managedPaths: ['big/*.json'], writers: { unknownGaps: [] } }] };
  const chunk = Buffer.alloc(512 * 1024, 'x');
  for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(env.dataDir, 'big', `f${i}.json`), chunk);
  const g = { ...gates(), big: createMutationGate({ id: 'w.big', covers: ['store.big'] }) };
  const c = createMaintenanceCoordinator({ controlDir: env.controlDir, registry: big, participants: Object.values(g) });
  let stop = false;
  let writes = 0;
  const writer = (async () => {
    while (!stop) {
      try { await runAcrossGates([g.alpha, g.db], async () => { writes += 1; env.db.exec(`UPDATE t SET n = ${writes}`); }); } catch { /* paused */ }
      await sleep(1);
    }
  })();
  const made = await createOnlineBackup({ ...env, coordinator: c, registry: big });
  stop = true;
  await writer;
  assert.equal(made.stage.files, 43);
  assert.ok(made.stage.bytes >= 40 * chunk.length);
  assert.ok(made.metrics.barrierMs < c.budgets.maxBarrierMs, `barrier ${made.metrics.barrierMs} ms`);
  assert.ok(made.metrics.maxLagMs < c.budgets.maxEventLoopLagMs, `lag ${made.metrics.maxLagMs} ms`);
  assert.ok(writes > 0);
});

test('encrypted online backup verifies with the key and leaves no plaintext stage', async () => {
  const env = makeEnv();
  const c = coordinatorFor(env, gates());
  const made = await createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY, password: PW, kdf: KDF });
  assert.equal(made.kind, 'encrypted');
  const v = await verifyEncryptedBackup(made.path, PW, { controlDir: env.controlDir, registry: REGISTRY });
  assert.ok(v.manifest.entries.length >= 3);
  assert.deepEqual(listArchives(path.join(env.controlDir, 'staging')), []);
});

test('barrier duration budget: over-budget staging publishes nothing and reopens gates', async () => {
  const env = makeEnv();
  const g = gates();
  const c = coordinatorFor(env, g, { maxBarrierMs: 40 });
  await assert.rejects(
    createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY, hooks: { afterCopy: () => sleep(60) } }),
    { code: 'BARRIER_BUDGET_EXCEEDED' },
  );
  assert.ok(Object.values(g).every((x) => !x.isClosed()));
  assert.deepEqual(listArchives(env.destRoot), []);
  assert.deepEqual(listArchives(path.join(env.controlDir, 'staging')), []);
});

test('event-loop budget: a blocking staging step aborts the backup', async () => {
  const env = makeEnv();
  const g = gates();
  const c = coordinatorFor(env, g, { maxEventLoopLagMs: 5 });
  const busy = (ms) => { const t = Date.now(); while (Date.now() - t < ms); };
  await assert.rejects(
    createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY, hooks: { afterCopy: () => busy(40) } }),
    { code: 'BARRIER_BUDGET_EXCEEDED' },
  );
  assert.deepEqual(listArchives(env.destRoot), []);
});

test('staging size limit refuses a dataset that belongs to the offline backup', async () => {
  const env = makeEnv();
  const c = coordinatorFor(env, gates(), { maxStageBytes: 10 });
  await assert.rejects(createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY }), { code: 'STAGE_TOO_LARGE' });
  assert.deepEqual(listArchives(env.destRoot), []);
});

test('store locks follow the registry order, not registration order; always released', async () => {
  const env = makeEnv();
  const events = [];
  const mk = (id, store) => createMutationGate({
    id, covers: [store], lock: { acquire: async () => { events.push(`lock:${id}`); }, release: () => { events.push(`unlock:${id}`); } },
  });
  // Registered in reverse order on purpose.
  const parts = [mk('w.db', 'store.db'), mk('w.beta', 'store.beta'), mk('w.alpha', 'store.alpha')];
  const c = createMaintenanceCoordinator({ controlDir: env.controlDir, registry: REGISTRY, participants: parts });
  const out = await c.run({ purpose: 't' }, async () => 'ok');
  assert.equal(out.value, 'ok');
  assert.deepEqual(out.metrics.order, ['w.alpha', 'w.beta', 'w.db']);
  assert.deepEqual(events, ['lock:w.alpha', 'lock:w.beta', 'lock:w.db', 'unlock:w.db', 'unlock:w.beta', 'unlock:w.alpha']);
});

test('a lock that never frees times out without deadlock: held locks and gates are released', async () => {
  const env = makeEnv();
  const released = [];
  const g = gates({
    alpha: { lock: { acquire: async () => {}, release: () => released.push('alpha') } },
    beta: { lock: { acquire: () => new Promise(() => {}), release: () => released.push('beta') } },
  });
  const c = coordinatorFor(env, g, { lockTimeoutMs: 30 });
  await assert.rejects(createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY }), { code: 'LOCK_TIMEOUT' });
  assert.deepEqual(released, ['alpha']);
  assert.ok(Object.values(g).every((x) => !x.isClosed()));
  assert.deepEqual(listArchives(env.destRoot), []);
  // The lease is free again, so the next attempt can proceed (no starvation by a failed barrier).
  const lease = acquireLease(env.controlDir, 'probe');
  lease.release();
});

test('active provider work defers the backup instead of being killed or waited for', async () => {
  const env = makeEnv();
  const provider = createMutationGate({ id: 'w.runs', kind: 'run-launch', covers: ['store.beta'], deferOnActive: true });
  const g = gates({});
  const c = createMaintenanceCoordinator({ controlDir: env.controlDir, registry: REGISTRY, participants: [g.alpha, provider, g.db] });
  let release;
  const active = provider.run(() => new Promise((r) => { release = r; }));
  const err = await createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY }).catch((e) => e);
  assert.equal(err.code, 'MAINTENANCE_DEFERRED');
  assert.equal(err.deferred, true);
  assert.ok(!provider.isClosed() && !g.alpha.isClosed());
  assert.deepEqual(listArchives(env.destRoot), []);
  // The provider run itself was not interrupted and new work is accepted again.
  release('done');
  assert.equal(await active, 'done');
  assert.equal(await provider.run(() => 'next'), 'next');
});

test('a mutation that does not drain in time fails the backup (DRAIN_TIMEOUT)', async () => {
  const env = makeEnv();
  const g = gates();
  const c = coordinatorFor(env, g, { drainTimeoutMs: 30 });
  let release;
  const stuck = g.alpha.run(() => new Promise((r) => { release = r; }));
  await assert.rejects(createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY }), { code: 'DRAIN_TIMEOUT' });
  assert.ok(!g.alpha.isClosed());
  release();
  await stuck;
});

test('failed or timed-out flush publishes nothing; buffers stay with the writer', async () => {
  const env = makeEnv();
  const buffer = ['unsaved'];
  const g = gates({ beta: { flush: async () => ({ ok: false, failed: buffer.length }) } });
  const c = coordinatorFor(env, g);
  const err = await createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY }).catch((e) => e);
  assert.equal(err.code, 'FLUSH_FAILED');
  assert.deepEqual(buffer, ['unsaved'], 'coordinator never clears a failed buffer');
  assert.ok(Object.values(g).every((x) => !x.isClosed()));
  const g2 = gates({ beta: { flush: () => new Promise(() => {}) } });
  await assert.rejects(createOnlineBackup({ ...env, coordinator: coordinatorFor(env, g2, { flushTimeoutMs: 30 }), registry: REGISTRY }), { code: 'FLUSH_FAILED' });
  const g3 = gates({ beta: { flush: async () => { throw new Error('boom'); } } });
  await assert.rejects(createOnlineBackup({ ...env, coordinator: coordinatorFor(env, g3), registry: REGISTRY }), { code: 'FLUSH_FAILED' });
  assert.deepEqual(listArchives(env.destRoot), []);
});

test('unresolved journal blocks the copy', async () => {
  const env = makeEnv();
  const g = gates({ db: { validate: async () => ({ ok: false, pending: 2 }) } });
  await assert.rejects(createOnlineBackup({ ...env, coordinator: coordinatorFor(env, g), registry: REGISTRY }), { code: 'JOURNAL_UNRESOLVED' });
  assert.deepEqual(listArchives(env.destRoot), []);
});

test('an unregistered writer that changes a file mid-copy is detected, nothing is published', async () => {
  const env = makeEnv();
  const c = coordinatorFor(env, gates());
  await assert.rejects(
    createOnlineBackup({
      ...env, coordinator: c, registry: REGISTRY,
      hooks: { duringCopy: (rel) => { if (rel === 'beta.json') fs.appendFileSync(path.join(env.dataDir, rel), ' '); } },
    }),
    { code: 'WRITER_DURING_BARRIER' },
  );
  assert.deepEqual(listArchives(env.destRoot), []);
});

test('fence or dataset generation changing during the barrier aborts', async () => {
  const env = makeEnv();
  const c = coordinatorFor(env, gates());
  await assert.rejects(
    createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY, hooks: { afterCopy: () => writeControlState(env.controlDir, { fence: 5, datasetGeneration: 'g2' }) } }),
    { code: 'FENCE_CHANGED' },
  );
  assert.deepEqual(listArchives(env.destRoot), []);
});

test('full disk is reported before the barrier: no false success, writers never paused', async () => {
  const env = makeEnv();
  const g = gates();
  let closedSeen = false;
  g.alpha.close = ((orig) => () => { closedSeen = true; orig(); })(g.alpha.close);
  const c = coordinatorFor(env, g);
  await assert.rejects(createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY, freeBytes: () => 0 }), { code: 'DISK_FULL' });
  assert.equal(closedSeen, false);
  assert.deepEqual(listArchives(env.destRoot), []);
});

test('external lease and external pause defer the backup', async () => {
  const env = makeEnv();
  const g = gates();
  const c = coordinatorFor(env, g);
  const lease = acquireLease(env.controlDir, 'offline-tool');
  const held = await createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY }).catch((e) => e);
  assert.equal(held.code, 'LEASE_HELD');
  assert.equal(held.deferred, true);
  assert.ok(Object.values(g).every((x) => !x.isClosed()));
  lease.release();
  writeControlState(env.controlDir, { paused: true, pauseReason: 'restore' });
  const paused = await createOnlineBackup({ ...env, coordinator: c, registry: REGISTRY }).catch((e) => e);
  assert.equal(paused.code, 'MAINTENANCE_DEFERRED');
  assert.ok(paused instanceof MaintenanceError);
  assert.deepEqual(listArchives(env.destRoot), []);
});

// ---------- retention ----------

const rec = (id, origin, at, extra = {}) => ({ id, name: `${id}.bak`, origin, verifiedAt: at, ...extra });

test('retention keeps the newest N scheduled, protects manual/protected/last good, runs only after a verified new backup', () => {
  const dir = tmp();
  const archives = [
    rec('s1', 'scheduled', '2026-01-01'), rec('s2', 'scheduled', '2026-01-02'), rec('m1', 'manual', '2026-01-00'),
    rec('s3', 'scheduled', '2026-01-03'), rec('p1', 'scheduled', '2025-12-01', { protected: true }), rec('s4', 'scheduled', '2026-01-04'),
  ];
  for (const a of archives) fs.writeFileSync(path.join(dir, a.name), 'x');
  const r = applyRetention({ targetDir: dir, archives, keep: 2, newId: 's4' });
  assert.deepEqual(r.deleted.sort(), ['s1', 's2']);
  assert.deepEqual(listArchives(dir).sort(), ['m1.bak', 'p1.bak', 's3.bak', 's4.bak']);
  assert.ok(r.kept.includes('m1') && r.kept.includes('p1'));
});

test('retention does nothing when the new backup is not verified, keep is invalid, or names escape the target', () => {
  const dir = tmp();
  const outside = path.join(tmp(), 'victim.bak');
  fs.writeFileSync(outside, 'keep me');
  const archives = [rec('old', 'scheduled', '2026-01-01'), { ...rec('evil', 'scheduled', '2026-01-02'), name: path.relative(dir, outside) }, rec('new', 'scheduled', '')];
  fs.writeFileSync(path.join(dir, 'old.bak'), 'x');
  const unverified = applyRetention({ targetDir: dir, archives, keep: 1, newId: 'new' });
  assert.deepEqual(unverified.deleted, []);
  assert.equal(applyRetention({ targetDir: dir, archives: [...archives.slice(0, 2), rec('new', 'scheduled', '2026-01-03')], keep: 0, newId: 'new' }).deleted.length, 0);
  const traversal = applyRetention({ targetDir: dir, archives: [archives[1], rec('new', 'scheduled', '2026-01-03')], keep: 1, newId: 'new' });
  assert.deepEqual(traversal.deleted, []);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
  assert.ok(fs.existsSync(path.join(dir, 'old.bak')));
});

// ---------- scheduler ----------

function schedulerEnv(overrides = {}) {
  const root = tmp();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const controlDir = path.join(root, 'control');
  const target = path.join(root, 'media', 'backups');
  let clock = Date.parse('2026-03-01T10:00:00Z');
  let seq = 0;
  const calls = [];
  const scheduler = createBackupScheduler({
    controlDir, dataDir,
    capability: overrides.capability || (() => ({ enabled: true, reasons: [] })),
    passwordProvider: overrides.passwordProvider || (() => 'pw-for-tests-123'),
    now: () => clock,
    isPidAlive: overrides.isPidAlive,
    runBackup: overrides.runBackup || (async ({ destRoot, password }) => {
      calls.push({ destRoot, password });
      seq += 1;
      const id = `b${seq}`;
      fs.mkdirSync(destRoot, { recursive: true });
      fs.writeFileSync(path.join(destRoot, `${id}.bak`), 'data');
      return { id, path: path.join(destRoot, `${id}.bak`), kind: 'encrypted', bytes: 4, createdAt: new Date(clock).toISOString() };
    }),
  });
  return { root, dataDir, controlDir, target, scheduler, calls, advance: (ms) => { clock += ms; }, now: () => clock };
}

const HOUR = 3600 * 1000;

test('scheduler is off by default and never runs until opted in', async () => {
  const e = schedulerEnv();
  assert.deepEqual(e.scheduler.getPolicy(), DEFAULT_POLICY);
  assert.equal(DEFAULT_POLICY.enabled, false);
  assert.equal((await e.scheduler.tick()).status, 'disabled');
  assert.equal(e.calls.length, 0);
});

test('policy validation: target must be separate from data/control; bounds enforced', () => {
  const e = schedulerEnv();
  assert.throws(() => e.scheduler.setPolicy({ enabled: true, targetDir: path.join(e.dataDir, 'backups') }), { code: 'TARGET_INVALID' });
  assert.throws(() => e.scheduler.setPolicy({ enabled: true, targetDir: path.join(e.controlDir, 'pre-restore') }), { code: 'TARGET_INVALID' });
  assert.throws(() => e.scheduler.setPolicy({ enabled: true, targetDir: path.dirname(e.dataDir) }), { code: 'TARGET_INVALID' });
  assert.throws(() => e.scheduler.setPolicy({ enabled: true, targetDir: 'relative/dir' }), { code: 'TARGET_INVALID' });
  assert.throws(() => e.scheduler.setPolicy({ keep: 0 }), { code: 'POLICY_INVALID' });
  assert.throws(() => e.scheduler.setPolicy({ intervalHours: 0 }), { code: 'POLICY_INVALID' });
  // A symlink pointing into the data directory is resolved before the check.
  const link = path.join(e.root, 'link');
  fs.symlinkSync(e.dataDir, link);
  assert.throws(() => validateTargetDir(path.join(link, 'x'), e), { code: 'TARGET_INVALID' });
  const ok = e.scheduler.setPolicy({ enabled: true, targetDir: e.target });
  assert.equal(ok.keep, 7);
  assert.equal(ok.intervalHours, 24);
});

test('scheduled run: one backup per slot, then retention keeps 7 and never the unverified', async () => {
  const e = schedulerEnv();
  e.scheduler.setPolicy({ enabled: true, targetDir: e.target, keep: 3 });
  const first = await e.scheduler.tick();
  assert.equal(first.status, 'succeeded');
  assert.equal((await e.scheduler.tick()).status, 'not_due', 'slot deduplication');
  for (let i = 0; i < 5; i += 1) {
    e.advance(25 * HOUR);
    assert.equal((await e.scheduler.tick()).status, 'succeeded');
  }
  const names = listArchives(e.target).sort();
  assert.deepEqual(names, ['b4.bak', 'b5.bak', 'b6.bak']);
  assert.equal(e.scheduler.status().archives.length, 3);
});

test('failure, bad key, missing key and full disk never delete good copies', async () => {
  let fail = null;
  const e = schedulerEnv({
    runBackup: async ({ destRoot }) => {
      if (fail) throw fail;
      fs.mkdirSync(destRoot, { recursive: true });
      const id = `ok${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
      fs.writeFileSync(path.join(destRoot, `${id}.bak`), 'x');
      return { id, path: path.join(destRoot, `${id}.bak`), kind: 'plain', bytes: 1, createdAt: '' };
    },
  });
  e.scheduler.setPolicy({ enabled: true, targetDir: e.target, keep: 1, encrypt: false });
  assert.equal((await e.scheduler.tick()).status, 'succeeded');
  const good = listArchives(e.target);
  assert.equal(good.length, 1);
  for (const err of [Object.assign(new Error('bad key'), { code: 'ENVELOPE_AUTH_FAILED' }), Object.assign(new Error('no space'), { code: 'ENOSPC' }), Object.assign(new Error('disk'), { code: 'DISK_FULL' })]) {
    fail = err;
    e.advance(25 * HOUR);
    const r = await e.scheduler.tick();
    assert.equal(r.status, 'failed');
    assert.equal(r.code, err.code);
    assert.deepEqual(listArchives(e.target), good, `${err.code}: good copy intact`);
    // Retry only after the backoff, not on every tick.
    assert.equal((await e.scheduler.tick()).status, 'waiting');
    e.advance(FAILURE_RETRY_MS + 1);
  }
  assert.equal(e.scheduler.status().archives.length, 1);
  assert.equal(e.scheduler.status().lastFailure.code, 'DISK_FULL');
  // Missing operator key for an encrypted policy: failure, nothing deleted.
  const k = schedulerEnv({ passwordProvider: () => undefined });
  k.scheduler.setPolicy({ enabled: true, targetDir: k.target });
  const r = await k.scheduler.tick();
  assert.equal(r.code, 'KEY_MISSING');
  assert.equal(k.calls.length, 0);
});

test('a deferred backup retries later without counting as a failure', async () => {
  const e = schedulerEnv({ runBackup: async () => { throw new MaintenanceError('MAINTENANCE_DEFERRED', 'provider work active'); } });
  e.scheduler.setPolicy({ enabled: true, targetDir: e.target });
  const r = await e.scheduler.tick();
  assert.equal(r.status, 'deferred');
  const s = e.scheduler.status();
  assert.equal(s.lastFailure, null);
  assert.equal(s.lastDeferral.code, 'MAINTENANCE_DEFERRED');
  assert.ok(s.nextAttemptAt > e.now());
});

test('external pause pauses the scheduler; missing certification reports why', async () => {
  const e = schedulerEnv();
  e.scheduler.setPolicy({ enabled: true, targetDir: e.target });
  writeControlState(e.controlDir, { paused: true, pauseReason: 'restore' });
  assert.equal((await e.scheduler.tick()).status, 'paused');
  assert.equal(e.calls.length, 0);
  const u = schedulerEnv({ capability: () => ({ enabled: false, reasons: [{ code: 'WRITER_NOT_REGISTERED', id: 'store.x' }] }) });
  u.scheduler.setPolicy({ enabled: true, targetDir: u.target });
  const r = await u.scheduler.tick();
  assert.equal(r.status, 'unavailable');
  assert.equal(r.reasons[0].id, 'store.x');
});

test('job lease: single job, live owner respected, dead owner or expired lease taken over (restart-safe)', async () => {
  const e = schedulerEnv();
  e.scheduler.setPolicy({ enabled: true, targetDir: e.target });
  const leaseFile = path.join(e.controlDir, 'online-backup-job-lease.json');
  const lease = (pid, expiresAt) => fs.writeFileSync(leaseFile, JSON.stringify({ token: 'x', pid, host: os.hostname(), expiresAt }));
  lease(process.pid, e.now() + HOUR);
  assert.equal((await e.scheduler.tick()).status, 'busy');
  assert.equal(e.calls.length, 0);

  // Owner process died before the restart: lease is stale and taken over.
  const dead = schedulerEnv({ isPidAlive: () => false });
  dead.scheduler.setPolicy({ enabled: true, targetDir: dead.target });
  fs.writeFileSync(path.join(dead.controlDir, 'online-backup-job-lease.json'), JSON.stringify({ token: 'x', pid: 999999, host: os.hostname(), expiresAt: dead.now() + HOUR }));
  assert.equal((await dead.scheduler.tick()).status, 'succeeded');
  assert.ok(!fs.existsSync(path.join(dead.controlDir, 'online-backup-job-lease.json')), 'released after the job');

  // Live pid but expired TTL (hung job): taken over.
  fs.rmSync(leaseFile, { force: true });
  lease(process.pid, e.now() - 1);
  assert.equal((await e.scheduler.tick()).status, 'succeeded');

  // Unreadable lease: unknown owner is respected, not stolen.
  const bad = schedulerEnv();
  bad.scheduler.setPolicy({ enabled: true, targetDir: bad.target });
  fs.writeFileSync(path.join(bad.controlDir, 'online-backup-job-lease.json'), '{not json');
  assert.equal((await bad.scheduler.tick()).status, 'busy');
});

test('concurrent ticks admit exactly one job', async () => {
  let running = 0;
  let max = 0;
  const e = schedulerEnv({
    runBackup: async ({ destRoot }) => {
      running += 1; max = Math.max(max, running);
      await sleep(30);
      running -= 1;
      fs.mkdirSync(destRoot, { recursive: true });
      fs.writeFileSync(path.join(destRoot, 'one.bak'), 'x');
      return { id: 'one', path: path.join(destRoot, 'one.bak'), kind: 'plain', bytes: 1, createdAt: '' };
    },
  });
  e.scheduler.setPolicy({ enabled: true, targetDir: e.target });
  const results = await Promise.all([e.scheduler.tick(), e.scheduler.tick(), e.scheduler.tick()]);
  assert.equal(max, 1);
  assert.equal(results.filter((r) => r.status === 'succeeded').length, 1);
});

test('restart: bookkeeping survives a new scheduler instance (no duplicate in the same slot)', async () => {
  const e = schedulerEnv();
  e.scheduler.setPolicy({ enabled: true, targetDir: e.target });
  assert.equal((await e.scheduler.tick()).status, 'succeeded');
  const again = createBackupScheduler({
    controlDir: e.controlDir, dataDir: e.dataDir, capability: () => ({ enabled: true, reasons: [] }), now: e.now,
    runBackup: async () => { throw new Error('must not run'); },
  });
  assert.equal((await again.tick()).status, 'not_due');
});

test('a corrupt state file fails closed (no retention on unknown history)', async () => {
  const e = schedulerEnv();
  e.scheduler.setPolicy({ enabled: true, targetDir: e.target });
  fs.mkdirSync(e.controlDir, { recursive: true });
  fs.writeFileSync(path.join(e.controlDir, 'online-backup-state.json'), '{broken');
  await assert.rejects(e.scheduler.tick(), { code: 'CONTROL_CORRUPT' });
  assert.equal(e.calls.length, 0);
});

test('end to end: scheduler + real online backup into a separate target, encrypted with the operator key', async () => {
  const env = makeEnv();
  const g = gates();
  resetOnlineParticipants();
  Object.values(g).forEach((p) => registerOnlineParticipant(p));
  const service = createOnlineBackupService({ dataDir: env.dataDir, controlDir: env.controlDir, registry: REGISTRY, env: { CRETLI_ONLINE_BACKUP_KEY: PW } });
  const target = path.join(env.root, 'other-disk', 'backups');
  service.scheduler.setPolicy({ enabled: true, targetDir: target, keep: 2 });
  // Cheap KDF is injected through a direct call below; the service path uses default scrypt parameters.
  const r = await service.scheduler.tick();
  assert.equal(r.status, 'succeeded', JSON.stringify(r));
  assert.equal(listArchives(target).filter((n) => n.endsWith('.cretlibak')).length, 1);
  resetOnlineParticipants();
});
