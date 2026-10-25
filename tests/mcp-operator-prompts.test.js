import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  externalMcpInstructions,
  invalidateMcpOperatorGuideCache,
  LOCKED_SAFETY_RULES,
  readOperatorPlaybook,
  validateMcpInstructionOutputs,
  validateMcpOperatorInstructionOverride,
} from '../lib/mcp/mcp-external-guide.js';
import {
  decideMcpOperatorPromptProposal,
  listMcpOperatorPromptHistory,
  listMcpOperatorPromptProposals,
  proposeMcpOperatorPromptChange,
  readMcpOperatorPromptOverrides,
  resetMcpOperatorPromptOverride,
  setMcpOperatorPromptOverride,
} from '../lib/mcp/mcp-operator-prompt-store.js';

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-mcp-operator-data-'));
  const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-mcp-operator-ws-'));
  return { dataDir, workspaceFolder, cleanup: () => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(workspaceFolder, { recursive: true, force: true }); invalidateMcpOperatorGuideCache(); } };
}

test('workspace overrides merge by mode while locked safety rules remain immutable', (t) => {
  const f = fixture(); t.after(f.cleanup);
  setMcpOperatorPromptOverride(f.workspaceFolder, 'common', '- Custom common rule.', { dataDir: f.dataDir });
  setMcpOperatorPromptOverride(f.workspaceFolder, 'operator', '- Custom operator rule.', { dataDir: f.dataDir });
  invalidateMcpOperatorGuideCache(f.workspaceFolder);
  const plan = externalMcpInstructions('plan', f.workspaceFolder, { dataDir: f.dataDir });
  const operator = externalMcpInstructions('operator', f.workspaceFolder, { dataDir: f.dataDir });
  assert.match(plan, /Custom common rule/);
  assert.doesNotMatch(plan, /Custom operator rule/);
  assert.match(operator, /Custom operator rule/);
  for (const locked of LOCKED_SAFETY_RULES) {
    assert.ok(plan.includes(locked));
    assert.ok(operator.includes(locked));
  }
  resetMcpOperatorPromptOverride(f.workspaceFolder, 'common', { dataDir: f.dataDir });
  invalidateMcpOperatorGuideCache(f.workspaceFolder);
  assert.doesNotMatch(externalMcpInstructions('plan', f.workspaceFolder, { dataDir: f.dataDir }), /Custom common rule/);
});

test('3500/3501 boundaries are enforced independently for plan, agent and operator outputs', (t) => {
  const f = fixture(); t.after(f.cleanup);
  for (const mode of ['plan', 'agent', 'operator']) {
    const exact = validateMcpInstructionOutputs({ [mode]: 'x'.repeat(3500) });
    assert.equal(exact.ok, true, `${mode} accepts exactly 3500 characters`);
    assert.deepEqual(exact.modes, [{ mode, chars: 3500, overBudget: false }]);
    const over = validateMcpInstructionOutputs({ [mode]: 'x'.repeat(3501) });
    assert.equal(over.ok, false, `${mode} rejects 3501 characters`);
    assert.deepEqual(over.modes, [{ mode, chars: 3501, overBudget: true }]);
  }
  const validation = validateMcpOperatorInstructionOverride(f.workspaceFolder, 'operator', `- ${'x'.repeat(3400)}`, { dataDir: f.dataDir });
  assert.equal(validation.ok, false);
  assert.match(validation.error, /3500/);
  assert.deepEqual(validation.modes.map((row) => row.mode), ['operator'], 'operator edits validate only their applicable output');
  const common = validateMcpOperatorInstructionOverride(f.workspaceFolder, 'common', '- Common candidate.', { dataDir: f.dataDir });
  assert.equal(common.ok, true);
  assert.deepEqual(common.modes.map((row) => row.mode), ['plan', 'agent', 'operator'], 'common edits validate every affected mode');
  assert.deepEqual(readMcpOperatorPromptOverrides(f.workspaceFolder, { dataDir: f.dataDir }), {});
});

test('operator proposals need a separate human decision and approval records history', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const proposal = proposeMcpOperatorPromptChange(f.workspaceFolder, 'common', '- Proposed common rule.', 'Make the workflow clearer.', { dataDir: f.dataDir, id: 'proposal-1' });
  assert.equal(proposal.status, 'pending');
  assert.deepEqual(readMcpOperatorPromptOverrides(f.workspaceFolder, { dataDir: f.dataDir }), {}, 'proposal is not active');
  assert.equal(listMcpOperatorPromptProposals(f.workspaceFolder, { dataDir: f.dataDir })[0].status, 'pending');
  decideMcpOperatorPromptProposal(f.workspaceFolder, proposal.id, true, { dataDir: f.dataDir });
  assert.equal(readMcpOperatorPromptOverrides(f.workspaceFolder, { dataDir: f.dataDir }).common, '- Proposed common rule.');
  assert.equal(listMcpOperatorPromptHistory(f.workspaceFolder, { dataDir: f.dataDir })[0].action, 'approve-proposal');
});

test('playbook cache is invalidated without restarting', (t) => {
  const f = fixture(); t.after(f.cleanup);
  assert.match(readOperatorPlaybook(f.workspaceFolder, { dataDir: f.dataDir }), /Cretli operator playbook/);
  setMcpOperatorPromptOverride(f.workspaceFolder, 'playbook', '# Workspace playbook', { dataDir: f.dataDir });
  assert.doesNotMatch(readOperatorPlaybook(f.workspaceFolder, { dataDir: f.dataDir }), /Workspace playbook/, 'cached value remains until invalidated');
  invalidateMcpOperatorGuideCache(f.workspaceFolder);
  assert.equal(readOperatorPlaybook(f.workspaceFolder, { dataDir: f.dataDir }), '# Workspace playbook');
});
