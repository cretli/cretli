import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  applyDelegationWorkflowPatch,
  inspectDelegationWorkflowStart,
} from '../lib/delegation-workflow.js';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import {
  buildRegressionGatePromptBlock,
  extractLeafAcceptanceCriteria,
  mergeDelegationOpenFindings,
} from '../lib/delegation-review-gate.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import { selectModelPick } from '../lib/model-role-profiles.js';

const parentId = crypto.randomUUID();

{
  const merged = mergeDelegationOpenFindings('', 'first bug', 'abc123');
  assert.match(merged, /first bug/);
  const again = mergeDelegationOpenFindings(merged, 'first bug', 'abc123');
  assert.equal(again, merged);
}

{
  const block = buildRegressionGatePromptBlock({
    openFindingsText: 'missing dedupe in archive',
    stopReason: 'same_findings',
  });
  assert.match(block, /REGRESSION GATE/);
  assert.match(block, /same_findings/);
  assert.match(block, /missing dedupe/);
}

{
  const body = '**Problem.** x\n\n**Kryteria akceptacji.** Test must FAIL on regression.\n\n**Powiązania.** y';
  const acceptance = extractLeafAcceptanceCriteria(body);
  assert.match(acceptance, /FAIL on regression/);
}

{
  applyDelegationWorkflowPatch({
    parentChatId: parentId,
    lastVerdict: 'FAIL',
    findingsText: 'finding one',
    idempotencyKey: 'r1',
  });
  applyDelegationWorkflowPatch({
    parentChatId: parentId,
    lastVerdict: 'FAIL',
    findingsText: 'finding one',
    idempotencyKey: 'r2',
  });
  const blocked = inspectDelegationWorkflowStart({ parentChatId: parentId });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'workflow_stopped');
  const prompt = buildDelegationExecutorPrompt({
    sourceKind: 'text',
    taskText: 'Review the fix',
    assignment: 'review',
    executionMode: 'agent',
    workflowRow: {
      openFindingsText: 'finding one',
      stopReason: 'same_findings',
    },
    leafAcceptanceText: 'Must re-check prior findings',
  });
  assert.equal(prompt.ok, true);
  assert.match(prompt.prompt, /REGRESSION GATE/);
  assert.match(prompt.prompt, /LEAF ACCEPTANCE/);
  assert.match(prompt.prompt, /Must re-check prior findings/);
}

{
  const chatId = crypto.randomUUID();
  const now = Date.now();
  const delegations = [
    {
      parentChatId: chatId,
      status: 'completed',
      assignment: 'implement',
      pickRole: 'implement',
      executor: { model: 'deepseek-flash' },
      createdAt: new Date(now - 60000).toISOString(),
    },
  ];
  const history = buildModelPickHistory({
    role: 'review',
    chatId,
    delegations,
    harnesses: ['deepseek', 'claude'],
    now,
  });
  assert.ok(history.hardExcludeModels.includes('deepseek-flash'));
  const picked = selectModelPick({
    role: 'review',
    harnesses: [
      { id: 'deepseek', enabled: true, ready: true, can_delegate: true },
      { id: 'claude', enabled: true, ready: true, can_delegate: true },
    ],
    modelsByHarness: {
      deepseek: {
        favorites_configured: true,
        items: [
          { id: 'deepseek-flash', available: true, roles: ['review'] },
        ],
      },
      claude: {
        favorites_configured: true,
        items: [
          { id: 'claude-opus-5-5::effort=low', available: true, roles: ['review'] },
        ],
      },
    },
    history,
  });
  assert.equal(picked.ok, true);
  assert.notEqual(picked.pick.model, 'deepseek-flash');
}

{
  // B1: report_text is the documented field; findings must be derived from it
  // so the regression gate and same_findings fire without findings_text.
  const parent = crypto.randomUUID();
  const first = applyDelegationWorkflowPatch({
    parentChatId: parent,
    lastVerdict: 'FAIL',
    reportText: 'TASK: review\nVERDICT: FAIL\nbug A',
    materialRevision: 'm1',
    idempotencyKey: 'report-r1',
  });
  assert.match(first.openFindingsText, /bug A/);
  const second = applyDelegationWorkflowPatch({
    parentChatId: parent,
    lastVerdict: 'FAIL',
    reportText: 'TASK: review\nVERDICT: FAIL\nbug B',
    materialRevision: 'm1',
    idempotencyKey: 'report-r2',
  });
  assert.notEqual(second.stopReason, 'same_findings');
  assert.match(second.openFindingsText, /bug A/);
  assert.match(second.openFindingsText, /bug B/);
  const third = applyDelegationWorkflowPatch({
    parentChatId: parent,
    lastVerdict: 'FAIL',
    reportText: 'TASK: review\nVERDICT: FAIL\nbug B',
    materialRevision: 'm1',
    idempotencyKey: 'report-r3',
  });
  assert.equal(third.stopReason, 'same_findings');
  assert.equal(third.consecutiveSameFail, 2);
  assert.equal(inspectDelegationWorkflowStart({ parentChatId: parent }).ok, false);
}

{
  // B2: a history-sync patch (countReview false) mirrors an already-recorded
  // FAIL; it must not trip same_findings before a new failure.
  const parent = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId: parent,
    lastVerdict: 'FAIL',
    findingsText: 'finding X',
    findingsHash: 'hashX',
    materialRevision: 'm1',
    idempotencyKey: 'sync-r1',
  });
  const synced = applyDelegationWorkflowPatch({
    parentChatId: parent,
    lastVerdict: 'FAIL',
    round: 1,
    countReview: false,
    idempotencyKey: 'sync-r2',
  });
  assert.equal(synced.consecutiveSameFail, 1);
  assert.notEqual(synced.stopReason, 'same_findings');
  assert.equal(inspectDelegationWorkflowStart({ parentChatId: parent }).ok, true);
}

{
  // B1b: findings from the leaf-keyed Watcher store reach the regression gate.
  const block = buildRegressionGatePromptBlock(
    { openFindingsText: 'workflow finding' },
    'WATCHER_FINDING_ABC',
  );
  assert.match(block, /workflow finding/);
  assert.match(block, /WATCHER_FINDING_ABC/);
  const prompt = buildDelegationExecutorPrompt({
    sourceKind: 'text',
    taskText: 'Review the fix',
    assignment: 'review',
    executionMode: 'agent',
    workflowRow: { openFindingsText: 'workflow finding' },
    watcherFindingsText: 'WATCHER_FINDING_ABC',
  });
  assert.equal(prompt.ok, true);
  assert.match(prompt.prompt, /WATCHER_FINDING_ABC/);
}

console.log('delegation-fix-loop-regression.test.js OK');
