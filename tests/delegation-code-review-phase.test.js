import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  applyDelegationWorkflowPatch,
  inspectDelegationWorkflowStart,
} from '../lib/delegation-workflow.js';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import {
  buildAuditReviewPromptBlock,
  buildClosureReviewPromptBlock,
  buildCodeReviewClosureRoundKey,
  buildCodeReviewWorkflowPatchOnClosureStart,
  buildCodeReviewWorkflowPatchOnFinish,
  resolveCodeReviewPhaseWorkflowIdempotencyKey,
  DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED,
  inspectDelegationCodeReviewStart,
  isCredibleCodeReviewTerminal,
  reconcileClosureReviewVerdict,
  resolveDelegationCodeReviewMode,
  resolveEffectiveCodeReviewReportVerdict,
} from '../lib/delegation-code-review-phase.js';
import { buildModelPickHistory } from '../lib/model-pick-history.js';
import { selectModelPick } from '../lib/model-role-profiles.js';

const parentId = crypto.randomUUID();
const leafId = crypto.randomUUID();

{
  const mode = resolveDelegationCodeReviewMode({
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    workflow: { codeReviewAuditDone: false },
  });
  assert.equal(mode, 'audit');
  const closureMode = resolveDelegationCodeReviewMode({
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    workflow: { codeReviewAuditDone: true },
  });
  assert.equal(closureMode, 'closure');
  assert.equal(resolveDelegationCodeReviewMode({
    assignment: 'review',
    reviewSubject: 'plan',
    leafId,
    workflow: {},
  }), '');
}

{
  const auditPrompt = buildDelegationExecutorPrompt({
    sourceKind: 'text',
    taskText: 'Review code',
    assignment: 'review',
    executionMode: 'agent',
    reviewMode: 'audit',
    leafAcceptanceText: 'Must pass unit tests',
  });
  assert.equal(auditPrompt.ok, true);
  assert.match(auditPrompt.prompt, /\[CODE REVIEW AUDIT\]/);
  assert.match(auditPrompt.prompt, /Must pass unit tests/);
  assert.doesNotMatch(auditPrompt.prompt, /\[CODE REVIEW CLOSURE\]/);
  assert.doesNotMatch(auditPrompt.prompt, /Do not run a fresh full audit/);
  const closurePrompt = buildDelegationExecutorPrompt({
    sourceKind: 'text',
    taskText: 'Review code',
    assignment: 'review',
    executionMode: 'agent',
    reviewMode: 'closure',
    workflowRow: { openFindingsText: 'F1 (P1): missing guard' },
  });
  assert.equal(closurePrompt.ok, true);
  assert.match(closurePrompt.prompt, /\[CODE REVIEW CLOSURE\]/);
  assert.match(closurePrompt.prompt, /F1 \(P1\)/);
  assert.match(closurePrompt.prompt, /FOLLOW_UP/);
  assert.doesNotMatch(closurePrompt.prompt, /\[CODE REVIEW AUDIT\]/);
  assert.doesNotMatch(closurePrompt.prompt, /Perform a full scoped audit/);
  const emptyClosure = buildDelegationExecutorPrompt({
    sourceKind: 'text',
    taskText: 'Review code',
    assignment: 'review',
    executionMode: 'agent',
    reviewMode: 'closure',
    workflowRow: {},
  });
  assert.equal(emptyClosure.ok, true);
  assert.match(emptyClosure.prompt, /Verify only regressions/);
  assert.doesNotMatch(emptyClosure.prompt, /Perform a full scoped audit/);
}

{
  assert.match(buildAuditReviewPromptBlock('Acceptance line'), /OUT_OF_SCOPE/);
  assert.match(buildClosureReviewPromptBlock({}, ''), /Verify only regressions/);
}

{
  assert.equal(reconcileClosureReviewVerdict('F1 STILL_OPEN (P1)', 'FAIL'), 'FAIL');
  assert.equal(reconcileClosureReviewVerdict([
    'F1 FIXED with test evidence',
    'VERDICT: FAIL',
    '[FOLLOW_UP]',
    'F9 (P2): style nit',
  ].join('\n'), 'FAIL'), 'PASS');
  const followUpReport = [
    'F1 FIXED with test evidence',
    'VERDICT: FAIL',
    '[FOLLOW_UP]',
    'F9 (P2): style nit',
  ].join('\n');
  assert.equal(resolveEffectiveCodeReviewReportVerdict({
    reviewSubject: 'code',
    reviewMode: 'closure',
    report: followUpReport,
    reportVerdict: 'FAIL',
  }), 'PASS');
  assert.equal(resolveEffectiveCodeReviewReportVerdict({
    reviewSubject: 'code',
    reviewMode: 'audit',
    report: followUpReport,
    reportVerdict: 'FAIL',
  }), 'FAIL');
}

