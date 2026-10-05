import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  subscribeChatListUpdates,
  broadcastChatListChanged,
  __clearChatListUpdateClientsForTest,
} from '../lib/chat-list-updates.js';
import {
  initAgentPresenceBus,
  scheduleAgentPresenceRefresh,
  flushAgentPresenceNow,
  __setPresenceSummarizeForTest,
  __setWatcherPresenceForTest,
  __resetAgentPresenceBusForTest,
} from '../lib/agent-presence-bus.js';
import { __resetAgentPresenceHooksForTest, setChatPresenceActivity } from '../lib/agent-presence-hooks.js';
import { workspaceWatcherPresenceRows } from '../lib/workspace-watcher-live.js';

function socket() {
  const messages = [];
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    messages,
    send: (payload) => messages.push(JSON.parse(payload)),
  });
}

__resetAgentPresenceHooksForTest();
__resetAgentPresenceBusForTest();
__clearChatListUpdateClientsForTest();
initAgentPresenceBus();
__setPresenceSummarizeForTest(() => ({}));
__setWatcherPresenceForTest(() => workspaceWatcherPresenceRows([
  { workspaceFolder: '/repo/auto', mode: 'autopilot', activeCycle: { chatId: 'orch-1', todoIds: ['t1'] } },
  { workspaceFolder: '/repo/off', mode: 'off' },
]));

const session = socket();
const widget = socket();
subscribeChatListUpdates(session, { kind: 'session' });
subscribeChatListUpdates(widget, { kind: 'widget', chatIds: ['only'] });
assert.equal(session.messages[0].type, 'agentPresence');
assert.equal(session.messages[0].snapshot, true);
assert.equal(session.messages[0].watchers.length, 1);
assert.equal(session.messages[0].watchers[0].workspaceFolder, '/repo/auto');
assert.equal(session.messages[0].watchers[0].activeCycleChatId, 'orch-1');
assert.equal(widget.messages[0].type, 'agentPresence');
assert.ok(!widget.messages[0].states.other);
assert.equal(widget.messages[0].watchers, undefined, 'widget scope stays free of workspace badges');

__setPresenceSummarizeForTest(() => ({
  only: { state: 'busy', runId: 'r', delegationId: '', delegationStatus: '', attention: false, waitingAgentCount: 0 },
  other: { state: 'waiting', runId: '', delegationId: 'd', delegationStatus: 'running', attention: true, waitingAgentCount: 1 },
}));
scheduleAgentPresenceRefresh();
flushAgentPresenceNow();
const sessionDelta = session.messages.find((row) => row.type === 'agentPresence' && row.snapshot !== true);
const widgetDelta = widget.messages.find((row) => row.type === 'agentPresence' && row.snapshot !== true);
assert.ok(sessionDelta.states.only);
assert.ok(sessionDelta.states.other);
assert.ok(widgetDelta.states.only);
assert.equal(widgetDelta.states.other, undefined);
assert.equal(widgetDelta.seq, 1);

__setPresenceSummarizeForTest(() => ({
  only: { state: 'busy', runId: 'r', delegationId: '', delegationStatus: '', attention: false, waitingAgentCount: 0 },
}));
setChatPresenceActivity('only', { activityKey: 'read', activityArg: 'a.js' });
scheduleAgentPresenceRefresh(['only']);
flushAgentPresenceNow();
const coalesced = session.messages.filter((row) => row.type === 'agentPresence' && row.snapshot !== true);
assert.equal(coalesced.at(-1).seq, 2);
assert.equal(coalesced.at(-1).states.only.activityKey, 'read');

// A watcher change alone (no chat state change) still fans out, so the sidebar
// autopilot badge stays live.
__setWatcherPresenceForTest(() => workspaceWatcherPresenceRows([
  { workspaceFolder: '/repo/auto', mode: 'autopilot', paused: true, activeCycle: { chatId: 'orch-1', todoIds: ['t1'] } },
]));
scheduleAgentPresenceRefresh();
flushAgentPresenceNow();
const watcherDelta = session.messages.filter((row) => row.type === 'agentPresence' && row.snapshot !== true).at(-1);
assert.equal(watcherDelta.watchers[0].paused, true);
assert.equal(watcherDelta.seq, 3);

broadcastChatListChanged({ reason: 'archive', chatId: 'aaa' });
assert.equal(session.messages.at(-1).type, 'chatsChanged');

__resetAgentPresenceBusForTest();
__resetAgentPresenceHooksForTest();
__clearChatListUpdateClientsForTest();
console.log('agent-presence-bus.test.js OK');
