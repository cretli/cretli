import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createMcpServer, callContextTool } from '../lib/mcp/mcp-service.js';
import { loadMcpDocument } from '../lib/persist/mcp-persist.js';
import { MCP_ACCESS_LOG_FILE, appendMcpAccess, readMcpAccessLog } from '../lib/mcp/mcp-access-log.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

test('access log keeps newest first, filters by server and never stores arguments', () => {
  appendMcpAccess({ serverId: 'a', serverName: 'A', tool: 'one', outcome: 'ok', chatId: 'c1', harness: 'claude', durationMs: 12.4 });
  appendMcpAccess({ serverId: 'b', serverName: 'B', tool: 'two', outcome: 'denied', reason: 'plan mode' });
  appendMcpAccess({ serverId: 'a', serverName: 'A', tool: 'three', outcome: 'error', reason: 'boom' });
  const all = readMcpAccessLog();
  assert.deepEqual(all.map((row) => row.tool), ['three', 'two', 'one']);
  assert.deepEqual(readMcpAccessLog({ serverId: 'a' }).map((row) => row.tool), ['three', 'one']);
  assert.equal(all[2].ms, 12);
  assert.deepEqual(Object.keys(all[2]).sort(), ['at', 'chatId', 'harness', 'mode', 'ms', 'outcome', 'server', 'serverId', 'tool']);
});

test('calls to external servers are logged: unavailable server and Plan-mode denial', async () => {
  const created = await createMcpServer({
    name: 'Logged',
    transport: 'stdio',
    harnesses: ['claude'],
    connection: { command: 'node' },
    secrets: { API_KEY: 'super-secret-value' },
  }, loadMcpDocument().revision);
  const id = created.server.id;
  const context = { harness: 'claude', mode: 'plan', workspaceFolder: '/tmp/none' };

  const missing = await callContextTool({ ...context, harness: 'codex' }, id, 'send_message', { to: 'x' });
  assert.equal(missing.ok, false);
  const denied = await callContextTool(context, id, 'send_message', { to: 'x' });
  assert.equal(denied.denied, true);

  const rows = readMcpAccessLog({ serverId: id });
  assert.deepEqual(rows.map((row) => row.outcome), ['denied', 'unavailable']);
  assert.equal(rows[0].harness, 'claude');
  assert.equal(rows[0].mode, 'plan');
  assert.doesNotMatch(fs.readFileSync(resolveDataPath(MCP_ACCESS_LOG_FILE), 'utf8'), /"to":"x"|super-secret-value/);
});

test('secret values echoed in an error reason are masked', () => {
  appendMcpAccess({ serverId: 'z', tool: 't', outcome: 'error', reason: 'auth failed for key super-secret-value' });
  assert.match(readMcpAccessLog({ serverId: 'z' })[0].reason, /\*\*\*/);
});
