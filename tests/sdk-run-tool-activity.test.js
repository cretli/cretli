import assert from 'node:assert/strict';
import {
  hasOpenSdkRunTools,
  noteSdkRunToolActivity,
  resetSdkRunToolActivity,
} from '../lib/sdk/sdk-run-tool-activity.js';

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

console.log('sdk-run-tool-activity.test.js OK');
