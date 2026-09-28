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
  __resetAgentPresenceBusForTest,
} from '../lib/agent-presence-bus.js';
import { __resetAgentPresenceHooksForTest, setChatPresenceActivity } from '../lib/agent-presence-hooks.js';

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

const session = socket();
const widget = socket();
subscribeChatListUpdates(session, { kind: 'session' });
subscribeChatListUpdates(widget, { kind: 'widget', chatIds: ['only'] });
assert.equal(session.messages[0].type, 'agentPresence');
assert.equal(session.messages[0].snapshot, true);
assert.equal(widget.messages[0].type, 'agentPresence');
assert.ok(!widget.messages[0].states.other);

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

broadcastChatListChanged({ reason: 'archive', chatId: 'aaa' });
assert.equal(session.messages.at(-1).type, 'chatsChanged');

__resetAgentPresenceBusForTest();
__resetAgentPresenceHooksForTest();
__clearChatListUpdateClientsForTest();
console.log('agent-presence-bus.test.js OK');
