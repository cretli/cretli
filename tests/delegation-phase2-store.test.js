import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createDelegationRecord, loadDelegations, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { setDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';
import {
  closeDelegationSqlite,
  loadDelegationsSqlite,
  openDelegationSqlite,
  withDelegationSqliteTransaction,
} from '../lib/persist/delegation-sqlite.js';
import {
  migrateDelegationsJsonToSqlite,
  rollbackDelegationsSqliteToJson,
} from '../lib/persist/delegation-migrate.js';
import { classifyDelegationAttention, pageDelegationRows, summarizeDelegation } from '../lib/delegation-query.js';
import { applyDelegationRetention } from '../lib/delegation-retention.js';
import { resolveDelegationAdapterCapabilities, listDelegationAdapterCapabilities } from '../lib/delegation-adapter-capabilities.js';
import { registerMockChatRunAdapter } from '../lib/chat-run/mock-adapter.js';

registerMockChatRunAdapter('opencode');

{
  const rows = Array.from({ length: 5 }, (_, index) => ({
    id: `id-${index}`,
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
    status: 'completed',
  }));
  const first = pageDelegationRows(rows, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = pageDelegationRows(rows, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 2);
  assert.notEqual(second.items[0].id, first.items[0].id);
  const summary = summarizeDelegation({
    id: 'x',
    status: 'failed',
    planMarkdown: 'SECRET PLAN',
    report: 'SECRET REPORT',
    executor: { model: 'm', transport: 'opencode' },
  });
  assert.equal(summary.planMarkdown, undefined);
  assert.equal(summary.report, undefined);
  assert.equal(summary.acknowledgedAt, '');
  assert.equal(summary.retryableDelivery, false);
  const withMailbox = summarizeDelegation(summary, {
    mailbox: [{ delegationId: 'x', status: 'uncertain' }],
  });
  assert.equal(withMailbox.retryableDelivery, true);
  assert.equal(withMailbox.pendingMailbox, true);
  assert.equal(classifyDelegationAttention({ status: 'completed' }, {
    mailbox: [{ status: 'queued' }],
  }), 'pending_delivery');
}

{
  const caps = resolveDelegationAdapterCapabilities('opencode', { review: true });
  assert.equal(caps.deniesMutation, true);
  assert.equal(caps.canReadFiles, true);
  assert.equal(caps.coverage, 'unit');
  assert.ok(listDelegationAdapterCapabilities().some((row) => row.transport === 'deepseek'));
}

{
  setDelegationStoreBackend('sqlite');
  closeDelegationSqlite();
  const a = createDelegationRecord({ parentChatId: 'p1', childChatId: 'c1', idempotencyKey: 'k1' });
  updateDelegationRecord(a.id, { status: 'completed', report: 'ok' });
  const loaded = loadDelegations();
  assert.equal(loaded.some((row) => row.id === a.id && row.report === 'ok'), true);
  const database = openDelegationSqlite();
  try {
    withDelegationSqliteTransaction(database, () => {
      database.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('crash', '1');
      throw new Error('boom');
    });
  } catch {
    // expected
  }
  const crashed = database.prepare('SELECT value FROM meta WHERE key = ?').get('crash');
  assert.equal(crashed, undefined);
  closeDelegationSqlite();
  setDelegationStoreBackend('json');
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-migrate-'));
  const delegationsPath = path.join(dir, 'delegations.json');
  const mailboxPath = path.join(dir, 'delegation-mailbox.json');
  fs.writeFileSync(delegationsPath, JSON.stringify({
    v: 2,
    items: [{ id: 'd1', parentChatId: 'p', status: 'completed', revision: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
  }));
  fs.writeFileSync(mailboxPath, JSON.stringify({
    v: 1,
    items: [{ id: 'm1', toChatId: 'p', fromChatId: 'c', status: 'delivered', createdAt: '2026-01-01T00:00:00.000Z' }],
  }));
  const dry = migrateDelegationsJsonToSqlite({ dataDir: dir, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.counts.delegations, 1);
  const migrated = migrateDelegationsJsonToSqlite({ dataDir: dir });
  assert.equal(migrated.switched, true);
  const marker = JSON.parse(fs.readFileSync(delegationsPath, 'utf8'));
  assert.equal(marker.backend, 'sqlite');
  const extraDb = openDelegationSqlite({ dataDir: dir });
  extraDb.prepare(`
    INSERT INTO delegations(id, revision, status, parent_chat_id, child_chat_id, workspace_folder, idempotency_key, created_at, archived_at, json)
    VALUES('d2', 1, 'failed', 'p', '', '', '', '2026-01-02T00:00:00.000Z', '', '{"id":"d2","revision":2,"status":"failed","parentChatId":"p"}')
  `).run();
  closeDelegationSqlite();
  const rolled = rollbackDelegationsSqliteToJson({ dataDir: dir, backupDir: migrated.backupDir });
  assert.equal(rolled.counts.delegations, 2);
  const restored = JSON.parse(fs.readFileSync(delegationsPath, 'utf8'));
  assert.equal(restored.v, 2);
  assert.ok(restored.items.some((row) => row.id === 'd2'));
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-mp-'));
  closeDelegationSqlite();
  openDelegationSqlite({ dataDir: dir });
  closeDelegationSqlite();
  const persistUrl = new URL('../lib/persist/delegations-persist.js', import.meta.url).href;
  const backendUrl = new URL('../lib/persist/delegation-store-backend.js', import.meta.url).href;
  const childScript = `
    import { setDelegationStoreBackend } from ${JSON.stringify(backendUrl)};
    import { createDelegationRecord } from ${JSON.stringify(persistUrl)};
    setDelegationStoreBackend('sqlite');
    const id = process.env.ROW_ID;
    createDelegationRecord({ parentChatId: 'p', childChatId: id, idempotencyKey: id });
    console.log('wrote', id);
  `;
  const writers = [];
  for (let i = 0; i < 4; i += 1) {
    writers.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        env: {
          ...process.env,
          CRETLI_DATA_DIR: dir,
          CRETLI_DELEGATION_STORE: 'sqlite',
          ROW_ID: `row-${i}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.stderr.on('data', (chunk) => { out += String(chunk); });
      child.on('close', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(out || `exit ${code}`));
      });
    }));
  }
  await Promise.all(writers);
  closeDelegationSqlite();
  const database = openDelegationSqlite({ dataDir: dir });
  const rows = loadDelegationsSqlite(database);
  assert.equal(rows.length, 4);
  closeDelegationSqlite();
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  createDelegationRecord({
    parentChatId: 'old',
    childChatId: 'oldc',
    status: 'completed',
  });
  const row = loadDelegations().at(-1);
  updateDelegationRecord(row.id, {
    finishedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    planMarkdown: 'x'.repeat(100),
    status: 'completed',
  });
  const result = applyDelegationRetention({ now: Date.now(), retentionMs: 24 * 60 * 60 * 1000 });
  assert.equal(result.archived >= 0, true);
}

console.log('delegation-phase2-store.test.js OK');
