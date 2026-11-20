import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_COMMIT_PUSH_BLOCK,
  NO_DATA_DIR_BLOCK,
  NO_PUSH_DESTRUCTIVE_BLOCK,
  PLAN_GATE_ANCESTOR_BLOCK,
  PROMPT_BLOCKS,
  REVIEWER_POLICY_BLOCK,
} from '../lib/prompts/index.js';
import { buildWorkspaceWatcherCyclePromptPlan } from '../lib/workspace-watcher-prompt.js';
import { TODO_EXECUTION_WORKFLOW } from '../lib/todo-execution-prompt.js';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import { buildBatchWrapperPrompt } from '../lib/integrate-batch.js';

const todo = { id: '11111111-2222-3333-4444-555555555555', title: 'T' };
const cycle = {
  workspaceFolder: '/w',
  watcher: { policy: {} },
  decision: {},
  todo,
  orchestrator: { harness: 'claude', model: 'm', source: 'x' },
  cycleId: 'c1',
};

/** @returns {Array<{ name: string, prompt: string, blocks: string[] }>} */
function migratedPrompts() {
  const batch = { id: 'b1', epoch: 1, workspaceFolder: '/w', baseUrl: 'https://your-pc:3011', entries: [{ mode: 'verify', title: 'X', todoId: 't1' }] };
  const delegation = buildDelegationExecutorPrompt({ sourceKind: 'text', taskText: 'do it', executionMode: 'agent', assignment: 'implement' });
  assert.equal(delegation.ok, true);
  const orchestrator = [NO_COMMIT_PUSH_BLOCK, NO_DATA_DIR_BLOCK, PLAN_GATE_ANCESTOR_BLOCK];
  return [
    { name: 'watcher default', prompt: buildWorkspaceWatcherCyclePromptPlan(cycle).prompt, blocks: orchestrator },
    { name: 'watcher worktree', prompt: buildWorkspaceWatcherCyclePromptPlan({ ...cycle, executionMode: 'worktree' }).prompt, blocks: orchestrator },
    { name: 'watcher plan-only', prompt: buildWorkspaceWatcherCyclePromptPlan({ ...cycle, decision: { planOnly: true } }).prompt, blocks: orchestrator },
    // Without plan approval there is no gate to describe, so the gate block is absent by design.
    { name: 'watcher no approval', prompt: buildWorkspaceWatcherCyclePromptPlan({ ...cycle, watcher: { policy: { requirePlanApproval: false } } }).prompt, blocks: [NO_COMMIT_PUSH_BLOCK, NO_DATA_DIR_BLOCK] },
    { name: 'todo execution', prompt: TODO_EXECUTION_WORKFLOW, blocks: [...orchestrator, REVIEWER_POLICY_BLOCK] },
    { name: 'delegation executor', prompt: delegation.prompt, blocks: [NO_COMMIT_PUSH_BLOCK, NO_DATA_DIR_BLOCK] },
    { name: 'bulk integrate', prompt: buildBatchWrapperPrompt(batch, 'secret'), blocks: [NO_PUSH_DESTRUCTIVE_BLOCK, NO_DATA_DIR_BLOCK] },
  ];
}

const countOf = (text, needle) => text.split(needle).length - 1;

test('registry exports non-empty named blocks', () => {
  for (const [name, text] of Object.entries(PROMPT_BLOCKS)) {
    assert.ok(typeof text === 'string' && text.length > 10, name);
  }
});

test('every migrated prompt contains its required blocks exactly once', () => {
  for (const { name, prompt, blocks } of migratedPrompts()) {
    for (const block of blocks) {
      assert.equal(countOf(prompt, block), 1, `${name}: block "${block.slice(0, 40)}…"`);
    }
  }
});

test('the plan gate block is absent when the workspace requires no plan approval', () => {
  const ungated = buildWorkspaceWatcherCyclePromptPlan({ ...cycle, watcher: { policy: { requirePlanApproval: false } } }).prompt;
  assert.equal(countOf(ungated, PLAN_GATE_ANCESTOR_BLOCK), 0);
});

test('orchestrator prompts mention the ban verbs only through the shared blocks', () => {
  for (const { name, prompt } of migratedPrompts().slice(0, 5)) {
    assert.equal(countOf(prompt, 'under `data/`'), 1, `${name}: data/ ban`);
    assert.equal(countOf(prompt, 'Never commit, push'), 1, `${name}: commit/push ban`);
  }
});

test('a prompt missing a block is detected (negative case)', () => {
  const [{ prompt, blocks }] = migratedPrompts();
  for (const block of blocks) {
    const stripped = prompt.split(block).join('');
    assert.notEqual(countOf(stripped, block), 1);
    const doubled = `${prompt}\n${block}`;
    assert.notEqual(countOf(doubled, block), 1);
  }
});

test('watcher cycle prompt stays >= 20% shorter than the pre-registry baseline', () => {
  // Baselines measured before the registry migration: 5368 (default), 5652 (worktree).
  const baseline = { default: 5368, worktree: 5652 };
  const normal = buildWorkspaceWatcherCyclePromptPlan(cycle);
  const worktree = buildWorkspaceWatcherCyclePromptPlan({ ...cycle, executionMode: 'worktree' });
  assert.equal(normal.tooLong, false);
  assert.equal(worktree.tooLong, false);
  assert.ok(normal.prompt.length <= Math.floor(baseline.default * 0.8), `default ${normal.prompt.length}`);
  assert.ok(worktree.prompt.length <= Math.floor(baseline.worktree * 0.8), `worktree ${worktree.prompt.length}`);
  // Keep >= 600 chars of headroom so each new rule does not immediately trip the 20% limit.
  assert.ok(normal.prompt.length <= Math.floor(baseline.default * 0.8) - 600, `default headroom ${normal.prompt.length}`);
  assert.ok(worktree.prompt.length <= Math.floor(baseline.worktree * 0.8) - 600, `worktree headroom ${worktree.prompt.length}`);
});

test('watcher prompt keeps its behavioural instructions', () => {
  const { prompt } = buildWorkspaceWatcherCyclePromptPlan(cycle);
  for (const needle of ['pick_id', 'review_subject', 'workflow_update', 'delegation_rate', 'delegation_ack', 'record_findings', 'todo_ids', 'report_id', 'cycle_id']) {
    assert.ok(prompt.includes(needle), needle);
  }
});
