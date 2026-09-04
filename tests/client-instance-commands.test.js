import assert from 'node:assert/strict';
import {
  completeClientInstanceCommand,
  dequeueClientInstanceCommands,
  enqueueClientInstanceCommand,
  getClientInstanceCommand,
  listClientInstanceCommandResults,
  resetClientInstanceCommandsForTests,
} from '../lib/client-instance-commands.js';

resetClientInstanceCommandsForTests();

const targetId = 'abc12345-dead-beef-cafe-000000000001';
const fromId = 'abc12345-dead-beef-cafe-000000000002';

const command = enqueueClientInstanceCommand(targetId, fromId, 'ping');
assert.ok(command);
assert.equal(command?.type, 'ping');
assert.equal(getClientInstanceCommand(command.id)?.status, 'pending');

const consoleCommand = enqueueClientInstanceCommand(targetId, fromId, 'consoleReport');
assert.ok(consoleCommand);
assert.equal(consoleCommand?.type, 'consoleReport');

const dequeued = dequeueClientInstanceCommands(targetId);
assert.equal(dequeued.length, 2);
assert.equal(dequeued[0].id, command.id);
assert.equal(dequeued[1].id, consoleCommand.id);
assert.equal(dequeueClientInstanceCommands(targetId).length, 0);

const inFlight = getClientInstanceCommand(command.id);
assert.ok(inFlight);
assert.equal(inFlight?.status, 'pending');

const completed = completeClientInstanceCommand(command.id, { ok: true, pong: true, elapsedMs: 7 });
assert.ok(completed);
assert.equal(completed?.status, 'completed');
assert.equal(completed?.result?.elapsedMs, 7);

const results = listClientInstanceCommandResults(targetId, 5);
assert.equal(results.length, 1);
assert.equal(results[0].type, 'ping');

for (let i = 0; i < 11; i += 1) {
  enqueueClientInstanceCommand(targetId, fromId, 'flushLogs');
}
const overflow = enqueueClientInstanceCommand(targetId, fromId, 'ping');
assert.equal(overflow, null);

resetClientInstanceCommandsForTests();
const expired = enqueueClientInstanceCommand(targetId, fromId, 'ping', null, Date.now() - 70000);
assert.ok(expired);
const staleQueue = dequeueClientInstanceCommands(targetId, Date.now());
assert.equal(staleQueue.length, 0);

console.log('client-instance-commands.test.js: ok');
