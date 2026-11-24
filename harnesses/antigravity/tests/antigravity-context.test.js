import '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAntigravityContextReading, parseAntigravityNativeCommand, readAntigravityCommandNames } from '../antigravity-context.js';
import { runAntigravityPrompt } from '../antigravity-client.js';

const reading = (totalTokens) => ({ type: 'context_usage', usage: { inputTokens: totalTokens, totalTokens } });

test('only an advertised command at the very start is a native command', () => {
  assert.equal(parseAntigravityNativeCommand('/compact'), 'compact');
  assert.equal(parseAntigravityNativeCommand('  /goal ship the fix'), 'goal');
  assert.equal(parseAntigravityNativeCommand('/home/me/file.txt is broken'), '');
  assert.equal(parseAntigravityNativeCommand('/tmp is full'), '');
  assert.equal(parseAntigravityNativeCommand('please /compact'), '');
  assert.equal(parseAntigravityNativeCommand('/review now', ['review']), 'review');
  assert.equal(parseAntigravityNativeCommand('/compact', ['goal']), '');
  assert.deepEqual(readAntigravityCommandNames({ availableCommands: [{ name: 'goal' }, { name: '' }, {}] }), ['goal']);
});

test('compaction is the /compact turn or a large drop from a sizeable context', () => {
  assert.equal(classifyAntigravityContextReading({ previousTotal: 9000, event: reading(12000), command: 'compact' }), 'compacted_by_command');
  assert.equal(classifyAntigravityContextReading({ previousTotal: 300000, event: reading(60000) }), 'compacted');
  assert.equal(classifyAntigravityContextReading({ previousTotal: 300000, event: reading(250000) }), 'measured');
  // Small contexts fluctuate (a summary call can shrink 10K to 9K): not a compaction.
  assert.equal(classifyAntigravityContextReading({ previousTotal: 10335, event: reading(5000) }), 'measured');
  assert.equal(classifyAntigravityContextReading({ previousTotal: null, event: reading(5000) }), 'measured');
});

function fakeConnection({ replay }) {
  return (options) => ({
    close() {},
    async request(method) {
      if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (method === 'session/load') {
        options.onUpdate({ sessionId: 'saved', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } });
        if (replay) options.onUpdate({ sessionId: 'saved', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } } });
        return { sessionId: 'saved' };
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    },
  });
}

test('a resume that replays no history reports a dropped session', async () => {
  const base = { cwd: process.cwd(), model: 'default', mode: 'agent', prompt: 'hi', mcpServers: {}, sessionId: 'saved', onSession: async () => {}, onEvent: () => {}, checkPermission: async () => ({ outcome: 'proceed' }) };
  for (const replay of [true, false]) {
    let dropped = 0;
    let commands = [];
    await runAntigravityPrompt({ ...base, connectionFactory: fakeConnection({ replay }), onSessionDropped: async () => { dropped += 1; }, onCommands: (names) => { commands = names; } });
    assert.equal(dropped, replay ? 0 : 1);
    assert.deepEqual(commands, ['compact']);
  }
});
