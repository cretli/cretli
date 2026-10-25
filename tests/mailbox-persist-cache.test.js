// Pin the JSON store before any module reads the ambient value; the runtime
// sets CRETLI_DELEGATION_STORE=sqlite, and a static import of the mailbox would
// otherwise be evaluated first and resolve the wrong backend.
process.env.CRETLI_DELEGATION_STORE = 'json';
const { ISOLATED_DATA_DIR } = await import('./helpers/isolated-data-dir.js');
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const { createMailboxMessage, listMailboxByStatus, loadMailboxMessages } = await import('../lib/persist/delegation-mailbox-persist.js');

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
  // A write re-seeds the cache, so the next read does not re-parse the file.
  assert.equal(mailboxReads, 0);
  assert.equal(after[1].body, 'next');
  after[1].body = 'mutated';
  assert.equal(loadMailboxMessages()[1].body, 'next');
  for (const status of ['dispatching', 'delivered', 'queued', 'failed']) {
    createMailboxMessage({ fromChatId: 'a', toChatId: 'b', kind: 'reply', replyKind: 'progress', body: `s-${status}`, status, idempotencyKey: `mix-${status}` });
  }
  const bodies = (rows) => rows.map((row) => row.body);
  const active = listMailboxByStatus(['queued', 'dispatching']);
  assert.ok(active.every((row) => ['queued', 'dispatching'].includes(row.status)));
  assert.deepEqual(bodies(active).filter((b) => b.startsWith('s-')), ['s-dispatching', 's-queued']);
  assert.deepEqual(bodies(listMailboxByStatus(['failed', 'failed'])), ['s-failed']);
  assert.deepEqual(bodies(listMailboxByStatus(['delivered'])).filter((b) => b.startsWith('s-')), ['s-delivered']);
  const expectedAll = loadMailboxMessages().filter((r) => ['queued', 'dispatching'].includes(r.status));
  assert.deepEqual(active, expectedAll);
  active[0].body = 'mutated';
  assert.notEqual(listMailboxByStatus(['queued', 'dispatching'])[0].body, 'mutated');
  assert.deepEqual(listMailboxByStatus(['no-such-status']), []);
  assert.deepEqual(listMailboxByStatus([]), []);
  console.log('mailbox-persist-cache.test.js ok');
} finally {
  fs.readFileSync = originalRead;
}
