/**
 * Leaf R6: the chat-run adapter CONTRACT for kernel-backed transports — durable
 * probe/lookup by requestId, the reattach/resume capability surface, an explicit
 * `unsupported` for transports outside the recovery MVP set, and the explicit
 * transcript-loss signal.
 *
 * The neighbouring suites cover one half each: `recovery-*` is store/contract
 * only, `chat-run-accept` is runtime only. This file joins them, because the gap
 * R6 closes is precisely that a kernel adapter read the in-memory rooms Map and
 * could not answer "which run did this requestId get?" after a restart.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { addChat } from '../lib/persist/chats-persist.js';
import {
  acceptRoomPrompt,
  createDurableRequestLookup,
  registerKernelChatRunAdapter,
} from '../lib/chat-run/kernel-adapter.js';
import {
  getChatRunAdapter,
  getChatRunAdapterCapabilities,
  lookupChatRunRequest,
  probeChatRunLiveness,
  startChatRun,
  unregisterChatRunAdapter,
} from '../lib/chat-run-service.js';
import { closeRecoveryStore, openRecoveryStore } from '../lib/recovery/recovery-store.js';
import { createRecoveryIds } from '../lib/recovery/recovery-ids.js';
import {
  beginRunLaunch,
  markAcceptanceUnconfirmed,
  recordExecutorAck,
} from '../lib/recovery/recovery-lifecycle.js';
import {
  RECOVERY_DEFERRED_ADAPTERS,
  RECOVERY_MVP_ADAPTERS,
  RUN_TRANSCRIPT_LOSS_REASONS,
  describeRecoveryAdapterContract,
  normalizeRunTranscriptLossReason,
} from '../lib/recovery/recovery-contract.js';

/** Transports this suite may register, so each test can undo its own registration. */
const REGISTERABLE_TRANSPORTS = ['codex', 'claude', 'qwen', 'deepseek', 'codebuddy', 'opencode'];

/**
 * @returns {string}
 */
function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'kernel-chat-run-'));
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
    for (const transport of REGISTERABLE_TRANSPORTS) unregisterChatRunAdapter(transport);
  }
}

/**
 * Record a durable run row keyed by `requestId`. Acceptance only exists when an
 * executor ack was written, which is the whole point of the lookup below.
 *
 * @param {object} store
 * @param {{ requestId?: string, adapterRunId?: string, accepted?: boolean, chatId?: string, harness?: string }} [input]
 * @returns {{ logicalRunId: string, attemptId: string, requestId: string }}
 */
function seedRun(store, input = {}) {
  const launch = beginRunLaunch({
    family: 'chat',
    owner: 'chat-run-service',
    requestId: input.requestId,
    chatId: input.chatId || '',
    harness: input.harness || 'codex',
  }, store);
  const ids = launch.ids;
  if (input.accepted === false) {
    markAcceptanceUnconfirmed({
      logicalRunId: ids.logicalRunId,
      expectedRevision: launch.run.revision,
      reasonToken: 'launch_without_ack',
    }, store);
  } else {
    recordExecutorAck({
      logicalRunId: ids.logicalRunId,
      expectedRevision: launch.run.revision,
      source: 'adapter_ack',
      adapterRunId: input.adapterRunId || '',
    }, store);
  }
  return ids;
}

/**
 * @param {{ sessionKey?: string, busy?: boolean }} [options]
 * @returns {{ room: object, calls: { startPrompt: number } }}
 */
function makeRoom(options = {}) {
  const calls = { startPrompt: 0 };
  const room = {
    sessionKey: options.sessionKey || 'sess-kernel',
    busy: options.busy === true,
    currentRun: null,
    startPrompt(prompt, mode) {
      calls.startPrompt += 1;
      this.busy = true;
      this.prompt = prompt;
      this.mode = mode;
      this.currentRun = { id: 'run-live-1' };
    },
  };
  return { room, calls };
}

