import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  checkDatasetGeneration, isRestorePaused, readControlState, writeControlState,
} from '../lib/backup/offline/control-dir.js';
import { createOfflineBackup, verifyOfflineBackup } from '../lib/backup/offline/offline-backup.js';
import {
  finalizeRestore, readRestoreJournal, recoverPendingRestore, restoreOfflineBackup, resumeAfterRestore, rollbackRestore,
} from '../lib/backup/offline/offline-restore.js';
import { enumerateManaged } from '../lib/backup/offline/managed-files.js';
import { checkExternalRestoreGeneration, createRestoreGate } from '../lib/backup/offline/restore-gate.js';
import { createChatHistoryAdapter } from '../lib/persist/chat-history-adapter.js';
import { appendChatHistoryEvents, deleteChatHistory, setChatHistoryAdapterForTests } from '../lib/persist/chat-history-service.js';

/** @returns {{ root: string, dataDir: string, controlDir: string, destRoot: string }} */
function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-offline-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, controlDir: path.join(root, 'control'), destRoot: path.join(root, 'backups') };
}

/** @param {string} file @param {string} marker */
function writeDb(file, marker) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id), v TEXT);');
  db.exec(`INSERT INTO p VALUES (1); INSERT INTO c VALUES (1, 1, '${marker}');`);
  db.close();
}

/** @param {string} file */
function readMarker(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return String(db.prepare('SELECT v FROM c').get().v); } finally { db.close(); }
}

/** @param {string} dataDir @param {string} gen */
function seed(dataDir, gen) {
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, rel), text);
  };
  w('chats.json', `{"gen":"${gen}"}`);
  w('todos/a.json', `{"a":"${gen}"}`);
  w('todos/b.json', `{"b":"${gen}"}`);
  w('usage/ledger-index.json', `{"i":"${gen}"}`);
  w('config.json', `{"c":"${gen}"}`);
  writeDb(path.join(dataDir, 'recovery.sqlite'), gen);
  writeDb(path.join(dataDir, 'delegations.sqlite'), gen);
}

/** Retained / unrelated / runtime material that must survive and never be archived. */
function seedRetained(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'auth.json'), 'SECRET-AUTH');
  fs.mkdirSync(path.join(dataDir, 'claude-home'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'claude-home', 'x'), 'home');
  fs.writeFileSync(path.join(dataDir, 'unrelated.txt'), 'keep me');
  fs.writeFileSync(path.join(dataDir, 'workspace-watchers.lock.sqlite'), 'runtime-lock');
}

/** @param {string} dataDir */
function snapshot(dataDir) {
  const out = {};
  for (const { rel } of enumerateManaged(dataDir, { includeSidecars: true }).files) {
    const abs = path.join(dataDir, rel);
    out[rel] = rel.endsWith('.sqlite') ? `sqlite:${readMarker(abs)}` : fs.readFileSync(abs, 'utf8');
  }
  return out;
}

/** @param {string} dataDir */
function leftovers(dataDir) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (/\.restore-.*\.(staged|prev)$/.test(e.name)) found.push(e.name);
    }
  };
  walk(dataDir);
  return found;
}

