/**
 * Unclean boot (kill -9) fixture: thousands of finished delegations plus a few interrupted ones in an
 * isolated data dir. Boot reconciliation must give the event loop a turn regularly instead of running
 * the whole sweep as one block, and must still deliver a pending outbox item.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDelegationsOnBoot, hasPendingOutboxItems } from '../lib/delegation-service.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');

test('hasPendingOutboxItems', () => {
  assert.equal(hasPendingOutboxItems(null), false);
  assert.equal(hasPendingOutboxItems({ outbox: [{ id: 'o', deliveredAt: '2026-01-01' }] }), false);
  assert.equal(hasPendingOutboxItems({ outbox: [{ id: 'o', deliveredAt: '' }] }), true);
});

test('boot reconciliation yields to the event loop on a large unclean store', async () => {
  const N = 4000;
  const at = '2026-11-04T18:00:00.000Z';
  // Written as one store file, like the data a killed process leaves behind; finished rows already
  // delivered their history card, a few still carry the in-flight verify marker.
  const items = Array.from({ length: N }, (_, i) => ({
    id: `d-${i}`,
    revision: 1,
    parentChatId: `p-${i % 20}`,
    childChatId: `c-${i}`,
    status: 'completed',
    createdAt: at,
    historyDeliveredAt: at,
    ...(i % 500 === 0 ? { verifyPending: { startedAt: at } } : {}),
  }));
  // Undelivered outbox intent of an unknown kind: flushed (and skipped) without touching other rows.
  items.push({
    id: 'd-pending',
    revision: 1,
    parentChatId: 'p-x',
    childChatId: 'c-x',
    status: 'completed',
    createdAt: at,
    historyDeliveredAt: at,
    outbox: [{ id: 'ob-1', type: 'unknown_kind', deliveredAt: '' }],
  });
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'delegations.json'), JSON.stringify({ v: 2, items }));
  const pending = { id: 'd-pending' };

  let ticks = 0;
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks += 1;
  }, 1);
  const started = performance.now();
  await reconcileDelegationsOnBoot();
  const totalMs = performance.now() - started;
  clearInterval(timer);
  console.log(`[unclean-boot] ${N + 1} rows, reconcile ${totalMs.toFixed(0)} ms, timer ticks ${ticks}, max gap ${maxGap.toFixed(0)} ms`);
  // Before the yield the whole sweep was one macrotask: the 1 ms timer could not fire at all.
  assert.ok(ticks >= 5, `timer fired only ${ticks} times during ${totalMs.toFixed(0)} ms`);
  assert.ok(maxGap < Math.max(250, totalMs / 3), `max event-loop gap ${maxGap.toFixed(0)} ms`);
  assert.ok(getDelegationById(pending.id), 'pending-outbox row still present after the flush');
  assert.equal(getDelegationById('d-0').verifyPending ?? null, null);
});