test('a kernel adapter answers a requestId from the durable store, not the rooms Map', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = seedRun(store, { adapterRunId: 'run-durable-1' });
      // The process restarted: no room is left for any session key.
      const rooms = new Map();
      registerKernelChatRunAdapter({
        transport: 'codex',
        rooms,
        ensureRoom: async () => {
          throw new Error('lookup must not touch the room kernel');
        },
        recoveryStore: store,
      });
      const found = getChatRunAdapter('codex').lookupRequest({
        chat: { cursorSessionId: 'sess-gone' },
        requestId: ids.requestId,
      });
      assert.equal(found.accepted, true);
      assert.equal(found.runId, 'run-durable-1');
      assert.equal(found.logicalRunId, ids.logicalRunId);
      assert.equal(found.attemptId, ids.attemptId);
      assert.equal(found.acceptanceState, 'accepted');
      assert.equal(found.unsupported, false);
      // Clause 5: the durable row is found, the transcript that lived in the
      // room is not -> the loss is surfaced, never pretended away.
      assert.equal(found.transcriptLost, true);
      assert.equal(found.transcriptLossReason, 'room_missing');
      t.diagnostic(`durable lookup answered ${found.runId} for ${ids.requestId}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the durable lookup never invents acceptance and answers unknown ids as null', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const acceptedIds = seedRun(store, { adapterRunId: 'run-a' });
      const unconfirmedIds = seedRun(store, { accepted: false });
      const rooms = new Map();
      registerKernelChatRunAdapter({
        transport: 'qwen',
        rooms,
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        recoveryStore: store,
      });
      const lookup = getChatRunAdapter('qwen').lookupRequest;

      assert.equal(lookup({ chat: {}, requestId: '' }), null);
      assert.equal(lookup({ chat: {}, requestId: '   ' }), null);
      assert.equal(lookup({ chat: {}, requestId: createRecoveryIds().requestId }), null);

      // A row without an executor ack is `accepted:false` with no run id: the
      // contract refuses to claim a run started without durable proof.
      const unconfirmed = lookup({ chat: {}, requestId: unconfirmedIds.requestId });
      assert.equal(unconfirmed.accepted, false);
      assert.equal(unconfirmed.runId, '');
      assert.equal(unconfirmed.acceptanceState, 'unconfirmed');
      assert.equal(unconfirmed.state, 'starting');

      const accepted = lookup({ chat: {}, requestId: acceptedIds.requestId });
      assert.equal(accepted.accepted, true);
      assert.equal(accepted.runId, 'run-a');
      t.diagnostic(`unconfirmed row answered accepted:${unconfirmed.accepted}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unopenable store answers null instead of pretending the run ended', (t) => {
  const dir = tempDir();
  const store = openRecoveryStore({ dataDir: dir });
  const ids = seedRun(store, { adapterRunId: 'run-x' });
  closeRecoveryStore(store);
  rmSync(dir, { recursive: true, force: true });
  // Same store object, now closed: the lookup must degrade to "unknown".
  const lookup = createDurableRequestLookup({ transport: 'codex', rooms: new Map(), recoveryStore: store });
  assert.equal(lookup({ chat: {}, requestId: ids.requestId }), null);
  t.diagnostic('closed store -> null (no invented terminal state)');
});

