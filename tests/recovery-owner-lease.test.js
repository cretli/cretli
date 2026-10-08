/**
 * Owner lease + generation fencing tests for the recovery registry (leaf R3).
 *
 * Every test uses its own temporary data dir. The cross-process test at the end
 * spawns real child processes through the shared recovery crash harness.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  closeRecoveryStore,
  openRecoveryStore,
  RECOVERY_STORE_SCHEMA_VERSION,
} from '../lib/recovery/recovery-store.js';
import {
  RECOVERY_OWNER_LEASE_DEFAULT_TTL_MS,
  RecoveryOwnerLeaseError,
  acquireRecoveryOwnerLease,
  checkRecoveryOwnerFence,
  getRecoveryOwnerLease,
  isRecoveryOwnerProcessAlive,
  releaseRecoveryOwnerLease,
  renewRecoveryOwnerLease,
} from '../lib/recovery/recovery-owner-lease.js';
import { getProcessStartTime } from '../lib/delegation-owner-lock.js';
import { createCrashDataDir, spawnRecoveryBarrier } from './helpers/recovery-crash-harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_URL = pathToFileURL(path.join(HERE, '..', 'lib', 'recovery', 'recovery-store.js')).href;
const LEASE_URL = pathToFileURL(
  path.join(HERE, '..', 'lib', 'recovery', 'recovery-owner-lease.js')
).href;

/** A fixed, deterministic epoch used as `now` throughout the tests. */
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
/** PIDs above the Linux pid_max range reliably probe as dead. */
const DEAD_PID = 999_999_999;
const OWNER_START = getProcessStartTime(process.pid);

/**
 * @returns {string}
 */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'recovery-lease-'));
}

/**
 * @param {string} dir
 * @param {(store: object) => void} fn
 */
function withStore(dir, fn) {
  const store = openRecoveryStore({ dataDir: dir });
  try {
    fn(store);
  } finally {
    closeRecoveryStore(store);
  }
}

/**
 * @param {string} dir
 * @param {() => void} fn
 */
