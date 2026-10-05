import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { createMailboxMessage, loadMailboxMessages } from '../lib/persist/delegation-mailbox-persist.js';

const file = path.join(ISOLATED_DATA_DIR, 'delegation-mailbox.json');
const originalRead = fs.readFileSync;
let mailboxReads = 0;
fs.readFileSync = function readFileSyncCounting(target, ...args) {
  if (String(target).endsWith(`${path.sep}delegation-mailbox.json`)) mailboxReads += 1;
  return originalRead.call(this, target, ...args);
};

try {
  fs.mkdirSync(ISOLATED_DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    items: [{ id: 'm1', status: 'queued', kind: 'reply', body: 'hello' }],
  }));
  mailboxReads = 0;
  const first = loadMailboxMessages();
  const second = loadMailboxMessages();
  assert.equal(first.length, 1);
  assert.equal(second[0].id, 'm1');
  assert.equal(mailboxReads, 1);
  first[0].body = 'mutated';
  assert.equal(loadMailboxMessages()[0].body, 'hello');
  assert.equal(mailboxReads, 1);
  createMailboxMessage({ kind: 'task', fromChatId: 'a', toChatId: 'b', body: 'next' });
  mailboxReads = 0;
  const after = loadMailboxMessages();
  assert.equal(after.length, 2);
  assert.equal(mailboxReads, 1);
  console.log('mailbox-persist-cache.test.js ok');
} finally {
  fs.readFileSync = originalRead;
}
