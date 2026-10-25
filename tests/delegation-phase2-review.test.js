import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  acquireDelegationOwnerLock,
  getDelegationOwnerLockInfo,
  getDelegationOwnerLockPaths,
  getProcessStartTime,
  isKillProbeAlive,
  isStoredOwnerLive,
  releaseDelegationOwnerLock,
  DelegationOwnerLockError,
} from '../lib/delegation-owner-lock.js';
import {
  hashDelegationItems,
  migrateDelegationsJsonToSqlite,
} from '../lib/persist/delegation-migrate.js';
import { setDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';
import {
  closeDelegationSqlite,
  loadDelegationsSqlite,
  loadMailboxSqlite,
  openDelegationSqlite,
  replaceDelegationsSqlite,
} from '../lib/persist/delegation-sqlite.js';
import {
  createDelegationRecord,
  getDelegationById,
  getDelegationsDataPath,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import {
  createMailboxMessage,
  getMailboxMessageById,
  updateMailboxMessage,
} from '../lib/persist/delegation-mailbox-persist.js';
import { enqueueDelegationStoreWork } from '../lib/delegation-store-lock.js';
import {
  resetDelegationLifecycleForTest,
} from '../lib/delegation-lifecycle.js';
import { bootDelegationRuntime, shutdownDelegationRuntime } from '../lib/delegation-runtime-boot.js';
import {
  collectScopedDelegationHealthRows,
} from '../lib/delegation-health.js';
import {
  getDelegationRuntimeHealth,
  resetDelegationRuntimeHealth,
  stopDelegationRuntimeWorker,
} from '../lib/delegation-runtime-worker.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';

stopDelegationRuntimeWorker();
resetDelegationLifecycleForTest();
resetDelegationRuntimeHealth();

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function runNodeModule(source, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', reject);
  });
}

{
  const left = hashDelegationItems([{ id: 'a', report: 'one', revision: 1 }]);
  const right = hashDelegationItems([{ id: 'a', report: 'two', revision: 1 }]);
  assert.notEqual(left, right);
}