function withTempDir(dir, fn) {
  try {
    fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Validation + schema
// ---------------------------------------------------------------------------

test('acquire rejects an empty ownerId with invalid_owner before touching a store', () => {
  assert.throws(
    () => acquireRecoveryOwnerLease({ ownerId: '   ' }),
    (err) => {
      assert.ok(err instanceof RecoveryOwnerLeaseError);
      assert.equal(err.code, 'invalid_owner');
      return true;
    }
  );
  assert.throws(() => acquireRecoveryOwnerLease({}), (err) => err.code === 'invalid_owner');
});

test('the default TTL is 30s and the store migrates to schema 3 with a singleton lease table', () => {
  assert.equal(RECOVERY_OWNER_LEASE_DEFAULT_TTL_MS, 30_000);
  assert.equal(RECOVERY_STORE_SCHEMA_VERSION, 3);

  const dir = tempDir();
  withTempDir(dir, () => {
    // Simulate a v1 file: a real SQLite file at user_version 1 without the
    // lease table. Opening must migrate it forward in place to v3.
    const filePath = path.join(dir, 'recovery.sqlite');
    const raw = new DatabaseSync(filePath);
    raw.exec('CREATE TABLE recovery_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.exec("INSERT INTO recovery_meta(key, value) VALUES('schemaVersion', '1')");
    raw.exec('PRAGMA user_version = 1');
    raw.close();

    const store = openRecoveryStore({ filePath });
    try {
      assert.equal(store.schemaVersion, 3);
      const table = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recovery_owner_lease'")
        .get();
      assert.ok(table, 'v1 file gains the recovery_owner_lease table');
      for (const name of ['recovery_queue', 'recovery_cancels', 'recovery_waiting']) {
        const v3Table = store.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(name);
        assert.ok(v3Table, `v1 file gains the ${name} table (v3)`);
      }
      const userVersion = Number(store.db.prepare('PRAGMA user_version').get().user_version);
      assert.equal(userVersion, 3);

      // The singleton CHECK is real: a second row with a different id fails.
      const escaped = 'id,owner_id,owner_token,pid,pid_start,generation,started_at,heartbeat_at,json';
      assert.throws(() =>
        store.db
          .prepare(`INSERT INTO recovery_owner_lease(${escaped}) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(2, 'x', 'y', 1, '', 1, 'a', 'a', '{}')
      );
    } finally {
      closeRecoveryStore(store);
    }
  });
});

// ---------------------------------------------------------------------------
// acquire / renew
// ---------------------------------------------------------------------------

test('acquire creates generation 1 and a same-token acquire renews without bumping generation', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      const first = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        now: T0,
        ttlMs: 60_000,
      });
      assert.equal(first.acquired, true);
      assert.equal(first.renewed, false);
      assert.equal(first.takeover, false);
      assert.equal(first.reason, 'created');
      assert.equal(first.generation, 1);
      assert.equal(first.ownerToken, 'tok-a');
      assert.equal(first.lease.ownerId, 'worker-a');
      assert.equal(first.lease.ownerToken, 'tok-a');
      assert.equal(first.lease.generation, 1);
      assert.equal(first.lease.startedAt, new Date(T0).toISOString());
      assert.equal(first.lease.heartbeatAt, new Date(T0).toISOString());
      assert.equal(first.lease.expiresAt, new Date(T0 + 60_000).toISOString());
      assert.equal(first.lease.expired, false);
      assert.equal(first.lease.live, true);
      assert.equal(first.lease.pid, process.pid);
      assert.equal(first.lease.pidStart, OWNER_START);

      const renew = renewRecoveryOwnerLease({
        store,
        ownerToken: 'tok-a',
        generation: 1,
        now: T0 + 5_000,
        ttlMs: 60_000,
      });
      assert.equal(renew.ok, true);
      assert.equal(renew.lease.generation, 1);
      assert.equal(renew.lease.heartbeatAt, new Date(T0 + 5_000).toISOString());

      const again = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        now: T0 + 10_000,
        ttlMs: 60_000,
      });
      assert.equal(again.acquired, true);
      assert.equal(again.renewed, true);
      assert.equal(again.reason, 'renewed');
      assert.equal(again.generation, 1, 'renewal keeps the generation');
      assert.equal(again.lease.startedAt, new Date(T0).toISOString());
      assert.equal(again.lease.heartbeatAt, new Date(T0 + 10_000).toISOString());
    });
  });
});

test('a live second owner gets owner_held without throwing and cannot mutate the row', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        now: T0,
        ttlMs: 60_000,
      });

      const held = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        now: T0 + 1_000,
        ttlMs: 60_000,
      });
      assert.equal(held.acquired, false);
      assert.equal(held.renewed, false);
      assert.equal(held.takeover, false);
      assert.equal(held.reason, 'owner_held');
      assert.equal(held.generation, 1);
      // The top-level token is the caller's *candidate*; only the lease carries
      // the real holder.
      assert.equal(held.ownerToken, 'tok-b');
      assert.equal(held.lease.ownerToken, 'tok-a');
      assert.equal(held.lease.ownerId, 'worker-a');

      const view = getRecoveryOwnerLease({ store, now: T0 + 1_000, ttlMs: 60_000 });
      assert.equal(view.held, true);
      assert.equal(view.ownerToken, 'tok-a');
      assert.equal(view.generation, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// takeover
// ---------------------------------------------------------------------------

test('takeover after a dead PID raises the generation by exactly one', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      const dead = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        pid: DEAD_PID,
        pidStart: '',
        now: T0,
        ttlMs: 60_000,
      });
      assert.equal(dead.reason, 'created');
      assert.equal(dead.generation, 1);
      assert.equal(dead.lease.pidAlive, false);
      assert.equal(dead.lease.live, false);

      const next = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        pid: process.pid,
        pidStart: OWNER_START,
        now: T0 + 1,
        ttlMs: 60_000,
      });
      assert.equal(next.acquired, true);
      assert.equal(next.takeover, true);
      assert.equal(next.reason, 'takeover');
      assert.equal(next.generation, 2);
      assert.equal(next.lease.ownerToken, 'tok-b');
      assert.equal(next.lease.ownerId, 'worker-b');
      assert.equal(next.lease.pidAlive, true);
      assert.equal(next.lease.live, true);
      assert.equal(next.lease.startedAt, new Date(T0 + 1).toISOString());
    });
  });
});

test('takeover detects PID reuse through a stale pidStart even while the PID lives', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      const reused = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        pid: process.pid,
        pidStart: 'stale-starttime',
        now: T0,
        ttlMs: 60_000,
      });
      assert.equal(reused.reason, 'created');
      assert.equal(reused.lease.pidAlive, true);
      assert.equal(
        isRecoveryOwnerProcessAlive(process.pid, 'stale-starttime'),
        false,
        'a live PID with a mismatched starttime is PID reuse, not a live owner'
      );

      const view = getRecoveryOwnerLease({ store, now: T0, ttlMs: 60_000 });
      assert.equal(view.live, false, 'PID reuse makes the stored owner not live');

      const next = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        pid: process.pid,
        pidStart: OWNER_START,
        now: T0 + 1,
        ttlMs: 60_000,
      });
      assert.equal(next.takeover, true);
      assert.equal(next.generation, 2);
    });
  });
});

test('takeover happens exactly at TTL expiry, not one millisecond earlier', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        now: T0,
        ttlMs: 1_000,
      });

      const justBefore = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        now: T0 + 999,
      });
      assert.equal(justBefore.acquired, false);
      assert.equal(justBefore.reason, 'owner_held');

      const atExpiry = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        now: T0 + 1_000,
      });
      assert.equal(atExpiry.acquired, true);
      assert.equal(atExpiry.takeover, true);
      assert.equal(atExpiry.reason, 'takeover');
      assert.equal(atExpiry.generation, 2);
      // The stored TTL is reused when the takeover call omits `ttlMs`.
      assert.equal(atExpiry.lease.ttlMs, 1_000);
      assert.equal(atExpiry.lease.expiresAt, new Date(T0 + 2_000).toISOString());
    });
  });
});

// ---------------------------------------------------------------------------
// fencing
// ---------------------------------------------------------------------------

test('checkRecoveryOwnerFence accepts the current owner and rejects stale callbacks', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      assert.deepEqual(
        checkRecoveryOwnerFence({ store, ownerToken: 'tok-a', generation: 1, now: T0 }),
        { ok: false, reason: 'no_lease' }
      );

      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        now: T0,
        ttlMs: 1_000,
      });
      assert.deepEqual(
        checkRecoveryOwnerFence({ store, ownerToken: 'tok-a', generation: 1, now: T0 + 500 }),
        { ok: true }
      );

      // The incumbent's heartbeat expires at T0 + 1_000; the takeover call
      // cannot extend it with a larger requested TTL.
      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        now: T0 + 1_000,
        ttlMs: 60_000,
      });
      assert.equal(getRecoveryOwnerLease({ store, now: T0 + 2_000 }).generation, 2);

      // A callback issued before the takeover is fenced out.
      assert.deepEqual(
        checkRecoveryOwnerFence({ store, ownerToken: 'tok-a', generation: 1, now: T0 + 3_000 }),
        { ok: false, reason: 'stale_owner' }
      );
      // A stolen token with the old generation is fenced out too.
      assert.deepEqual(
        checkRecoveryOwnerFence({ store, ownerToken: 'tok-b', generation: 1, now: T0 + 3_000 }),
        { ok: false, reason: 'generation_mismatch' }
      );
      // The current owner + generation passes.
      assert.deepEqual(
        checkRecoveryOwnerFence({ store, ownerToken: 'tok-b', generation: 2, now: T0 + 3_000 }),
        { ok: true }
      );
    });
  });
});

test('checkRecoveryOwnerFence reports lease_expired and owner_dead', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        now: T0,
        ttlMs: 1_000,
      });
      assert.deepEqual(
        checkRecoveryOwnerFence({ store, ownerToken: 'tok-a', generation: 1, now: T0 + 1_000 }),
        { ok: false, reason: 'lease_expired' }
      );

      // A fresh row whose owner PID is already gone yields owner_dead.
      const dead = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        pid: DEAD_PID,
        pidStart: '',
        now: T0 + 2_000,
        ttlMs: 60_000,
      });
      assert.equal(dead.reason, 'takeover');
      assert.deepEqual(
        checkRecoveryOwnerFence({ store, ownerToken: 'tok-b', generation: 2, now: T0 + 2_000 }),
        { ok: false, reason: 'owner_dead' }
      );
    });
  });
});

test('renewRecoveryOwnerLease rejects no_lease, stale_owner and generation_mismatch', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      assert.deepEqual(
        renewRecoveryOwnerLease({ store, ownerToken: 'tok-a', generation: 1, now: T0 }),
        { ok: false, reason: 'no_lease' }
      );

      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        pid: DEAD_PID,
        pidStart: '',
        now: T0,
        ttlMs: 60_000,
      });
      // worker-a is dead, so a live worker-b takes generation 1 -> 2.
      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        now: T0 + 1,
        ttlMs: 60_000,
      });

      assert.deepEqual(
        renewRecoveryOwnerLease({ store, ownerToken: 'tok-a', generation: 1, now: T0 + 3 }),
        { ok: false, reason: 'stale_owner' }
      );
      assert.deepEqual(
        renewRecoveryOwnerLease({ store, ownerToken: 'tok-b', generation: 1, now: T0 + 3 }),
        { ok: false, reason: 'generation_mismatch' }
      );
      const ok = renewRecoveryOwnerLease({
        store,
        ownerToken: 'tok-b',
        generation: 2,
        now: T0 + 3,
        ttlMs: 60_000,
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.lease.generation, 2);
      assert.equal(ok.lease.heartbeatAt, new Date(T0 + 3).toISOString());
    });
  });
});

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

test('release deletes only the current owner; a stale token cannot remove or take over the lease', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        ownerToken: 'tok-a',
        pid: DEAD_PID,
        pidStart: '',
        now: T0,
        ttlMs: 60_000,
      });
      acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        ownerToken: 'tok-b',
        now: T0 + 1,
        ttlMs: 60_000,
      });

      assert.deepEqual(
        releaseRecoveryOwnerLease({ store, ownerToken: 'tok-a', generation: 1 }),
        { released: false, reason: 'stale_owner' }
      );
      assert.deepEqual(
        releaseRecoveryOwnerLease({ store, ownerToken: 'foreign-token' }),
        { released: false, reason: 'stale_owner' }
      );
      assert.deepEqual(
        releaseRecoveryOwnerLease({ store, ownerToken: 'tok-b', generation: 1 }),
        { released: false, reason: 'generation_mismatch' }
      );

      const stillHeld = getRecoveryOwnerLease({ store, now: T0 + 2 });
      assert.equal(stillHeld.held, true);
      assert.equal(stillHeld.ownerToken, 'tok-b', 'foreign callbacks did not take over');
      assert.equal(stillHeld.generation, 2);

      assert.deepEqual(
        releaseRecoveryOwnerLease({ store, ownerToken: 'tok-b', generation: 2 }),
        { released: true, reason: 'released' }
      );
      assert.deepEqual(getRecoveryOwnerLease({ store, now: T0 + 3 }), { held: false });
      assert.deepEqual(
        releaseRecoveryOwnerLease({ store, ownerToken: 'tok-b' }),
        { released: false, reason: 'no_lease' }
      );
    });
  });
});

// ---------------------------------------------------------------------------
// instance token is not an ownership proof
// ---------------------------------------------------------------------------

test('serverInstanceToken/instanceToken is neither proof of ownership nor a fencing token', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    withStore(dir, (store) => {
      const created = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-a',
        instanceToken: 'server-instance-abc',
        serverInstanceToken: 'server-instance-abc',
        now: T0,
        ttlMs: 60_000,
      });
      assert.equal(created.acquired, true);
      assert.notEqual(created.lease.ownerToken, 'server-instance-abc');
      assert.notEqual(created.ownerToken, 'server-instance-abc');

      const held = acquireRecoveryOwnerLease({
        store,
        ownerId: 'worker-b',
        instanceToken: 'server-instance-abc',
        serverInstanceToken: 'server-instance-abc',
        now: T0 + 1,
        ttlMs: 60_000,
      });
      assert.equal(held.acquired, false);
      assert.equal(held.reason, 'owner_held');
      assert.equal(held.lease.ownerToken, created.lease.ownerToken);
      assert.notEqual(held.lease.ownerToken, 'server-instance-abc');

      // The instance token cannot pass the generation fence either.
      assert.deepEqual(
        checkRecoveryOwnerFence({
          store,
          ownerToken: 'server-instance-abc',
          generation: 1,
          now: T0 + 2,
        }),
        { ok: false, reason: 'stale_owner' }
      );
    });
  });
});

// ---------------------------------------------------------------------------
// durability + dataDir convenience
// ---------------------------------------------------------------------------

test('the lease survives closing and reopening the store on the same file', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    let token = '';
    {
      const store = openRecoveryStore({ dataDir: dir });
      try {
        const created = acquireRecoveryOwnerLease({
          store,
          ownerId: 'worker-a',
          ownerToken: 'tok-a',
          now: T0,
          ttlMs: 60_000,
        });
        token = created.lease.ownerToken;
        assert.equal(created.reason, 'created');
      } finally {
        closeRecoveryStore(store);
      }
    }

    const reopened = openRecoveryStore({ dataDir: dir });
    try {
      const view = getRecoveryOwnerLease({ store: reopened, now: T0 + 1_000, ttlMs: 60_000 });
      assert.equal(view.held, true);
      assert.equal(view.ownerToken, token);
      assert.equal(view.generation, 1);
      assert.equal(view.heartbeatAt, new Date(T0).toISOString());

      const renew = renewRecoveryOwnerLease({
        store: reopened,
        ownerToken: token,
        generation: 1,
        now: T0 + 2_000,
        ttlMs: 60_000,
      });
      assert.equal(renew.ok, true);
      assert.equal(renew.lease.generation, 1);
    } finally {
      closeRecoveryStore(reopened);
    }
  });
});

test('acquire/renew/get/fence/release also work with only a dataDir (own connection)', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    const created = acquireRecoveryOwnerLease({
      dataDir: dir,
      ownerId: 'data-dir-owner',
      ownerToken: 'tok-dir',
      now: T0,
      ttlMs: 60_000,
    });
    assert.equal(created.acquired, true);
    assert.equal(getRecoveryOwnerLease({ dataDir: dir, now: T0 }).ownerToken, 'tok-dir');
    assert.deepEqual(
      checkRecoveryOwnerFence({ dataDir: dir, ownerToken: 'tok-dir', generation: 1, now: T0 + 1 }),
      { ok: true }
    );
    assert.equal(
      releaseRecoveryOwnerLease({ dataDir: dir, ownerToken: 'tok-dir', generation: 1 }).released,
      true
    );
    assert.deepEqual(getRecoveryOwnerLease({ dataDir: dir, now: T0 + 2 }), { held: false });
  });
});

// ---------------------------------------------------------------------------
// two instances
// ---------------------------------------------------------------------------

test('two independent store connections: exactly one wins the takeover, generation rises by one', () => {
  const dir = tempDir();
  withTempDir(dir, () => {
    const seed = openRecoveryStore({ dataDir: dir });
    let one = null;
    let two = null;
    try {
      const seeded = acquireRecoveryOwnerLease({
        store: seed,
        ownerId: 'seed-owner',
        ownerToken: 'tok-seed',
        pid: DEAD_PID,
        pidStart: '',
        now: T0,
        ttlMs: 60_000,
      });
      assert.equal(seeded.generation, 1);

      one = openRecoveryStore({ dataDir: dir });
      two = openRecoveryStore({ dataDir: dir });
      const first = acquireRecoveryOwnerLease({
        store: one,
        ownerId: 'instance-one',
        ownerToken: 'tok-one',
        pid: process.pid,
        pidStart: OWNER_START,
        now: T0 + 1,
        ttlMs: 60_000,
      });
      const second = acquireRecoveryOwnerLease({
        store: two,
        ownerId: 'instance-two',
        ownerToken: 'tok-two',
        pid: process.pid,
        pidStart: OWNER_START,
        now: T0 + 2,
        ttlMs: 60_000,
      });
      const winners = [first, second].filter((result) => result.acquired);
      const losers = [first, second].filter((result) => !result.acquired);
      assert.equal(winners.length, 1, `exactly one winner: ${JSON.stringify([first, second])}`);
      assert.equal(losers.length, 1);
      assert.equal(losers[0].reason, 'owner_held');
      assert.equal(winners[0].generation, 2, 'generation rises exactly once');
    } finally {
      if (one) closeRecoveryStore(one);
      if (two) closeRecoveryStore(two);
      closeRecoveryStore(seed);
    }

    const finalStore = openRecoveryStore({ dataDir: dir });
    try {
      const view = getRecoveryOwnerLease({ store: finalStore, now: T0 + 3, ttlMs: 60_000 });
      assert.equal(view.held, true);
      assert.equal(view.generation, 2);
      assert.ok(['tok-one', 'tok-two'].includes(view.ownerToken));
    } finally {
      closeRecoveryStore(finalStore);
    }
  });
});

/**
 * Two real child processes open the same store, wait on the harness barrier and
 * then race a takeover of an already-dead lease. Exactly one must win.
 */
const ACQUIRE_RACE_SCRIPT = `
import fs from 'node:fs';
import { closeRecoveryStore, openRecoveryStore } from ${JSON.stringify(STORE_URL)};
import { acquireRecoveryOwnerLease } from ${JSON.stringify(LEASE_URL)};

const dataDir = process.env.RECOVERY_CRASH_DATA_DIR;
const go = process.env.RECOVERY_CRASH_BARRIER;
const token = process.env.RECOVERY_LEASE_TOKEN;
const store = openRecoveryStore({ dataDir });
process.stdout.write('READY\\n');
while (!fs.existsSync(go)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const result = acquireRecoveryOwnerLease({
  store,
  ownerId: 'child-' + token,
  ownerToken: token,
  pid: process.pid,
  now: Date.now(),
  ttlMs: 60000,
});
process.stdout.write('RESULT ' + JSON.stringify({
  acquired: result.acquired,
  reason: result.reason,
  generation: result.generation,
  ownerToken: result.lease ? result.lease.ownerToken : '',
  pidAlive: result.lease ? result.lease.pidAlive : false,
}) + '\\n');
// Keep the winner alive while the loser inspects the committed lease, so the
// loser observes a live owner instead of taking over an already-exited PID.
if (result.acquired) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}
closeRecoveryStore(store);
`;

test('two child processes race the takeover: exactly one wins and generation rises by one', async () => {
  const dir = createCrashDataDir();
  /** @type {object | null} */
  let barrier = null;
  try {
    const seed = openRecoveryStore({ dataDir: dir });
    try {
      const seeded = acquireRecoveryOwnerLease({
        store: seed,
        ownerId: 'seed-owner',
        ownerToken: 'tok-seed',
        pid: DEAD_PID,
        pidStart: '',
        now: T0,
        ttlMs: 60_000,
      });
      assert.equal(seeded.generation, 1);
    } finally {
      closeRecoveryStore(seed);
    }

    barrier = await spawnRecoveryBarrier({
      dataDir: dir,
      script: ACQUIRE_RACE_SCRIPT,
      count: 2,
      envForIndex: (index) => ({ RECOVERY_LEASE_TOKEN: index === 0 ? 'tok-child-0' : 'tok-child-1' }),
    });
    assert.equal(barrier.handles.length, 2);
    barrier.release();
    await barrier.waitForExit(20_000);

    const results = barrier.handles.map((handle) => {
      const match = handle.stdout().match(/RESULT (\{.*\})/);
      assert.ok(
        match,
        `child printed a RESULT line\n--- stdout ---\n${handle.stdout()}\n--- stderr ---\n${handle.stderr()}`
      );
      return JSON.parse(match[1]);
    });
    const winners = results.filter((result) => result.acquired);
    const losers = results.filter((result) => !result.acquired);
    assert.equal(winners.length, 1, `exactly one winner: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1, `exactly one owner_held: ${JSON.stringify(results)}`);
    assert.equal(losers[0].reason, 'owner_held');
    assert.equal(winners[0].generation, 2, 'generation rises exactly once across processes');
    assert.equal(winners[0].pidAlive, true);

    const finalStore = openRecoveryStore({ dataDir: dir });
    try {
      const view = getRecoveryOwnerLease({ store: finalStore, now: Date.now(), ttlMs: 60_000 });
      assert.equal(view.held, true);
      assert.equal(view.generation, 2);
      assert.equal(view.ownerToken, winners[0].ownerToken);
    } finally {
      closeRecoveryStore(finalStore);
    }
  } finally {
    if (barrier) await barrier.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
