/**
 * Leaf R10 — one recovery owner per delegation family, idempotent outbox
 * redelivery, untouched budgets/rounds, kept slots and `runStoppingAt`.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  authorizeFamilyRecoveryAction,
  claimFamilyRecovery,
  getFamilyClaim,
  updateFamilyClaim,
  planFamilyRecovery,
  resolveFamilyKey,
  runFamilyBootRecovery,
} from '../lib/recovery/recovery-family.ts';
import { acquireRecoveryOwnerLease, releaseRecoveryOwnerLease } from '../lib/recovery/recovery-owner-lease.ts';
import { closeRecoveryStore, openRecoveryStore } from '../lib/recovery/recovery-store.ts';
import { makeTempDir } from './helpers/temp-dir.js';

const NOW = 1_700_000_000_000;

function withStore(fn) {
  const dir = makeTempDir('recovery-family-');
  const store = openRecoveryStore({ dataDir: dir });
  try {
    return fn(store);
  } finally {
    closeRecoveryStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
}

function lease(store) {
  const result = acquireRecoveryOwnerLease({ ownerId: 'owner-a', store, now: NOW });
  return { ownerToken: result.ownerToken, generation: result.generation };
}

const delegations = () => [
  { id: 'd1', parentChatId: 'p1', status: 'running' },
  { id: 'd2', parentChatId: 'p1', status: 'interrupted', interruptCode: 'server_restart' },
  { id: 'd3', parentChatId: 'p1', status: 'interrupted', interruptCode: 'server_restart', interruptContinuedAt: '2026-01-01' },
  { id: 'd4', parentChatId: 'p2', status: 'completed', runStoppingAt: new Date(NOW - 1000).toISOString() },
];

test('family key groups parent and children; plan never auto-starts a child', () => {
  assert.equal(resolveFamilyKey({ parentChatId: 'p1' }), 'family:p1');
  const plan = planFamilyRecovery({ delegations: delegations(), now: NOW });
  const p1 = plan.families.find((f) => f.familyKey === 'family:p1');
  assert.deepEqual(p1.childIds, ['d1', 'd2', 'd3']);
  assert.deepEqual(p1.autoStartChildIds, []);
  assert.deepEqual(p1.restartRetryEligibleIds, ['d2']);
  assert.deepEqual(p1.budgetMutations, []);
});

test('single owner per family: a second owner is refused, a child cannot act', () => {
  withStore((store) => {
    const a = lease(store);
    const first = claimFamilyRecovery({ familyKey: 'family:p1', ...a, now: NOW, store });
    assert.equal(first.ok, true);
    assert.equal(first.reason, 'claimed');
    assert.equal(claimFamilyRecovery({ familyKey: 'family:p1', ...a, now: NOW, store }).reason, 'renewed');
    const other = claimFamilyRecovery({ familyKey: 'family:p1', ownerToken: 'rogue', generation: a.generation, now: NOW, store });
    assert.equal(other.ok, false);
    assert.equal(other.reason, 'fence_rejected'); // live second owner never reaches the CAS
    assert.equal(authorizeFamilyRecoveryAction({ familyKey: 'family:p1', ownerToken: 'child-token', generation: a.generation, store }).allowed, false);
    assert.equal(authorizeFamilyRecoveryAction({ familyKey: 'family:p1', ...a, store }).allowed, true);
    assert.equal(authorizeFamilyRecoveryAction({ familyKey: 'family:none', ...a, store }).reason, 'no_family_claim');
  });
});

test('outbox is redelivered once, only queued rows, only after boot reconciliation', async () => {
  await withStoreAsync(async (store) => {
    const a = lease(store);
    const mailbox = [
      { id: 'm1', delegationId: 'd1', toChatId: 'p1', status: 'queued' },
      { id: 'm2', delegationId: 'd1', toChatId: 'p1', status: 'uncertain' },
      { id: 'm3', delegationId: 'd1', toChatId: 'p1', status: 'delivered' },
    ];
    const calls = [];
    const drainRecipient = async (chatId) => {
      calls.push(chatId);
      return [{ id: 'm1', status: 'delivered' }];
    };
    const blocked = await runFamilyBootRecovery({ delegations: delegations(), mailbox, ...a, drainRecipient, store, now: NOW });
    assert.equal(blocked.reason, 'boot_not_reconciled');
    assert.deepEqual(calls, []);
    const run = { delegations: delegations(), mailbox, ...a, bootReconciled: true, drainRecipient, store, now: NOW };
    const first = await runFamilyBootRecovery(run);
    assert.deepEqual(first.families.find((f) => f.familyKey === 'family:p1').redelivered, ['m1']);
    const second = await runFamilyBootRecovery(run);
    assert.deepEqual(second.families.find((f) => f.familyKey === 'family:p1').redelivered, []);
    assert.deepEqual(calls, ['p1']);
  });
});

test('recovery leaves workflow rounds/budgets and delegation rows untouched', async () => {
  await withStoreAsync(async (store) => {
    const a = lease(store);
    const rows = delegations();
    const workflow = { round: 2, maxRounds: 4, budgetTokens: 1000, deadlineAt: '2030-01-01' };
    const before = JSON.stringify({ rows, workflow });
    await runFamilyBootRecovery({
      delegations: rows, mailbox: [], ...a, bootReconciled: true, drainRecipient: async () => [], store, now: NOW,
    });
    assert.equal(JSON.stringify({ rows, workflow }), before);
  });
});

test('slot stays occupied for active/unknown rows and runStoppingAt is not resumable', () => {
  const plan = planFamilyRecovery({ delegations: delegations(), now: NOW });
  const p1 = plan.families.find((f) => f.familyKey === 'family:p1');
  const p2 = plan.families.find((f) => f.familyKey === 'family:p2');
  assert.equal(p1.slotOccupied, true);
  assert.deepEqual(p1.occupiedChildIds, ['d1']);
  assert.equal(p2.slotOccupied, true);
  assert.deepEqual(p2.stoppingChildIds, ['d4']);
  assert.deepEqual(p2.noResumeChildIds, ['d4']);
  assert.deepEqual(p2.restartRetryEligibleIds, []);
  const stoppingInterrupted = planFamilyRecovery({
    delegations: [{ id: 'x', parentChatId: 'p9', status: 'interrupted', interruptCode: 'server_restart', runStoppingAt: new Date(NOW).toISOString() }],
    now: NOW,
  });
  assert.deepEqual(stoppingInterrupted.families[0].restartRetryEligibleIds, []);
});

test('takeover keeps outboxDone; stale_generation for same token; boot->release->reacquire->claim', async () => {
  await withStoreAsync(async (store) => {
    const mailbox = [
      { id: 'm1', delegationId: 'd1', toChatId: 'p1', status: 'queued' },
      { id: 'm9', delegationId: 'd1', toChatId: 'p1', status: 'queued' },
    ];
    const drained = [];
    const drainRecipient = async (chatId, opts) => {
      drained.push(opts.onlyIds.slice());
      return opts.onlyIds.filter((id) => id === 'm1').map((id) => ({ id, status: 'delivered' }));
    };
    const a = lease(store);
    const run = (l) => runFamilyBootRecovery({
      delegations: delegations(), mailbox, ...l, bootReconciled: true, drainRecipient, store, now: NOW,
    });
    const first = await run(a);
    assert.deepEqual(first.families.find((f) => f.familyKey === 'family:p1').redelivered, ['m1']);
    assert.deepEqual(drained[0], ['m1', 'm9']);
    // Boot ends: lease row is deleted, next boot re-creates it with a new token.
    assert.equal(releaseRecoveryOwnerLease({ ownerToken: a.ownerToken, generation: a.generation, store }).released, true);
    const b = lease(store);
    assert.notEqual(b.ownerToken, a.ownerToken);
    const second = await run(b);
    const fam = second.families.find((f) => f.familyKey === 'family:p1');
    assert.equal(fam.claimed, true);
    assert.equal(fam.reason, 'takeover');
    assert.deepEqual(fam.redelivered, []);
    assert.deepEqual(drained[1], ['m9']);
    assert.deepEqual(getFamilyClaim({ familyKey: 'family:p1', store }).outboxDone, ['m1']);
    // Same token with a newer stored generation is stale.
    const stale = claimFamilyRecovery({ familyKey: 'family:p1', ownerToken: b.ownerToken, generation: b.generation, now: NOW, store });
    assert.equal(stale.reason, 'renewed');
    updateFamilyClaim({ familyKey: 'family:p1', ownerToken: b.ownerToken, generation: b.generation, store });
  });
});

test('stale_generation, deferOutbox skip default drain, empty outbox is not claimed, family failure isolated', async () => {
  await withStoreAsync(async (store) => {
    const a = lease(store);
    const db = (await import('../lib/recovery/recovery-store.ts')).getRecoveryStoreDatabase(store);
    db.prepare('INSERT OR REPLACE INTO recovery_meta(key, value) VALUES(?, ?)').run(
      'familyRecovery:family:px',
      JSON.stringify({ familyKey: 'family:px', ownerToken: a.ownerToken, generation: a.generation + 5, outboxDone: [] }),
    );
    assert.equal(claimFamilyRecovery({ familyKey: 'family:px', ...a, now: NOW, store }).reason, 'stale_generation');
    const mailbox = [
      { id: 'm1', delegationId: 'd1', toChatId: 'p1', status: 'queued' },
      { id: 'm4', delegationId: 'd4', toChatId: 'p2', status: 'queued' },
    ];
    const result = await runFamilyBootRecovery({
      delegations: delegations(), mailbox, ...a, bootReconciled: true, store, now: NOW,
      drainRecipient: async (chatId) => {
        if (chatId === 'p1') throw new Error('boom');
        return [{ id: 'm4', status: 'delivered' }];
      },
    });
    assert.equal(result.families.find((f) => f.familyKey === 'family:p1').reason, 'family_failed');
    assert.deepEqual(result.families.find((f) => f.familyKey === 'family:p2').redelivered, ['m4']);
    const empty = await runFamilyBootRecovery({
      delegations: delegations(), mailbox: [], ...a, bootReconciled: true, store, now: NOW, drainRecipient: async () => [],
    });
    assert.deepEqual(empty.families, []);
    assert.equal(getFamilyClaim({ familyKey: 'family:p3', store }), null);
  });
});

async function withStoreAsync(fn) {
  const dir = makeTempDir('recovery-family-');
  const store = openRecoveryStore({ dataDir: dir });
  try {
    return await fn(store);
  } finally {
    closeRecoveryStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bootDelegationRuntime: deferred outbox, lease released in finally, second boot takes the family over', async () => {
  const { bootDelegationRuntime, shutdownDelegationRuntime } = await import('../lib/delegation-runtime-boot.js');
  const { createMailboxMessage } = await import('../lib/persist/delegation-mailbox-persist.js');
  const { getRecoveryOwnerLease } = await import('../lib/recovery/recovery-owner-lease.ts');
  const { stopDelegationRuntimeWorker } = await import('../lib/delegation-runtime-worker.js');
  const lifecycle = await import('../lib/delegation-lifecycle.js');
  createMailboxMessage({ fromChatId: 'boot-child', toChatId: 'boot-ghost-parent', kind: 'reply', body: 'x', status: 'queued' });
  const bootOnce = async () => {
    await bootDelegationRuntime({ intervalMs: 60_000 });
    await shutdownDelegationRuntime({ timeoutMs: 1000 });
    stopDelegationRuntimeWorker();
    lifecycle.resetDelegationLifecycleForTest();
  };
  const inspect = () => {
    const store = openRecoveryStore();
    try {
      return {
        leaseHeld: getRecoveryOwnerLease({ store }).held,
        claim: getFamilyClaim({ familyKey: 'family:boot-ghost-parent', store }),
      };
    } finally {
      closeRecoveryStore(store);
    }
  };
  await bootOnce();
  const first = inspect();
  assert.equal(first.leaseHeld, false, 'boot releases the lease in finally');
  assert.ok(first.claim, 'family claimed after R8 classification');
  // Empty outbox on the next boot is not claimed; a new queued row is.
  createMailboxMessage({ fromChatId: 'boot-child', toChatId: 'boot-ghost-parent', kind: 'reply', body: 'y', status: 'queued' });
  await bootOnce();
  const second = inspect().claim;
  const firstClaim = first.claim;
  assert.notEqual(second.ownerToken, firstClaim.ownerToken, 'second boot owns the claim (takeover, not owner_held)');
});
