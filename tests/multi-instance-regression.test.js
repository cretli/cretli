import assert from 'node:assert/strict';
import {
  buildSdkRoomOwnerMeta,
  getSdkRoomRegistryMode,
  initSdkRoomRegistry,
  isLocalSdkRoomOwner,
  lookupSdkRoomOwner,
  refreshSdkRoomOwner,
  registerSdkRoomOwner,
  resolveSdkRoomOwnerTtlSec,
  unregisterSdkRoomOwner,
} from '../lib/sdk/sdk-room-registry.ts';
import { resetServerInstanceIdForTests } from '../lib/sdk/sdk-instance-id.ts';
import {
  applySequencedRemoteRoomEvent,
  createSdkRemoteRoomStub,
  isSdkRemoteRoomStub,
} from '../lib/sdk/sdk-remote-room-stub.ts';

/**
 * Regression set for the semantics documented in docs/MULTI-INSTANCE.md:
 * the owner instance holds the room lease and writes history, a non-owner is a
 * read-only stub, and failover happens only after the lease TTL expires.
 * Uses an in-memory Redis double with a virtual clock; no network, no real Redis.
 */

let nowMs = 1_000_000;
const originalDateNow = Date.now;
Date.now = () => nowMs;

/** Minimal Redis KV double: get / set(EX, NX) / del with TTL on the virtual clock. */
function createFakeRedis() {
  const store = new Map();
  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= nowMs) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  return {
    isOpen: true,
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, options = {}) {
      if (options.NX && live(key)) return null;
      const expiresAt = Number.isFinite(options.EX) ? nowMs + options.EX * 1000 : null;
      store.set(key, { value, expiresAt });
      return 'OK';
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
}

/** Switches the process-wide server instance id (the registry reads it lazily). */
function actAs(instanceId) {
  resetServerInstanceIdForTests();
  process.env.CRETLI_INSTANCE_ID = instanceId;
}

const SESSION = 'session-multi-instance';

