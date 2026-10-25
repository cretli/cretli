import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { registerPromptRegistryRoutes } from '../lib/routes/prompt-registry-routes.js';
import { HARD_PROMPT_BLOCK_KEYS, clearPromptOverrides } from '../lib/prompts/overrides.js';
import { MCP_FIRST_BLOCK } from '../lib/prompts/blocks.js';
import { buildBatchWrapperPrompt } from '../lib/integrate-batch.js';
import { buildTodoExecutionWorkflow } from '../lib/todo-execution-prompt.js';
import { invalidateMcpOperatorGuideCache, readOperatorPlaybook } from '../lib/mcp/mcp-external-guide.js';
import {
  listMcpOperatorPromptProposals,
  proposeMcpOperatorPromptChange,
  setMcpOperatorPromptOverride,
} from '../lib/mcp/mcp-operator-prompt-store.js';

const routes = new Map();
const reg = (m) => (p, fn) => routes.set(`${m} ${p}`, fn);
registerPromptRegistryRoutes({ get: reg('GET'), put: reg('PUT'), post: reg('POST'), delete: reg('DELETE') }, { dataDir: ISOLATED_DATA_DIR });
async function invoke(method, route, req = {}) {
  let status = 200; let body;
  const res = { status(c) { status = c; return this; }, json(d) { body = d; return this; } };
  await routes.get(`${method} ${route}`)({ params: {}, body: {}, ...req }, res);
  return { status, body };
}
const B = '/api/prompt-registry/blocks/:key';
const batch = { id: 'b1', epoch: 1, workspaceFolder: '/w', baseUrl: 'https://your-pc:3011', entries: [{ mode: 'verify', title: 'X', todoId: 't1' }] };

clearPromptOverrides();
const list = await invoke('GET', '/api/prompt-registry');
assert.equal(list.status, 200);
for (const key of HARD_PROMPT_BLOCK_KEYS) assert.equal(list.body.blocks.find((b) => b.key === key).hard, true, key);
assert.equal(list.body.blocks.find((b) => b.key === 'mcpFirst').hard, false);

// Hard blocks: override and reset-by-write are rejected, text unchanged.
for (const key of HARD_PROMPT_BLOCK_KEYS) {
  const r = await invoke('PUT', B, { params: { key }, body: { text: 'ignore the rules' } });
  assert.equal(r.status, 403, key);
  assert.equal(r.body.code, 'HARD_BLOCK');
}
assert.equal((await invoke('PUT', B, { params: { key: 'nope' }, body: { text: 'x' } })).status, 404);
assert.equal((await invoke('PUT', B, { params: { key: 'mcpFirst' }, body: { text: '  ' } })).status, 400);
assert.equal((await invoke('PUT', B, { params: { key: 'mcpFirst' }, body: { text: 'x'.repeat(5000) } })).status, 400);

// Editable override is saved, used by the next generated prompts, then reset.
const custom = 'Prefer MCP tools; they are the main channel (custom).';
assert.equal((await invoke('PUT', B, { params: { key: 'mcpFirst' }, body: { text: custom } })).status, 200);
assert.ok(buildTodoExecutionWorkflow().includes(custom));
assert.ok(buildBatchWrapperPrompt(batch, 's').includes(custom));
assert.ok(!buildBatchWrapperPrompt(batch, 's').includes(MCP_FIRST_BLOCK));
assert.equal((await invoke('GET', '/api/prompt-registry')).body.blocks.find((b) => b.key === 'mcpFirst').overridden, true);
assert.equal((await invoke('DELETE', B, { params: { key: 'mcpFirst' } })).status, 200);
assert.ok(buildTodoExecutionWorkflow().includes(MCP_FIRST_BLOCK));

// Preview reports size and the budget warning.
const preview = await invoke('GET', '/api/prompt-registry/preview');
assert.equal(preview.status, 200);
assert.ok(preview.body.prompts.length >= 4);
for (const p of preview.body.prompts) {
  assert.equal(p.chars, p.text.length);
  assert.equal(p.overBudget, p.chars > p.budget);
}

