import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';

// A client-less room closes after its grace period unless `holdRoom` says the
// harness still has work the kernel cannot see.
let held = true;
const aborted = [];
const kernel = createAgentRoomKernel({
  transport: 'claude',
  graceMs: 5,
  persistHistory: () => {},
  abortRoom: (room) => { aborted.push(room); },
  holdRoom: () => held,
});
const room = kernel.createRoomState({ sessionKey: 'room-1', chatId: '' });
kernel.rooms.set('room-1', room);
const client = { readyState: 1, send() {} };
room.clients.add(client);

kernel.detachClient(room, client, 'room-1');
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(aborted.length, 0, 'held work keeps the process');
assert.equal(kernel.rooms.has('room-1'), true);

held = false;
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(aborted.length, 1, 'the room closes once the work is over');
assert.equal(kernel.rooms.has('room-1'), false);

console.log('claude-room-background-hold.test.js OK');
process.exit(0);
