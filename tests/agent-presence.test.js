import assert from 'node:assert/strict';
import {
  filterPresenceForScope,
  fingerprintAgentPresence,
  parseToolPresenceActivity,
  sanitizePresenceActivityArg,
} from '../lib/agent-presence-activity.js';
import {
  hasAgentPresenceSeqGap,
  shouldSkipHttpAgentStates,
} from '../lib/agent-presence-policy.js';
import {
  applyAgentPresenceToChats,
  applyAgentStatesToChats,
} from '../app_front/features/chat/chatHistorySyncPoll.js';

assert.equal(sanitizePresenceActivityArg('/home/you/secret/package.json'), 'package.json');
assert.equal(sanitizePresenceActivityArg('C:\\\\Users\\\\you\\\\app.js'), 'app.js');
assert.equal(parseToolPresenceActivity({ name: 'Read', path: '/a/b/c.ts' })?.activityKey, 'read');
assert.equal(parseToolPresenceActivity({ name: 'Shell' })?.activityKey, 'bash');
assert.equal(parseToolPresenceActivity({ name: 'unknown_tool' }), null);

const fpBusy = fingerprintAgentPresence({
  state: 'busy',
  delegationId: 'd1',
  attention: false,
  waitingAgentCount: 0,
  activityKey: 'read',
  activityArg: 'a.js',
});
const fpBusy2 = fingerprintAgentPresence({
  state: 'busy',
  delegationId: 'd1',
  attention: false,
  waitingAgentCount: 0,
  activityKey: 'read',
  activityArg: 'b.js',
});
assert.notEqual(fpBusy, fpBusy2);

const scoped = filterPresenceForScope(
  { a: { state: 'busy' }, b: { state: 'waiting' } },
  ['a', 'c'],
  { kind: 'widget', chatIds: ['a'] }
);
assert.equal(Object.keys(scoped.states).join(','), 'a');
assert.deepEqual(scoped.cleared, ['a']);

assert.equal(shouldSkipHttpAgentStates({
  redisBus: true,
  hasOpenHarnessWs: true,
  lastPresenceAt: Date.now(),
}), false);
assert.equal(shouldSkipHttpAgentStates({
  hasOpenHarnessWs: true,
  lastPresenceAt: Date.now() - 1000,
  hidden: false,
}), true);
assert.equal(shouldSkipHttpAgentStates({
  hasOpenHarnessWs: false,
  lastPresenceAt: Date.now(),
}), false);
assert.equal(hasAgentPresenceSeqGap(1, 3, false), true);
assert.equal(hasAgentPresenceSeqGap(1, 3, true), false);
assert.equal(hasAgentPresenceSeqGap(2, 3, false), false);

const chats = [
  { id: 'a', _serverRunState: { state: 'busy', delegationId: 'd1', attention: false } },
  { id: 'b', _serverRunState: { state: 'busy', waitingAgentCount: 2 } },
];
assert.equal(
  applyAgentStatesToChats(chats, {
    a: { state: 'busy', delegationId: 'd1', attention: false, waitingAgentCount: 3 },
  }),
  true
);
assert.equal(chats[0]._serverRunState.waitingAgentCount, 3);
assert.equal(chats[1]._serverRunState, null);

// A server agent-states response is authoritative even when nothing changed: it
// still advances the server watermark that blocks stale push-inbox patches.
const unchangedStamp = [{ id: 'same', _serverRunState: { state: 'busy' } }];
assert.equal(
  applyAgentStatesToChats(unchangedStamp, { same: { state: 'busy' } }),
  false
);
assert.ok(unchangedStamp[0]._serverRunStateAt > 0);

const deltaChats = [
  { id: 'keep', _serverRunState: { state: 'busy' } },
  { id: 'gone', _serverRunState: { state: 'attention' } },
];
const patched = applyAgentPresenceToChats(deltaChats, {
  snapshot: false,
  states: { keep: { state: 'busy', activityKey: 'read', activityArg: 'x.js' } },
  cleared: ['gone'],
});
assert.equal(patched.changed, true);
assert.equal(deltaChats[0]._serverRunState.activityKey, 'read');
assert.equal(deltaChats[1]._serverRunState, null);

console.log('agent-presence.test.js OK');
