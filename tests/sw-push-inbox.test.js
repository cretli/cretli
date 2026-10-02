import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const filePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/sw-push-inbox.js'
);
const source = readFileSync(filePath, 'utf8');
const context = { self: {}, indexedDB: undefined };
vm.createContext(context);
vm.runInContext(source, context);
const inbox = context.self.cretliPushInbox;
assert.ok(inbox, 'sw-push-inbox.js must expose cretliPushInbox');

const record = inbox.buildPushInboxRecordFromNotificationPayload({
  title: 'Cretli',
  data: {
    type: 'agent-needs-input',
    chatId: 'c1',
    kind: 'permission',
    at: 900,
  },
});
assert.equal(record.chatId, 'c1');
assert.equal(record.type, 'agent-needs-input');
assert.equal(record.kind, 'permission');
assert.equal(record.at, 900);
assert.equal(record.title, 'Cretli');

const merged = inbox.mergePushInboxRecords(
  { chatId: 'c1', type: 'agent-finished', at: 1 },
  { chatId: 'c1', type: 'agent-finished', at: 5, status: 'done' }
);
assert.equal(merged.at, 5);
assert.equal(merged.status, 'done');

// Persistence must never be skipped for a visible client anymore: the freshness
// watermark (server vs inbox) decides, not window visibility.
assert.equal(inbox.shouldSkipPushInboxPersistForVisibleClient, undefined);

console.log('sw-push-inbox.test.js: ok');
