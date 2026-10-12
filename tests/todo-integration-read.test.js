import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachTodoIntegrationReadModels,
  summarizeTodoIntegration,
} from '../lib/todo-integration-read.js';
import { fingerprintTodoMaterial, fingerprintTodoTree } from '../lib/todo-integration-proof.js';

function withProof(todo, targetCommit = 'a'.repeat(40)) {
  return {
    ...todo,
    integration: {
      state: 'integrated',
      evidence: {
        targetBranch: 'main',
        targetCommit,
        sourceCommit: 'b'.repeat(40),
        materialRevision: 'material-1',
        cycleId: 'cycle-1',
        source: 'human_project',
        confirmedAt: '2026-10-11T00:00:00.000Z',
        changeRef: `TODO ${todo.id}: verified change`,
        branchVerified: true,
        changeAttested: true,
        todoMaterialFingerprint: fingerprintTodoMaterial(todo),
      },
    },
  };
}

test('legacy and ready integration states are read without inferring target proof', () => {
  assert.equal(summarizeTodoIntegration({ id: 'legacy', status: 'done', integration: { state: 'integrated' } }).detail, 'legacy_confirmation');
  assert.equal(summarizeTodoIntegration({ id: 'empty', status: 'done' }).state, 'unconfirmed');
  assert.equal(summarizeTodoIntegration({ id: 'project', status: 'doing', executionMode: 'project' }).state, 'unconfirmed');
  assert.equal(summarizeTodoIntegration({ id: 'ready', status: 'done', integration: { state: 'ready' } }).state, 'awaiting');
  assert.equal(summarizeTodoIntegration({ id: 'applied', integration: { state: 'ready', appliedAt: '2026-10-11' } }).detail, 'working_directory_applied');
  assert.equal(summarizeTodoIntegration({ id: 'rejected', integration: { state: 'rejected', reason: 'human rejected' } }).detail, 'rejected');
  assert.equal(summarizeTodoIntegration({ id: 'conflict', integration: { state: 'ready', reason: 'integration_conflict' } }).detail, 'conflict');
});

test('a target proof is current only for the exact task material', () => {
  const original = withProof({ id: 'task-a', body: 'specific task material', status: 'done' });
  assert.equal(summarizeTodoIntegration(original).state, 'integrated');
  assert.equal(summarizeTodoIntegration({ ...original, body: 'changed task material' }).state, 'unconfirmed');
  assert.equal(summarizeTodoIntegration({ ...original, title: 'Cosmetic title edit' }).state, 'integrated');
});

test('a human no-code classification is tied to task material', () => {
  const task = { id: 'no-code', body: 'Documentation only', status: 'done' };
  const recorded = {
    ...task,
    integration: {
      state: 'integrated',
      changeScope: 'none',
      noCodeReason: 'No source files changed.',
      noCodeMaterialFingerprint: fingerprintTodoMaterial(task),
    },
  };
  assert.equal(summarizeTodoIntegration(recorded).detail, 'no_code_changes');
  assert.equal(summarizeTodoIntegration({ ...recorded, body: 'Now changes code' }).detail, 'stale_evidence');
});

test('parent integration aggregates required leaves by target branch, not done status', () => {
  const all = attachTodoIntegrationReadModels([
    { id: 'parent', title: 'root', status: 'done' },
    withProof({ id: 'leaf-a', parentId: 'parent', status: 'done', siblingIndex: 0 }, 'a'.repeat(40)),
    withProof({ id: 'leaf-b', parentId: 'parent', status: 'done', siblingIndex: 1 }, 'c'.repeat(40)),
  ]);
  assert.equal(all.find((row) => row.id === 'parent').integrationSummary.state, 'integrated');
  const partial = attachTodoIntegrationReadModels([
    { id: 'parent', status: 'done' },
    withProof({ id: 'leaf-a', parentId: 'parent', status: 'done' }),
    { id: 'leaf-b', parentId: 'parent', status: 'done', integration: { state: 'ready' } },
  ]);
  assert.equal(partial.find((row) => row.id === 'parent').integrationSummary.state, 'partial');
  assert.deepEqual(partial.find((row) => row.id === 'parent').integrationSummary.aggregate, {
    confirmed: 1, required: 2, rejected: 0, conflicts: 0, missing: 1,
  });
  const noCodeLeaf = {
    id: 'leaf-no-code', parentId: 'parent', status: 'done',
    body: 'No source change',
    integration: {
      state: 'integrated', changeScope: 'none',
      noCodeMaterialFingerprint: fingerprintTodoMaterial({ id: 'leaf-no-code', parentId: 'parent', status: 'done', body: 'No source change' }),
    },
  };
  const covered = attachTodoIntegrationReadModels([
    { id: 'parent', status: 'done' },
    withProof({ id: 'leaf-a', parentId: 'parent', status: 'done' }),
    noCodeLeaf,
  ]);
  assert.equal(covered.find((row) => row.id === 'parent').integrationSummary.state, 'integrated');
  assert.deepEqual(covered.find((row) => row.id === 'parent').integrationSummary.aggregate, {
    confirmed: 1, required: 1, rejected: 0, conflicts: 0, missing: 0,
  });
});

test('an explicit parent tree proof takes precedence and expires when descendant material changes', () => {
  const parent = { id: 'parent-tree', title: 'root', status: 'done', body: 'whole tree' };
  const leaf = { id: 'leaf-tree', parentId: parent.id, title: 'leaf', status: 'done', body: 'leaf material' };
  const tree = [parent, leaf];
  const proofParent = withProof(parent);
  proofParent.integration.evidence.scope = 'tree';
  proofParent.integration.evidence.treeMaterialFingerprint = fingerprintTodoTree(tree, parent.id);
  const attached = attachTodoIntegrationReadModels([proofParent, leaf]);
  assert.equal(attached.find((row) => row.id === parent.id).integrationSummary.state, 'integrated');
  assert.deepEqual(attached.find((row) => row.id === parent.id).integrationSummary.aggregate, { confirmed: 1, required: 1 });
  const coveredLeaf = attached.find((row) => row.id === leaf.id).integrationSummary;
  assert.equal(coveredLeaf.state, 'integrated');
  assert.equal(coveredLeaf.detail, '');
  assert.equal(coveredLeaf.coveredByTreeId, parent.id);
  assert.equal(coveredLeaf.hasCurrentEvidence, false);

  const changed = attachTodoIntegrationReadModels([proofParent, { ...leaf, body: 'changed leaf material' }]);
  assert.equal(changed.find((row) => row.id === parent.id).integrationSummary.state, 'unconfirmed');
  assert.equal(changed.find((row) => row.id === leaf.id).integrationSummary.state, 'unconfirmed');
});

test('a proof stays current when the read path hydrates the plan from the workspace file', () => {
  const stored = { id: 'task-plan', body: 'task', status: 'done', plan: { markdown: '# Plan\n' } };
  const proofed = withProof(stored);
  const hydrated = { ...proofed, plan: { markdown: '# Plan' }, planStoredMarkdown: '# Plan\n' };
  assert.equal(summarizeTodoIntegration(hydrated).state, 'integrated');
  assert.equal(summarizeTodoIntegration({ ...hydrated, planStoredMarkdown: '# Another plan\n' }).state, 'unconfirmed');
});
