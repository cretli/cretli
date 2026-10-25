import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeDelegationSqlite,
  openDelegationSqlite,
} from '../lib/persist/delegation-sqlite.js';
import {
  migrateDelegationsJsonToSqlite,
  rollbackDelegationsSqliteToJson,
  hashDelegationItems,
} from '../lib/persist/delegation-migrate.js';
import { createHash } from 'node:crypto';

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-phase3-sqlite-'));
const delegationsPath = path.join(dir, 'delegations.json');
const mailboxPath = path.join(dir, 'delegation-mailbox.json');
const items = [
  { id: 'd1', parentChatId: 'p', status: 'completed', revision: 1, createdAt: '2026-01-01T00:00:00.000Z' },
];
const mailbox = [
  { id: 'm1', toChatId: 'p', fromChatId: 'c', status: 'delivered', createdAt: '2026-01-01T00:00:00.000Z' },
];
fs.writeFileSync(delegationsPath, JSON.stringify({ v: 2, items }));
fs.writeFileSync(mailboxPath, JSON.stringify({ v: 1, items: mailbox }));
const beforeHash = hashDelegationItems(items);
const beforeMailbox = hashFile(mailboxPath);
const beforeStat = fs.statSync(delegationsPath);

const dry = migrateDelegationsJsonToSqlite({ dataDir: dir, dryRun: true });
assert.equal(dry.dryRun, true);
assert.equal(fs.readFileSync(delegationsPath, 'utf8').includes('"backend"'), false);
assert.equal(fs.statSync(delegationsPath).mtimeMs, beforeStat.mtimeMs);

const migrated = migrateDelegationsJsonToSqlite({ dataDir: dir });
assert.equal(migrated.switched, true);
assert.ok(migrated.backupDir);
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
assert.equal(restored.backend || '', '');
assert.ok(restored.items.some((row) => row.id === 'd1'));
assert.ok(restored.items.some((row) => row.id === 'd2'));
assert.equal(hashDelegationItems(restored.items.filter((row) => row.id === 'd1')), beforeHash);

const remigrated = migrateDelegationsJsonToSqlite({ dataDir: dir });
assert.equal(remigrated.switched, true);
const remigratedJson = JSON.parse(fs.readFileSync(delegationsPath, 'utf8'));
assert.equal(remigratedJson.backend, 'sqlite');
const db = openDelegationSqlite({ dataDir: dir });
const live = db.prepare('SELECT id FROM delegations ORDER BY id').all().map((row) => row.id);
closeDelegationSqlite();
assert.deepEqual(live.sort(), ['d1', 'd2']);
assert.ok(beforeMailbox);

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({
  gate: 'D9',
  beforeHash,
  backupDir: migrated.backupDir,
  remigrated: live,
}));
console.log('delegation-phase3-sqlite-checklist.test.js OK');
