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
  DELEGATION_WORKFLOW_STOP_REVIEWER_POOL_DEGRADED,
  inspectDelegationCodeReviewStart,
  isCredibleCodeReviewTerminal,
  reconcileClosureReviewVerdict,
  resolveDelegationCodeReviewMode,
  resolveEffectiveCodeReviewReportVerdict,
} from '../lib/delegation-code-review-phase.js';
import { normalizeCodeReviewPoolRound } from '../lib/delegation-pool-round.js';
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

// --- Reviewer pool: one round record, effect applied once at resolution ---
{
  const { saveDelegationSettings } = await import('../lib/persist/delegation-settings-persist.js');
  const { clearDelegationEnvCache, resolveReviewerPool } = await import('../lib/delegation-settings.js');
  const { buildCodeReviewWorkflowPatchOnStart } = await import('../lib/delegation-code-review-phase.js');
  const poolWorkspace = '/tmp/reviewer-pool-ws';
  const poolMembers = [{ harness: 'claude', model: 'rev-a' }, { harness: 'codex', model: 'rev-b' }];
  const setPool = (enabled) => {
    saveDelegationSettings(poolWorkspace, { reviewer_pair_enabled: enabled, reviewer_pair_members: poolMembers });
    clearDelegationEnvCache();
  };
  setPool(true);
  const seed = (name, fields = {}) => {
    const parentChatId = crypto.randomUUID();
    const leaf = crypto.randomUUID();
    const workflow = applyDelegationWorkflowPatch({
      parentChatId,
      leafId: leaf,
      codeReviewAuditDone: true,
      codeReviewClosureCount: 2,
      maxCodeReviewClosures: 9,
      round: 1,
      materialRevision: `rev-${name}`,
      idempotencyKey: `pool-${name}-seed`,
      ...fields,
    });
    return { parentChatId, leafId: leaf, workflow, name };
  };
  const mkJob = (ctx, model, verdict, mode = 'closure') => ({
    id: crypto.randomUUID(),
    parentChatId: ctx.parentChatId,
    leafId: ctx.leafId,
    workspaceFolder: poolWorkspace,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: mode,
    report: `VERDICT: ${verdict}\n${verdict === 'FAIL' ? 'F1 STILL_OPEN' : 'F1 FIXED'}`,
    reportVerdict: verdict,
    executor: { transport: model === 'rev-a' ? 'claude' : 'codex', model },
  });
  const start = (ctx, job, mode = 'closure') => {
    const patch = buildCodeReviewWorkflowPatchOnStart(ctx.workflow, {
      delegationId: job.id,
      mode,
      workspaceFolder: poolWorkspace,
    });
    if (patch) {
      ctx.workflow = applyDelegationWorkflowPatch({
        ...patch,
        parentChatId: ctx.parentChatId,
        leafId: ctx.leafId,
        idempotencyKey: `start-${job.id}`,
        countReview: false,
      });
    }
  };
  const finish = (ctx, job) => {
    ctx.workflow = applyCodeReviewFinishPatch(job, ctx.workflow);
  };
  const round = (name, first, second, fields) => {
    const ctx = seed(name, fields);
    const a = mkJob(ctx, 'rev-a', first);
    const b = mkJob(ctx, 'rev-b', second);
    start(ctx, a);
    start(ctx, b);
    finish(ctx, a);
    finish(ctx, b);
    return ctx.workflow;
  };
  // Seeded with count>=1: a failed round is count+1 regardless of finish order.
  let wf = round('ff', 'FAIL', 'FAIL');
  assert.equal(wf.codeReviewClosureCount, 3, 'FF counts one closure on top of the seed');
  assert.equal(wf.codeReviewAuditDone, true);
  wf = round('fp', 'FAIL', 'PASS');
  assert.equal(wf.codeReviewClosureCount, 3, 'FP: sibling PASS does not erase the FAIL');
  assert.equal(wf.codeReviewAuditDone, true);
  wf = round('pf', 'PASS', 'FAIL');
  assert.equal(wf.codeReviewClosureCount, 3, 'PF: PASS finishing first does not reset the counter');
  assert.equal(wf.codeReviewAuditDone, true);
  wf = round('pp', 'PASS', 'PASS');
  assert.equal(wf.codeReviewClosureCount, 0, 'PP resets the counter');
  assert.equal(wf.codeReviewAuditDone, false);
  assert.ok(wf.codeReviewClosureEpoch >= 1);

  // A lone PASS mutates nothing until the round resolves.
  {
    const ctx = seed('lone');
    const a = mkJob(ctx, 'rev-a', 'PASS');
    const b = mkJob(ctx, 'rev-b', 'PASS');
    start(ctx, a);
    start(ctx, b);
    const epochBefore = ctx.workflow.codeReviewClosureEpoch;
    finish(ctx, a);
    assert.equal(ctx.workflow.codeReviewClosureCount, 2);
    assert.equal(ctx.workflow.codeReviewAuditDone, true);
    assert.equal(ctx.workflow.codeReviewClosureEpoch, epochBefore);
    finish(ctx, b);
    assert.equal(ctx.workflow.codeReviewClosureCount, 0);
  }

  // start -> finish -> start(second member / replacement) -> finish sequences.
  {
    const ctx = seed('seq-pf');
    const a = mkJob(ctx, 'rev-a', 'PASS');
    const b = mkJob(ctx, 'rev-b', 'FAIL');
    start(ctx, a);
    finish(ctx, a);
    start(ctx, b);
    assert.ok(ctx.workflow.codeReviewPoolRound, 'a later start must not clear the unresolved round record');
    finish(ctx, b);
    assert.equal(ctx.workflow.codeReviewClosureCount, 3);
    assert.equal(ctx.workflow.codeReviewAuditDone, true);
  }
  {
    const ctx = seed('seq-fp');
    const a = mkJob(ctx, 'rev-a', 'FAIL');
    const b = mkJob(ctx, 'rev-b', 'PASS');
    start(ctx, a);
    finish(ctx, a);
    start(ctx, b);
    finish(ctx, b);
    assert.equal(ctx.workflow.codeReviewClosureCount, 3, 'late sibling PASS does not reset');
    assert.equal(ctx.workflow.codeReviewAuditDone, true);
  }
  {
    const ctx = seed('seq-ff');
    const a = mkJob(ctx, 'rev-a', 'FAIL');
    const b = mkJob(ctx, 'rev-b', 'FAIL');
    start(ctx, a);
    finish(ctx, a);
    start(ctx, b);
    finish(ctx, b);
    assert.equal(ctx.workflow.codeReviewClosureCount, 3, 'FF started sequentially counts +1, not +2');
  }
  {
    // Replacement after an infra failure of one member (no credible result).
    const ctx = seed('replace');
    const a = mkJob(ctx, 'rev-a', 'PASS');
    const lost = { ...mkJob(ctx, 'rev-b', 'PASS'), status: 'failed', report: '', reportVerdict: '', error: 'quota exceeded' };
    const replacement = mkJob(ctx, 'rev-b', 'PASS');
    start(ctx, a);
    start(ctx, lost);
    finish(ctx, a);
    finish(ctx, lost);
    assert.equal(ctx.workflow.codeReviewClosureCount, 2, 'infra failure leaves the round open');
    start(ctx, replacement);
    finish(ctx, replacement);
    assert.equal(ctx.workflow.codeReviewClosureCount, 0, 'replacement PASS resolves the round as PASS');
  }

  // Setting flipped off mid-round: the round keeps the pool semantics it started with.
  {
    const ctx = seed('flip');
    const a = mkJob(ctx, 'rev-a', 'PASS');
    const b = mkJob(ctx, 'rev-b', 'FAIL');
    start(ctx, a);
    start(ctx, b);
    setPool(false);
    finish(ctx, a);
    assert.equal(ctx.workflow.codeReviewClosureCount, 2, 'PASS first still does not reset after the flip');
    finish(ctx, b);
    assert.equal(ctx.workflow.codeReviewClosureCount, 3);
    assert.equal(ctx.workflow.codeReviewAuditDone, true);
    setPool(true);
  }
  // Setting switched on mid-round (round started without a pool): legacy accounting.
  {
    setPool(false);
    const ctx = seed('flip-on');
    const a = mkJob(ctx, 'rev-a', 'FAIL');
    start(ctx, a);
    assert.equal(ctx.workflow.codeReviewPoolRound, null);
    setPool(true);
    finish(ctx, a);
    assert.equal(ctx.workflow.codeReviewClosureCount, 3);
  }

  // Audit mode: FAIL wins, a sibling PASS cannot reset auditDone/epoch afterwards.
  {
    const ctx = seed('audit-fp', { codeReviewAuditDone: false, codeReviewClosureCount: 0 });
    const a = mkJob(ctx, 'rev-a', 'FAIL', 'audit');
    const b = mkJob(ctx, 'rev-b', 'PASS', 'audit');
    start(ctx, a, 'audit');
    start(ctx, b, 'audit');
    finish(ctx, b);
    assert.equal(ctx.workflow.codeReviewAuditDone, false, 'audit PASS first mutates nothing');
    finish(ctx, a);
    assert.equal(ctx.workflow.codeReviewAuditDone, true);
    const epochAfterFail = ctx.workflow.codeReviewClosureEpoch;
    assert.equal(ctx.workflow.codeReviewAuditReviewer, 'claude/rev-a');
    const late = mkJob(ctx, 'rev-b', 'PASS', 'audit');
    start(ctx, late, 'audit');
    finish(ctx, late);
    assert.equal(ctx.workflow.codeReviewAuditDone, true);
    assert.equal(ctx.workflow.codeReviewClosureEpoch, epochAfterFail);
  }
  {
    const ctx = seed('audit-pp', { codeReviewAuditDone: false, codeReviewClosureCount: 1 });
    const a = mkJob(ctx, 'rev-a', 'PASS', 'audit');
    const b = mkJob(ctx, 'rev-b', 'PASS', 'audit');
    start(ctx, a, 'audit');
    start(ctx, b, 'audit');
    finish(ctx, a);
    finish(ctx, b);
    assert.equal(ctx.workflow.codeReviewClosureCount, 0);
    assert.equal(ctx.workflow.codeReviewAuditDone, false);
  }

  // MAX_CLOSURES counts rounds: three failed pool rounds (two jobs each) exhaust a cap of 3.
  {
    const ctx = seed('cap', { codeReviewClosureCount: 0, maxCodeReviewClosures: 3 });
    for (let i = 1; i <= 3; i += 1) {
      ctx.workflow = applyDelegationWorkflowPatch({
        parentChatId: ctx.parentChatId,
        leafId: ctx.leafId,
        round: i,
        materialRevision: `cap-${i}`,
        idempotencyKey: `cap-material-${i}`,
        countReview: false,
      });
      const a = mkJob(ctx, 'rev-a', 'FAIL');
      const b = mkJob(ctx, 'rev-b', 'FAIL');
      start(ctx, a);
      start(ctx, b);
      finish(ctx, a);
      finish(ctx, b);
      assert.equal(ctx.workflow.codeReviewClosureCount, i, `after pool round ${i}`);
      assert.equal(
        ctx.workflow.stopReason === DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED,
        i === 3,
        'cap reached only after the third round',
      );
    }
  }

  assert.equal(resolveReviewerPool('/tmp/no-settings-ws').active, false);
  assert.equal(resolveReviewerPool(poolWorkspace).members.length, 2);
  const poolOff = '/tmp/reviewer-pool-off-ws';
  saveDelegationSettings(poolOff, { reviewer_pair_enabled: true, reviewer_pair_members: [] });
  clearDelegationEnvCache();
  assert.equal(resolveReviewerPool(poolOff).active, false, 'incomplete members = inactive');
}