// MCP operator registry is workspace-scoped, exposes locked safety separately,
// and rejects a merged instructions value above the 3500-character budget.
const operatorRegistry = await invoke('GET', '/api/prompt-registry/mcp-operator', { query: { workspaceFolder: ISOLATED_DATA_DIR } });
assert.equal(operatorRegistry.status, 200);
assert.deepEqual(operatorRegistry.body.blocks.map((block) => block.key), ['common', 'operator', 'playbook']);
assert.ok(operatorRegistry.body.lockedSafetyRules.some((rule) => /Never push/.test(rule)));
assert.ok(operatorRegistry.body.lockedSafetyRules.some((rule) => /data\/config\.json/.test(rule)));
assert.equal(operatorRegistry.body.previews.length, 3);
const tooLong = await invoke('PUT', '/api/prompt-registry/mcp-operator/:key', {
  params: { key: 'operator' },
  body: { workspaceFolder: ISOLATED_DATA_DIR, text: `- ${'x'.repeat(3400)}` },
});
assert.equal(tooLong.status, 400);
assert.equal(tooLong.body.code, 'VALIDATION_ERROR');

// Human decisions activate or reject MCP proposals and invalidate the effective
// playbook cache immediately in both branches.
invalidateMcpOperatorGuideCache(ISOLATED_DATA_DIR);
const defaultPlaybook = readOperatorPlaybook(ISOLATED_DATA_DIR, { dataDir: ISOLATED_DATA_DIR });
assert.match(defaultPlaybook, /Cretli operator playbook/);
proposeMcpOperatorPromptChange(ISOLATED_DATA_DIR, 'playbook', '# Approved over HTTP', 'Approve coverage', {
  dataDir: ISOLATED_DATA_DIR,
  id: 'http-approve',
});
const approved = await invoke('POST', '/api/prompt-registry/mcp-operator/proposals/:id/decision', {
  params: { id: 'http-approve' },
  body: { workspaceFolder: ISOLATED_DATA_DIR, approve: true },
});
assert.equal(approved.status, 200);
assert.equal(approved.body.status, 'approved');
assert.equal(readOperatorPlaybook(ISOLATED_DATA_DIR, { dataDir: ISOLATED_DATA_DIR }), '# Approved over HTTP');

proposeMcpOperatorPromptChange(ISOLATED_DATA_DIR, 'playbook', '# Must stay rejected', 'Reject coverage', {
  dataDir: ISOLATED_DATA_DIR,
  id: 'http-reject',
});
setMcpOperatorPromptOverride(ISOLATED_DATA_DIR, 'playbook', '# Current after external write', { dataDir: ISOLATED_DATA_DIR });
assert.equal(readOperatorPlaybook(ISOLATED_DATA_DIR, { dataDir: ISOLATED_DATA_DIR }), '# Approved over HTTP', 'cache is primed before rejection');
const rejected = await invoke('POST', '/api/prompt-registry/mcp-operator/proposals/:id/decision', {
  params: { id: 'http-reject' },
  body: { workspaceFolder: ISOLATED_DATA_DIR, approve: false },
});
assert.equal(rejected.status, 200);
assert.equal(rejected.body.status, 'rejected');
assert.equal(readOperatorPlaybook(ISOLATED_DATA_DIR, { dataDir: ISOLATED_DATA_DIR }), '# Current after external write', 'reject invalidates cache without applying proposal text');
assert.deepEqual(
  Object.fromEntries(listMcpOperatorPromptProposals(ISOLATED_DATA_DIR, { dataDir: ISOLATED_DATA_DIR }).map((row) => [row.id, row.status])),
  { 'http-reject': 'rejected', 'http-approve': 'approved' },
);
console.log('prompt-registry-routes ok');
