import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  createEncryptedBackup, listEncryptedBackups, openEncryptedBackup, recoverPendingEncryptedRestore, restoreEncryptedBackup,
  verifyEncryptedBackup,
} from '../lib/backup/encryption/encrypted-backup.js';
import {
  decryptToFile, encryptToFile, ENVELOPE_LIMITS, readEnvelopeListing,
} from '../lib/backup/encryption/envelope.js';
import { createOfflineBackup, verifyOfflineBackup } from '../lib/backup/offline/offline-backup.js';
import { readRestoreJournal, recoverPendingRestore, finalizeRestore, restoreOfflineBackup } from '../lib/backup/offline/offline-restore.js';
import { enumerateManaged } from '../lib/backup/offline/managed-files.js';
import { createStagingDir, describeStaging } from '../lib/backup/offline/staging.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'backup', 'envelope-v1');
const FIXTURE_PW = 'correct horse battery staple';
const FIXTURE_SHA = '3f3b74aef2492cc4720577c8fed179295a9b04f6d425e59ce34eb84075ba406d';
const PW = 'Tr0ub4dor&3-backup-key';
/** Cheap scrypt for end-to-end tests (still inside the accepted bounds). */
const KDF = { log2N: 14, r: 8, p: 1 };
const CANARY = 'CANARY-MCP-SECRET-7f3a91';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-enc-')); }

function makeEnv() {
  const root = tmp();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, dataDir, controlDir: path.join(root, 'control'), destRoot: path.join(root, 'backups') };
}

function writeDb(file, marker) {
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE c(id INTEGER PRIMARY KEY, v TEXT);');
  db.exec(`INSERT INTO c VALUES (1, '${marker}');`);
  db.close();
}

function seed(dataDir, gen, secret = `${CANARY}-${gen}`) {
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dataDir, rel), text);
  };
  w('chats.json', `{"gen":"${gen}"}`);
  w('todos/a.json', `{"a":"${gen}"}`);
  w('mcp.json', `{"servers":"${gen}"}`);
  w('mcp-secrets.json', `{"token":"${secret}"}`);
  writeDb(path.join(dataDir, 'recovery.sqlite'), gen);
}

function snap(dataDir) {
  const out = {};
  for (const { rel } of enumerateManaged(dataDir, { includeSidecars: true }).files) {
    const abs = path.join(dataDir, rel);
    out[rel] = rel.endsWith('.sqlite')
      ? (() => { const db = new DatabaseSync(abs, { readOnly: true }); try { return `sqlite:${db.prepare('SELECT v FROM c').get().v}`; } finally { db.close(); } })()
      : fs.readFileSync(abs, 'utf8');
  }
  return out;
}

function copyFixture() {
  const dir = tmp();
  const file = path.join(dir, 'f.cretlibak');
  fs.copyFileSync(path.join(FIX, 'fixture.cretlibak'), file);
  return { dir, file, out: path.join(dir, 'out.bin'), bytes: fs.readFileSync(file) };
}

async function expectFail(bytes, codes, password = FIXTURE_PW, opts = {}) {
  const dir = tmp();
  const file = path.join(dir, 'x.cretlibak');
  const out = path.join(dir, 'out.bin');
  fs.writeFileSync(file, bytes);
  await assert.rejects(decryptToFile(file, out, password, opts), (err) => {
    assert.ok(codes.includes(err.code), `unexpected ${err.code}: ${err.message}`);
    return true;
  });
  assert.equal(fs.existsSync(out), false, 'no plaintext may survive a failed decryption');
}

test('compatibility fixture v1: pinned bytes decrypt and the writer still reproduces them', async () => {
  const bytes = fs.readFileSync(path.join(FIX, 'fixture.cretlibak'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), FIXTURE_SHA);
  const plain = fs.readFileSync(path.join(FIX, 'plain.bin'));
  const dir = tmp();
  const out = path.join(dir, 'p.bin');
  const r = await decryptToFile(path.join(FIX, 'fixture.cretlibak'), out, FIXTURE_PW);
  assert.deepEqual(fs.readFileSync(out), plain);
  assert.equal(r.chunks, 2);
  assert.deepEqual(r.descriptor, { createdAt: '2026-01-01T00:00:00.000Z', profile: 'data' });
  assert.deepEqual(readEnvelopeListing(path.join(FIX, 'fixture.cretlibak')), {
    createdAt: '2026-01-01T00:00:00.000Z', profile: 'data', bytes: bytes.length, version: 1,
  });
  const again = path.join(dir, 'again.cretlibak');
  await encryptToFile(again, FIXTURE_PW, (w) => { w(plain.subarray(0, 1000)); w(plain.subarray(1000)); }, {
    descriptor: { createdAt: '2026-01-01T00:00:00.000Z', profile: 'data' }, kdf: KDF, chunkSize: 65536,
    entropy: { salt: Buffer.from(Array.from({ length: 16 }, (_, i) => i)), noncePrefix: Buffer.from([0xa0, 0xa1, 0xa2, 0xa3]) },
  });
  assert.ok(fs.readFileSync(again).equals(bytes), 'format v1 must stay byte-for-byte reproducible');
});

