import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { buildDelegationExecutorPrompt } from '../lib/delegation-prompt.js';
import {
  buildDelegationRequestHash,
  resolveDelegationChildExecutionMode,
} from '../lib/delegation-request.js';

const review = buildDelegationExecutorPrompt({
  sourceKind: 'plan',
  planMarkdown: '# Verify the plan',
  executionMode: 'agent',
  assignment: 'review',
  extraInstructions: 'Only inspect the implementation and report defects. Do not edit files.',
});
assert.equal(review.ok, true);
assert.match(review.prompt, /You are the reviewer/);
assert.match(review.prompt, /Do not implement\. Do not edit files/);
assert.match(review.prompt, /scripts\/review-verify\.js/);
assert.doesNotMatch(review.prompt, /native shell disabled/);
assert.doesNotMatch(review.prompt, /parent must run review-verify/);
assert.doesNotMatch(review.prompt, /node tests\/\*\.test\.js/);
assert.match(review.prompt, /\[ASSIGNMENT\]/);
assert.equal(review.displayText, 'Only inspect the implementation and report defects. Do not edit files.');
assert.doesNotMatch(review.prompt, /Implement the attached approved plan/);
assert.match(review.prompt, /Inability to run tests is not inability to inspect code/);
assert.match(review.prompt, /parent host verification/);

const planDefault = buildDelegationExecutorPrompt({
  sourceKind: 'plan',
  planMarkdown: '# Verify the plan',
  executionMode: 'plan',
});
assert.equal(planDefault.ok, true);
assert.match(planDefault.prompt, /Assignment: review/);
assert.match(planDefault.prompt, /Review the assignment against the repository/);
assert.equal(planDefault.displayText, 'Review the approved plan.');
assert.equal(resolveDelegationChildExecutionMode('plan', 'review'), 'agent');
assert.equal(resolveDelegationChildExecutionMode('plan', 'implement'), 'plan');
// An executor child must not inherit a plan-mode parent: Plan is explicit only.
assert.equal(resolveDelegationChildExecutionMode(undefined, 'implement', 'plan'), 'agent');
assert.equal(resolveDelegationChildExecutionMode(undefined, 'review', 'plan'), 'agent');
assert.equal(resolveDelegationChildExecutionMode('agent', 'implement', 'plan'), 'agent');
assert.equal(resolveDelegationChildExecutionMode('plan', 'implement', 'agent'), 'plan');

const implementation = buildDelegationExecutorPrompt({
  sourceKind: 'plan',
  planMarkdown: '# Implement the plan',
  executionMode: 'agent',
  assignment: 'implement',
});
assert.equal(implementation.ok, true);
assert.match(implementation.prompt, /Implement the attached approved plan/);
assert.match(implementation.prompt, /Assignment: implement/);
assert.match(implementation.prompt, /Send the report through delegation_reply/);
assert.match(implementation.prompt, /idempotency_key/);
assert.match(implementation.prompt, /blockers/);
assert.match(implementation.prompt, /artifacts/);
assert.doesNotMatch(implementation.prompt, /wait for the user to pass it/);
assert.match(implementation.prompt, /cretli-ref chat=<uuid> seq=<n>/);
assert.match(implementation.prompt, /chat_event\(\{ chat: "<full-uuid>", seq: <n>, field: "text" \}\)/);
assert.match(implementation.prompt, /field is required/);
assert.match(implementation.prompt, /\[VERIFICATION SCOPE\]/);
assert.match(implementation.prompt, /Repeat or broaden verification only after a new change/);
assert.match(implementation.prompt, /15 minutes for a fix\/review or 30 minutes/);
assert.doesNotMatch(planDefault.prompt, /\[VERIFICATION SCOPE\]/);

const fix = buildDelegationExecutorPrompt({
  sourceKind: 'text', taskText: 'Repair the consumer.', assignment: 'fix', executionMode: 'agent',
  workflowRow: { openFindingsText: 'F1: consumer mismatch' },
  watcherFindingsText: 'F2: caller regression',
  leafAcceptanceText: 'No unscoped production request.',
});
assert.equal(fix.ok, true);
assert.match(fix.prompt, /\[FIX CHECKLIST\]/);
assert.match(fix.prompt, /F1: consumer mismatch/);
assert.match(fix.prompt, /F2: caller regression/);
assert.match(fix.prompt, /No unscoped production request/);
assert.doesNotMatch(fix.prompt, /You are the reviewer/);

assert.match(planDefault.prompt, /The system will deliver the final report to the parent/);
assert.doesNotMatch(planDefault.prompt, /delegation_reply/);

