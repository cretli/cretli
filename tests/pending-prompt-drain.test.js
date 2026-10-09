import assert from 'node:assert/strict';
import {
  beginUpdateOperation,
  endUpdateOperation,
  resetUpdateGateForTest,
} from '../lib/update-gate.js';
import {
  canStartPendingPromptDrain,
  drainOnePendingPrompt,
} from '../lib/agent-harness/pending-prompt-drain.js';
import {
  registerPendingPromptRoomSource,
  resetPendingPromptRoomSourcesForTest,
} from '../lib/agent-harness/pending-prompt-resume.js';

resetUpdateGateForTest();
resetPendingPromptRoomSourcesForTest();

const room = { busy: false, pendingPrompts: [{ text: 'queued-one', mode: 'agent' }] };
const slot = beginUpdateOperation({ kind: 'install', reason: 'pending-prompt-drain-test' });
assert.equal(slot.allowed, true);
assert.equal(canStartPendingPromptDrain(room), false);

let started = false;
assert.equal(drainOnePendingPrompt(room, () => { started = true; }), false);
assert.equal(started, false);
assert.equal(room.pendingPrompts.length, 1);

endUpdateOperation(slot.operationId);
assert.equal(canStartPendingPromptDrain(room), true);
assert.equal(drainOnePendingPrompt(room, (item) => {
  started = true;
  assert.equal(item.text, 'queued-one');
}), true);
assert.equal(started, true);
assert.equal(room.pendingPrompts.length, 0);

// Resume hook drains idle rooms after the update slot clears.
const resumeRoom = {
  busy: false,
  pendingPrompts: [{ text: 'after-gate', mode: 'agent' }],
  drainQueue() {
    drainOnePendingPrompt(this, (next) => {
      this.lastDrained = next.text;
    });
  },
};
registerPendingPromptRoomSource(() => [resumeRoom]);
const resumeSlot = beginUpdateOperation({ kind: 'update', reason: 'resume-hook-test' });
endUpdateOperation(resumeSlot.operationId);

await new Promise((resolve) => setImmediate(resolve));
assert.equal(resumeRoom.lastDrained, 'after-gate');
assert.equal(resumeRoom.pendingPrompts.length, 0);

resetUpdateGateForTest();
resetPendingPromptRoomSourcesForTest();

console.log('pending-prompt-drain.test.js: ok');
