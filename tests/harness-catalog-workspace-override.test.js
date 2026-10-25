/**
 * F2 regression: a workspace-scoped `empty_favorites=all` must reach the model
 * catalog used by `model_pick` / `model_list`. The handlers forward
 * `workspaceFolder`; the catalog resolves the per-workspace delegation env from
 * it instead of falling back to `process.env`.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { listHarnessModels } from '../lib/harness-catalog.js';
import { clearDelegationEnvCache } from '../lib/delegation-settings.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { saveSettings } from '../lib/persist/settings.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { tempDir } from './helpers/temp-git-repo.js';

const workspace = tempDir('cretli-f2-ws-');
const previousEmptyFavorites = process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
const previousMcpWorkspace = process.env.CRETLI_MCP_WORKSPACE;

// The process env denies empty favorites; only the workspace record says "all".
process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = 'deny';
delete process.env.CRETLI_MCP_WORKSPACE;
saveSettings({ deepseekChatEnabledModels: [] });
saveDelegationSettings(workspace, { empty_favorites: 'all' });
clearDelegationEnvCache();

test('workspace empty_favorites=all re-enables rows the process env dropped', () => {
  const withoutWorkspace = listHarnessModels({ harness: 'deepseek', enabledOnly: true });
  assert.equal(withoutWorkspace.favorites_configured, false);
  assert.deepEqual(withoutWorkspace.items, []);

  const withWorkspace = listHarnessModels({
    harness: 'deepseek',
    enabledOnly: true,
    workspaceFolder: workspace,
  });
  assert.ok(withWorkspace.items.length > 0);
  assert.ok(withWorkspace.items.every((row) => row.enabled !== false));
});

test('model_list forwards the session workspaceFolder', async () => {
  const recorded = [];
  const client = {
    async listHarnessModels(input) {
      recorded.push(input);
      return { items: [], source: 'fake', warning: '', favorites_configured: false };
    },
  };
  const handlers = createCretliMcpToolHandlers(client, {
    mode: 'agent',
    harness: 'sdk',
    chatId: 'chat-f2-list',
    workspaceFolder: workspace,
  });
  const result = await handlers.model_list({ harness: 'deepseek', enabled_only: true });
  assert.equal(result.isError, false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].enabledOnly, true);
  assert.equal(recorded[0].workspaceFolder, workspace);
});

test('model_pick forwards the session workspaceFolder to the model list', async () => {
  const recorded = [];
  const client = {
    async listHarnessCatalog() {
      return [{ id: 'opencode', enabled: true, ready: true, can_delegate: true }];
    },
    async listHarnessModels(input) {
      recorded.push(input);
      return {
        favorites_configured: true,
        items: [{ id: 'opencode/test', label: 'Test', roles: ['plan'] }],
      };
    },
  };
  const handlers = createCretliMcpToolHandlers(client, {
    mode: 'agent',
    harness: 'sdk',
    chatId: 'chat-f2-pick',
    workspaceFolder: workspace,
  });
  await handlers.model_pick({ role: 'plan' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].harness, 'opencode');
  assert.equal(recorded[0].enabledOnly, true);
  assert.equal(recorded[0].workspaceFolder, workspace);
  assert.equal(recorded[0].role, 'plan');
});

test('model_list without a workspace keeps working env-only', async () => {
  const recorded = [];
  const client = {
    async listHarnessModels(input) {
      recorded.push(input);
      return { items: [], source: 'fake', warning: '', favorites_configured: false };
    },
  };
  const handlers = createCretliMcpToolHandlers(client, { mode: 'agent', harness: 'sdk' });
  const result = await handlers.model_list({ harness: 'deepseek' });
  assert.equal(result.isError, false);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].workspaceFolder, undefined);
});

test.after(() => {
  if (previousEmptyFavorites == null) delete process.env.CRETLI_DELEGATION_EMPTY_FAVORITES;
  else process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = previousEmptyFavorites;
  if (previousMcpWorkspace == null) delete process.env.CRETLI_MCP_WORKSPACE;
  else process.env.CRETLI_MCP_WORKSPACE = previousMcpWorkspace;
  fs.rmSync(workspace, { recursive: true, force: true });
  removeIsolatedDataDir();
});