const baseHash = {
  parentChatId: 'parent',
  sourceKind: 'plan',
  planRevision: 1,
  harness: 'sdk',
  model: 'model',
};
assert.notEqual(
  buildDelegationRequestHash({ ...baseHash, assignment: 'review' }),
  buildDelegationRequestHash({ ...baseHash, assignment: 'implement' }),
);

console.log('delegation-prompt.test.js OK');

// The denied-shell rule lives only in the review role, so it is present once in Plan and Agent mode.
for (const executionMode of ['plan', 'agent']) {
  const built = buildDelegationExecutorPrompt({
    sourceKind: 'plan',
    planMarkdown: '# Verify the plan',
    executionMode,
    assignment: 'review',
  });
  assert.equal(built.ok, true);
  const occurrences = built.prompt.split('A denied shell call does not fail or end the review.').length - 1;
  assert.equal(occurrences, 1, `denied-shell rule once in ${executionMode} mode`);
  assert.doesNotMatch(built.prompt, /If a shell command is denied, the review remains active/);
  assert.match(built.prompt, /Do not implement\. Do not edit files/);
  assert.match(built.prompt, /TASK: audit\|implement\|review/);
}

// Findings keys table: prompt sources and ordering.
{
  const ledgerFindings = [{
    key: 'R1A1-F1', priority: 'P1', category: 'missing-test', files: ['lib/a.js'], summary: 'No test for guard',
  }];
  const build = (input) => buildDelegationExecutorPrompt({
    sourceKind: 'text', taskText: 'Review', executionMode: 'agent', ...input,
  });
  const closure = build({
    assignment: 'review',
    reviewMode: 'closure',
    workflowRow: { openFindingsText: 'F1 (P1) STILL_OPEN guard missing' },
    watcherFindingsText: 'WATCHER finding about caller',
    openLedgerFindings: ledgerFindings,
  });
  assert.equal(closure.ok, true);
  const text = closure.prompt;
  assert.ok(text.indexOf('F1 (P1) STILL_OPEN guard missing') < text.indexOf('[FINDING KEYS]'), 'keys follow prior findings');
  assert.match(text, /WATCHER finding about caller/);
  assert.match(text, /\| R1A1-F1 \| P1 \| missing-test \|/);

  // Reviewer omitted the JSON block: no ledger entries -> prior text only, no keys.
  const noKeys = build({
    assignment: 'review',
    reviewMode: 'closure',
    workflowRow: { openFindingsText: 'F1 (P1) STILL_OPEN guard missing' },
    watcherFindingsText: 'WATCHER finding about caller',
    openLedgerFindings: [],
  });
  assert.match(noKeys.prompt, /F1 \(P1\) STILL_OPEN guard missing/);
  assert.match(noKeys.prompt, /WATCHER finding about caller/);
  assert.doesNotMatch(noKeys.prompt, /\[FINDING KEYS\]\n/);

  // Fixer receives the same prior findings (orchestrator/Watcher text) plus keys.
  const fix = build({
    assignment: 'fix',
    workflowRow: { findingsText: 'orchestrator findings_text' },
    watcherFindingsText: 'WATCHER finding about caller',
    openLedgerFindings: ledgerFindings,
  });
  assert.match(fix.prompt, /orchestrator findings_text/);
  assert.match(fix.prompt, /WATCHER finding about caller/);
  assert.ok(fix.prompt.indexOf('orchestrator findings_text') < fix.prompt.indexOf('[FINDING KEYS]'));

  // Empty prior text + open ledger entries: closure lists the keys, not "No open findings".
  const emptyPrior = build({ assignment: 'review', reviewMode: 'closure', workflowRow: {}, openLedgerFindings: ledgerFindings });
  assert.match(emptyPrior.prompt, /\| R1A1-F1 \|/);
  assert.doesNotMatch(emptyPrior.prompt, /No open findings were recorded/);

  // Flag off: no keys table even with ledger entries.
  const previous = process.env.CRETLI_REVIEW_FINDINGS_BLOCK;
  process.env.CRETLI_REVIEW_FINDINGS_BLOCK = '0';
  try {
    const off = build({
      assignment: 'review', reviewMode: 'closure', workflowRow: { openFindingsText: 'F1 open' }, openLedgerFindings: ledgerFindings,
    });
    assert.doesNotMatch(off.prompt, /\[FINDING KEYS\]\n/);
    assert.doesNotMatch(off.prompt, /\[FINDINGS BLOCK\]/);
  } finally {
    if (previous === undefined) delete process.env.CRETLI_REVIEW_FINDINGS_BLOCK;
    else process.env.CRETLI_REVIEW_FINDINGS_BLOCK = previous;
  }
}