{
  const chatId = crypto.randomUUID();
  const now = Date.now();
  const auditModel = 'claude-opus-5-5::effort=low';
  const history = buildModelPickHistory({
    role: 'review',
    chatId,
    leafId,
    codeReviewAuditDone: true,
    codeReviewAuditReviewer: `claude/${auditModel}`,
    delegations: [
      {
        parentChatId: chatId,
        leafId,
        status: 'completed',
        assignment: 'review',
        pickRole: 'review',
        executor: { transport: 'claude', model: auditModel },
        reviewMode: 'audit',
        report: 'VERDICT: PASS\nAll good',
        reportVerdict: 'PASS',
        createdAt: new Date(now - 120000).toISOString(),
      },
      {
        parentChatId: chatId,
        status: 'completed',
        assignment: 'implement',
        pickRole: 'implement',
        executor: { transport: 'deepseek', model: 'deepseek-chat' },
        createdAt: new Date(now - 180000).toISOString(),
      },
    ],
    harnesses: ['claude', 'deepseek'],
    now,
  });
  assert.ok(history.leafReviewSticky);
  assert.equal(history.leafReviewSticky.key, `claude/${auditModel}`);
  const picked = selectModelPick({
    role: 'review',
    harnesses: [
      { id: 'claude', enabled: true, ready: true, can_delegate: true },
      { id: 'deepseek', enabled: true, ready: true, can_delegate: true },
    ],
    modelsByHarness: {
      claude: {
        favorites_configured: true,
        items: [{ id: auditModel, available: true, roles: ['review'] }],
      },
      deepseek: {
        favorites_configured: true,
        items: [{ id: 'deepseek-chat', available: true, roles: ['review'] }],
      },
    },
    history,
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.pick.model, auditModel);
}

{
  const chatId = crypto.randomUUID();
  const now = Date.now();
  const auditModel = 'claude-opus-5-5::effort=low';
  const altModel = 'deepseek-chat';
  const history = buildModelPickHistory({
    role: 'review',
    chatId,
    leafId,
    codeReviewAuditDone: true,
    codeReviewAuditReviewer: `claude/${auditModel}`,
    delegations: [
      {
        parentChatId: chatId,
        leafId,
        status: 'completed',
        assignment: 'review',
        pickRole: 'review',
        executor: { transport: 'claude', model: auditModel },
        reviewMode: 'audit',
        report: 'VERDICT: PASS',
        reportVerdict: 'PASS',
        createdAt: new Date(now - 180000).toISOString(),
      },
      {
        parentChatId: chatId,
        leafId,
        status: 'completed',
        assignment: 'implement',
        pickRole: 'implement',
        executor: { transport: 'openrouter', model: 'other-implementer' },
        createdAt: new Date(now - 120000).toISOString(),
      },
      {
        parentChatId: chatId,
        leafId,
        status: 'failed',
        assignment: 'review',
        pickRole: 'review',
        executor: { transport: 'claude', model: auditModel },
        reviewMode: 'closure',
        error: 'adapter timeout',
        createdAt: new Date(now - 60000).toISOString(),
      },
    ],
    harnesses: ['claude', 'deepseek'],
    now,
  });
  assert.equal(history.leafReviewSticky, null);
  const picked = selectModelPick({
    role: 'review',
    harnesses: [
      { id: 'claude', enabled: true, ready: true, can_delegate: true },
      { id: 'deepseek', enabled: true, ready: true, can_delegate: true },
    ],
    modelsByHarness: {
      claude: {
        favorites_configured: true,
        items: [{ id: auditModel, available: true, roles: ['review'] }],
      },
      deepseek: {
        favorites_configured: true,
        items: [{ id: altModel, available: true, roles: ['review'] }],
      },
    },
    history,
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.pick.model, altModel);
}

function applyCodeReviewFinishPatch(delegation, workflow) {
  const patch = buildCodeReviewWorkflowPatchOnFinish(delegation, workflow);
  if (!patch) return workflow;
  return applyDelegationWorkflowPatch({
    ...patch,
    idempotencyKey: resolveCodeReviewPhaseWorkflowIdempotencyKey(delegation, workflow),
    countReview: false,
  });
}

{
  applyDelegationWorkflowPatch({
    parentChatId: parentId,
    leafId,
    codeReviewAuditDone: true,
    codeReviewAuditReviewer: 'claude/reviewer-a',
    codeReviewClosureCount: 0,
    round: 1,
    materialRevision: 'rev-a',
    idempotencyKey: 'audit-done',
  });
  let workflow = applyDelegationWorkflowPatch({
    parentChatId: parentId,
    leafId,
    countReview: false,
    idempotencyKey: 'noop',
  });
  const closureFail = {
    id: crypto.randomUUID(),
    parentChatId: parentId,
    leafId,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: 'closure',
    report: 'VERDICT: FAIL\nF1 STILL_OPEN',
    reportVerdict: 'FAIL',
    executor: { transport: 'claude', model: 'reviewer-a' },
  };
  workflow = applyCodeReviewFinishPatch(closureFail, workflow);
  assert.equal(workflow.codeReviewClosureCount, 1);
  workflow = applyCodeReviewFinishPatch({
    ...closureFail,
    id: crypto.randomUUID(),
    attemptId: 'fanout-2',
  }, workflow);
  assert.equal(workflow.codeReviewClosureCount, 1, 'fanout second finish must not double-count');
  workflow = applyCodeReviewFinishPatch(closureFail, workflow);
  assert.equal(workflow.codeReviewClosureCount, 1, 'retry same delegation id must not double-count');
  workflow = applyDelegationWorkflowPatch({
    parentChatId: parentId,
    leafId,
    round: 2,
    materialRevision: 'rev-b',
    idempotencyKey: 'cycle-2',
  });
  workflow = applyCodeReviewFinishPatch({
    ...closureFail,
    id: crypto.randomUUID(),
    report: 'VERDICT: FAIL',
    reportVerdict: 'FAIL',
  }, workflow);
  assert.equal(workflow.codeReviewClosureCount, 2);
  assert.equal(workflow.stopReason, DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED);
  let gate = inspectDelegationCodeReviewStart({
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    workflow,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'workflow_stopped');
  const resume = applyDelegationWorkflowPatch({
    parentChatId: parentId,
    leafId,
    resumeRounds: true,
    clearStop: true,
    idempotencyKey: 'resume-closure',
  });
  assert.equal(resume.stopReason, '');
  assert.equal(resume.maxCodeReviewClosures, 3);
  gate = inspectDelegationCodeReviewStart({
    assignment: 'review',
    reviewSubject: 'code',
    leafId,
    workflow: resume,
    resumeRounds: true,
  });
  assert.equal(gate.ok, true);
  assert.equal(inspectDelegationWorkflowStart({
    parentChatId: parentId,
    leafId,
    assignment: 'review',
  }).ok, true);
}

{
  const workflow = { codeReviewAuditDone: false, codeReviewClosureCount: 0, round: 0 };
  const infraAudit = {
    id: crypto.randomUUID(),
    parentChatId: parentId,
    leafId,
    status: 'failed',
    reviewSubject: 'code',
    reviewMode: 'audit',
    error: 'timeout',
    executor: { transport: 'claude', model: 'bad' },
  };
  assert.equal(isCredibleCodeReviewTerminal(infraAudit), false);
  assert.equal(buildCodeReviewWorkflowPatchOnFinish(infraAudit, workflow), null);
  const credAudit = {
    ...infraAudit,
    id: crypto.randomUUID(),
    status: 'completed',
    error: '',
    report: 'VERDICT: FAIL\nF1 (P1)',
    reportVerdict: 'FAIL',
  };
  assert.equal(isCredibleCodeReviewTerminal(credAudit), true);
  const afterAudit = applyCodeReviewFinishPatch(credAudit, workflow);
  assert.equal(afterAudit.codeReviewAuditDone, true);
  assert.equal(afterAudit.codeReviewAuditReviewer, 'claude/bad');
}

{
  const chatId = crypto.randomUUID();
  const localLeafId = crypto.randomUUID();
  applyDelegationWorkflowPatch({
    parentChatId: chatId,
    leafId: localLeafId,
    codeReviewAuditDone: true,
    codeReviewAuditReviewer: 'claude/reviewer-z',
    codeReviewClosureCount: 0,
    round: 0,
    idempotencyKey: 'closure-fallback-setup',
  });
  let workflow = applyDelegationWorkflowPatch({
    parentChatId: chatId,
    leafId: localLeafId,
    countReview: false,
    idempotencyKey: 'closure-fallback-read',
  });
  assert.equal(buildCodeReviewClosureRoundKey(workflow), '0::0');
  const closureFail = {
    id: crypto.randomUUID(),
    parentChatId: chatId,
    leafId: localLeafId,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: 'closure',
    report: 'VERDICT: FAIL\nF1 STILL_OPEN',
    reportVerdict: 'FAIL',
    executor: { transport: 'claude', model: 'reviewer-z' },
  };
  workflow = applyCodeReviewFinishPatch(closureFail, workflow);
  assert.equal(workflow.codeReviewClosureCount, 1);
  assert.equal(workflow.codeReviewLastClosureRoundKey, '0::0');
  workflow = applyCodeReviewFinishPatch({
    ...closureFail,
    id: crypto.randomUUID(),
    attemptId: 'fanout-dup',
  }, workflow);
  assert.equal(workflow.codeReviewClosureCount, 1, 'fanout on same 0::0 roundKey must not double-count');
  assert.ok(buildCodeReviewWorkflowPatchOnClosureStart(workflow));
  workflow = applyDelegationWorkflowPatch({
    parentChatId: chatId,
    leafId: localLeafId,
    ...buildCodeReviewWorkflowPatchOnClosureStart(workflow),
    idempotencyKey: 'closure-restart-before-second',
    countReview: false,
  });
  assert.equal(buildCodeReviewClosureRoundKey(workflow), '0::1');
  workflow = applyCodeReviewFinishPatch({
    ...closureFail,
    id: crypto.randomUUID(),
    report: 'VERDICT: FAIL\nF1 STILL_OPEN still',
    reportVerdict: 'FAIL',
  }, workflow);
  assert.equal(workflow.codeReviewClosureCount, 2, 'second distinct closure with round=0 and no material must increment');
  assert.equal(workflow.codeReviewLastClosureRoundKey, '0::1');
}

{
  const chatId = crypto.randomUUID();
  const localLeafId = crypto.randomUUID();
  let workflow = { codeReviewAuditDone: false, codeReviewClosureCount: 0, round: 0 };
  const auditFail = {
    id: crypto.randomUUID(),
    parentChatId: chatId,
    leafId: localLeafId,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: 'audit',
    report: 'VERDICT: FAIL\nF1 (P1)',
    reportVerdict: 'FAIL',
    executor: { transport: 'claude', model: 'reviewer-cycle' },
  };
  applyDelegationWorkflowPatch({
    parentChatId: chatId,
    leafId: localLeafId,
    idempotencyKey: 'cycle-setup',
  });
  workflow = applyCodeReviewFinishPatch(auditFail, workflow);
  assert.equal(workflow.codeReviewAuditDone, true);
  assert.equal(workflow.codeReviewClosureEpoch, 1);
  const closureFail = {
    id: crypto.randomUUID(),
    parentChatId: chatId,
    leafId: localLeafId,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: 'closure',
    report: 'VERDICT: FAIL\nF1 STILL_OPEN',
    reportVerdict: 'FAIL',
    executor: { transport: 'claude', model: 'reviewer-cycle' },
  };
  workflow = applyCodeReviewFinishPatch(closureFail, workflow);
  assert.equal(workflow.codeReviewClosureCount, 1);
  assert.equal(workflow.codeReviewLastClosureRoundKey, '0::0');
  workflow = applyDelegationWorkflowPatch({
    parentChatId: chatId,
    leafId: localLeafId,
    lastVerdict: 'PASS',
    idempotencyKey: 'simulate-leaf-pass-reset',
  });
  assert.equal(workflow.codeReviewClosureCount, 0);
  assert.equal(workflow.codeReviewAuditDone, false);
  assert.equal(workflow.codeReviewClosureEpoch, 2);
  const auditAgain = {
    ...auditFail,
    id: crypto.randomUUID(),
    report: 'VERDICT: FAIL\nF2 (P1)',
  };
  workflow = applyCodeReviewFinishPatch(auditAgain, workflow);
  assert.equal(workflow.codeReviewAuditDone, true);
  assert.equal(workflow.codeReviewClosureEpoch, 3);
  workflow = applyCodeReviewFinishPatch({
    ...closureFail,
    id: crypto.randomUUID(),
  }, workflow);
  assert.equal(workflow.codeReviewClosureCount, 1, 'new audit cycle closure FAIL must count again at 0::0');
  assert.equal(workflow.codeReviewLastClosureRoundKey, '0::0');
}

console.log('delegation-code-review-phase.test.js OK');
