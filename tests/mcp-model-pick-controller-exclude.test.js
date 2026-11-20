import './helpers/isolated-data-dir.js';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { CATALOG_MCP_TOOLS } from '../lib/mcp/builtin/catalog-tools.js';
import { setBuiltinMcpRuntimeDeps } from '../lib/mcp/builtin/runtime-deps.js';

setBuiltinMcpRuntimeDeps({ dataDir: ISOLATED_DATA_DIR });
const modelPick = CATALOG_MCP_TOOLS.find((tool) => tool.name === 'model_pick');

// Two claude-family models; the orchestrator chat runs the first (with an effort suffix).
const harnesses = [{ id: 'claude', enabled: true, ready: true, can_delegate: true }];
const models = {
  favorites_configured: true,
  items: [
    { id: 'claude-sonnet-5-5', label: 'Sonnet', favorite: true },
    { id: 'claude-opus-5-5', label: 'Opus', favorite: true },
  ],
};
const client = {
  listHarnessCatalog: async () => harnesses,
  listHarnessModels: async () => models,
};

async function pick(role, orchestratorModel) {
  const chat = addChat(crypto.randomUUID(), 'orch', null, ISOLATED_DATA_DIR, orchestratorModel, {
    agentTransport: 'claude',
    sdkMode: 'agent',
  });
  const res = await modelPick.handler(
    { role, explore: false, shadow: false },
    { client, session: { chatId: chat.id, workspaceFolder: ISOLATED_DATA_DIR } },
  );
  return res.structuredContent?.pick?.model || '';
}

test('MCP model_pick excludes the orchestrator base model for review (alias + effort)', async () => {
  const out = await pick('review', 'sonnet::effort=medium');
  assert.equal(out, 'claude-opus-5-5');
});

test('MCP model_pick does not exclude the orchestrator model for implement', async () => {
  const out = await pick('implement', 'sonnet::effort=medium');
  assert.equal(out, 'claude-sonnet-5-5');
});
