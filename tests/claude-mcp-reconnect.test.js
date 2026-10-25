import assert from 'node:assert/strict';

import { reconnectFailedClaudeMcpServers } from '../lib/claude/claude-session.ts';

/**
 * @param {Array<Array<{ name: string, status: string }>>} statusSequence
 */
function fakeQuery(statusSequence) {
  const calls = { status: 0, reconnect: /** @type {string[]} */ ([]) };
  return {
    calls,
    async mcpServerStatus() {
      const rows = statusSequence[Math.min(calls.status, statusSequence.length - 1)];
      calls.status += 1;
      return rows;
    },
    async reconnectMcpServer(name) {
      calls.reconnect.push(name);
    },
  };
}

// Healthy bridge: one status probe, no reconnect.
{
  const query = fakeQuery([[{ name: 'cretli_bridge', status: 'connected' }]]);
  const result = await reconnectFailedClaudeMcpServers(query, ['cretli_bridge']);
  assert.deepEqual(result, { reconnected: [], failed: [] });
  assert.equal(query.calls.status, 1);
  assert.deepEqual(query.calls.reconnect, []);
}

// Crashed bridge that reconnects.
{
  const query = fakeQuery([
    [{ name: 'cretli_bridge', status: 'failed' }],
    [{ name: 'cretli_bridge', status: 'connected' }],
  ]);
  const result = await reconnectFailedClaudeMcpServers(query, ['cretli_bridge']);
  assert.deepEqual(result, { reconnected: ['cretli_bridge'], failed: [] });
  assert.deepEqual(query.calls.reconnect, ['cretli_bridge']);
}

// Reconnect does not help: reported as still failed.
{
  const query = fakeQuery([[{ name: 'cretli_bridge', status: 'failed' }]]);
  const result = await reconnectFailedClaudeMcpServers(query, ['cretli_bridge']);
  assert.deepEqual(result, { reconnected: [], failed: ['cretli_bridge'] });
}

// Failed servers Cretli did not configure are ignored.
{
  const query = fakeQuery([[{ name: 'someone_else', status: 'failed' }]]);
  const result = await reconnectFailedClaudeMcpServers(query, ['cretli_bridge']);
  assert.deepEqual(result, { reconnected: [], failed: [] });
  assert.deepEqual(query.calls.reconnect, []);
}

// Old SDK without control requests, or a hanging probe: never blocks the turn.
{
  assert.deepEqual(
    await reconnectFailedClaudeMcpServers({}, ['cretli_bridge']),
    { reconnected: [], failed: [] },
  );
  const hanging = { mcpServerStatus: () => new Promise(() => {}) };
  assert.deepEqual(
    await reconnectFailedClaudeMcpServers(hanging, ['cretli_bridge'], { timeoutMs: 20 }),
    { reconnected: [], failed: [] },
  );
}

console.log('claude-mcp-reconnect tests passed');
