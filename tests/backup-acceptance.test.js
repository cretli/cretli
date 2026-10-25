/**
 * Backup/restore acceptance suite (todo 7). Exercises export -> restore end to end on isolated temp-dir
 * fixtures through the public offline/encrypted/zip/retention APIs. No agent, provider or child process
 * is ever started. Measurements are printed as `METRIC {...}` lines and summarised in
 * docs/backup-acceptance-report.md. Cases whose feature does not exist are `skip`ped with the reason.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createOfflineBackup, verifyOfflineBackup } from '../lib/backup/offline/offline-backup.js';
import {
  finalizeRestore, readRestoreJournal, recoverPendingRestore, restoreOfflineBackup, rollbackRestore, resumeAfterRestore,
} from '../lib/backup/offline/offline-restore.js';
import { isRestorePaused, readControlState } from '../lib/backup/offline/control-dir.js';
import { enumerateManaged, sha256File } from '../lib/backup/offline/managed-files.js';
import {
  createEncryptedBackup, openEncryptedBackup, restoreEncryptedBackup, verifyEncryptedBackup,
} from '../lib/backup/encryption/encrypted-backup.js';
import { decryptToFile, ENVELOPE_LIMITS } from '../lib/backup/encryption/envelope.js';
import { buildStoreZip, readStoreZip, ZipArchiveError } from '../lib/backup/zip-store.js';
import { applyRetention } from '../lib/backup/online/retention.js';
import { createOnlineBackup } from '../lib/backup/online/online-backup.js';

const KDF = { log2N: 14, r: 8, p: 1 };
const PW = 'Tr0ub4dor&3-acceptance-key';
const CANARY = 'CANARY-ACCEPT-SECRET-91c2';
const metric = (name, value) => console.log(`METRIC ${JSON.stringify({ name, ...value })}`);

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-accept-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, controlDir: path.join(root, 'control'), destRoot: path.join(root, 'backups') };
}

function writeDb(file, marker, rows = 1) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id), v TEXT);');
  db.exec('INSERT INTO p VALUES (1)');
  const ins = db.prepare('INSERT INTO c VALUES (?, 1, ?)');
  for (let i = 1; i <= rows; i += 1) ins.run(i, `${marker}-${i}`);
  db.close();
}

function seed(dataDir, gen, { rows = 1, blobKb = 0 } = {}) {
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, rel), text);
  };
  w('chats.json', `{"gen":"${gen}"}`);
  w('todos/a.json', `{"a":"${gen}"}`);
  w('todos/b.json', blobKb ? JSON.stringify({ pad: crypto.randomBytes(blobKb * 512).toString('hex') }) : `{"b":"${gen}"}`);
  w('usage/ledger-index.json', `{"i":"${gen}"}`);
  w('mcp.json', `{"servers":"${gen}"}`);
  w('mcp-secrets.json', `{"token":"${CANARY}-${gen}"}`);
  writeDb(path.join(dataDir, 'recovery.sqlite'), gen, rows);
  writeDb(path.join(dataDir, 'delegations.sqlite'), gen, rows);
}

/** Auth/TLS/harness/unrelated material that must be neither archived nor touched by a restore. */
function seedRetained(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'auth.json'), 'SECRET-AUTH');
  fs.mkdirSync(path.join(dataDir, 'claude-home'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'claude-home', 'x'), 'home');
  fs.writeFileSync(path.join(dataDir, 'unrelated.txt'), 'keep me');
}