test('round trip restores managed data, preserves retained paths, excludes runtime locks, fences generation', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  seedRetained(env.dataDir);
  writeControlState(env.controlDir, { datasetGeneration: 'old-gen', fence: 4 });
  const expected = snapshot(env.dataDir);
  const { backupDir, manifest } = await createOfflineBackup(env);
  assert.ok(!manifest.entries.some((e) => e.path.includes('.lock')), 'runtime lock excluded');
  assert.ok(!manifest.entries.some((e) => e.path === 'auth.json'));
  assert.equal(manifest.entries.filter((e) => e.kind === 'sqlite').length, 2);
  verifyOfflineBackup(backupDir);

  seed(env.dataDir, 'v2');
  fs.rmSync(path.join(env.dataDir, 'todos', 'a.json'));
  fs.writeFileSync(path.join(env.dataDir, 'todos', 'extra.json'), '{}');
  fs.writeFileSync(path.join(env.dataDir, 'recovery.sqlite-wal'), '');
  const result = await restoreOfflineBackup({ ...env, backupDir, externalHighWater: 50 });

  assert.deepEqual(snapshot(env.dataDir), expected);
  assert.equal(fs.readFileSync(path.join(env.dataDir, 'auth.json'), 'utf8'), 'SECRET-AUTH');
  assert.equal(fs.readFileSync(path.join(env.dataDir, 'claude-home', 'x'), 'utf8'), 'home');
  assert.equal(fs.readFileSync(path.join(env.dataDir, 'unrelated.txt'), 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(path.join(env.dataDir, 'workspace-watchers.lock.sqlite'), 'utf8'), 'runtime-lock');
  assert.ok(!fs.existsSync(path.join(env.dataDir, 'todos', 'extra.json')));
  const state = readControlState(env.controlDir);
  assert.equal(state.datasetGeneration, result.generation);
  assert.notEqual(state.datasetGeneration, 'old-gen');
  assert.ok(state.fence > 50 && state.fence > 4);
  assert.ok(isRestorePaused(env.controlDir));
  assert.ok(fs.existsSync(path.join(result.preRestoreBackup, 'manifest.json')), 'verified pre-restore copy');
  // Pre-restore copy holds the v2 data that was replaced.
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.preRestoreBackup, 'files', 'chats.json'), 'utf8')).gen, 'v2');

  finalizeRestore(env);
  assert.deepEqual(leftovers(env.dataDir), []);
  resumeAfterRestore(env.controlDir);
  assert.equal(isRestorePaused(env.controlDir), false);
});

test('crash after every journal step rolls forward to the backup state', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const expected = snapshot(env.dataDir);
  const { backupDir } = await createOfflineBackup(env);
  let crashes = 0;
  for (let n = 1; n < 200; n += 1) {
    seed(env.dataDir, 'v2');
    fs.writeFileSync(path.join(env.dataDir, 'todos', 'extra.json'), '{}');
    let calls = 0;
    const hooks = { onStep() { calls += 1; if (calls === n) throw new Error('simulated crash'); } };
    let crashed = false;
    try {
      await restoreOfflineBackup({ ...env, backupDir, hooks });
    } catch (err) {
      if (!/simulated crash/.test(String(err?.message))) throw err;
      crashed = true;
    }
    if (!crashed) {
      assert.deepEqual(snapshot(env.dataDir), expected);
      finalizeRestore(env);
      break;
    }
    crashes += 1;
    // Process restart: a stale lease from the "dead" run is released by the lease guard (same pid is alive here).
    fs.rmSync(path.join(env.controlDir, 'lease.json'), { force: true });
    const rec = recoverPendingRestore(env);
    if (rec.action === 'aborted') {
      assert.equal(readRestoreJournal(env.controlDir), null);
      assert.equal(snapshot(env.dataDir)['chats.json'], '{"gen":"v2"}', 'abort leaves data untouched');
      assert.deepEqual(leftovers(env.dataDir), []);
      continue;
    }
    if (rec.action === 'none' && readRestoreJournal(env.controlDir) === null) {
      // The failure hit while still staging: the restore aborted itself before touching any destination.
      assert.equal(snapshot(env.dataDir)['chats.json'], '{"gen":"v2"}');
      assert.deepEqual(leftovers(env.dataDir), []);
      continue;
    }
    // A crash on the very last hook happens after the journal already says complete.
    assert.ok(rec.action === 'rolled-forward' || (rec.action === 'none' && readRestoreJournal(env.controlDir).status === 'complete'));
    assert.deepEqual(snapshot(env.dataDir), expected, `state after crash #${n}`);
    assert.ok(isRestorePaused(env.controlDir));
    finalizeRestore(env);
    assert.deepEqual(leftovers(env.dataDir), []);
  }
  assert.ok(crashes >= 20, `expected many crash points, got ${crashes}`);
});

test('full disk while staging leaves destinations untouched and clean', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir } = await createOfflineBackup(env);
  seed(env.dataDir, 'v2');
  let n = 0;
  const hooks = { beforeStage() { n += 1; if (n === 3) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); } };
  await assert.rejects(restoreOfflineBackup({ ...env, backupDir, hooks }), /ENOSPC/);
  assert.equal(snapshot(env.dataDir)['chats.json'], '{"gen":"v2"}');
  assert.deepEqual(leftovers(env.dataDir), []);
  assert.equal(readRestoreJournal(env.controlDir), null);
  assert.equal(readControlState(env.controlDir).datasetGeneration, null);
});