// Findings block isolation: the block never changes verdicts, hashes or prior-findings text.
{
  const blockWith = (status, summary) => [
    '```findings-json',
    JSON.stringify({ findings: [
      { id: 'F1', status: 'FIXED', priority: 'P1', category: 'missing-test', summary: 'fixed' },
      { id: 'F9', status, priority: 'P2', category: 'style-convention', summary },
    ] }),
    '```',
  ].join('\n');
  // FIXED + FOLLOW_UP P2 (summary even mentions STILL_OPEN) stays PASS.
  const passReport = `F1 FIXED with tests.\n${blockWith('FOLLOW_UP', 'was STILL_OPEN in an earlier draft (P2)')}\nTASK: review\nVERDICT: PASS\n`;
  assert.equal(reconcileClosureReviewVerdict(passReport, 'PASS'), 'PASS');
  assert.equal(resolveEffectiveCodeReviewReportVerdict({
    reviewMode: 'closure', reviewSubject: 'code', report: passReport,
  }), 'PASS');
  // Prose STILL_OPEN still FAILs, with or without the block.
  const failReport = `F1 STILL_OPEN - guard missing.\n${blockWith('FOLLOW_UP', 'nit (P2)')}\nTASK: review\nVERDICT: PASS\n`;
  assert.equal(reconcileClosureReviewVerdict(failReport, 'PASS'), 'FAIL');

  // Findings hash and openFindingsText are identical with and without the block.
  const prose = 'F1 (P1) STILL_OPEN guard missing in lib/a.js\nTASK: review\nVERDICT: FAIL\n';
  const withBlock = `F1 (P1) STILL_OPEN guard missing in lib/a.js\n${blockWith('NEW', 'something new')}\nTASK: review\nVERDICT: FAIL\n`;
  const applyReport = (reportText) => applyDelegationWorkflowPatch({
    parentChatId: crypto.randomUUID(),
    leafId: crypto.randomUUID(),
    reportText,
    idempotencyKey: `iso-${crypto.randomUUID()}`,
  });
  const plain = applyReport(prose);
  const blocked = applyReport(withBlock);
  assert.equal(blocked.findingsHash, plain.findingsHash);
  assert.equal(blocked.openFindingsText, plain.openFindingsText);
  assert.equal(blocked.findingsText, plain.findingsText);
  assert.equal(blocked.lastVerdict, 'FAIL');
  assert.doesNotMatch(blocked.openFindingsText, /findings-json/);
}

