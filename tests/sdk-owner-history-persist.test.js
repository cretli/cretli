import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Owner-side SDK history persistence.
 *
 * The multi-instance regression test only exercises the `!isRemoteStub` branch of
 * `applySequencedRemoteRoomEvent` on a synthetic room. This test drives the real
 * production owner path instead: `broadcastRoom` -> `pushRoomEvent` ->
 * `persistRoomEventFromPayload` in lib/sdk/cursor-agent-sdk-ws.ts. It then reads
 * the durable store and checks which payloads became history records.
 *
 * Paths are resolved at import time (lib/runtime-paths.js), so CRETLI_DATA_DIR
 * must point at a scratch directory before the production modules are imported.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-sdk-owner-history-'));
process.env.CRETLI_DATA_DIR = dataDir;

const CHAT_ID = 'chat-owner-history';
const SESSION_KEY = 'session-owner-history';
const EVENT_STREAM_ID = 'stream-owner-history';

try {
  const { broadcastRoom, flushPersistBuffer, resolveMutableSdkRoom, sdkRoomsForTests } = await import('../lib/sdk/cursor-agent-sdk-ws.ts');
  const { getChatHistoryPage } = await import('../lib/persist/chat-history-service.js');

  // A real owner room (not a remote stub) as built by ensureSdkRoom: it owns the
  // lease, sequences its own events and is the only writer of its history.
  const room = {
    clients: new Set(),
    agent: null,
    cwd: dataDir,
    modelId: 'auto',
    modelSelection: 'auto',
    apiKey: 'test-key',
    sdkMode: 'agent',
    busy: false,
    currentRun: null,
    pendingPrompts: [],
    eventStreamId: EVENT_STREAM_ID,
    eventSeq: 0,
    eventLog: [],
    sessionKey: SESSION_KEY,
    chatId: CHAT_ID,
    chatTitle: 'Owner history test',
    onRunFinished: null,
    _persistBuf: [],
    _persistTimer: null,
  };

  // --- Transient payloads are sequenced but must not create history records.
  for (const payload of [
    { type: 'hello' },
    { type: 'sdkPromptStarted' },
    { type: 'sdkBusy', busy: true },
    { type: 'sdkQueued', text: 'queued while busy' },
  ]) {
    broadcastRoom(room, payload);
  }
  const transientFlush = await flushPersistBuffer(room);
  assert.equal(transientFlush.ok, true, 'flushing transient-only payloads succeeds');
  assert.equal(transientFlush.pending, 0);
  assert.equal(room.eventSeq, 4, 'every broadcast payload gets a room event sequence');
  assert.equal(room.eventLog.length, 4, 'broadcastRoom keeps the replay log');
  assert.equal(
    (await getChatHistoryPage(CHAT_ID, { limit: 50 })).events.length,
    0,
    'hello/sdkPromptStarted/sdkBusy/sdkQueued are not persisted'
  );

  // --- Persisted payloads: an SDK event plus two meta rows (mode/error ask for an immediate flush).
  broadcastRoom(room, { type: 'sdkEvent', event: { type: 'tool_call', callId: 'owner-call-1' } });
  broadcastRoom(room, { type: 'sdkMode', mode: 'agent' });
  broadcastRoom(room, { type: 'sdkError', code: 'owner_test_error', message: 'owner path error' });

  const flush = await flushPersistBuffer(room);
  assert.equal(flush.ok, true, 'owner history flush is acknowledged');
  assert.equal(flush.pending, 0);
  assert.equal(flush.deadLettered, 0);

  const page = await getChatHistoryPage(CHAT_ID, { limit: 50 });
  assert.equal(page.ok, true);
  assert.equal(page.headSeq, 3, 'exactly the three persistent payloads were stored');
  assert.equal(page.events.length, 3);
  assert.deepEqual(
    page.events.map((event) => event.seq),
    [1, 2, 3]
  );

  const [sdkRow, modeRow, errorRow] = page.events.map((event) => event.rec);

  assert.equal(sdkRow.kind, 'sdk');
  assert.deepEqual(sdkRow.event, { type: 'tool_call', callId: 'owner-call-1' });
  assert.equal(sdkRow.eventStreamId, EVENT_STREAM_ID, 'the record keeps the owner event stream');
  assert.equal(sdkRow.roomEventSeq, 5, 'the record keeps the room event sequence (after four transient payloads)');

  assert.equal(modeRow.kind, 'meta');
  assert.equal(modeRow.variant, 'mode');
  assert.equal(modeRow.payload, 'agent');
  assert.equal(modeRow.eventStreamId, EVENT_STREAM_ID);
  assert.equal(modeRow.roomEventSeq, 6);

  assert.equal(errorRow.kind, 'meta');
  assert.equal(errorRow.variant, 'error');
  assert.equal(errorRow.payload, 'owner path error');
  assert.equal(errorRow.eventStreamId, EVENT_STREAM_ID);
  assert.equal(errorRow.roomEventSeq, 7);

  // --- Lease expiry race: two connections hold the same remote stub and both
  // try to mutate after the owner lease is gone (registry lookup returns null).
  // Exactly one local room may result; the loser must adopt it.
  const { createSdkRemoteRoomStub, isSdkRemoteRoomStub } = await import('../lib/sdk/sdk-remote-room-stub.ts');
  const { initSdkRoomRegistry } = await import('../lib/sdk/sdk-room-registry.ts');
  initSdkRoomRegistry(null);
  const RACE_KEY = 'session-lease-race';
  const raceChat = { id: 'chat-lease-race', title: 'Lease race' };
  const raceDeps = { cwd: dataDir, modelId: 'auto', modelSelection: 'auto', apiKey: 'k', sdkMode: 'agent' };
  const stub = createSdkRemoteRoomStub(
    RACE_KEY,
    raceChat,
    { instanceId: 'node-gone', eventStreamId: 'stream-race', eventSeq: 3, busy: false },
    raceDeps
  );
  sdkRoomsForTests.set(RACE_KEY, stub);
  const results = await Promise.all([
    resolveMutableSdkRoom(RACE_KEY, raceChat, stub, raceDeps, () => assert.fail('no live owner')),
    resolveMutableSdkRoom(RACE_KEY, raceChat, stub, raceDeps, () => assert.fail('no live owner')),
  ]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(results.filter((r) => r.upgraded).length, 1, 'exactly one connection creates the local room');
  assert.equal(results[0].room, results[1].room, 'both connections share one local room');
  assert.equal(sdkRoomsForTests.get(RACE_KEY), results[0].room);
  assert.equal(isSdkRemoteRoomStub(results[0].room), false);
  sdkRoomsForTests.delete(RACE_KEY);

  console.log('All SDK owner history persist tests passed.');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CRETLI_DATA_DIR;
}
