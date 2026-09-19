import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { acceptSdkRoomPrompt } from '../lib/sdk/sdk-prompt-accept.js';
import { registerChatRunAdapter } from '../lib/chat-run-service.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { enqueueMailboxMessage } from '../lib/delegation-mailbox.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const setup = deferred();
const response = deferred();
let finished = false;
let settled = false;
const room = {
  currentRun: { id: 'previous-run' },
  async startPrompt(prompt, mode, fromQueue, clientSentAt, displayText, onAccepted) {
    assert.deepEqual([prompt, mode, fromQueue, clientSentAt, displayText],
      ['report', 'plan', false, null, 'Child reply']);
    await setup.promise;
    this.currentRun = { id: 'new-run' };
    onAccepted(this.currentRun);
    await response.promise;
    finished = true;
    this.currentRun = null;
  },
};
const started = acceptSdkRoomPrompt(room, {
  prompt: 'report', mode: 'plan', displayText: 'Child reply',
}).then((result) => { settled = true; return result; });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(settled, false, 'must wait for asynchronous SDK send');
setup.resolve();
assert.deepEqual(await started, { runId: 'new-run', accepted: true });
assert.equal(finished, false, 'acceptance must not wait for the response');
response.resolve();

const quick = await acceptSdkRoomPrompt({
  async startPrompt(_prompt, _mode, _queued, _sentAt, _display, onAccepted) {
    onAccepted({ id: 'quick-run' });
  },
}, { prompt: 'quick' });
assert.equal(quick.runId, 'quick-run', 'a completed run must retain its acknowledgement');

const unconfirmed = await acceptSdkRoomPrompt({
  currentRun: { id: 'stale-run' },
  async startPrompt() {},
}, { prompt: 'cancelled during setup' });
assert.equal(unconfirmed.runId, '', 'never confirm a previous run');

await assert.rejects(acceptSdkRoomPrompt({
  async startPrompt() { throw new Error('setup failed'); },
}, { prompt: 'failure' }), /setup failed/);

const parent = addChat('accept-parent', 'Parent', null, '/tmp', 'auto', { agentTransport: 'sdk' });
const child = addChat('accept-child', 'Child', null, '/tmp', 'auto', { agentTransport: 'sdk' });
const mailboxResponse = deferred();
let starts = 0;
const mailboxRoom = {
  busy: false,
  async startPrompt(_prompt, _mode, _queued, _sentAt, displayText, onAccepted) {
    starts += 1;
    this.busy = true;
    assert.equal(displayText, 'Child reply');
    await new Promise((resolve) => setImmediate(resolve));
    onAccepted({ id: 'mailbox-run' });
    await mailboxResponse.promise;
    this.busy = false;
  },
};
registerChatRunAdapter({
  transport: 'sdk',
  start: (input) => acceptSdkRoomPrompt(mailboxRoom, input),
  getState: () => ({ runId: '', busy: mailboxRoom.busy }),
  cancel: async () => {},
});
const message = {
  fromChatId: child.id, toChatId: parent.id, body: 'Review finished',
  idempotencyKey: 'async-sdk-mailbox',
};
const delivered = await enqueueMailboxMessage(message);
assert.equal(delivered.message.status, 'delivered');
assert.equal(delivered.message.recipientRunId, 'mailbox-run');
assert.equal(mailboxRoom.busy, true, 'delivery confirms acceptance, not completion');
assert.deepEqual(loadChatHistory(parent.id).events
  .filter((row) => row.rec.variant === 'mailbox')
  .map((row) => JSON.parse(row.rec.payload).status), ['queued', 'delivered']);
const replay = await enqueueMailboxMessage(message);
assert.equal(replay.message.id, delivered.message.id);
assert.equal(starts, 1, 'idempotent replay must not restart the parent');
mailboxResponse.resolve();

console.log('sdk-prompt-accept.test.js OK');