test('active or unknown writers and held lease are refused', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const lock = path.join(env.dataDir, 'delegation-owner.lock');
  fs.mkdirSync(lock);
  await assert.rejects(createOfflineBackup(env), { code: 'UNKNOWN_WRITER' });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(createOfflineBackup(env), { code: 'ACTIVE_WRITER' });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
  await createOfflineBackup(env); // dead owner: stale lock leftover is a runtime artifact
  fs.rmSync(lock, { recursive: true });
  fs.writeFileSync(path.join(env.dataDir, 'recovery.sqlite-wal'), 'dirty');
  await assert.rejects(createOfflineBackup(env), { code: 'UNKNOWN_WRITER' });
  fs.rmSync(path.join(env.dataDir, 'recovery.sqlite-wal'));
  fs.mkdirSync(env.controlDir, { recursive: true });
  fs.writeFileSync(path.join(env.controlDir, 'lease.json'), JSON.stringify({ token: 'x', pid: process.pid, host: os.hostname() }));
  await assert.rejects(createOfflineBackup(env), { code: 'LEASE_HELD' });
});

test('staged SQLite must pass integrity_check and foreign_key_check', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  // Foreign-key violation written with enforcement off.
  const db = new DatabaseSync(path.join(env.dataDir, 'recovery.sqlite'));
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO c VALUES (2, 999, 'orphan');");
  db.close();
  await assert.rejects(createOfflineBackup(env), { code: 'SQLITE_CHECK_FAILED' });
  assert.deepEqual(fs.readdirSync(env.destRoot), [], 'no partial backup published');

  writeDb(path.join(env.dataDir, 'recovery.sqlite'), 'v1');
  const { backupDir } = await createOfflineBackup(env);
  // Tampered payload fails digest verification before any restore mutation.
  const payload = path.join(backupDir, 'files', 'recovery.sqlite');
  const buf = fs.readFileSync(payload);
  buf[buf.length - 10] ^= 0xff;
  fs.writeFileSync(payload, buf);
  assert.throws(() => verifyOfflineBackup(backupDir), { code: 'BACKUP_INVALID' });
  seed(env.dataDir, 'v2');
  await assert.rejects(restoreOfflineBackup({ ...env, backupDir }), { code: 'BACKUP_INVALID' });
  assert.equal(snapshot(env.dataDir)['chats.json'], '{"gen":"v2"}');
});

test('manifest cannot reach protected, traversal or non-managed paths; unsupported format fails early', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir } = await createOfflineBackup(env);
  const manifestFile = path.join(backupDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const base = manifest.entries[0];
  for (const bad of ['auth.json', '../escape.json', '/etc/passwd', 'unrelated.txt', 'claude-home/x']) {
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, entries: [{ ...base, path: bad }] }));
    assert.throws(() => verifyOfflineBackup(backupDir), (err) => ['UNSAFE_PATH', 'PROTECTED_PATH', 'BACKUP_INVALID'].includes(err.code), bad);
  }
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, format: 'cretli-offline-backup/99' }));
  assert.throws(() => verifyOfflineBackup(backupDir), { code: 'BACKUP_UNSUPPORTED' });
});

test('stale or missing dataset generation is rejected after restore', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  assert.deepEqual(checkDatasetGeneration(env.controlDir, undefined), { ok: true }, 'legacy dataset without generation');
  const { backupDir } = await createOfflineBackup(env);
  const first = await restoreOfflineBackup({ ...env, backupDir });
  assert.equal(checkDatasetGeneration(env.controlDir, undefined).code, 'generation_missing');
  assert.equal(checkDatasetGeneration(env.controlDir, '').code, 'generation_missing');
  assert.equal(checkDatasetGeneration(env.controlDir, 'old-generation').code, 'generation_stale');
  assert.deepEqual(checkDatasetGeneration(env.controlDir, first.generation), { ok: true });
  finalizeRestore(env);
  const second = await restoreOfflineBackup({ ...env, backupDir });
  assert.notEqual(second.generation, first.generation);
  assert.ok(second.fence > first.fence);
  assert.equal(checkDatasetGeneration(env.controlDir, first.generation).code, 'generation_stale');
});