/** Content hash + row counts of everything managed, for before/after comparison. */
function fingerprint(dataDir) {
  const out = {};
  for (const { rel } of enumerateManaged(dataDir, { includeSidecars: true }).files) {
    const abs = path.join(dataDir, rel);
    if (rel.endsWith('.sqlite')) {
      const db = new DatabaseSync(abs, { readOnly: true });
      try {
        out[rel] = { rows: db.prepare('SELECT COUNT(*) n FROM c').get().n, first: db.prepare('SELECT v FROM c ORDER BY id LIMIT 1').get().v };
      } finally { db.close(); }
    } else {
      out[rel] = { sha: sha256File(abs) };
    }
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
}

const noPartials = (dataDir) => walk(dataDir).filter((f) => /\.(partial|restore-|staged)|\.tmp$/.test(f));

test('fresh install: restore into an empty data dir reproduces hashes and SQLite row counts', async () => {
  const src = makeEnv();
  seed(src.dataDir, 'v1', { rows: 500 });
  seedRetained(src.dataDir);
  const expected = fingerprint(src.dataDir);
  let t = Date.now();
  const { backupDir, manifest } = await createOfflineBackup(src);
  const backupMs = Date.now() - t;
  assert.equal(manifest.credentials, false);
  assert.ok(manifest.omissions.some((o) => o.includes('mcp-secrets.json')), 'plain backup records the secret omission');
  const files = walk(path.join(backupDir, 'files')).map((f) => path.relative(path.join(backupDir, 'files'), f));
  assert.ok(!files.some((f) => /auth\.json|claude-home|unrelated/.test(f)), 'retained paths never archived');
  assert.ok(!JSON.stringify(walk(backupDir).map((f) => fs.readFileSync(f).includes(CANARY))).includes('true'), 'secret canary absent from plain backup');
  for (const e of manifest.entries) assert.equal(sha256File(path.join(backupDir, 'files', e.path)), e.sha256);

  const dst = makeEnv(); // fresh install: no data, no control dir
  t = Date.now();
  const r = await restoreOfflineBackup({ ...dst, backupDir });
  const restoreMs = Date.now() - t;
  const got = fingerprint(dst.dataDir);
  delete expected['mcp-secrets.json'];
  assert.deepEqual(got, expected);
  assert.equal(got['recovery.sqlite'].rows, 500);
  assert.ok(isRestorePaused(dst.controlDir), 'dataset stays paused until explicit resume');
  assert.ok(r.generation);
  assert.deepEqual(noPartials(dst.dataDir), []);
  assert.ok(!fs.existsSync(path.join(dst.dataDir, 'auth.json')));
  metric('fresh-restore', { entries: manifest.entries.length, sqliteRows: 500, backupMs, restoreMs, replaced: r.replaced });
  finalizeRestore(dst);
  resumeAfterRestore(dst.controlDir);
  assert.equal(isRestorePaused(dst.controlDir), false);
});

test('existing install: retained paths and unrelated files survive; rollback reverses; managed secrets kept when backup declares none', async () => {
  const src = makeEnv();
  seed(src.dataDir, 'v1');
  const { backupDir } = await createOfflineBackup(src);
  const env = makeEnv();
  seed(env.dataDir, 'v2');
  seedRetained(env.dataDir);
  fs.writeFileSync(path.join(env.dataDir, 'todos', 'extra.json'), '{}');
  const before = fingerprint(env.dataDir);
  const r = await restoreOfflineBackup({ ...env, backupDir });
  assert.ok(r.removed >= 1, 'managed file absent from backup is removed');
  assert.equal(fs.readFileSync(path.join(env.dataDir, 'auth.json'), 'utf8'), 'SECRET-AUTH');
  assert.equal(fs.readFileSync(path.join(env.dataDir, 'unrelated.txt'), 'utf8'), 'keep me');
  assert.ok(fs.readFileSync(path.join(env.dataDir, 'mcp-secrets.json'), 'utf8').includes('v2'), 'destination secrets kept');
  assert.equal(fs.existsSync(path.join(env.dataDir, 'todos', 'extra.json')), false);
  // Write after restore, then lossy rollback: the new write is lost, previous state is back.
  fs.writeFileSync(path.join(env.dataDir, 'chats.json'), '{"gen":"post-restore"}');
  rollbackRestore({ ...env, acknowledgeLossy: true });
  assert.deepEqual(fingerprint(env.dataDir), before);
  assert.ok(isRestorePaused(env.controlDir), 'rollback leaves the dataset paused for reconciliation');
});

test('corrupt source: a non-SQLite or damaged *.sqlite aborts the backup and publishes nothing', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  fs.writeFileSync(path.join(env.dataDir, 'delegations.sqlite'), 'this is not sqlite');
  await assert.rejects(createOfflineBackup(env), (e) => e.code === 'SQLITE_CORRUPT');
  const left = fs.existsSync(env.destRoot) ? fs.readdirSync(env.destRoot) : [];
  assert.deepEqual(left, [], 'no partial or published backup directory');
});

