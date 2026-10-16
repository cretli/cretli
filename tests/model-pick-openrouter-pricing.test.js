/**
 * Catalog-tools wiring for the shadow cost proxy (follow-up F3).
 *
 * `model_pick` must hand the network-free OpenRouter pricing getter to the pick
 * service, so an OpenRouter candidate is priced from the exact catalog rate
 * (`basis: rate`) instead of always falling back to the tier table.
 */
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG_MCP_TOOLS } from '../lib/mcp/builtin/catalog-tools.js';
import { writeOpenRouterPricingCache } from '../lib/openrouter/openrouter-pricing-cache.js';

const workspace = mkdtempSync(path.join(os.tmpdir(), 'cr-or-pricing-'));
const client = {
  async listHarnessCatalog() {
    return [{ id: 'openrouter', enabled: true, ready: true, can_delegate: true }];
  },
  async listHarnessModels({ harness }) {
    if (harness !== 'openrouter') return { favorites_configured: false, items: [] };
    return {
      favorites_configured: true,
      items: [{ id: 'acme/x', roles: ['implement'], cost_tier: 3, quality_tier: 3, speed_tier: 3 }],
    };
  },
  async getTodo() {
    return null;
  },
};
const session = { chatId: 'chat-or', workspaceFolder: workspace, harness: 'opencode', mode: 'agent' };
const tool = CATALOG_MCP_TOOLS.find((row) => row.name === 'model_pick');
assert.ok(tool, 'model_pick tool exists');

writeOpenRouterPricingCache([{
  id: 'acme/x',
  name: 'Acme X',
  pricing: { prompt: '0.000001', completion: '0.000004' },
}]);

const picked = await tool.handler({ role: 'implement' }, { client, session });
assert.notEqual(picked.isError, true, picked.content?.[0]?.text);
assert.equal(picked.structuredContent.pick.harness, 'openrouter');
assert.equal(picked.structuredContent.cost_proxy.unit, 'rcu');
assert.equal(
  picked.structuredContent.cost_proxy.selected.basis,
  'rate',
  'the cached OpenRouter catalog price is used as the exact rate',
);
// `acme/x` has no static rate, so a `tier_table` basis would prove the pricing
// getter was not wired; the only exact source for it is the OpenRouter cache.

removeIsolatedDataDir();
console.log('model-pick-openrouter-pricing.test.js OK');