test('wrong password and header/record tampering fail authentication and leave no plaintext', async () => {
  const { bytes } = copyFixture();
  await expectFail(bytes, ['ENVELOPE_AUTH_FAILED'], 'not the right password');
  for (const offset of [20, 36, 12 + 0, bytes.length - 1, bytes.length - 60, 200, 30000, 70000]) {
    if (offset === 12) continue; // a KDF parameter flip is covered by the exhaustion test
    const t = Buffer.from(bytes);
    t[offset] ^= 0x01;
    await expectFail(t, ['ENVELOPE_AUTH_FAILED', 'ENVELOPE_FORMAT', 'ENVELOPE_TRUNCATED', 'ENVELOPE_KDF_LIMIT']);
  }
});

test('chunk reorder, duplication and a missing chunk fail', async () => {
  const { bytes } = copyFixture();
  const descLen = bytes.readUInt16BE(40);
  const start = 42 + descLen;
  const rec = (pos) => {
    const len = bytes.readUInt32BE(pos + 1);
    return { pos, end: pos + 5 + len + 16 };
  };
  const h = rec(start); const c1 = rec(h.end); const c2 = rec(c1.end); const fin = rec(c2.end);
  assert.equal(fin.end, bytes.length);
  const slice = (r) => bytes.subarray(r.pos, r.end);
  const head = bytes.subarray(0, h.end);
  await expectFail(Buffer.concat([head, slice(c2), slice(c1), slice(fin)]), ['ENVELOPE_AUTH_FAILED', 'ENVELOPE_FORMAT']);
  await expectFail(Buffer.concat([head, slice(c2), slice(fin)]), ['ENVELOPE_AUTH_FAILED']);
  await expectFail(Buffer.concat([head, slice(c1), slice(fin)]), ['ENVELOPE_AUTH_FAILED']);
  await expectFail(Buffer.concat([head, slice(c1), slice(c1), slice(c2), slice(fin)]), ['ENVELOPE_AUTH_FAILED']);
  await expectFail(Buffer.concat([head, slice(c1), slice(c2)]), ['ENVELOPE_TRUNCATED']);
});

test('truncation at any point and appended bytes always fail', async () => {
  const { bytes } = copyFixture();
  const cuts = new Set([0, 1, 7, 8, 41, 42, 60, 100, bytes.length - 1, bytes.length - 17, bytes.length - 49, bytes.length - 70]);
  for (let i = 0; i < 25; i += 1) cuts.add(Math.floor((bytes.length * i) / 25));
  for (const n of cuts) await expectFail(bytes.subarray(0, n), ['ENVELOPE_TRUNCATED', 'ENVELOPE_FORMAT', 'ENVELOPE_AUTH_FAILED']);
  await expectFail(Buffer.concat([bytes, Buffer.from([0])]), ['ENVELOPE_TRAILING']);
  await expectFail(Buffer.concat([bytes, crypto.randomBytes(1000)]), ['ENVELOPE_TRAILING']);
  // A second valid-looking record after the final one is trailing data too.
  await expectFail(Buffer.concat([bytes, bytes.subarray(bytes.length - 80)]), ['ENVELOPE_TRAILING']);
});