test('corrupt backup payload: digest mismatch, missing payload, bad SQLite and unknown format fail verification before restore', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir, manifest } = await createOfflineBackup(env);
  const cases = {
    digest: () => fs.appendFileSync(path.join(backupDir, 'files', 'chats.json'), ' '),
    missing: () => fs.rmSync(path.join(backupDir, 'files', 'todos', 'a.json')),
    format: () => { const m = { ...manifest, format: 'cretli-offline-backup/99' }; fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(m)); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const copy = path.join(env.root, `copy-${name}`);
    fs.cpSync(backupDir, copy, { recursive: true });
    const orig = backupDir;
    const mutated = copy;
    // Re-point the mutation at the copy.
    if (name === 'digest') fs.appendFileSync(path.join(mutated, 'files', 'chats.json'), ' ');
    if (name === 'missing') fs.rmSync(path.join(mutated, 'files', 'todos', 'a.json'));
    if (name === 'format') fs.writeFileSync(path.join(mutated, 'manifest.json'), JSON.stringify({ ...manifest, format: 'cretli-offline-backup/99' }));
    void orig; void cases;
    const target = makeEnv();
    seed(target.dataDir, 'keep');
    const pre = fingerprint(target.dataDir);
    await assert.rejects(restoreOfflineBackup({ ...target, backupDir: mutated }), (e) => ['BACKUP_INVALID', 'BACKUP_UNSUPPORTED'].includes(e.code), name);
    assert.deepEqual(fingerprint(target.dataDir), pre, `${name}: destination untouched`);
  }
  // Staged SQLite with a dangling FK fails integrity gates (digest recomputed so only the DB check can catch it).
  const bad = path.join(env.root, 'copy-fk');
  fs.cpSync(backupDir, bad, { recursive: true });
  const dbFile = path.join(bad, 'files', 'recovery.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO c VALUES (999, 12345, 'dangling')");
  db.close();
  const m = JSON.parse(fs.readFileSync(path.join(bad, 'manifest.json'), 'utf8'));
  m.entries.find((e) => e.path === 'recovery.sqlite').sha256 = sha256File(dbFile);
  fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify(m));
  assert.throws(() => verifyOfflineBackup(bad), (e) => e.code === 'SQLITE_CHECK_FAILED');
});

test('path traversal and non-managed manifest entries are rejected', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir, manifest } = await createOfflineBackup(env);
  for (const evil of ['../escape.json', '/etc/passwd', 'auth.json', 'claude-home/x', '.cretli-control/state.json', 'a/../../b']) {
    const copy = path.join(env.root, `evil-${crypto.randomBytes(3).toString('hex')}`);
    fs.cpSync(backupDir, copy, { recursive: true });
    const m = { ...manifest, entries: [...manifest.entries, { path: evil, storeId: 'x', kind: 'file', bytes: 0, sha256: '0'.repeat(64) }] };
    fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(m));
    assert.throws(() => verifyOfflineBackup(copy), (e) => ['UNSAFE_PATH', 'PROTECTED_PATH', 'BACKUP_INVALID'].includes(e.code), evil);
  }
});