// Flag 0: audit / closure prompt blocks are byte-identical to the legacy text.
{
  const env = { CRETLI_REVIEW_FINDINGS_BLOCK: '0' };
  assert.equal(buildAuditReviewPromptBlock('Acceptance line', { env }), [
    '[CODE REVIEW AUDIT]',
    'This is the first code review of this leaf. Perform a full scoped audit against the leaf acceptance criteria below.',
    'Record every in-scope finding with a stable ID (for example F1, F2) and a priority (P1 blocking, P2/P3 non-blocking).',
    'Mark observations outside this leaf scope as OUT_OF_SCOPE; they must not change your VERDICT.',
    'Do not perform a closure-only pass; inspect the implementation and tests needed to judge the leaf criteria.',
    '[LEAF ACCEPTANCE CRITERIA]\nAcceptance line',
    'Tell the orchestrator to create separate todos for any OUT_OF_SCOPE follow-ups instead of fixing them in this leaf.',
  ].join('\n'));
  const ledgerFindings = [{ key: 'R1A1-F1', priority: 'P1', category: 'other', files: [], summary: 's' }];
  assert.equal(buildClosureReviewPromptBlock({ openFindingsText: 'F1 open' }, '', { env, ledgerFindings }), [
    '[CODE REVIEW CLOSURE]',
    'This is a closure review after a fix. Do not run a fresh full audit of the whole leaf.',
    'Work only from the open findings table below: for each prior finding state FIXED or STILL_OPEN with file/test evidence.',
    'Re-check regressions introduced by the fix. New findings block VERDICT: PASS only when they are P1 or a regression caused by the fix.',
    'Other new findings belong in a FOLLOW_UP section and must not change VERDICT when all audit findings are FIXED.',
    'Tell the orchestrator to create separate todos for FOLLOW_UP and OUT_OF_SCOPE items instead of expanding this leaf.',
    '[OPEN FINDINGS]\nF1 open',
  ].join('\n'));
  // Flag on: one example object and the findings-json request appear before TASK/VERDICT.
  const on = buildAuditReviewPromptBlock('Acceptance line', { env: {} });
  assert.match(on, /\[FINDINGS BLOCK\]/);
  assert.match(on, /```findings-json/);
  assert.match(on, /"category": "missing-test"/);
}

// --- F2 regression: a LEARNED fixed pair opens the two-reviewer round ------
{
  const { saveDelegationSettings } = await import('../lib/persist/delegation-settings-persist.js');
  const { clearDelegationEnvCache, resolveReviewerPool } = await import('../lib/delegation-settings.js');
  const { buildCodeReviewWorkflowPatchOnStart } = await import('../lib/delegation-code-review-phase.js');
  const { addReviewerPairMember } = await import('../lib/persist/reviewer-pairs-persist.js');
  const learnedWs = `/tmp/reviewer-pool-learned-ws-${crypto.randomUUID()}`;
  saveDelegationSettings(learnedWs, {
    reviewer_policy: { code: { selection: 'fixed_pair', members_source: 'learned', session: 'leaf' } },
  });
  clearDelegationEnvCache();
  const parentChatId = crypto.randomUUID();
  const leafId = crypto.randomUUID();
  const learnedWorkflow = applyDelegationWorkflowPatch({
    parentChatId,
    leafId,
    codeReviewAuditDone: true,
    codeReviewClosureCount: 1,
    round: 1,
    materialRevision: 'learned-rev',
    idempotencyKey: 'learned-seed',
  });
  // One learned member: the pair is incomplete, not off.
  addReviewerPairMember(parentChatId, { harness: 'claude', model: 'rev-a' }, 'code');
  const oneMember = resolveReviewerPool(learnedWs, { subject: 'code', parentChatId, delegations: [] });
  assert.equal(oneMember.active, false);
  assert.equal(oneMember.incomplete, true, 'one learned member is an incomplete fixed pair');
  const startPatch = buildCodeReviewWorkflowPatchOnStart(learnedWorkflow, {
    delegationId: 'learned-a',
    mode: 'closure',
    workspaceFolder: learnedWs,
    parentChatId,
    delegations: [],
  });
  assert.ok(startPatch?.codeReviewPoolRound, 'a learned fixed pair opens the two-reviewer round');
  assert.equal(startPatch.codeReviewPoolRound.pool, true);
  assert.deepEqual(startPatch.codeReviewPoolRound.started, ['learned-a']);
  // The second member completes the pair; the pool becomes active.
  addReviewerPairMember(parentChatId, { harness: 'codex', model: 'rev-b' }, 'code');
  const complete = resolveReviewerPool(learnedWs, { subject: 'code', parentChatId, delegations: [] });
  assert.equal(complete.active, true);
  assert.equal(complete.incomplete, false);
}

// --- F10 regression: one eligible reviewer is bounded, never a false PASS --
{
  const { saveDelegationSettings } = await import('../lib/persist/delegation-settings-persist.js');
  const { clearDelegationEnvCache } = await import('../lib/delegation-settings.js');
  const { buildCodeReviewWorkflowPatchOnStart } = await import('../lib/delegation-code-review-phase.js');
  const degradeWs = `/tmp/reviewer-pool-degrade-ws-${crypto.randomUUID()}`;
  saveDelegationSettings(degradeWs, {
    reviewer_pair_enabled: true,
    reviewer_pair_members: [{ harness: 'claude', model: 'rev-a' }, { harness: 'codex', model: 'rev-b' }],
  });
  clearDelegationEnvCache();
  const parentChatId = crypto.randomUUID();
  const leaf = crypto.randomUUID();
  let wf = applyDelegationWorkflowPatch({
    parentChatId,
    leafId: leaf,
    workspaceFolder: degradeWs,
    codeReviewAuditDone: true,
    codeReviewClosureCount: 0,
    maxCodeReviewClosures: 4,
    round: 1,
    materialRevision: 'degrade-rev',
    idempotencyKey: 'degrade-seed',
  });
  const mkJob = (model) => ({
    id: crypto.randomUUID(),
    parentChatId,
    leafId: leaf,
    workspaceFolder: degradeWs,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: 'closure',
    report: 'VERDICT: PASS\nF1 FIXED',
    reportVerdict: 'PASS',
    executor: { transport: model === 'rev-a' ? 'claude' : 'codex', model },
  });
  const start = (job) => {
    const patch = buildCodeReviewWorkflowPatchOnStart(wf, {
      delegationId: job.id,
      mode: 'closure',
      workspaceFolder: degradeWs,
      parentChatId,
      reviewer: { transport: job.executor.transport, model: job.executor.model },
    });
    if (patch) {
      wf = applyDelegationWorkflowPatch({
        ...patch,
        parentChatId,
        leafId: leaf,
        idempotencyKey: `degrade-start-${job.id}`,
        countReview: false,
      });
    }
  };
  const first = mkJob('rev-a');
  const duplicate = mkJob('rev-a');
  start(first);
  wf = applyCodeReviewFinishPatch(first, wf);
  assert.equal(normalizeCodeReviewPoolRound(wf.codeReviewPoolRound).resolved, '', 'one PASS stays pending, not approved');
  assert.equal(wf.stopReason, '');
  start(duplicate);
  wf = applyCodeReviewFinishPatch(duplicate, wf);
  const record = normalizeCodeReviewPoolRound(wf.codeReviewPoolRound);
  assert.equal(record.resolved, 'DEGRADED', 'two PASS from one reviewer identity never resolve as approval');
  assert.equal(record.degradedReason, 'reviewer_pool_single_reviewer');
  assert.equal(wf.codeReviewClosureCount, 0, 'a degraded round advances no closure');
  assert.equal(wf.codeReviewAuditDone, true, 'a degraded round does not flip the audit phase');
  assert.equal(wf.stopReason, DELEGATION_WORKFLOW_STOP_REVIEWER_POOL_DEGRADED);
  const blocked = inspectDelegationCodeReviewStart({
    assignment: 'review', reviewSubject: 'code', leafId: leaf, workflow: wf,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, DELEGATION_WORKFLOW_STOP_REVIEWER_POOL_DEGRADED);
  assert.match(blocked.error, /second distinct reviewer/);
  const resumed = inspectDelegationCodeReviewStart({
    assignment: 'review', reviewSubject: 'code', leafId: leaf, workflow: wf, resumeRounds: true,
  });
  assert.equal(resumed.ok, true, 'an explicit resume can retry the degraded round');
  // Two DISTINCT reviewers still resolve as PASS.
  let ok = applyDelegationWorkflowPatch({
    parentChatId,
    leafId: leaf,
    workspaceFolder: degradeWs,
    codeReviewAuditDone: true,
    codeReviewClosureCount: 0,
    maxCodeReviewClosures: 4,
    round: 2,
    materialRevision: 'degrade-rev-2',
    idempotencyKey: 'degrade-seed-2',
    clearStop: true,
  });
  const distinctA = mkJob('rev-a');
  const distinctB = mkJob('rev-b');
  const startOk = (job) => {
    const patch = buildCodeReviewWorkflowPatchOnStart(ok, {
      delegationId: job.id,
      mode: 'closure',
      workspaceFolder: degradeWs,
      parentChatId,
      reviewer: { transport: job.executor.transport, model: job.executor.model },
    });
    if (patch) {
      ok = applyDelegationWorkflowPatch({
        ...patch,
        parentChatId,
        leafId: leaf,
        idempotencyKey: `degrade-start-ok-${job.id}`,
        countReview: false,
      });
    }
  };
  startOk(distinctA);
  startOk(distinctB);
  ok = applyCodeReviewFinishPatch(distinctA, ok);
  ok = applyCodeReviewFinishPatch(distinctB, ok);
  assert.equal(normalizeCodeReviewPoolRound(ok.codeReviewPoolRound).resolved, 'PASS');
  assert.equal(ok.codeReviewClosureCount, 0);
}

// --- F15 regression: effort suffix and Claude alias never make a 2nd reviewer -
{
  const { saveDelegationSettings } = await import('../lib/persist/delegation-settings-persist.js');
  const { clearDelegationEnvCache } = await import('../lib/delegation-settings.js');
  const { buildCodeReviewWorkflowPatchOnStart } = await import('../lib/delegation-code-review-phase.js');
  const aliasWs = `/tmp/reviewer-pool-alias-ws-${crypto.randomUUID()}`;
  saveDelegationSettings(aliasWs, {
    reviewer_pair_enabled: true,
    reviewer_pair_members: [
      { harness: 'claude', model: 'claude-opus-5-5' },
      { harness: 'codex', model: 'rev-b' },
    ],
  });
  clearDelegationEnvCache();
  const parentChatId = crypto.randomUUID();
  const leaf = crypto.randomUUID();
  let wf = applyDelegationWorkflowPatch({
    parentChatId,
    leafId: leaf,
    workspaceFolder: aliasWs,
    codeReviewAuditDone: true,
    codeReviewClosureCount: 0,
    maxCodeReviewClosures: 4,
    round: 1,
    materialRevision: 'alias-rev',
    idempotencyKey: 'alias-seed',
  });
  const mkAliasJob = (model, transport = 'claude') => ({
    id: crypto.randomUUID(),
    parentChatId,
    leafId: leaf,
    workspaceFolder: aliasWs,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: 'closure',
    report: 'VERDICT: PASS\nF1 FIXED',
    reportVerdict: 'PASS',
    executor: { transport, model },
  });
  const startAlias = (job) => {
    const patch = buildCodeReviewWorkflowPatchOnStart(wf, {
      delegationId: job.id,
      mode: 'closure',
      workspaceFolder: aliasWs,
      parentChatId,
      reviewer: { transport: job.executor.transport, model: job.executor.model },
    });
    if (patch) {
      wf = applyDelegationWorkflowPatch({
        ...patch,
        parentChatId,
        leafId: leaf,
        idempotencyKey: `alias-start-${job.id}`,
        countReview: false,
      });
    }
  };
  // One reviewer, two spellings: numbered id at low effort and the `opus` alias
  // at high effort. Canonical identity must merge them.
  const numbered = mkAliasJob('claude-opus-5-5::effort=low');
  const aliased = mkAliasJob('opus::effort=high');
  startAlias(numbered);
  startAlias(aliased);
  wf = applyCodeReviewFinishPatch(numbered, wf);
  wf = applyCodeReviewFinishPatch(aliased, wf);
  const aliasRecord = normalizeCodeReviewPoolRound(wf.codeReviewPoolRound);
  assert.equal(
    aliasRecord.resolved,
    'DEGRADED',
    'effort/alias variants of one reviewer must never resolve as a two-reviewer PASS',
  );
  assert.equal(aliasRecord.degradedReason, 'reviewer_pool_single_reviewer');
  assert.equal(wf.codeReviewClosureCount, 0, 'a degraded alias round advances no closure');
  assert.equal(wf.stopReason, DELEGATION_WORKFLOW_STOP_REVIEWER_POOL_DEGRADED);
}

// --- F17 regression: an outsider never supplies the fixed pair's 2nd PASS ----
{
  const { saveDelegationSettings } = await import('../lib/persist/delegation-settings-persist.js');
  const { clearDelegationEnvCache } = await import('../lib/delegation-settings.js');
  const { buildCodeReviewWorkflowPatchOnStart } = await import('../lib/delegation-code-review-phase.js');
  const outsiderWs = `/tmp/reviewer-pool-outsider-ws-${crypto.randomUUID()}`;
  saveDelegationSettings(outsiderWs, {
    reviewer_pair_enabled: true,
    reviewer_pair_members: [
      { harness: 'claude', model: 'rev-a' },
      { harness: 'codex', model: 'rev-b' },
    ],
  });
  clearDelegationEnvCache();
  const parentChatId = crypto.randomUUID();
  const leaf = crypto.randomUUID();
  let wf = applyDelegationWorkflowPatch({
    parentChatId,
    leafId: leaf,
    workspaceFolder: outsiderWs,
    codeReviewAuditDone: true,
    codeReviewClosureCount: 0,
    maxCodeReviewClosures: 4,
    round: 1,
    materialRevision: 'outsider-rev',
    idempotencyKey: 'outsider-seed',
  });
  const mkMember = (harness, model, membership) => ({
    id: crypto.randomUUID(),
    parentChatId,
    leafId: leaf,
    workspaceFolder: outsiderWs,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: 'closure',
    report: 'VERDICT: PASS\nF1 FIXED',
    reportVerdict: 'PASS',
    executor: { transport: harness, model },
    reviewerPolicy: { selection: 'fixed_pair', membership },
  });
  const startMember = (job) => {
    const patch = buildCodeReviewWorkflowPatchOnStart(wf, {
      delegationId: job.id,
      mode: 'closure',
      workspaceFolder: outsiderWs,
      parentChatId,
      reviewer: { transport: job.executor.transport, model: job.executor.model },
    });
    if (patch) {
      wf = applyDelegationWorkflowPatch({
        ...patch,
        parentChatId,
        leafId: leaf,
        idempotencyKey: `outsider-start-${job.id}`,
        countReview: false,
      });
    }
  };
  const memberA = mkMember('claude', 'rev-a', 'member');
  const outsider = mkMember('deepseek', 'rev-outside', 'outside_pool');
  const memberB = mkMember('codex', 'rev-b', 'member');
  startMember(memberA);
  startMember(outsider);
  wf = applyCodeReviewFinishPatch(memberA, wf);
  wf = applyCodeReviewFinishPatch(outsider, wf);
  let record = normalizeCodeReviewPoolRound(wf.codeReviewPoolRound);
  assert.equal(record.resolved, '', 'member PASS + outside-pool PASS must stay pending');
  assert.equal(record.memberships[outsider.id], 'outside_pool');
  assert.equal(wf.codeReviewClosureCount, 0, 'an unresolved pair round advances no closure');
  // The second real member resolves the round; the outsider neither helped nor
  // blocked it.
  startMember(memberB);
  wf = applyCodeReviewFinishPatch(memberB, wf);
  record = normalizeCodeReviewPoolRound(wf.codeReviewPoolRound);
  assert.equal(record.resolved, 'PASS');
  assert.equal(wf.codeReviewClosureCount, 0);
}

// --- F15 regression: missing reviewer identity never fabricates a 2nd member -
{
  const { saveDelegationSettings } = await import('../lib/persist/delegation-settings-persist.js');
  const { clearDelegationEnvCache } = await import('../lib/delegation-settings.js');
  const { buildCodeReviewWorkflowPatchOnStart } = await import('../lib/delegation-code-review-phase.js');
  const blankWs = `/tmp/reviewer-pool-blank-ws-${crypto.randomUUID()}`;
  saveDelegationSettings(blankWs, {
    reviewer_pair_enabled: true,
    reviewer_pair_members: [
      { harness: 'claude', model: 'rev-a' },
      { harness: 'codex', model: 'rev-b' },
    ],
  });
  clearDelegationEnvCache();
  const parentChatId = crypto.randomUUID();
  const leaf = crypto.randomUUID();
  let wf = applyDelegationWorkflowPatch({
    parentChatId,
    leafId: leaf,
    workspaceFolder: blankWs,
    codeReviewAuditDone: true,
    codeReviewClosureCount: 0,
    maxCodeReviewClosures: 4,
    round: 1,
    materialRevision: 'blank-rev',
    idempotencyKey: 'blank-seed',
  });
  const mkBlank = () => ({
    id: crypto.randomUUID(),
    parentChatId,
    leafId: leaf,
    workspaceFolder: blankWs,
    status: 'completed',
    reviewSubject: 'code',
    reviewMode: 'closure',
    report: 'VERDICT: PASS\nF1 FIXED',
    reportVerdict: 'PASS',
    executor: {},
  });
  const startBlank = (job) => {
    const patch = buildCodeReviewWorkflowPatchOnStart(wf, {
      delegationId: job.id,
      mode: 'closure',
      workspaceFolder: blankWs,
      parentChatId,
    });
    if (patch) {
      wf = applyDelegationWorkflowPatch({
        ...patch,
        parentChatId,
        leafId: leaf,
        idempotencyKey: `blank-start-${job.id}`,
        countReview: false,
      });
    }
  };
  const first = mkBlank();
  const second = mkBlank();
  startBlank(first);
  startBlank(second);
  wf = applyCodeReviewFinishPatch(first, wf);
  wf = applyCodeReviewFinishPatch(second, wf);
  const blankRecord = normalizeCodeReviewPoolRound(wf.codeReviewPoolRound);
  assert.equal(blankRecord.resolved, 'DEGRADED', 'identity-less PASSes must not fabricate an approval');
  assert.equal(wf.codeReviewClosureCount, 0);
}

console.log('delegation-code-review-phase.test.js OK');
