/**
 * Reliable agent-presence delivery.
 *
 * Pins the four guarantees added on top of the coalescing bus:
 *   - a frame dropped by WebSocket backpressure is repaired with a snapshot on the next
 *     flush (and the short retry), so a busy→idle transition cannot hang the sidebar;
 *   - the bus carries a process epoch so a server restart is visible to the client;
 *   - the client drops duplicate `(epoch, seq)` frames before touching any state, applies
 *     the content of a gap frame, and asks HTTP for the missing middle;
 *   - a late HTTP snapshot cannot roll back a newer WS row.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  subscribeChatListUpdates,
  __clearChatListUpdateClientsForTest,
} from '../lib/chat-list-updates.js';
import {
  initAgentPresenceBus,
  scheduleAgentPresenceRefresh,
  flushAgentPresenceNow,
  __setPresenceSummarizeForTest,
  __setWatcherPresenceForTest,
  __resetAgentPresenceBusForTest,
  __setPresenceEpochForTest,
} from '../lib/agent-presence-bus.js';
import { __resetAgentPresenceHooksForTest } from '../lib/agent-presence-hooks.js';
import { shouldSkipHttpAgentStates } from '../lib/agent-presence-policy.js';
import {
  ingestAgentPresenceMessage,
  applyAgentStatesToChats,
  __getAgentPresenceSyncStateForTest,
  __resetAgentPresenceSyncForTest,
} from '../app_front/features/chat/chatHistorySyncPoll.js';
import {
  applyDelta,
  get as getPresence,
  __resetAgentPresenceStoreForTest,
} from '../app_front/features/chat/agentPresenceStore.js';

const BUSY = {
  state: 'busy',
  runId: 'r1',
  delegationId: '',
  delegationStatus: '',
  attention: false,
  waitingAgentCount: 0,
};
const WAITING = {
  state: 'waiting',
  runId: '',
  delegationId: 'd1',
  delegationStatus: 'running',
  attention: true,
  waitingAgentCount: 1,
};

function socket() {
  const messages = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    messages,
    send(payload) {
      messages.push(JSON.parse(payload));
    },
  });
}

// ---------------------------------------------------------------------------
// Bus: backpressure and epoch
// ---------------------------------------------------------------------------

__resetAgentPresenceHooksForTest();
__resetAgentPresenceBusForTest();
__clearChatListUpdateClientsForTest();
initAgentPresenceBus();
__setPresenceSummarizeForTest(() => ({}));
__setWatcherPresenceForTest(() => []);

const pressured = socket();
subscribeChatListUpdates(pressured, { kind: 'session' });
assert.equal(pressured.messages[0].snapshot, true);
const firstEpoch = pressured.messages[0].epoch;
assert.ok(firstEpoch, 'every presence frame carries a bus epoch');

// Establish a real delta so the bus has a fingerprint to diff the idle transition against.
__setPresenceSummarizeForTest(() => ({ only: BUSY }));
scheduleAgentPresenceRefresh(['only']);
flushAgentPresenceNow();
const busyDelta = pressured.messages.at(-1);
assert.equal(busyDelta.snapshot, false);
assert.equal(busyDelta.seq, 1);
assert.equal(busyDelta.epoch, firstEpoch);

// busy → idle while the socket is backpressured: the frame is dropped, nobody queues deltas.
__setPresenceSummarizeForTest(() => ({}));
pressured.bufferedAmount = 1e9;
scheduleAgentPresenceRefresh(['only']);
flushAgentPresenceNow();
assert.equal(pressured.messages.length, 2, 'the backpressured delta must not reach the socket');

// Next flush repairs the debt with a full snapshot (idempotent), not a queued delta.
pressured.bufferedAmount = 0;
flushAgentPresenceNow();
const repair = pressured.messages.at(-1);
assert.equal(repair.snapshot, true, 'an owed socket gets a snapshot, not a delta');
assert.equal(repair.epoch, firstEpoch);
assert.equal(repair.states.only, undefined, 'the repair snapshot carries the current idle map');

// A restart mints a new epoch, so a client can never mistake the fresh low seq for a
// continuation of the previous process.
__resetAgentPresenceBusForTest();
__clearChatListUpdateClientsForTest();
__setPresenceSummarizeForTest(() => ({}));
__setWatcherPresenceForTest(() => []);
const restarted = socket();
subscribeChatListUpdates(restarted, { kind: 'session' });
assert.ok(restarted.messages[0].epoch);
assert.notEqual(restarted.messages[0].epoch, firstEpoch, 'a restarted bus starts a new epoch');

// The setter lets a test pin an epoch without waiting for a real restart.
__setPresenceEpochForTest('epoch-pinned');
__setPresenceSummarizeForTest(() => ({ only: BUSY }));
scheduleAgentPresenceRefresh(['only']);
flushAgentPresenceNow();
assert.equal(restarted.messages.at(-1).epoch, 'epoch-pinned');

// The short retry timer repairs the debt with no further delta at all — the actual
// acceptance path, where the dropped busy→idle frame was the last one of the run.
__resetAgentPresenceBusForTest();
__clearChatListUpdateClientsForTest();
__setPresenceSummarizeForTest(() => ({}));
__setWatcherPresenceForTest(() => []);
const retried = socket();
subscribeChatListUpdates(retried, { kind: 'session' });
__setPresenceSummarizeForTest(() => ({ only: BUSY }));
scheduleAgentPresenceRefresh(['only']);
flushAgentPresenceNow();
__setPresenceSummarizeForTest(() => ({}));
retried.bufferedAmount = 1e9;
scheduleAgentPresenceRefresh(['only']);
flushAgentPresenceNow();
retried.bufferedAmount = 0;
await new Promise((resolve) => setTimeout(resolve, 400));
const retriedSnapshot = retried.messages.at(-1);
assert.equal(retriedSnapshot.snapshot, true, 'the retry timer delivers the repair snapshot');
assert.equal(retriedSnapshot.states.only, undefined);

// ---------------------------------------------------------------------------
// Client: snapshot lowers seq, dedupe, gap apply, fallback policy
// ---------------------------------------------------------------------------

__resetAgentPresenceSyncForTest();
__resetAgentPresenceStoreForTest();
const seqChats = [{ id: 'a' }];
let result = ingestAgentPresenceMessage(seqChats, {
  epoch: 'E',
  seq: 5,
  snapshot: false,
  states: { a: BUSY },
});
assert.equal(result.seqGap, false);
assert.equal(__getAgentPresenceSyncStateForTest().lastPresenceSeq, 5);

// A snapshot is authoritative even when its seq is lower: reset downward.
ingestAgentPresenceMessage(seqChats, { epoch: 'E', seq: 2, snapshot: true, states: {} });
assert.equal(__getAgentPresenceSyncStateForTest().lastPresenceSeq, 2, 'a snapshot may lower the seq');
assert.equal(seqChats[0]._serverRunState, null);

// Because the seq moved down, the following in-order delta is not mistaken for a duplicate.
ingestAgentPresenceMessage(seqChats, {
  epoch: 'E',
  seq: 3,
  snapshot: false,
  states: { a: WAITING },
});
assert.equal(seqChats[0]._serverRunState.state, 'waiting');

// Dedupe: each chat socket re-delivers the same shared frame, so a repeated (epoch, seq)
// must be dropped before it can touch the store or the chat object.
__resetAgentPresenceSyncForTest();
__resetAgentPresenceStoreForTest();
const dedupeChats = [{ id: 'a' }];
ingestAgentPresenceMessage(dedupeChats, { epoch: 'E', seq: 3, snapshot: false, states: { a: BUSY } });
const duplicate = ingestAgentPresenceMessage(dedupeChats, {
  epoch: 'E',
  seq: 3,
  snapshot: false,
  states: { a: WAITING },
});
assert.equal(duplicate.duplicate, true);
assert.equal(duplicate.changed, false);
assert.equal(dedupeChats[0]._serverRunState.state, 'busy', 'the duplicate must not overwrite');
assert.equal(getPresence('a').state, 'busy', 'the duplicate must not reach the store');

// A gap frame is applied and the module asks for the missing middle.
__resetAgentPresenceSyncForTest();
__resetAgentPresenceStoreForTest();
const gapChats = [{ id: 'baseline' }, { id: 'late' }];
ingestAgentPresenceMessage(gapChats, {
  epoch: 'E',
  seq: 1,
  snapshot: false,
  states: { baseline: BUSY },
});
const gap = ingestAgentPresenceMessage(gapChats, {
  epoch: 'E',
  seq: 4,
  snapshot: false,
  states: { late: WAITING },
});
assert.equal(gap.seqGap, true);
assert.equal(gap.changed, true);
assert.equal(gapChats[1]._serverRunState.state, 'waiting', 'the gap frame content is applied');
assert.equal(getPresence('late').state, 'waiting');
const afterGap = __getAgentPresenceSyncStateForTest();
assert.equal(afterGap.lastPresenceSeq, 4);
assert.equal(afterGap.presenceFallbackRequired, true);
assert.equal(afterGap.lastPresenceAt, 0, 'a gap invalidates the recent-presence shortcut');

// The fallback must not be skipped while the gap is unresolved.
assert.equal(
  shouldSkipHttpAgentStates({
    hasOpenHarnessWs: true,
    lastPresenceAt: Date.now(),
    presenceUncertain: true,
  }),
  false
);
assert.equal(
  shouldSkipHttpAgentStates({
    hasOpenHarnessWs: true,
    lastPresenceAt: Date.now(),
    presenceUncertain: false,
  }),
  true
);

// A gap that lands while an HTTP request is in flight must not be cleared by that request:
// the fallback stays pending for the next pass.
const inflightRequestAt = Date.now() - 1000;
applyAgentStatesToChats(gapChats, { baseline: WAITING }, { requestedAt: inflightRequestAt });
assert.equal(
  __getAgentPresenceSyncStateForTest().presenceFallbackRequired,
  true,
  'a request started before the gap cannot resolve it'
);
applyAgentStatesToChats(gapChats, { baseline: WAITING }, { requestedAt: Date.now() });
assert.equal(__getAgentPresenceSyncStateForTest().presenceFallbackRequired, false);

// An epoch change resets the baseline and requires a snapshot too.
__resetAgentPresenceSyncForTest();
__resetAgentPresenceStoreForTest();
const epochChats = [{ id: 'a' }];
ingestAgentPresenceMessage(epochChats, { epoch: 'E1', seq: 9, snapshot: false, states: { a: BUSY } });
const switched = ingestAgentPresenceMessage(epochChats, {
  epoch: 'E2',
  seq: 1,
  snapshot: false,
  states: { a: WAITING },
});
assert.equal(switched.seqGap, true, 'a new epoch delta cannot be trusted as a continuation');
assert.equal(__getAgentPresenceSyncStateForTest().lastPresenceEpoch, 'E2');
assert.equal(__getAgentPresenceSyncStateForTest().lastPresenceSeq, 1);
assert.equal(epochChats[0]._serverRunState.state, 'waiting');
// The snapshot that follows clears the uncertainty.
ingestAgentPresenceMessage(epochChats, { epoch: 'E2', seq: 1, snapshot: true, states: { a: BUSY } });
assert.equal(__getAgentPresenceSyncStateForTest().presenceFallbackRequired, false);

// ---------------------------------------------------------------------------
// Client: a late HTTP snapshot cannot roll back a newer WS row
// ---------------------------------------------------------------------------

__resetAgentPresenceStoreForTest();
applyDelta({ a: BUSY, keep: BUSY }, [], 5000);
const raceChats = [{ id: 'a', _serverRunState: BUSY, _serverRunStateAt: 5000 }];

// The HTTP request started at 4000, before the WS frame landed at 5000.
const staleApplied = applyAgentStatesToChats(raceChats, { a: WAITING }, { requestedAt: 4000 });
assert.equal(staleApplied.changed, false, 'an older HTTP response is a no-op');
assert.deepEqual(staleApplied.dirtyIds, [], 'a rejected response dirties nothing');
assert.equal(raceChats[0]._serverRunState.state, 'busy');
assert.equal(getPresence('a').state, 'busy');
assert.equal(getPresence('keep').state, 'busy', 'a newer row absent from the map is not cleared');

// A response requested after the WS frame still applies normally.
const freshApplied = applyAgentStatesToChats(raceChats, { a: WAITING }, { requestedAt: 6000 });
assert.equal(freshApplied.changed, true);
assert.deepEqual(freshApplied.dirtyIds, ['a']);
assert.equal(raceChats[0]._serverRunState.state, 'waiting');
assert.equal(getPresence('a').state, 'waiting');

// ---------------------------------------------------------------------------
// chat.js wiring (browser bundle, so asserted by source scan)
// ---------------------------------------------------------------------------

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatSource = readFileSync(path.join(root, 'app_front/chat.js'), 'utf8');
assert.match(chatSource, /ingestAgentPresenceMessage\(chats, msg\)/);
assert.match(
  chatSource,
  /applyAgentStatesToChats\(chats, data\.states, \{ requestedAt \}\)/,
  'the gap HTTP fallback must pass the request time so a late answer cannot win'
);
assert.match(
  chatSource,
  /if \(result\.changed\) scheduleChatListStateRefresh\(result\.dirtyIds\);/,
  'a gap frame must still repaint the deltas it carried'
);
assert.match(
  chatSource,
  /const applied = applyAgentStatesToChats\(chats, data\.states, \{ requestedAt \}\);\s*\n\s*if \(applied\.changed\) scheduleChatListStateRefresh\(applied\.dirtyIds\);/,
  'the HTTP gap/push-inbox fallback repaints only the rows it changed'
);
assert.match(
  chatSource,
  /onAgentStatesChange: \(dirtyIds\) => \{[\s\S]{0,60}?scheduleChatListStateRefresh\(dirtyIds\);/,
  'the revision poll forwards the changed ids to the scheduler'
);
assert.doesNotMatch(
  chatSource,
  /if \(applyAgentStatesToChats\(/,
  'no caller may test the result object as a boolean (an object is always truthy)'
);

console.log('agent-presence-delivery.test.js OK');