test('encrypted round trip: secrets only with the opt-in, no plaintext canary in the envelope, listing is header-only', async () => {
  const src = makeEnv();
  seed(src.dataDir, 'v1', { rows: 200 });
  const expectedFull = fingerprint(src.dataDir);
  let t = Date.now();
  const withSecrets = await createEncryptedBackup({ ...src, password: PW, kdf: KDF, includeCredentials: true });
  const encMs = Date.now() - t;
  const plain = await createEncryptedBackup({ ...src, password: PW, kdf: KDF });
  for (const f of [withSecrets.file, plain.file]) {
    assert.equal(fs.readFileSync(f).includes(CANARY), false, 'ciphertext holds no plaintext canary');
    assert.equal(fs.statSync(f).mode & 0o077, 0, 'backup file is owner-only');
  }
  const dst = makeEnv();
  seed(dst.dataDir, 'old');
  t = Date.now();
  await verifyEncryptedBackup(withSecrets.file, PW, { controlDir: dst.controlDir });
  const verifyMs = Date.now() - t;
  t = Date.now();
  await restoreEncryptedBackup({ ...dst, file: withSecrets.file, password: PW, kdf: KDF });
  const restoreMs = Date.now() - t;
  assert.deepEqual(fingerprint(dst.dataDir), expectedFull, 'secrets restored from the opt-in backup');
  // Pre-restore recovery copy is encrypted and re-openable with the same key.
  const pre = fs.readdirSync(path.join(dst.controlDir, 'pre-restore')).filter((n) => n.endsWith('.cretlibak'));
  assert.equal(pre.length, 1);
  await verifyEncryptedBackup(path.join(dst.controlDir, 'pre-restore', pre[0]), PW, { controlDir: dst.controlDir });
  assert.equal(fs.readFileSync(path.join(dst.controlDir, 'pre-restore', pre[0])).includes('old'), false);
  // Staging area is gone after success.
  const staging = path.join(dst.controlDir, 'staging');
  assert.ok(!fs.existsSync(staging) || fs.readdirSync(staging).length === 0, 'plaintext staging cleaned');
  await assert.rejects(verifyEncryptedBackup(withSecrets.file, 'wrong-passphrase-123', { controlDir: dst.controlDir }), (e) => e.code === 'ENVELOPE_AUTH_FAILED');
  // Plain profile restore keeps destination secrets.
  const keep = makeEnv();
  seed(keep.dataDir, 'dest');
  await restoreEncryptedBackup({ ...keep, file: plain.file, password: PW, kdf: KDF });
  assert.ok(fs.readFileSync(path.join(keep.dataDir, 'mcp-secrets.json'), 'utf8').includes('dest'));
  metric('encrypted', { encryptMs: encMs, verifyMs, restoreMs, envelopeBytes: fs.statSync(withSecrets.file).size, kdf: KDF });
});