test('KDF and size limits are enforced before any key derivation', async () => {
  const { bytes } = copyFixture();
  const calls = [];
  const hooks = { onKdf: (k) => calls.push(k) };
  const forged = (mutate) => { const t = Buffer.from(bytes); mutate(t); return t; };
  await expectFail(forged((t) => { t[12] = 30; }), ['ENVELOPE_KDF_LIMIT'], FIXTURE_PW, { hooks });
  await expectFail(forged((t) => { t[12] = 13; }), ['ENVELOPE_KDF_LIMIT'], FIXTURE_PW, { hooks });
  await expectFail(forged((t) => { t[13] = 255; }), ['ENVELOPE_KDF_LIMIT'], FIXTURE_PW, { hooks });
  await expectFail(forged((t) => { t[14] = 255; }), ['ENVELOPE_KDF_LIMIT'], FIXTURE_PW, { hooks });
  await expectFail(forged((t) => { t[12] = 17; t[13] = 8; t[14] = 4; }), ['ENVELOPE_KDF_LIMIT'], FIXTURE_PW, { hooks });
  await expectFail(forged((t) => { t.writeUInt32BE(0x7fffffff, 16); }), ['ENVELOPE_FORMAT'], FIXTURE_PW, { hooks });
  await expectFail(forged((t) => { t[8] = 2; }), ['ENVELOPE_UNSUPPORTED'], FIXTURE_PW, { hooks });
  await expectFail(forged((t) => { t.writeUInt16BE(60000, 40); }), ['ENVELOPE_FORMAT'], FIXTURE_PW, { hooks });
  // Plaintext cap smaller than the file implies: rejected on size alone.
  await expectFail(bytes, ['ENVELOPE_TOO_LARGE'], FIXTURE_PW, { hooks, maxPlainBytes: 1000 });
  assert.deepEqual(calls, [], 'the KDF must never run for rejected parameters');
  await assert.rejects(encryptToFile(path.join(tmp(), 'x'), PW, () => {}, { descriptor: { createdAt: 'x', profile: 'data' }, kdf: { log2N: 22, r: 8, p: 1 } }), { code: 'ENVELOPE_KDF_LIMIT' });
  await assert.rejects(encryptToFile(path.join(tmp(), 'x'), 'short', () => {}, { descriptor: { createdAt: 'x', profile: 'data' }, kdf: KDF }), { code: 'PASSWORD_WEAK' });
  assert.ok(ENVELOPE_LIMITS.maxLog2N <= 17);
});

test('encrypted backup: no plaintext in archive/listing/logs, plain backups carry no secrets, staging is empty', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const logged = [];
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  process.stderr.write = (c, ...r) => { logged.push(String(c)); return origErr(c, ...r); };
  process.stdout.write = (c, ...r) => { logged.push(String(c)); return origOut(c, ...r); };
  let r;
  try {
    r = await createEncryptedBackup({ ...env, password: PW, kdf: KDF, includeCredentials: true });
    await assert.rejects(verifyEncryptedBackup(r.file, 'wrong password!', { controlDir: env.controlDir }), (e) => { logged.push(e.message); return e.code === 'ENVELOPE_AUTH_FAILED'; });
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  const raw = fs.readFileSync(r.file);
  for (const needle of [CANARY, PW, 'chats.json', 'mcp-secrets', '"entries"', 'cretli-offline-backup', 'SQLite format 3']) {
    assert.equal(raw.includes(Buffer.from(needle)), false, `ciphertext leaks ${needle}`);
  }
  assert.equal(logged.join('\n').includes(PW), false);
  assert.equal(logged.join('\n').includes(CANARY), false);
  const listing = listEncryptedBackups(env.destRoot);
  assert.equal(listing.length, 1);
  assert.deepEqual(Object.keys(listing[0]).sort(), ['bytes', 'createdAt', 'id', 'profile', 'status']);
  assert.equal(listing[0].profile, 'data-credentials');
  assert.equal(JSON.stringify(listing).includes(CANARY), false);
  assert.deepEqual(describeStaging(env.controlDir), []);
  // The password is not persisted anywhere under the control directory or next to the backup.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...walk(env.controlDir), ...walk(env.destRoot)]) assert.equal(fs.readFileSync(f).includes(Buffer.from(PW)), false, f);

  // Plain backups omit managed secrets and cannot be asked to include them.
  await assert.rejects(createOfflineBackup({ ...env, destRoot: path.join(env.root, 'plain'), includeCredentials: true }), { code: 'CREDENTIALS_REQUIRE_ENCRYPTION' });
  const plain = await createOfflineBackup({ ...env, destRoot: path.join(env.root, 'plain') });
  assert.equal(plain.manifest.credentials, false);
  assert.equal(plain.manifest.entries.some((e) => e.path === 'mcp-secrets.json'), false);
  assert.ok(plain.manifest.omissions.some((o) => o.startsWith('mcp-secrets.json')));
  // A plain backup directory must not smuggle secrets in.
  fs.writeFileSync(path.join(plain.backupDir, 'files', 'mcp-secrets.json'), 'x');
  const mf = JSON.parse(fs.readFileSync(path.join(plain.backupDir, 'manifest.json'), 'utf8'));
  mf.entries.push({ path: 'mcp-secrets.json', storeId: 'store.mcp-config', kind: 'file', bytes: 1, sha256: crypto.createHash('sha256').update('x').digest('hex') });
  fs.writeFileSync(path.join(plain.backupDir, 'manifest.json'), JSON.stringify(mf));
  assert.throws(() => verifyOfflineBackup(plain.backupDir), { code: 'BACKUP_INVALID' });
  mf.credentials = true;
  fs.writeFileSync(path.join(plain.backupDir, 'manifest.json'), JSON.stringify(mf));
  assert.throws(() => verifyOfflineBackup(plain.backupDir), { code: 'BACKUP_INVALID' });
});