{
  const dir = makeTempDir('cretli-p2r1-');
  const delegationsPath = path.join(dir, 'delegations.json');
  const mailboxPath = path.join(dir, 'delegation-mailbox.json');
  writeJson(delegationsPath, {
    v: 2,
    items: [{
      id: 'd1',
      parentChatId: 'p',
      status: 'completed',
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      report: 'keep-me',
    }],
  });
  writeJson(mailboxPath, {
    v: 1,
    items: [{
      id: 'm1',
      toChatId: 'p',
      fromChatId: 'c',
      status: 'delivered',
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  });
  const first = migrateDelegationsJsonToSqlite({ dataDir: dir });
  assert.equal(first.switched, true);
  assert.equal(first.counts.delegations, 1);
  const second = migrateDelegationsJsonToSqlite({ dataDir: dir });
  assert.equal(second.alreadyMigrated, true);
  assert.equal(second.counts.delegations, 1);
  closeDelegationSqlite();
  const database = openDelegationSqlite({ dataDir: dir });
  const rows = loadDelegationsSqlite(database);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].report, 'keep-me');
  closeDelegationSqlite();
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir('cretli-p2r1-resume-');
  const delegationsPath = path.join(dir, 'delegations.json');
  const mailboxPath = path.join(dir, 'delegation-mailbox.json');
  const items = [
    { id: 'd1', parentChatId: 'p', status: 'completed', revision: 1, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'd2', parentChatId: 'p', status: 'failed', revision: 1, createdAt: '2026-01-02T00:00:00.000Z' },
  ];
  writeJson(delegationsPath, { v: 2, items });
  writeJson(mailboxPath, {
    v: 1,
    items: [{ id: 'm1', toChatId: 'p', fromChatId: 'c', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z' }],
  });
  const database = openDelegationSqlite({ dataDir: dir });
  replaceDelegationsSqlite(database, items);
  closeDelegationSqlite();
  writeJson(path.join(dir, 'delegation-migrate.checkpoint.json'), {
    phase: 'copied-delegations',
    backupDir: '',
  });
  const resumed = migrateDelegationsJsonToSqlite({ dataDir: dir });
  assert.equal(resumed.switched, true);
  closeDelegationSqlite();
  const loaded = openDelegationSqlite({ dataDir: dir });
  assert.equal(loadDelegationsSqlite(loaded).length, 2);
  assert.equal(loadMailboxSqlite(loaded).length, 1);
  closeDelegationSqlite();
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir('cretli-p2r1-lock-');
  writeJson(path.join(dir, 'delegations.json'), { v: 2, items: [] });
  writeJson(path.join(dir, 'delegation-mailbox.json'), { v: 1, items: [] });
  acquireDelegationOwnerLock({ dataDir: dir });
  const lockUrl = new URL('../lib/delegation-owner-lock.js', import.meta.url).href;
  const migrateUrl = new URL('../lib/persist/delegation-migrate.js', import.meta.url).href;
  const child = await runNodeModule(`
    import { migrateDelegationsJsonToSqlite } from ${JSON.stringify(migrateUrl)};
    import { DelegationOwnerLockError } from ${JSON.stringify(lockUrl)};
    try {
      migrateDelegationsJsonToSqlite({ dataDir: ${JSON.stringify(dir)} });
      console.log('MIGRATED');
      process.exit(0);
    } catch (err) {
      console.log(err.code || err.name || err.message);
      process.exit(err instanceof DelegationOwnerLockError ? 2 : 1);
    }
  `);
  assert.equal(child.code, 2);
  assert.match(child.out, /DELEGATION_OWNER_LOCKED/);
  releaseDelegationOwnerLock({ dataDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  assert.equal(isKillProbeAlive(null), true);
  assert.equal(isKillProbeAlive({ code: 'EPERM' }), true);
  assert.equal(isKillProbeAlive({ code: 'ESRCH' }), false);
  const livePid = process.pid;
  assert.equal(
    isStoredOwnerLive({ pid: livePid, pidStart: '1' }, path.join(os.tmpdir(), 'cretli-missing.sock')),
    false,
  );
  assert.equal(
    isStoredOwnerLive({ pid: livePid, pidStart: getProcessStartTime(livePid) }, path.join(os.tmpdir(), 'cretli-missing.sock')),
    true,
  );
  assert.equal(
    isStoredOwnerLive(null, path.join(os.tmpdir(), 'cretli-missing.sock')),
    true,
  );
}

{
  const dir = makeTempDir('cretli-p2r2-gap-');
  const paths = getDelegationOwnerLockPaths({ dataDir: dir });
  const lockUrl = new URL('../lib/delegation-owner-lock.js', import.meta.url).href;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { getProcessStartTime } from ${JSON.stringify(lockUrl)};
    fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true });
    fs.writeFileSync(${JSON.stringify(paths.claimPath)}, JSON.stringify({
      pid: process.pid,
      ownerToken: 'gap-token',
      startedAt: new Date().toISOString(),
      pidStart: getProcessStartTime(process.pid),
    }));
    fs.mkdirSync(${JSON.stringify(paths.lockDir)});
    process.stdout.write('READY\\n');
    await new Promise(() => {});
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder did not become ready')), 4000);
    holder.stdout.on('data', (chunk) => {
      if (String(chunk).includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    holder.on('error', reject);
  });
  let acquired = false;
  try {
    acquireDelegationOwnerLock({ dataDir: dir });
    acquired = true;
  } catch (err) {
    assert.equal(err instanceof DelegationOwnerLockError, true);
  }
  assert.equal(acquired, false);
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.on('close', resolve));
  acquireDelegationOwnerLock({ dataDir: dir });
  releaseDelegationOwnerLock({ dataDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir('cretli-p2r2-nometadata-');
  const paths = getDelegationOwnerLockPaths({ dataDir: dir });
  fs.mkdirSync(paths.lockDir, { recursive: true });
  let thrown = null;
  try {
    acquireDelegationOwnerLock({ dataDir: dir });
  } catch (err) {
    thrown = err;
  }
  assert.equal(thrown instanceof DelegationOwnerLockError, true);
  assert.equal(fs.existsSync(paths.lockDir), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir('cretli-p2r2-token-');
  const held = acquireDelegationOwnerLock({ dataDir: dir });
  fs.writeFileSync(held.metaPath, `${JSON.stringify({
    pid: process.pid,
    ownerToken: 'other-token',
    startedAt: held.startedAt,
    pidStart: held.pidStart,
  }, null, 2)}\n`);
  releaseDelegationOwnerLock({ dataDir: dir });
  assert.equal(fs.existsSync(held.lockDir), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  setDelegationStoreBackend('sqlite');
  closeDelegationSqlite();
  const row = createDelegationRecord({
    parentChatId: 'cas-parent',
    childChatId: 'cas-child',
    idempotencyKey: 'cas-same-record',
  });
  const mail = createMailboxMessage({
    fromChatId: 'cas-child',
    toChatId: 'cas-parent',
    body: 'queued',
    status: 'queued',
    idempotencyKey: 'cas-mail',
  });
  closeDelegationSqlite();
  const persistUrl = new URL('../lib/persist/delegations-persist.js', import.meta.url).href;
  const mailboxUrl = new URL('../lib/persist/delegation-mailbox-persist.js', import.meta.url).href;
  const backendUrl = new URL('../lib/persist/delegation-store-backend.js', import.meta.url).href;
  const childScript = `
    import { setDelegationStoreBackend } from ${JSON.stringify(backendUrl)};
    import { updateDelegationRecord } from ${JSON.stringify(persistUrl)};
    import { updateMailboxMessage } from ${JSON.stringify(mailboxUrl)};
    setDelegationStoreBackend('sqlite');
    const tag = process.env.TAG;
    const updated = updateDelegationRecord(process.env.ROW_ID, { status: 'completed', report: tag }, { expectedRevision: 1 });
    const mail = updateMailboxMessage(process.env.MAIL_ID, { status: 'delivered', error: tag }, { expectedRevision: 1 });
    console.log(JSON.stringify({ row: Boolean(updated), mail: Boolean(mail), tag }));
  `;
  const results = await Promise.all(['A', 'B'].map((tag) => runNodeModule(childScript, {
    CRETLI_DATA_DIR: ISOLATED_DATA_DIR,
    CRETLI_DELEGATION_STORE: 'sqlite',
    ROW_ID: row.id,
    MAIL_ID: mail.id,
    TAG: tag,
  })));
  for (const result of results) {
    assert.equal(result.code, 0, result.out);
  }
  const parsed = results.map((result) => {
    const line = result.out.split('\n').map((row) => row.trim()).find((row) => row.startsWith('{'));
    assert.ok(line, result.out);
    return JSON.parse(line);
  });
  assert.equal(parsed.filter((row) => row.row).length, 1);
  assert.equal(parsed.filter((row) => row.mail).length, 1);
  closeDelegationSqlite();
  setDelegationStoreBackend('sqlite');
  const winner = getDelegationById(row.id);
  assert.equal(winner.revision, 2);
  assert.match(String(winner.report || ''), /^(A|B)$/);
  const mailWinner = getMailboxMessageById(mail.id);
  assert.equal(Number(mailWinner.revision), 2);
  closeDelegationSqlite();
  setDelegationStoreBackend('json');
}

{
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
  await bootDelegationRuntime({ intervalMs: 50 });
  let releaseHang;
  const hung = new Promise((resolve) => { releaseHang = resolve; });
  enqueueDelegationStoreWork(() => hung);
  const startedAt = Date.now();
  const result = await shutdownDelegationRuntime({ timeoutMs: 25 });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(elapsedMs < 200, `shutdown waited ${elapsedMs}ms`);
  assert.equal(getDelegationOwnerLockInfo().held, true);
  releaseHang();
  await enqueueDelegationStoreWork(() => undefined);
  await shutdownDelegationRuntime({ timeoutMs: 500 });
  resetDelegationLifecycleForTest();
  resetDelegationRuntimeHealth();
}

{
  setDelegationStoreBackend('json');
  createDelegationRecord({
    parentChatId: 'keep',
    childChatId: 'keep-child',
    idempotencyKey: 'scope-keep',
  });
  createDelegationRecord({
    parentChatId: 'foreign',
    childChatId: 'foreign-child',
    idempotencyKey: 'scope-foreign',
  });
  createMailboxMessage({
    fromChatId: 'keep-child',
    toChatId: 'keep',
    body: 'in-scope',
    status: 'queued',
    idempotencyKey: 'scope-mail-keep',
  });
  createMailboxMessage({
    fromChatId: 'other',
    toChatId: 'foreign',
    body: 'out-of-scope',
    status: 'queued',
    idempotencyKey: 'scope-mail-foreign',
  });
  const scoped = collectScopedDelegationHealthRows((row) => String(row.parentChatId || '') === 'keep');
  assert.equal(scoped.delegations.every((row) => row.parentChatId === 'keep'), true);
  assert.ok(scoped.delegations.some((row) => row.parentChatId === 'keep'));
  assert.equal(scoped.delegations.some((row) => row.parentChatId === 'foreign'), false);
  assert.ok(scoped.mailbox.some((row) => row.toChatId === 'keep'));
  assert.equal(scoped.mailbox.some((row) => row.toChatId === 'foreign'), false);
}

{
  const file = getDelegationsDataPath();
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, '{not-json');
  const health = getDelegationRuntimeHealth();
  assert.equal(health.store.readable, false);
  assert.equal(health.degraded, true);
  assert.ok(health.store.error);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not-json');
  if (previous) fs.writeFileSync(file, previous);
  else fs.rmSync(file, { force: true });
}

{
  const ownFolder = ISOLATED_DATA_DIR;
  const foreignFolder = path.join(os.tmpdir(), 'cretli-other-workspace');
  const own = addChat(crypto.randomUUID(), 'own-ws', null, ownFolder, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const foreign = addChat(crypto.randomUUID(), 'foreign-ws', null, foreignFolder, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  createMailboxMessage({
    fromChatId: own.id,
    toChatId: own.id,
    kind: 'reply',
    status: 'queued',
    body: 'own',
    idempotencyKey: 'http-mail-own',
  });
  createMailboxMessage({
    fromChatId: foreign.id,
    toChatId: foreign.id,
    kind: 'reply',
    status: 'queued',
    body: 'foreign',
    idempotencyKey: 'http-mail-foreign',
  });
  const routes = new Map();
  registerDelegationsRoutes({
    get: (p, fn) => routes.set(`GET ${p}`, fn),
    post: (p, fn) => routes.set(`POST ${p}`, fn),
  }, { workspaceDirForAgent: () => ownFolder });
  async function invokeRuntime(workspaceFolder) {
    let status = 200;
    let body;
    const res = {
      status(s) { status = s; return this; },
      json(b) { body = b; return this; },
    };
    await routes.get('GET /api/delegations/runtime')({
      params: {},
      query: { workspaceFolder },
      body: {},
    }, res);
    return { status, body };
  }
  const scoped = await invokeRuntime(ownFolder);
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.runtime.counts.pendingMailbox, 1);
}

{
  const dir = makeTempDir('cretli-p2r6-');
  const filePath = path.join(dir, 'delegations.sqlite');
  const probe = new DatabaseSync(filePath);
  probe.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  probe.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schemaVersion', '99');
  probe.exec('PRAGMA user_version = 99');
  probe.close();
  const before = fs.readFileSync(filePath);
  let code = '';
  try {
    openDelegationSqlite({ dataDir: dir });
  } catch (err) {
    code = err?.code || '';
  }
  assert.equal(code, 'DELEGATIONS_SCHEMA');
  assert.deepEqual(fs.readFileSync(filePath), before);
  closeDelegationSqlite();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('delegation-phase2-review.test.js OK');