test('crypto: truncation, tamper, reorder, trailing bytes and KDF-limit abuse fail without leaving plaintext', async () => {
  const src = makeEnv();
  seed(src.dataDir, 'v1', { blobKb: 200 });
  const { file } = await createEncryptedBackup({ ...src, password: PW, kdf: KDF, chunkSize: 65536, includeCredentials: true });
  const bytes = fs.readFileSync(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-accept-crypto-'));
  const run = async (name, buf, expectCodes) => {
    const f = path.join(dir, `${name}.cretlibak`);
    const out = path.join(dir, `${name}.out`);
    fs.writeFileSync(f, buf);
    await assert.rejects(decryptToFile(f, out, PW), (e) => { assert.ok(expectCodes.includes(e.code), `${name}: ${e.code}`); return true; });
    assert.equal(fs.existsSync(out), false, `${name}: no plaintext survives`);
  };
  await run('truncated-tail', bytes.subarray(0, bytes.length - 40), ['ENVELOPE_TRUNCATED', 'ENVELOPE_AUTH_FAILED', 'ENVELOPE_FORMAT']);
  await run('truncated-half', bytes.subarray(0, bytes.length >> 1), ['ENVELOPE_TRUNCATED', 'ENVELOPE_AUTH_FAILED', 'ENVELOPE_FORMAT']);
  await run('trailing', Buffer.concat([bytes, Buffer.from('x')]), ['ENVELOPE_TRAILING', 'ENVELOPE_AUTH_FAILED', 'ENVELOPE_FORMAT']);
  for (const off of [50, bytes.length >> 1, bytes.length - 5]) {
    const t = Buffer.from(bytes); t[off] ^= 1;
    await run(`flip-${off}`, t, ['ENVELOPE_AUTH_FAILED', 'ENVELOPE_FORMAT', 'ENVELOPE_TRUNCATED']);
  }
  // Reorder: swap two full chunk records (type u8 + len u32 + body + 16-byte tag), found by walking records.
  const descLen = bytes.readUInt16BE(40);
  let pos = 42 + descLen;
  const recs = [];
  while (pos < bytes.length) {
    const len = bytes.readUInt32BE(pos + 1);
    recs.push([pos, pos + 5 + len + 16]);
    pos += 5 + len + 16;
  }
  assert.ok(recs.length >= 5, `need several records, got ${recs.length}`);
  const slice = (i) => bytes.subarray(recs[i][0], recs[i][1]);
  const head = bytes.subarray(0, recs[0][0]);
  const order = recs.map((_, i) => i);
  [order[1], order[2]] = [order[2], order[1]];
  await run('reordered', Buffer.concat([head, ...order.map(slice)]), ['ENVELOPE_AUTH_FAILED']);
  await run('dropped-chunk', Buffer.concat([head, ...recs.map((_, i) => i).filter((i) => i !== 2).map(slice)]), ['ENVELOPE_AUTH_FAILED']);
  // Forged KDF cost in the header is refused before any key derivation.
  const forged = Buffer.from(bytes);
  forged[13] = 31; // log2N
  const kdfStarted = [];
  const f = path.join(dir, 'kdf.cretlibak');
  fs.writeFileSync(f, forged);
  await assert.rejects(decryptToFile(f, path.join(dir, 'kdf.out'), PW, { hooks: { onKdf: (k) => kdfStarted.push(k) } }), (e) => e.code === 'ENVELOPE_KDF_LIMIT');
  assert.deepEqual(kdfStarted, [], 'no scrypt run for an out-of-bounds header');
  assert.ok(ENVELOPE_LIMITS);
  metric('crypto-cases', { records: recs.length, envelopeBytes: bytes.length });
});

test('archive limits: ZIP traversal, absolute paths, entry-count and member-size bombs are rejected', () => {
  for (const name of ['../x', '/abs', 'a/../../b', 'a\\b', 'C:/x', '']) {
    assert.throws(() => buildStoreZip([{ name, data: Buffer.from('x') }]), ZipArchiveError, `build ${JSON.stringify(name)}`);
  }
  const ok = buildStoreZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b/c.txt', data: Buffer.alloc(2048, 1) }]);
  assert.equal(readStoreZip(ok).size, 2);
  assert.throws(() => readStoreZip(ok, { maxMemberBytes: 1000 }), ZipArchiveError, 'member larger than the limit');
  assert.throws(() => readStoreZip(ok, { maxTotalBytes: 1000 }), ZipArchiveError, 'archive larger than the limit');
  assert.throws(() => readStoreZip(ok, { maxEntries: 1 }), ZipArchiveError, 'too many entries');
  assert.throws(() => readStoreZip(Buffer.from('PK-not-a-zip-at-all-0123456789')), ZipArchiveError);
  const tampered = Buffer.from(ok); tampered[40] ^= 0xff;
  assert.throws(() => readStoreZip(tampered), ZipArchiveError, 'CRC / structure tamper');
});

test('version limits: future registry/manifest formats and plain backups carrying secrets are refused', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir, manifest } = await createOfflineBackup(env);
  const cp = path.join(env.root, 'secretplain');
  fs.cpSync(backupDir, cp, { recursive: true });
  fs.writeFileSync(path.join(cp, 'manifest.json'), JSON.stringify({ ...manifest, credentials: true }));
  assert.throws(() => verifyOfflineBackup(cp), (e) => e.code === 'BACKUP_INVALID');
  const future = path.join(env.root, 'future');
  fs.cpSync(backupDir, future, { recursive: true });
  fs.writeFileSync(path.join(future, 'manifest.json'), JSON.stringify({ ...manifest, format: 'cretli-offline-backup/2' }));
  assert.throws(() => verifyOfflineBackup(future), (e) => e.code === 'BACKUP_UNSUPPORTED');
});