test('encrypted restore round trip with an encrypted, verified pre-restore copy that can be restored again', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const v1 = snap(env.dataDir);
  const b = await createEncryptedBackup({ ...env, password: PW, kdf: KDF, includeCredentials: true });
  seed(env.dataDir, 'v2');
  const v2 = snap(env.dataDir);
  const out = await restoreEncryptedBackup({ ...env, file: b.file, password: PW, kdf: KDF });
  assert.deepEqual(snap(env.dataDir), v1);
  assert.match(out.preRestoreBackup, /\.cretlibak$/);
  assert.equal(fs.readFileSync(out.preRestoreBackup).includes(Buffer.from(`${CANARY}-v2`)), false);
  assert.equal(listEncryptedBackups(path.dirname(out.preRestoreBackup)).length, 1);
  assert.deepEqual(describeStaging(env.controlDir), []);
  assert.equal(JSON.stringify(readRestoreJournal(env.controlDir)).includes(PW), false);
  finalizeRestore(env);
  // Recover the destination from the encrypted pre-restore copy.
  await restoreEncryptedBackup({ ...env, file: out.preRestoreBackup, password: PW, kdf: KDF });
  assert.deepEqual(snap(env.dataDir), v2);
});

test('a backup without managed secrets keeps the destination credentials', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const b = await createEncryptedBackup({ ...env, password: PW, kdf: KDF });
  seed(env.dataDir, 'v2', 'DEST-SECRET');
  await restoreEncryptedBackup({ ...env, file: b.file, password: PW, kdf: KDF });
  assert.equal(fs.readFileSync(path.join(env.dataDir, 'mcp-secrets.json'), 'utf8'), '{"token":"DEST-SECRET"}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.dataDir, 'chats.json'), 'utf8')).gen, 'v1');
  const opened = await (async () => {
    const o = await openEncryptedBackup(b.file, PW, { controlDir: env.controlDir });
    fs.rmSync(o.stage, { recursive: true });
    return o;
  })();
  assert.equal(opened.manifest.credentials, false);
});

test('bad password, tampering and truncated backups never reach unpack or apply', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const b = await createEncryptedBackup({ ...env, password: PW, kdf: KDF });
  seed(env.dataDir, 'v2');
  const before = snap(env.dataDir);
  let parsed = 0;
  const hooks = { beforeUnpack: () => { parsed += 1; } };
  const bytes = fs.readFileSync(b.file);
  const variants = [
    ['wrong password', bytes, 'wrong password!!'],
    ['flipped byte', Buffer.from(bytes.map((v, i) => (i === bytes.length - 100 ? v ^ 1 : v))), PW],
    ['truncated', bytes.subarray(0, bytes.length - 30), PW],
    ['appended', Buffer.concat([bytes, Buffer.from('zz')]), PW],
  ];
  for (const [name, data, pw] of variants) {
    const file = path.join(env.root, `v-${crypto.randomBytes(3).toString('hex')}.cretlibak`);
    fs.writeFileSync(file, data);
    await assert.rejects(restoreEncryptedBackup({ ...env, file, password: pw, kdf: KDF, hooks }), /.*/, name);
    await assert.rejects(verifyEncryptedBackup(file, pw, { controlDir: env.controlDir, hooks }), /.*/, name);
  }
  assert.equal(parsed, 0, 'unpack/parse must not run on unauthenticated data');
  assert.deepEqual(snap(env.dataDir), before);
  assert.equal(readRestoreJournal(env.controlDir), null);
  assert.deepEqual(describeStaging(env.controlDir), []);
  assert.equal(fs.existsSync(path.join(env.controlDir, 'pre-restore')), false, 'no pre-restore copy before authentication');
});

