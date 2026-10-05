import assert from 'node:assert/strict';
import {
  hasOpenSdkRunTools,
  noteSdkRunToolActivity,
  resetSdkRunToolActivity,
} from '../lib/sdk/sdk-run-tool-activity.js';
import {
  __resetAgentPresenceHooksForTest,
  getChatPresenceActivity,
  setAgentPresenceDirtyHandler,
} from '../lib/agent-presence-hooks.js';

const room = {};
resetSdkRunToolActivity(room);
assert.equal(hasOpenSdkRunTools(room), false);

noteSdkRunToolActivity(room, { type: 'tool_call', call_id: 'c1', name: 'grep', status: 'running' });
assert.equal(hasOpenSdkRunTools(room), true);

noteSdkRunToolActivity(room, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
assert.equal(hasOpenSdkRunTools(room), true);

noteSdkRunToolActivity(room, { type: 'tool_call', call_id: 'c1', name: 'grep', status: 'success', result: 'ok' });
assert.equal(hasOpenSdkRunTools(room), false);

noteSdkRunToolActivity(room, { type: 'tool_call', call_id: 'c2', status: 'running' });
noteSdkRunToolActivity(room, { type: 'tool_call', call_id: 'c2', status: 'cancelled' });
assert.equal(hasOpenSdkRunTools(room), false);

noteSdkRunToolActivity(room, { type: 'tool_call', requestId: 'p1', name: 'read', status: 'running' });
noteSdkRunToolActivity(room, { type: 'tool_result', requestId: 'p1' });
assert.equal(hasOpenSdkRunTools(room), false);

noteSdkRunToolActivity(room, { type: 'tool_use', id: 'wait-tool', name: 'delegation_wait' });
assert.equal(hasOpenSdkRunTools(room), true);
noteSdkRunToolActivity(room, { type: 'tool_result', id: 'wait-tool' });
assert.equal(hasOpenSdkRunTools(room), false);

resetSdkRunToolActivity(room);
noteSdkRunToolActivity(room, { type: 'tool_call', call_id: 'hang', status: 'running' });
resetSdkRunToolActivity(room);
assert.equal(hasOpenSdkRunTools(room), false);

__resetAgentPresenceHooksForTest();
let dirtyCount = 0;
setAgentPresenceDirtyHandler(() => {
  dirtyCount += 1;
});
const live = { chatId: 'chat-tools' };
noteSdkRunToolActivity(live, { type: 'tool_call', call_id: 'a', name: 'read', path: 'a.js', status: 'running' });
noteSdkRunToolActivity(live, { type: 'tool_call', call_id: 'b', name: 'grep', path: 'b.js', status: 'running' });
assert.equal(getChatPresenceActivity('chat-tools')?.activityKey, 'grep');
noteSdkRunToolActivity(live, { type: 'tool_result', call_id: 'b' });
assert.equal(getChatPresenceActivity('chat-tools')?.activityKey, 'read');
assert.equal(getChatPresenceActivity('chat-tools')?.activityArg, 'a.js');
noteSdkRunToolActivity(live, { type: 'thinking', text: 'still reading' });
assert.equal(getChatPresenceActivity('chat-tools')?.activityKey, 'read');
noteSdkRunToolActivity(live, { type: 'tool_result', call_id: 'a' });
assert.equal(getChatPresenceActivity('chat-tools'), null);
noteSdkRunToolActivity(live, { type: 'thinking', text: 'next' });
assert.equal(getChatPresenceActivity('chat-tools')?.activityKey, 'thinking');
const dirtyAfterThinking = dirtyCount;
noteSdkRunToolActivity(live, { type: 'thinking', text: 'more' });
assert.equal(dirtyCount, dirtyAfterThinking);
resetSdkRunToolActivity(live);
assert.equal(getChatPresenceActivity('chat-tools'), null);
__resetAgentPresenceHooksForTest();

console.log('sdk-run-tool-activity.test.js OK');