test('file permissions: backup directory, control directory and staging are owner-only (POSIX)', { skip: process.platform === 'win32' && 'POSIX modes only' }, async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir } = await createOfflineBackup(env);
  assert.equal(fs.statSync(env.destRoot).mode & 0o077, 0, 'backup destination root is 0700');
  await restoreOfflineBackup({ ...env, backupDir });
  assert.equal(fs.statSync(env.controlDir).mode & 0o077, 0, 'control dir is private');
  // Plain backup payload files are created 0644 but sit under a 0700 directory chain (finding recorded in the report).
  const pre = path.join(env.controlDir, 'pre-restore');
  for (const d of [pre, ...fs.readdirSync(pre).map((n) => path.join(pre, n))]) assert.equal(fs.statSync(d).mode & 0o077, 0, `${d} is private`);
  assert.equal(fs.statSync(backupDir).mode & 0o077, 0, 'published backup directory is private');
});

test('fault injection: crash at every restore journal step rolls forward; counts of crash points', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1', { rows: 50 });
  const expected = fingerprint(env.dataDir);
  delete expected['mcp-secrets.json']; // plain backup omits managed secrets; the destination's copy is kept
  const { backupDir } = await createOfflineBackup(env);
  let crashes = 0;
  for (let n = 1; n < 300; n += 1) {
    seed(env.dataDir, 'v2');
    let calls = 0;
    const hooks = { onStep() { calls += 1; if (calls === n) throw new Error('simulated crash'); } };
    let crashed = false;
    try { await restoreOfflineBackup({ ...env, backupDir, hooks }); } catch (e) { if (!/simulated crash/.test(e.message)) throw e; crashed = true; }
    const got = () => { const f = fingerprint(env.dataDir); delete f['mcp-secrets.json']; return f; };
    if (!crashed) { assert.deepEqual(got(), expected); finalizeRestore(env); break; }
    crashes += 1;
    fs.rmSync(path.join(env.controlDir, 'lease.json'), { force: true });
    const rec = recoverPendingRestore(env);
    if (rec.action === 'rolled-forward') assert.deepEqual(got(), expected, `crash #${n}`);
    if (readRestoreJournal(env.controlDir)) finalizeRestore(env);
    assert.deepEqual(noPartials(env.dataDir), [], `crash #${n}: no stage leftovers`);
  }
  assert.ok(crashes >= 20);
  metric('journal-crash-points', { crashPoints: crashes, allRecovered: true });
});

test('fault injection: full disk while staging (plain and encrypted) leaves destinations and journal untouched', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const { backupDir } = await createOfflineBackup(env);
  const enc = await createEncryptedBackup({ ...env, password: PW, kdf: KDF });
  seed(env.dataDir, 'v2');
  const before = fingerprint(env.dataDir);
  let n = 0;
  const hooks = { beforeStage() { n += 1; if (n === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } };
  await assert.rejects(restoreOfflineBackup({ ...env, backupDir, hooks }), /ENOSPC/);
  assert.deepEqual(fingerprint(env.dataDir), before);
  assert.equal(readRestoreJournal(env.controlDir), null);
  n = 0;
  await assert.rejects(restoreEncryptedBackup({ ...env, file: enc.file, password: PW, kdf: KDF, hooks }), /ENOSPC/);
  assert.deepEqual(fingerprint(env.dataDir), before);
  assert.deepEqual(noPartials(env.dataDir), []);
  const staging = path.join(env.controlDir, 'staging');
  assert.ok(!fs.existsSync(staging) || fs.readdirSync(staging).length === 0, 'encrypted stage removed after a failure before apply');
  metric('full-disk', { plainTouched: false, encryptedTouched: false });
});

test('fault injection: a crash mid-copy of a backup publishes no half-written backup', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  let n = 0;
  await assert.rejects(createOfflineBackup({ ...env, hooks: { beforeCopy() { n += 1; if (n === 3) throw new Error('simulated crash'); } } }), /simulated crash/);
  assert.deepEqual(fs.readdirSync(env.destRoot), []);
});

