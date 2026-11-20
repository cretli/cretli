import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { armClaudeSessionIdleTimer, clearClaudeSessionIdleTimer, hasClaudeBackgroundWork } from '../lib/claude/claude-session.ts';
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

// A quiet shell task must survive both room eviction and session idle cleanup.
const session = {
  alive: true, query: { close() { session.closed = true; } }, input: { close() {} },
  backgroundTasks: new Set(['shell-1']), backgroundActivityAt: Date.now() - 43 * 60_000,
};
const shellKernel = createAgentRoomKernel({
  transport: 'claude', graceMs: 5, persistHistory: () => {},
  holdRoom: (room) => hasClaudeBackgroundWork(room),
});
const shellRoom = shellKernel.createRoomState({ sessionKey: 'shell-room', chatId: '' });
shellRoom._claudeSession = session;
shellKernel.rooms.set('shell-room', shellRoom);
shellRoom.clients.add(client);
armClaudeSessionIdleTimer(shellRoom, session, 5);
shellKernel.detachClient(shellRoom, client, 'shell-room');
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(shellKernel.rooms.has('shell-room'), true);
assert.equal(session.alive, true);
assert.notEqual(session.closed, true);
session.backgroundTasks.clear();
session.backgroundActivityAt = 0;
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(session.alive, false, 'normal idle cleanup resumes after task completion');
assert.equal(shellKernel.rooms.has('shell-room'), false);
clearClaudeSessionIdleTimer(session);
console.log('claude-room-background-hold.test.js OK');
process.exit(0);