test('canLookupRequest is reported for a kernel transport and probe stays honest', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = seedRun(store, { adapterRunId: 'run-probe', chatId: 'chat-probe' });
      const chat = addChat('sess-probe', 'Probe chat', null, '/tmp', 'm', {
        agentTransport: 'codex',
        sdkMode: 'agent',
      });
      registerKernelChatRunAdapter({
        transport: 'codex',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat }),
        recoveryStore: store,
      });

      const caps = getChatRunAdapterCapabilities('codex');
      assert.equal(caps.canLookupRequest, true);
      assert.equal(caps.recoverySupported, true);
      assert.equal(caps.recoveryScope, 'mvp');
      assert.equal(caps.resumeStrategy, 'resume_thread');
      assert.equal(caps.canResumeSession, true);
      // Only opencode is reattach-capable in the MVP table.
      assert.equal(caps.canReattach, false);
      assert.equal(caps.requiresCrashValidation, true);
      assert.equal(caps.recoveryValidation, 'pending');

      // The service-level probe the watcher/mailbox use now resolves durably.
      const found = lookupChatRunRequest({ chatId: chat.id, requestId: ids.requestId });
      assert.equal(found.accepted, true);
      assert.equal(found.runId, 'run-probe');

      // Clause 2: a durable-but-dead run is NOT alive and NOT proof it ended.
      const live = probeChatRunLiveness({ chatId: chat.id, runId: 'run-probe' });
      assert.equal(live.known, false);
      assert.equal(live.busy, false);
      assert.equal(live.reason, 'state_missing');
      t.diagnostic(`probe answered ${live.reason} for a durable accepted run`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start threads requestId into the room and a durable accept replays without a new start', async (t) => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    try {
      const chat = addChat('sess-thread', 'Thread chat', null, '/tmp', 'm', {
        agentTransport: 'codex',
        sdkMode: 'agent',
      });
      const rooms = new Map();
      const { room, calls } = makeRoom();
      rooms.set('sess-thread', room);
      let ensureRoomCalls = 0;
      registerKernelChatRunAdapter({
        transport: 'codex',
        rooms,
        ensureRoom: async () => {
          ensureRoomCalls += 1;
          return { room, chat };
        },
        waitingForInput: () => false,
        recoveryStore: store,
      });

      // 1d: the accept path carries the requestId into the room's run, so the
      // run this accept started can be bound to a durable row keyed by it.
      const firstRequestId = createRecoveryIds().requestId;
      const first = await startChatRun({
        chatId: chat.id,
        prompt: 'hello',
        mode: 'agent',
        requestId: firstRequestId,
      });
      assert.equal(first.accepted, true);
      assert.equal(first.runId, 'run-live-1');
      assert.equal(room.currentRun.requestId, firstRequestId);
      assert.equal(calls.startPrompt, 1);

      const accepted = acceptRoomPrompt(
        makeRoom().room,
        { prompt: 'p', mode: 'agent', displayText: 'd' },
        () => false
      );
      assert.equal(accepted.accepted, true);
      assert.equal(accepted.runId, 'run-live-1');
      assert.equal(accepted.requestId, '');

      // 1b through the service: a requestId the store already accepted must
      // replay its runId instead of launching another attempt.
      const ids = seedRun(store, { adapterRunId: 'run-durable-2', chatId: chat.id });
      const replay = await startChatRun({
        chatId: chat.id,
        prompt: 'must not be sent',
        mode: 'agent',
        requestId: ids.requestId,
      });
      assert.equal(replay.accepted, true);
      assert.equal(replay.runId, 'run-durable-2');
      assert.equal(ensureRoomCalls, 1);
      assert.equal(calls.startPrompt, 1);
      t.diagnostic('second start replayed the durable run without touching the room');
    } finally {
      closeRecoveryStore(store);
      for (const transport of REGISTERABLE_TRANSPORTS) unregisterChatRunAdapter(transport);
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    t.diagnostic(`start threading failed: ${err?.message || err}`);
    throw err;
  }
});