try {
  delete process.env.CURSOR_REMOTE_SDK_ROOM_OWNER_TTL_SEC;
  delete process.env.CRETLI_SDK_ROOM_OWNER_TTL_SEC;

  // --- Limits: default lease TTL and the 30 s floor must not regress.
  assert.equal(resolveSdkRoomOwnerTtlSec(), 120);
  process.env.CRETLI_SDK_ROOM_OWNER_TTL_SEC = '29';
  assert.equal(resolveSdkRoomOwnerTtlSec(), 120, 'TTL below the 30 s floor falls back to the default');
  process.env.CRETLI_SDK_ROOM_OWNER_TTL_SEC = '30';
  assert.equal(resolveSdkRoomOwnerTtlSec(), 30);
  process.env.CRETLI_SDK_ROOM_OWNER_TTL_SEC = '90.9';
  assert.equal(resolveSdkRoomOwnerTtlSec(), 90);
  delete process.env.CRETLI_SDK_ROOM_OWNER_TTL_SEC;

  // --- Single instance (no Redis): everyone is the owner, nothing is registered.
  initSdkRoomRegistry(null);
  assert.equal(getSdkRoomRegistryMode(), 'local');
  actAs('node-a');
  assert.equal(await registerSdkRoomOwner(SESSION), true);
  assert.equal(await isLocalSdkRoomOwner(SESSION), true);
  assert.equal(await lookupSdkRoomOwner(SESSION), null);

  // --- Two instances sharing one registry.
  const redis = createFakeRedis();
  initSdkRoomRegistry(redis);
  assert.equal(getSdkRoomRegistryMode(), 'redis');

  actAs('node-a');
  const room = { eventStreamId: 'stream-a', eventSeq: 7, busy: true };
  assert.equal(await registerSdkRoomOwner(SESSION, buildSdkRoomOwnerMeta(room)), true);
  const ownerRecord = await lookupSdkRoomOwner(SESSION);
  assert.equal(ownerRecord?.instanceId, 'node-a');
  assert.equal(ownerRecord?.eventSeq, 7);
  assert.equal(await isLocalSdkRoomOwner(SESSION), true);

  // Non-owner cannot register, refresh or unregister the owner's lease.
  actAs('node-b');
  assert.equal(await registerSdkRoomOwner(SESSION, {}), false, 'second instance must not steal a live lease');
  assert.equal(await refreshSdkRoomOwner(SESSION, {}), false, 'non-owner refresh is rejected');
  assert.equal(await isLocalSdkRoomOwner(SESSION), false);
  await unregisterSdkRoomOwner(SESSION);
  assert.equal((await lookupSdkRoomOwner(SESSION))?.instanceId, 'node-a', 'non-owner unregister is a no-op');

  // Owner refresh extends the lease: just before the original expiry, then well after.
  actAs('node-a');
  nowMs += 100_000;
  assert.equal(await refreshSdkRoomOwner(SESSION, buildSdkRoomOwnerMeta({ ...room, eventSeq: 9 })), true);
  nowMs += 100_000;
  assert.equal((await lookupSdkRoomOwner(SESSION))?.instanceId, 'node-a', 'refreshed lease is still live');
  assert.equal((await lookupSdkRoomOwner(SESSION))?.eventSeq, 9);

  // Failover: owner stops refreshing; only after the TTL does another instance claim the room.
  actAs('node-b');
  nowMs += 19_000; // 119 s since the last refresh (TTL 120 s)
  assert.equal(await registerSdkRoomOwner(SESSION, {}), false, 'lease not yet expired');
  nowMs += 2_000;
  assert.equal(await lookupSdkRoomOwner(SESSION), null, 'lease expired by TTL');
  assert.equal(await registerSdkRoomOwner(SESSION, buildSdkRoomOwnerMeta({ eventSeq: 9 })), true);
  assert.equal(await isLocalSdkRoomOwner(SESSION), true);
  actAs('node-a');
  assert.equal(await isLocalSdkRoomOwner(SESSION), false, 'the former owner is now a non-owner');

  // Clean owner shutdown releases the lease immediately (no TTL wait).
  actAs('node-b');
  await unregisterSdkRoomOwner(SESSION);
  assert.equal(await lookupSdkRoomOwner(SESSION), null);

  // --- Stub semantics: read-only mirror that never persists history.
  const broadcasts = [];
  const handlers = {
    roomEventLogMax: 3,
    broadcast: (_room, payload) => broadcasts.push(payload.roomEventSeq),
  };
  const stub = createSdkRemoteRoomStub(
    SESSION,
    { id: 'chat-1', title: 'T' },
    { instanceId: 'node-a', eventStreamId: 'stream-a', eventSeq: 1, busy: false },
    { cwd: '/tmp/ws', modelId: 'auto', modelSelection: 'auto', apiKey: 'k', sdkMode: 'agent' }
  );
  assert.equal(isSdkRemoteRoomStub(stub), true);
  assert.equal(stub.agent, null, 'stub must not hold an Agent');
  assert.equal(
    typeof stub.startPrompt,
    'undefined',
    'stub has no prompt runner: this only checks that startPrompt is absent, not the remote_room_stub send path'
  );
  assert.equal(stub.ownerInstanceId, 'node-a');

  for (let seq = 2; seq <= 6; seq += 1) {
    assert.equal(applySequencedRemoteRoomEvent(stub, { type: 'sdkEvent', roomEventSeq: seq }, handlers), true);
  }
  assert.deepEqual(broadcasts, [2, 3, 4, 5, 6], 'a stub relays every sequenced event to its clients');
  assert.equal(stub.eventLog.length, 3, 'replay log keeps the configured cap');
  assert.equal(applySequencedRemoteRoomEvent(stub, { type: 'sdkEvent', roomEventSeq: 4 }, handlers), false, 'stale seq is ignored');
  assert.equal(applySequencedRemoteRoomEvent(stub, { type: 'sdkEvent', roomEventSeq: 0 }, handlers), false);

  console.log('All multi-instance regression tests passed.');
} finally {
  Date.now = originalDateNow;
  delete process.env.CRETLI_INSTANCE_ID;
  resetServerInstanceIdForTests();
  initSdkRoomRegistry(null);
}