test('restore refuses to start when the encrypted pre-restore copy cannot be made', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const b = await createEncryptedBackup({ ...env, password: PW, kdf: KDF });
  seed(env.dataDir, 'v2');
  const before = snap(env.dataDir);
  fs.mkdirSync(env.controlDir, { recursive: true });
  fs.writeFileSync(path.join(env.controlDir, 'pre-restore'), 'blocker');
  await assert.rejects(restoreEncryptedBackup({ ...env, file: b.file, password: PW, kdf: KDF }));
  assert.deepEqual(snap(env.dataDir), before);
  assert.equal(readRestoreJournal(env.controlDir), null);
  assert.deepEqual(describeStaging(env.controlDir), []);
});

test('staging is owner-only and crash leftovers are swept on recovery', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  if (process.platform !== 'win32') {
    const dir = createStagingDir(env.controlDir, 'probe');
    assert.equal(fs.statSync(dir).mode & 0o077, 0);
    assert.equal(fs.statSync(path.dirname(dir)).mode & 0o077, 0);
  }
  // Crash while the plaintext backup is staged: nothing is published, the stage is removed in-process.
  await assert.rejects(createEncryptedBackup({ ...env, password: PW, kdf: KDF, hooks: { afterStaging() { throw new Error('crash'); } } }), /crash/);
  assert.deepEqual(describeStaging(env.controlDir), []);
  assert.deepEqual(listEncryptedBackups(env.destRoot), []);
  // A hard crash (kill -9) cannot clean up: simulate the leftovers and let recovery sweep them.
  const leftover = path.join(env.controlDir, 'staging', 'enc-dead-1');
  fs.mkdirSync(path.join(leftover, 'backup'), { recursive: true });
  fs.writeFileSync(path.join(leftover, 'backup', 'secret.bin'), CANARY);
  fs.mkdirSync(env.destRoot, { recursive: true });
  fs.writeFileSync(path.join(env.destRoot, 'x.cretlibak.partial'), 'partial');
  assert.equal(describeStaging(env.controlDir).length, 1);
  assert.equal(recoverPendingRestore(env).action, 'none');
  assert.deepEqual(describeStaging(env.controlDir), []);
  assert.equal(listEncryptedBackups(env.destRoot)[0].status, 'incomplete');
});

test('a crash during an encrypted apply rolls forward from the kept private stage; a lost stage needs the key', async () => {
  for (const loseStage of [false, true]) {
    const env = makeEnv();
    seed(env.dataDir, 'v1');
    const v1 = snap(env.dataDir);
    const b = await createEncryptedBackup({ ...env, password: PW, kdf: KDF, includeCredentials: true });
    seed(env.dataDir, 'v2');
    const hooks = { onStep(rel, step) { if (rel && step === 'replaced') throw new Error('simulated crash'); } };
    await assert.rejects(restoreEncryptedBackup({ ...env, file: b.file, password: PW, kdf: KDF, hooks }), /simulated crash/);
    fs.rmSync(path.join(env.controlDir, 'lease.json'), { force: true });
    const journal = readRestoreJournal(env.controlDir);
    assert.equal(journal.status, 'applying');
    assert.equal(JSON.stringify(journal).includes(PW), false);
    assert.equal(describeStaging(env.controlDir).length, 1, 'the stage the roll-forward needs is kept');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(journal.backupDir)).mode & 0o077, 0);
    if (loseStage) {
      fs.rmSync(path.dirname(journal.backupDir), { recursive: true, force: true });
      await assert.rejects(recoverPendingEncryptedRestore(env), { code: 'RECOVERY_KEY_REQUIRED' });
      await assert.rejects(recoverPendingEncryptedRestore({ ...env, password: 'definitely wrong' }), { code: 'ENVELOPE_AUTH_FAILED' });
      assert.equal((await recoverPendingEncryptedRestore({ ...env, password: PW })).action, 'rolled-forward');
    } else {
      assert.equal(recoverPendingRestore(env).action, 'rolled-forward');
    }
    assert.deepEqual(snap(env.dataDir), v1);
    assert.deepEqual(describeStaging(env.controlDir), []);
  }
});

test('plain restore API is unchanged by the encryption layer', async () => {
  const env = makeEnv();
  seed(env.dataDir, 'v1');
  const plain = await createOfflineBackup(env);
  seed(env.dataDir, 'v2');
  await restoreOfflineBackup({ ...env, backupDir: plain.backupDir });
  assert.equal(JSON.parse(fs.readFileSync(path.join(env.dataDir, 'chats.json'), 'utf8')).gen, 'v1');
});
