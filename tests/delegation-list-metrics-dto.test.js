import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { DELEGATION_MCP_TOOLS } from '../lib/mcp/builtin/delegation-tools.js';

const folder = mkdtempSync(path.join(os.tmpdir(), 'cr-list-metrics-'));
const parent = addChat('sess-lm-p', 'lm-parent', null, folder, 'm', { agentTransport: 'testfake', sdkMode: 'agent' });
const list = DELEGATION_MCP_TOOLS.find((item) => item.name === 'delegation_list');
const ctx = { client: createInProcessMcpClient({ chatId: parent.id, workspaceFolder: folder }), session: { chatId: parent.id, workspaceFolder: folder } };

function row(metrics) {
  const created = createDelegationRecord({
    parentChatId: parent.id, workspaceFolder: folder, executionFolder: folder,
    executor: { transport: 'claude', model: 'm' }, status: 'completed', assignment: 'implement',
  });
  return metrics ? updateDelegationRecord(created.id, { metrics }) : created;
}

test('compact rows expose only measured metric keys; unmeasured attempts omit the field; full keeps legacy shape', async () => {
  const measured = row({ tokens_in: 10, tokens_out: 2, cache_read_tokens: 7, billing_mode: 'subscription', usage_coverage: 'partial' });
  const bare = row(null);
  const compact = (await list.handler({ limit: 10 }, ctx)).structuredContent.items;
  const byId = new Map(compact.map((item) => [item.id, item]));
  assert.deepEqual(byId.get(measured.id).metrics, {
    tokens_in: 10, tokens_out: 2, cache_read_tokens: 7, billing_mode: 'subscription', usage_coverage: 'partial',
  });
  assert.equal(Object.hasOwn(byId.get(bare.id), 'metrics'), false);
  const full = (await list.handler({ limit: 10, detail: 'full' }, ctx)).structuredContent.items;
  for (const item of full) assert.equal(Object.hasOwn(item, 'metrics'), false, 'legacy full row is unchanged');
});
