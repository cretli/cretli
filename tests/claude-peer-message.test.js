import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readClaudePeerMessage } from '../lib/agent-harness/claude-event-normalizer.ts';
import { resolveClaudePeerChat, resolveClaudeSessionName } from '../lib/claude/claude-peer-message.ts';

const peerFrame = (origin, content = 'x') => ({
  type: 'user',
  isReplay: true,
  uuid: 'frame-uuid',
  parent_tool_use_id: null,
  message: { role: 'user', content },
  origin: { kind: 'peer', ...origin },
});

test('a peer delivery yields its sender and body', () => {
  assert.deepEqual(
    readClaudePeerMessage(peerFrame({ msg_id: 'm1', name: 'acme-chat-e95fdf1e', body: 'hello' })),
    { id: 'm1', fromName: 'acme-chat-e95fdf1e', body: 'hello' },
  );
});

test('joined envelopes are unwrapped when origin.body is absent', () => {
  const content = 'Another Claude session sent a message:\n<cross-session-message from="a">\none\n</cross-session-message>\n'
    + '<cross-session-message from="b">\ntwo\n</cross-session-message>\nGuidance for the model.';
  assert.equal(readClaudePeerMessage(peerFrame({}, content))?.body, 'one\n\ntwo');
  assert.equal(readClaudePeerMessage(peerFrame({}, [{ type: 'text', text: content }]))?.id, 'frame-uuid');
});

test('other user frames are not peer deliveries', () => {
  assert.equal(readClaudePeerMessage({ type: 'user', isReplay: true, message: { content: 'hi' } }), null);
  assert.equal(readClaudePeerMessage({ ...peerFrame({ msg_id: 'm' }), isReplay: false }), null);
  assert.equal(readClaudePeerMessage(peerFrame({ msg_id: 'm', senderTaskId: 'task' })), null);
  assert.equal(readClaudePeerMessage({ ...peerFrame({ msg_id: 'm' }), parent_tool_use_id: 'tool' }), null);
});

test('the session name leads back to the sending chat', () => {
  const id = 'e95fdf1e-4a2b-40ac-ad6d-392b8ece46b7';
  const name = resolveClaudeSessionName(id, '/srv/www/My.App');
  assert.equal(name, 'my-app-chat-e95fdf1e');
  const chat = { id, title: 'Sender' };
  assert.equal(resolveClaudePeerChat(name, [{ id: 'other' }, chat]), chat);
  // The CLI appends a counter when a name is taken.
  assert.equal(resolveClaudePeerChat(`${name}-2`, [chat]), chat);
  assert.equal(resolveClaudePeerChat('my-app-16', [chat]), null);
  assert.equal(resolveClaudePeerChat(`${name}`, [{ id: 'other' }]), null);
});