test('generation fencing: a restore advances generation/fence above the source and the restore stays paused', async () => {
  const src = makeEnv();
  seed(src.dataDir, 'v1');
  const { backupDir, manifest } = await createOfflineBackup(src);
  const dst = makeEnv();
  const before = readControlState(dst.controlDir);
  const r = await restoreOfflineBackup({ ...dst, backupDir, externalHighWater: 41 });
  const after = readControlState(dst.controlDir);
  assert.notEqual(after.datasetGeneration, before.datasetGeneration);
  assert.ok(after.fence > Math.max(manifest.source.fence || 0, 41));
  assert.equal(r.generation, after.datasetGeneration);
});

test('retention after a failed backup deletes nothing; after a verified one it keeps newest N scheduled only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-accept-ret-'));
  const mk = (id, origin, ok, extra = {}) => {
    fs.writeFileSync(path.join(dir, `${id}.cretlibak`), id);
    return { id, name: `${id}.cretlibak`, origin, verifiedAt: ok ? `2026-01-0${id.slice(1)}T00:00:00Z` : '', ...extra };
  };
  const archives = [mk('a1', 'scheduled', true), mk('a2', 'scheduled', true), mk('a3', 'scheduled', true), mk('a4', 'manual', true), mk('a5', 'scheduled', true, { protected: true }), mk('a6', 'scheduled', false)];
  const failed = applyRetention({ targetDir: dir, archives, keep: 1, newId: 'a6' });
  assert.deepEqual(failed.deleted, []);
  assert.equal(fs.readdirSync(dir).length, 6);
  const okRun = applyRetention({ targetDir: dir, archives: archives.map((a) => (a.id === 'a6' ? { ...a, verifiedAt: '2026-01-09T00:00:00Z' } : a)), keep: 1, newId: 'a6' });
  assert.deepEqual(okRun.deleted.sort(), ['a1', 'a2', 'a3']);
  for (const kept of ['a4', 'a5', 'a6']) assert.ok(fs.existsSync(path.join(dir, `${kept}.cretlibak`)), `${kept} kept`);
});

test('online backup: refused without a coordinator; nothing is written (active-run defer is covered by tests/online-backup.test.js, not re-proved here)', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  await assert.rejects(
    createOnlineBackup({ dataDir: env.dataDir, controlDir: env.controlDir, destRoot: env.destRoot, registry: { registryVersion: 1, inventoryGaps: [], stores: [] }, coordinator: null }),
    () => true,
  );
  assert.ok(!fs.existsSync(env.destRoot) || fs.readdirSync(env.destRoot).length === 0);
});

test('no agent work is spawned: restore/backup run in-process without child processes or network', async () => {
  const cp = await import('node:child_process');
  const origs = {};
  for (const k of ['spawn', 'exec', 'execFile', 'fork']) { origs[k] = cp.default[k]; cp.default[k] = () => { throw new Error(`spawn forbidden: ${k}`); }; }
  try {
    const env = makeEnv();
    seed(env.dataDir, 'v1');
    const { backupDir } = await createOfflineBackup(env);
    await restoreOfflineBackup({ ...env, backupDir });
  } finally {
    Object.assign(cp.default, origs);
  }
});

// ---- Features not implemented in the current code: explicit, documented skips ----
const GAPS = {
  'quarantine of corrupt raw source files in the data backup (offline backup aborts instead; only the conversations export records corrupt_source omissions)': 'no quarantine implementation in lib/backup/offline',
  'replay of the same restore receipt / lost response / deleted target for data restore': 'receipts exist only for conversation import (covered by tests/conversations-backup.test.js)',
  'stale/missing/offline WebSocket client generation transport': 'WebSocket generation transport not implemented (docs/backup/offline-data-recovery.md known gaps)',
  'online backup under real writers (barrier budgets with production writers)': 'no production writer registered; online mode disabled (docs/backup/online-backups.md)',
  'Settings UI PL/EN/mobile for backups': 'no backup Settings UI exists yet',
  'legacy-store readers / forward migration of pre-migration archives': 'only the current registry layout is restorable',
};
for (const [name, reason] of Object.entries(GAPS)) test(`gap: ${name}`, { skip: reason }, () => {});