// Review lessons: byte-identical when off/empty; per-audience blocks only.
{
  const previous = process.env.CRETLI_REVIEW_LESSONS;
  const lessons = [
    { id: 'l1', audience: 'implementer', kind: 'do', category: 'missing-test', text: 'Add a regression test.' },
  ];
  const suppress = [
    { id: 's1', audience: 'reviewer', kind: 'suppress', category: 'style-convention', text: 'Ignore quote style.' },
    { id: 's2', audience: 'reviewer', kind: 'suppress', category: 'security', text: 'Ignore token handling.' },
  ];
  const build = (input) => buildDelegationExecutorPrompt({
    sourceKind: 'text', taskText: 'Do work', executionMode: 'agent', ...input,
  }).prompt;
  const implementBase = build({ assignment: 'implement' });
  const auditBase = build({ assignment: 'review', reviewMode: 'audit' });
  try {
    process.env.CRETLI_REVIEW_LESSONS = '0';
    // Flag off: lessons passed in change nothing.
    assert.equal(build({ assignment: 'implement', reviewLessons: { audience: 'implementer', lessons } }), implementBase);
    // Divergent settings: the caller-resolved flag wins over the prompt's ambient env.
    const divergent = { assignment: 'implement', reviewLessons: { audience: 'implementer', lessons } };
    assert.match(build({ ...divergent, reviewLessonsEnabled: true }), /\[KNOWN REVIEW LESSONS\]/);
    assert.equal(build({ ...divergent, reviewLessonsEnabled: false }), implementBase);
    // Rollout defaults (flag unset): implementer on, reviewer suppress off; no lessons stays byte-identical.
    delete process.env.CRETLI_REVIEW_LESSONS;
    assert.equal(build({ assignment: 'implement', reviewLessons: { audience: 'implementer', lessons: [] } }), implementBase);
    assert.match(build({ assignment: 'implement', reviewLessons: { audience: 'implementer', lessons } }), /\[KNOWN REVIEW LESSONS\]/);
    assert.equal(build({ assignment: 'review', reviewMode: 'audit', reviewLessons: { audience: 'reviewer', lessons: suppress } }), auditBase);
    process.env.CRETLI_REVIEW_LESSONS = '1';
    // Flag on but no lessons: byte-identical.
    assert.equal(build({ assignment: 'implement', reviewLessons: { audience: 'implementer', lessons: [] } }), implementBase);
    assert.equal(build({ assignment: 'implement', reviewLessons: null }), implementBase);
    const impl = build({ assignment: 'implement', reviewLessons: { audience: 'implementer', lessons } });
    assert.match(impl, /\[KNOWN REVIEW LESSONS\]\n[^\n]*\n- L1: Add a regression test\./);
    assert.match(impl, /LESSONS CHECKED/);
    assert.doesNotMatch(impl, /KNOWN FALSE POSITIVES/);
    // Reviewer audience: false positives only, security never listed.
    const audit = build({ assignment: 'review', reviewMode: 'audit', reviewLessons: { audience: 'reviewer', lessons: suppress } });
    assert.match(audit, /\[KNOWN FALSE POSITIVES\]/);
    assert.match(audit, /Ignore quote style\./);
    assert.doesNotMatch(audit, /Ignore token handling\./);
    assert.match(audit, /P1 and security findings are never suppressed/);
    assert.doesNotMatch(audit, /KNOWN REVIEW LESSONS/);
    // Implementer lessons never reach a reviewer; suppressions never reach an implementer.
    assert.equal(build({ assignment: 'review', reviewMode: 'audit', reviewLessons: { audience: 'implementer', lessons } }), auditBase);
    assert.equal(build({ assignment: 'implement', reviewLessons: { audience: 'reviewer', lessons: suppress } }), implementBase);
    // Closure reviews get no lessons block.
    assert.doesNotMatch(build({ assignment: 'review', reviewMode: 'closure', reviewLessons: { audience: 'reviewer', lessons: suppress } }), /KNOWN FALSE POSITIVES/);
    // Planner lessons reach plan reviewers only.
    const planner = [{ id: 'p1', kind: 'do', category: 'other', text: 'Name the test files.' }];
    const planReview = build({ assignment: 'review', reviewSubject: 'plan', reviewLessons: { audience: 'planner', lessons: planner } });
    assert.match(planReview, /\[KNOWN PLANNING LESSONS\]/);
    assert.doesNotMatch(build({ assignment: 'implement', reviewLessons: { audience: 'planner', lessons: planner } }), /KNOWN PLANNING LESSONS/);
  } finally {
    if (previous === undefined) delete process.env.CRETLI_REVIEW_LESSONS;
    else process.env.CRETLI_REVIEW_LESSONS = previous;
  }
}