test('a transport outside the MVP set is an explicit unsupported, never a finished run', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = seedRun(store, { adapterRunId: 'run-cb', harness: 'codebuddy' });
      const rooms = new Map();
      registerKernelChatRunAdapter({
        transport: 'codebuddy',
        rooms,
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        recoveryStore: store,
      });

      const marker = getChatRunAdapter('codebuddy').lookupRequest({
        chat: {},
        requestId: ids.requestId,
      });
      // `accepted:null` — the adapter has nothing to say. `false` would read as
      // "no acceptance proof", and either way this is not proof of an outcome.
      assert.equal(marker.accepted, null);
      assert.equal(marker.unsupported, true);
      assert.equal(marker.decision, 'unsupported');
      assert.equal(marker.infraOutcome, 'unsupported');
      assert.equal(marker.recoveryScope, 'unsupported');
      assert.equal(marker.transcriptLost, true);
      assert.equal(marker.transcriptLossReason, 'no_recovery_contract');
      assert.ok(marker.rationale, 'unsupported carries the contract rationale');

      const caps = getChatRunAdapterCapabilities('codebuddy');
      assert.equal(caps.recoverySupported, false);
      assert.equal(caps.recoveryScope, 'unsupported');
      assert.equal(caps.recoveryDecision, 'unsupported');
      assert.equal(caps.recoveryInfraOutcome, 'unsupported');
      assert.equal(caps.canReattach, false);
      assert.equal(caps.canResumeSession, false);
      assert.equal(caps.resumeStrategy, '');
      // The lookup capability is now declared for every kernel transport, so the
      // answer is explicit even where the recovery contract is not.
      assert.equal(caps.canLookupRequest, true);

      // An unknown transport is unsupported the same way (deferred or not).
      const unknownCaps = getChatRunAdapterCapabilities('nosuchtransport');
      assert.equal(unknownCaps.recoveryDecision, 'unsupported');
      assert.equal(unknownCaps.recoveryInfraOutcome, 'unsupported');
      assert.equal(unknownCaps.transcriptLossReason, 'no_recovery_contract');
      t.diagnostic('codebuddy lookup answered explicit unsupported');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reattach/resume capability is the contract narrowed by the room, not a second table', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      // opencode is the only MVP row with reattach:true; a room may still deny
      // it, and a kernel room may never claim more than the table grants.
      registerKernelChatRunAdapter({
        transport: 'opencode',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        reattachCapability: false,
        recoveryStore: store,
      });
      const narrowed = getChatRunAdapterCapabilities('opencode');
      assert.equal(narrowed.canReattach, false);
      assert.equal(narrowed.transcriptLost, true);
      assert.notEqual(narrowed.transcriptLossReason, 'none');
      assert.equal(narrowed.resumeStrategy, '');

      unregisterChatRunAdapter('opencode');
      registerKernelChatRunAdapter({
        transport: 'opencode',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        reattachCapability: true,
        recoveryStore: store,
      });
      const reattachCaps = getChatRunAdapterCapabilities('opencode');
      assert.equal(reattachCaps.canReattach, true);
      assert.equal(reattachCaps.resumeStrategy, 'server_reattach');
      assert.equal(reattachCaps.transcriptLost, false);
      assert.equal(reattachCaps.transcriptLossReason, 'none');

      // A room claim cannot outgrow the table: codex has resume, no reattach.
      registerKernelChatRunAdapter({
        transport: 'codex',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        reattachCapability: true,
        recoveryStore: store,
      });
      const codexCaps = getChatRunAdapterCapabilities('codex');
      assert.equal(codexCaps.canReattach, false);
      assert.equal(codexCaps.canResumeSession, true);
      assert.equal(codexCaps.resumeStrategy, 'resume_thread');
      // Clause 5 on the capability surface: a resume here is a fresh turn in the
      // saved session id, so the prior transcript is declared lost.
      assert.equal(codexCaps.transcriptLost, true);
      assert.equal(codexCaps.transcriptLossReason, 'fresh_turn_in_saved_session');
      t.diagnostic('reattach capability narrowed by the contract');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every MVP kernel transport reports the contract, not its own table', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      registerKernelChatRunAdapter({
        transport: 'qwen',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        recoveryStore: store,
      });
      const qwen = getChatRunAdapterCapabilities('qwen');
      assert.equal(qwen.canLookupRequest, true);
      // A kernel room that never claims reattach cannot get it from the table.
      assert.equal(qwen.canReattach, false);
      assert.equal(qwen.canResumeSession, true);
      assert.equal(qwen.resumeStrategy, 'session_resume');
      assert.equal(qwen.recoverySupported, true);
      assert.equal(qwen.recoveryDecision, '');
      assert.equal(qwen.transcriptLost, true);
      assert.equal(qwen.transcriptLossReason, 'fresh_turn_in_saved_session');

      // deepseek is the other resume-MVP row; the strategy comes from the table.
      registerKernelChatRunAdapter({
        transport: 'deepseek',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        recoveryStore: store,
      });
      const deepseek = getChatRunAdapterCapabilities('deepseek');
      assert.equal(deepseek.resumeStrategy, 'session_id');
      assert.equal(deepseek.canReattach, false);
      assert.equal(deepseek.requiresCrashValidation, true);
      assert.equal(deepseek.recoveryValidation, 'pending');
      t.diagnostic(`qwen resume strategy ${qwen.resumeStrategy} / deepseek ${deepseek.resumeStrategy}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a durable accept without an adapter run id replays instead of starting twice', async (t) => {
  const dir = tempDir();
  try {
    const store = openRecoveryStore({ dataDir: dir });
    try {
      const chat = addChat('sess-no-runid', 'No run id chat', null, '/tmp', 'm', {
        agentTransport: 'codex',
        sdkMode: 'agent',
      });
      // `recordExecutorAck` accepts an empty adapterRunId: acceptance is proven,
      // the executor's own run id is not. That must not read as "never started".
      const ids = seedRun(store, {});
      const rooms = new Map();
      const { room, calls } = makeRoom();
      rooms.set('sess-no-runid', room);
      registerKernelChatRunAdapter({
        transport: 'codex',
        rooms,
        ensureRoom: async () => ({ room, chat }),
        waitingForInput: () => false,
        recoveryStore: store,
      });

      const found = getChatRunAdapter('codex').lookupRequest({
        chat: { cursorSessionId: 'sess-no-runid' },
        requestId: ids.requestId,
      });
      assert.equal(found.accepted, true);
      assert.equal(found.acceptanceState, 'accepted');
      assert.equal(found.runId, '');

      // The room is idle, so a guard that demands a non-empty runId falls
      // through to `adapter.start` and sends the prompt a second time.
      const replay = await startChatRun({
        chatId: chat.id,
        prompt: 'must not be sent again',
        mode: 'agent',
        requestId: ids.requestId,
      });
      assert.equal(replay.accepted, true);
      assert.equal(replay.runId, '');
      assert.equal(calls.startPrompt, 0);
      assert.equal(room.busy, false);
      t.diagnostic('proven accept replayed with no second prompt despite a missing adapterRunId');
    } finally {
      closeRecoveryStore(store);
      for (const transport of REGISTERABLE_TRANSPORTS) unregisterChatRunAdapter(transport);
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    t.diagnostic(`replay without an adapter run id failed: ${err?.message || err}`);
    throw err;
  }
});

test('opencode transcript none only when the room holds the durable run id', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = seedRun(store, { adapterRunId: 'run-live-ctx', harness: 'opencode' });
      const rooms = new Map();
      const lookup = createDurableRequestLookup({
        transport: 'opencode',
        rooms,
        recoveryStore: store,
        reattachCapability: true,
      });
      const chat = { cursorSessionId: 'sess-reattach' };
      const noRoom = lookup({ chat, requestId: ids.requestId });
      assert.equal(noRoom.transcriptLost, true);
      assert.equal(noRoom.transcriptLossReason, 'room_missing');
      const { room } = makeRoom();
      rooms.set('sess-reattach', room);
      const noCurrentRun = lookup({ chat, requestId: ids.requestId });
      assert.equal(noCurrentRun.transcriptLost, true);
      assert.equal(noCurrentRun.transcriptLossReason, 'no_live_run_match');
      room.currentRun = { id: 'wrong-run' };
      const mismatched = lookup({ chat, requestId: ids.requestId });
      assert.equal(mismatched.transcriptLost, true);
      assert.equal(mismatched.transcriptLossReason, 'no_live_run_match');
      room.currentRun = { id: 'run-live-ctx' };
      const matched = lookup({ chat, requestId: ids.requestId });
      assert.equal(matched.transcriptLost, false);
      assert.equal(matched.transcriptLossReason, 'none');
      t.diagnostic('clause 5: none only on live run match');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcript loss is explicit when the room is gone and not when it survives', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = seedRun(store, { adapterRunId: 'run-ctx' });
      const rooms = new Map();
      const { room } = makeRoom();
      registerKernelChatRunAdapter({
        transport: 'codex',
        rooms,
        ensureRoom: async () => ({ room, chat: {} }),
        recoveryStore: store,
      });
      const lookup = getChatRunAdapter('codex').lookupRequest;

      const gone = lookup({ chat: { cursorSessionId: 'sess-missing' }, requestId: ids.requestId });
      assert.equal(gone.accepted, true);
      assert.equal(gone.transcriptLost, true);
      assert.equal(gone.transcriptLossReason, 'room_missing');

      rooms.set('sess-here', room);
      const held = lookup({ chat: { cursorSessionId: 'sess-here' }, requestId: ids.requestId });
      assert.equal(held.accepted, true);
      // The room is alive, so nothing was lost by a restart; the contract still
      // says a resume of this transport starts a fresh turn in the saved session.
      assert.equal(held.transcriptLost, true);
      assert.equal(held.transcriptLossReason, 'fresh_turn_in_saved_session');

      const reattachLookup = createDurableRequestLookup({
        transport: 'opencode',
        rooms,
        recoveryStore: store,
        reattachCapability: true,
      });
      const emptyRoom = reattachLookup({ chat: { cursorSessionId: 'sess-here' }, requestId: ids.requestId });
      assert.equal(emptyRoom.transcriptLost, true);
      assert.equal(emptyRoom.transcriptLossReason, 'no_live_run_match');
      room.currentRun = { id: 'run-ctx' };
      const kept = reattachLookup({ chat: { cursorSessionId: 'sess-here' }, requestId: ids.requestId });
      assert.equal(kept.transcriptLost, false);
      assert.equal(kept.transcriptLossReason, 'none');
      room.currentRun = { id: 'other-run' };
      const mismatched = reattachLookup({ chat: { cursorSessionId: 'sess-here' }, requestId: ids.requestId });
      assert.equal(mismatched.transcriptLost, true);
      assert.equal(mismatched.transcriptLossReason, 'no_live_run_match');
      const lostAfterRestart = reattachLookup({
        chat: { cursorSessionId: 'sess-missing' },
        requestId: ids.requestId,
      });
      assert.equal(lostAfterRestart.transcriptLost, true);
      assert.equal(lostAfterRestart.transcriptLossReason, 'room_missing');
      t.diagnostic('transcript loss surfaced per observed room state');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R6 round-3 regressions: N1 (producer output must be a registered token) and
// N2 (the reattach observation must not depend on an omitted caller flag).
// ---------------------------------------------------------------------------

test('every transcript-loss reason the kernel lookup emits is a registered contract token', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const observed = new Set();
      // Enumerate the transports from the contract itself so the guard cannot
      // drift when a harness is added or removed.
      const transports = [
        ...Object.keys(RECOVERY_MVP_ADAPTERS),
        ...RECOVERY_DEFERRED_ADAPTERS,
      ];
      const roomStates = [
        null, // the room is gone
        { currentRun: null }, // the room survives without a run
        { currentRun: { id: 'run-foreign' } }, // the room holds another run
        { currentRun: { id: 'run-vocab' } }, // the room holds the durable run
      ];
      for (const transport of transports) {
        const ids = seedRun(store, { adapterRunId: 'run-vocab', harness: transport });
        for (const reattachCapability of [undefined, true, false]) {
          const rooms = new Map();
          const lookup = createDurableRequestLookup({
            transport,
            rooms,
            recoveryStore: store,
            reattachCapability,
          });
          for (const room of roomStates) {
            rooms.clear();
            if (room) rooms.set('sess-vocab', room);
            const found = lookup({
              chat: { cursorSessionId: 'sess-vocab' },
              requestId: ids.requestId,
            });
            if (found && typeof found.transcriptLossReason === 'string') {
              observed.add(found.transcriptLossReason);
            }
          }
        }
      }
      // N1: a producer value outside the closed vocabulary would normalize to ''
      // here, which is exactly the silent "no information" the contract forbids.
      for (const reason of observed) {
        assert.equal(
          normalizeRunTranscriptLossReason(reason),
          reason,
          `producer emitted "${reason}", which is not a registered loss reason`,
        );
      }
      assert.ok(observed.has('room_missing'), 'a missing room reports room_missing');
      assert.ok(observed.has('no_live_run_match'), 'a foreign live run reports no_live_run_match');
      assert.ok(observed.has('fresh_turn_in_saved_session'), 'a non-reattach transport reports the fresh-turn token');
      assert.ok(observed.has('none'), 'a live match still reports none');
      t.diagnostic(`kernel lookup vocabulary: ${[...observed].sort().join(', ')}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode production lookup defaults reattach from the contract, not an omitted flag', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = seedRun(store, { adapterRunId: 'run-opencode-live', harness: 'opencode' });
      const rooms = new Map();
      // The exact call shape from lib/opencode/opencode-agent-ws.js:1865 — no
      // `reattachCapability`. opencode's contract grants reattach:true, so an
      // omitted flag must NOT silently disable the live observation.
      const lookup = createDurableRequestLookup({ transport: 'opencode', rooms, recoveryStore: store });
      const chat = { cursorSessionId: 'sess-prod-opencode' };

      const absent = lookup({ chat, requestId: ids.requestId });
      assert.equal(absent.transcriptLost, true);
      assert.equal(absent.transcriptLossReason, 'room_missing');

      const { room } = makeRoom();
      rooms.set('sess-prod-opencode', room);
      const noRun = lookup({ chat, requestId: ids.requestId });
      assert.equal(noRun.transcriptLost, true);
      assert.equal(noRun.transcriptLossReason, 'no_live_run_match');

      room.currentRun = { id: 'run-foreign' };
      const foreign = lookup({ chat, requestId: ids.requestId });
      assert.equal(foreign.transcriptLost, true);
      assert.ok(
        RUN_TRANSCRIPT_LOSS_REASONS.includes(foreign.transcriptLossReason),
        'a foreign run reports a registered loss token',
      );

      room.currentRun = { id: 'run-opencode-live' };
      const matched = lookup({ chat, requestId: ids.requestId });
      assert.equal(matched.transcriptLost, false);
      assert.equal(matched.transcriptLossReason, 'none');
      assert.equal(matched.resumeStrategy, 'server_reattach');
      t.diagnostic('opencode lookup: an omitted reattach flag still sees a live match');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lookup and the capability surface narrow identically for every MVP transport and declaration', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      // F1 structural guard: production kernel registrations pass their runtime
      // claims through `registerKernelChatRunAdapter`. The per-run lookup and
      // `getChatRunAdapterCapabilities` must give ONE answer for the same
      // transport under the default AND under every explicit-false declaration.
      const transports = ['claude', 'codex', 'qwen', 'deepseek', 'opencode'];
      const declarations = [undefined, true, false];
      for (const transport of transports) {
        const ids = seedRun(store, { adapterRunId: 'run-narrow', harness: transport });
        const contract = describeRecoveryAdapterContract(transport);
        for (const reattachCapability of declarations) {
          for (const canResumeSessionCapability of declarations) {
            unregisterChatRunAdapter(transport);
            registerKernelChatRunAdapter({
              transport,
              rooms: new Map(),
              ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
              recoveryStore: store,
              reattachCapability,
              canResumeSessionCapability,
            });
            const found = getChatRunAdapter(transport).lookupRequest({
              chat: { cursorSessionId: 'sess-narrow' },
              requestId: ids.requestId,
            });
            const caps = getChatRunAdapterCapabilities(transport);
            const label = `${transport} reattach=${reattachCapability} resume=${canResumeSessionCapability}`;
            assert.equal(
              found.resumeStrategy,
              caps.resumeStrategy,
              `${label}: lookup must not disagree with capabilities`,
            );
            if (canResumeSessionCapability === false) {
              assert.equal(caps.canResumeSession, false, `${label}: resume disclaimed on capabilities`);
              assert.equal(caps.resumeStrategy, '', `${label}: no strategy for a disclaimed resume`);
              assert.equal(
                found.resumeStrategy,
                '',
                `${label}: lookup must not hand out a disclaimed resume strategy`,
              );
            }
            if (reattachCapability === false && contract.resumeStrategy === 'server_reattach') {
              assert.equal(caps.canReattach, false, `${label}: reattach disclaimed on capabilities`);
              assert.equal(caps.resumeStrategy, '', `${label}: reattach-only strategy withheld`);
              assert.equal(
                found.resumeStrategy,
                '',
                `${label}: lookup must not hand out a reattach-only strategy`,
              );
            }
          }
        }
      }
      // The exact disagreement N2 introduced: codex capabilities said
      // 'resume_thread' while its per-run lookup answered ''.
      unregisterChatRunAdapter('codex');
      unregisterChatRunAdapter('opencode');
      registerKernelChatRunAdapter({
        transport: 'codex',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        recoveryStore: store,
      });
      registerKernelChatRunAdapter({
        transport: 'opencode',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        recoveryStore: store,
      });
      assert.equal(getChatRunAdapterCapabilities('codex').resumeStrategy, 'resume_thread');
      assert.equal(getChatRunAdapterCapabilities('opencode').resumeStrategy, 'server_reattach');
      t.diagnostic('lookup and capabilities agree for every MVP transport and declaration');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a runtime that disclaims resume narrows both the capability surface and the per-run lookup', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = seedRun(store, { adapterRunId: 'run-no-resume', harness: 'codex' });
      // codex has a resume strategy in the MVP table and no reattach, so an
      // explicit resume disclaimer is the only thing that must clear it.
      registerKernelChatRunAdapter({
        transport: 'codex',
        rooms: new Map(),
        ensureRoom: async () => ({ room: makeRoom().room, chat: {} }),
        recoveryStore: store,
        canResumeSessionCapability: false,
      });
      const caps = getChatRunAdapterCapabilities('codex');
      assert.equal(caps.canResumeSession, false);
      assert.equal(caps.resumeStrategy, '');
      const found = getChatRunAdapter('codex').lookupRequest({
        chat: { cursorSessionId: 'sess-no-resume' },
        requestId: ids.requestId,
      });
      assert.equal(
        found.resumeStrategy,
        '',
        'the per-run lookup must not hand out a strategy the runtime disowned',
      );
      t.diagnostic('disclaimed resume narrows capabilities and lookup to the same empty strategy');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opencode reattach denial narrows the lookup exactly like the capability surface', (t) => {
  const dir = tempDir();
  try {
    withStore(dir, (store) => {
      const ids = seedRun(store, { adapterRunId: 'run-oc-denied', harness: 'opencode' });
      const rooms = new Map();
      const { room } = makeRoom();
      rooms.set('sess-oc-denied', room);
      room.currentRun = { id: 'run-oc-denied' };
      // Declare the reattach claim ONCE (the register input), so both surfaces
      // must reflect the denial. The room even holds the durable run: a runtime
      // that disclaimed reattach must NOT report the transcript as preserved.
      registerKernelChatRunAdapter({
        transport: 'opencode',
        rooms,
        ensureRoom: async () => ({ room, chat: {} }),
        recoveryStore: store,
        reattachCapability: false,
      });
      const caps = getChatRunAdapterCapabilities('opencode');
      assert.equal(caps.canReattach, false);
      assert.equal(caps.resumeStrategy, '');
      assert.notEqual(caps.transcriptLossReason, 'none');
      const found = getChatRunAdapter('opencode').lookupRequest({
        chat: { cursorSessionId: 'sess-oc-denied' },
        requestId: ids.requestId,
      });
      assert.equal(found.resumeStrategy, '', 'lookup must not advertise server_reattach');
      assert.notEqual(found.transcriptLossReason, 'none', 'lookup must not claim the context survived');
      assert.equal(found.transcriptLost, true);
      t.diagnostic('denied opencode reattach narrows both surfaces, no server_reattach and no none');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the opencode registration declares its reattach capability once for both surfaces', (t) => {
  // The second F1 divergence vector lived in this file, not in the helpers: an
  // independent `canReattach: true` literal next to a lookup built with no
  // capability input. A structural guard is the only way to keep the two from
  // drifting apart again, because a unit test cannot see a future edit there.
  const source = readFileSync(
    new URL('../lib/opencode/opencode-agent-ws.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /const\s+OPENCODE_REATTACH_CAPABILITY\s*=\s*true\s*;/);
  assert.match(source, /reattachCapability:\s*OPENCODE_REATTACH_CAPABILITY\b/);
  assert.match(source, /canReattach:\s*OPENCODE_REATTACH_CAPABILITY\b/);
  assert.doesNotMatch(source, /canReattach:\s*true\b/, 'no independent capability literal may return');
  t.diagnostic('opencode reattach capability is declared once and shared by lookup + capabilities');
});
