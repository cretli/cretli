process.env.CRETLI_DELEGATION_STORE = 'sqlite';
await import('./helpers/isolated-data-dir.js');
import assert from 'node:assert/strict';
const { createMailboxMessage, listMailboxByStatus, loadMailboxMessages } = await import('../lib/persist/delegation-mailbox-persist.js');
const { openDelegationSqlite } = await import('../lib/persist/delegation-sqlite.js');

for (const status of ['dispatching', 'delivered', 'queued', 'failed']) {
  createMailboxMessage({ fromChatId: 'a', toChatId: 'b', kind: 'reply', replyKind: 'progress', body: `s-${status}`, status, idempotencyKey: `mix-${status}` });
}
const active = listMailboxByStatus(['queued', 'dispatching']);
assert.deepEqual(active.map((r) => r.body), ['s-dispatching', 's-queued']);
assert.deepEqual(active, loadMailboxMessages().filter((r) => ['queued', 'dispatching'].includes(r.status)));
assert.deepEqual(listMailboxByStatus(['no-such-status']), []);
assert.deepEqual(listMailboxByStatus([]), []);
active[0].body = 'mutated';
assert.equal(listMailboxByStatus(['dispatching'])[0].body, 's-dispatching');
const plan = openDelegationSqlite()
  .prepare("EXPLAIN QUERY PLAN SELECT json FROM mailbox WHERE status IN (?, ?) ORDER BY created_at ASC, rowid ASC")
  .all('queued', 'dispatching').map((r) => String(r.detail)).join(' | ');
assert.match(plan, /idx_mailbox_status_created/);
console.log('mailbox-status-sqlite.test.js ok');