test('restore gate pauses automatic work once and is a no-op before restore', () => {
  const env = makeEnv();
  const gate = createRestoreGate(env.controlDir);
  const logs = [];
  assert.equal(gate.shouldSkipAutomaticWork((message) => logs.push(message)), false);
  assert.equal(gate.checkRestoreGeneration(undefined).ok, true);
  writeControlState(env.controlDir, { paused: true, datasetGeneration: 'restored-generation', fence: 4 });
  assert.equal(gate.shouldSkipAutomaticWork((message) => logs.push(message)), true);
  assert.equal(gate.shouldSkipAutomaticWork((message) => logs.push(message)), true);
  assert.equal(logs.length, 1, 'pause is logged once while the state remains paused');
  assert.equal(gate.checkRestoreGeneration(undefined).code, 'generation_missing');
  writeControlState(env.controlDir, { paused: false });
  assert.equal(gate.shouldSkipAutomaticWork((message) => logs.push(message)), false);
  assert.equal(gate.checkRestoreGeneration('restored-generation').ok, true);
});

test('restore generation is an HTTP admission check, not an internal history identity', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir } = await createOfflineBackup(env);
  await restoreOfflineBackup({ ...env, backupDir });
  resumeAfterRestore(env.controlDir);
  const gate = createRestoreGate(env.controlDir);
  const current = readControlState(env.controlDir).datasetGeneration;
  assert.equal(checkExternalRestoreGeneration(gate, undefined).body.code, 'generation_missing');
  assert.equal(checkExternalRestoreGeneration(gate, 'old').body.code, 'generation_stale');
  assert.equal(checkExternalRestoreGeneration(gate, current), null);

  const calls = [];
  const backend = Object.fromEntries([
    ['loadChatHistory', async () => null], ['appendChatHistoryEvents', async (...args) => { calls.push(['append', args]); return { ok: true }; }],
    ['appendChatNotice', async () => ({ ok: true })], ['getChatHistorySince', async () => ({ ok: true })],
    ['getChatHistoryEvent', async () => ({ ok: true })], ['getChatHistoryPage', async () => ({ ok: true })],
    ['copyChatHistory', async () => ({ ok: true })], ['copyChatHistoryUntil', async () => ({ ok: true })],
    ['deleteChatHistory', async (...args) => { calls.push(['delete', args]); return { ok: true }; }],
    ['listChatHistoryHeadSeqs', async () => []], ['getChatHistoryUsage', async () => ({})],
  ]);
  setChatHistoryAdapterForTests(createChatHistoryAdapter({ backend, kind: 'legacy' }));
  try {
    await appendChatHistoryEvents('chat-1', 'session-1', [], {});
    await deleteChatHistory('chat-1');
    assert.deepEqual(calls.map(([kind]) => kind), ['append', 'delete']);
  } finally {
    setChatHistoryAdapterForTests(null);
  }
});

test('explicit rollback restores previous files and advances the fence again', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir } = await createOfflineBackup(env);
  seed(env.dataDir, 'v2');
  fs.writeFileSync(path.join(env.dataDir, 'todos', 'extra.json'), '{"x":1}');
  const before = snapshot(env.dataDir);
  const res = await restoreOfflineBackup({ ...env, backupDir });
  assert.throws(() => rollbackRestore(env), { code: 'ROLLBACK_NOT_ACKNOWLEDGED' });
  rollbackRestore({ ...env, acknowledgeLossy: true });
  assert.deepEqual(snapshot(env.dataDir), before);
  const after = readControlState(env.controlDir);
  assert.notEqual(after.datasetGeneration, res.generation);
  assert.ok(after.fence > res.fence);
  assert.ok(after.paused);
  assert.deepEqual(leftovers(env.dataDir), []);
});

test('recovery abandons a restore that crashed while still preparing', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir } = await createOfflineBackup(env);
  const staged = path.join(env.dataDir, '.chats.json.restore-x.staged');
  fs.writeFileSync(staged, 'partial');
  fs.mkdirSync(env.controlDir, { recursive: true });
  fs.writeFileSync(path.join(env.controlDir, 'restore-journal.json'), JSON.stringify({
    schema: 1, id: 'x', status: 'preparing', backupDir, paths: [{ rel: 'chats.json', action: 'replace', step: 'pending' }],
    newState: { datasetGeneration: 'g', fence: 9 },
  }));
  assert.equal(recoverPendingRestore(env).action, 'aborted');
  assert.ok(!fs.existsSync(staged));
  assert.equal(readRestoreJournal(env.controlDir), null);
  assert.equal(readControlState(env.controlDir).datasetGeneration, null);
});
