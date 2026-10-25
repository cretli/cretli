/**
 * Reviewer policy: schema validation, deterministic legacy migration (every
 * enabled/strict/members combination), per-subject learned pairs, the policy
 * snapshot, and the cross-leaf / phase / contamination session gates.
 */
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDelegationSettings, getDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { resolveDelegationSettings, resolveDelegationSettingsView, resolveReviewerPool } from '../lib/delegation-settings.js';
import {
  buildReviewerPolicySnapshot,
  deriveLegacyReviewerPolicy,
  isSameReviewer,
  normalizeReviewerPolicySnapshot,
  resolveReviewerPoliciesForPrompt,
  resolveReviewerPolicy,
} from '../lib/reviewer-policy.js';
import { addReviewerPairMember, readReviewerPairMembers } from '../lib/persist/reviewer-pairs-persist.js';
import {
  findPairResumeSource,
  inspectDelegationSessionResume,
  SESSION_RESUME_REASON as R,
} from '../lib/delegation-session-resume.js';
import { buildReviewerPoolInstruction } from '../lib/todo-execution-prompt.js';

let counter = 0;
const folder = () => `${ISOLATED_DATA_DIR}/ws-${++counter}`;
const A = { harness: 'claude', model: 'claude-opus-5-5' };
const B = { harness: 'codex', model: 'gpt-6-astra' };

test('migration matrix: every enabled/strict/members combination maps explicitly', () => {
  const pair = [A, B];
  const cases = [
    // [enabled, strict, members] -> [selection, source, session]
    [false, false, [], ['auto', 'learned', 'fresh']],
    [false, false, pair, ['auto', 'learned', 'fresh']],
    [true, false, [], ['auto', 'learned', 'fresh']],
    [true, false, pair, ['fixed_pair', 'configured', 'fresh']],
    [false, true, [], ['fixed_pair', 'learned', 'leaf']],
    [false, true, pair, ['fixed_pair', 'configured', 'leaf']],
    [true, true, [], ['fixed_pair', 'learned', 'leaf']],
    [true, true, pair, ['fixed_pair', 'configured', 'leaf']],
  ];
  for (const [enabled, strict, members, expected] of cases) {
    const derived = deriveLegacyReviewerPolicy({ reviewer_pair_enabled: enabled, reviewer_pair_strict: strict, reviewer_pair_members: members });
    assert.deepEqual([derived.selection, derived.members_source, derived.session], expected, JSON.stringify({ enabled, strict, n: members.length }));
    // Never silently widened to orchestrator-wide reuse.
    assert.notEqual(derived.session, 'orchestrator');
  }
});

test('migration is read-time, idempotent, keeps the legacy fields and shows a notice', () => {
  const ws = folder();
  saveDelegationSettings(ws, { reviewer_pair_strict: true, reviewer_pair_enabled: true }, { dataDir: ISOLATED_DATA_DIR });
  const view1 = resolveDelegationSettingsView({ workspaceFolder: ws, dataDir: ISOLATED_DATA_DIR });
  const view2 = resolveDelegationSettingsView({ workspaceFolder: ws, dataDir: ISOLATED_DATA_DIR });
  assert.deepEqual(view1.reviewerPolicy, view2.reviewerPolicy);
  assert.equal(view1.reviewerPolicy.plan.session, 'leaf');
  assert.equal(view1.reviewerPolicy.code.session, 'leaf');
  assert.equal(view1.reviewerPolicy.plan.source, 'legacy');
  assert.equal(view1.reviewerPolicy.migration.notice, 'strict_leaf_reuse');
  assert.equal(view1.effective.reviewer_pair_strict, true, 'legacy fields stay stored for rollback');
  assert.equal(view1.effective.reviewer_policy, null);
});

test('an incomplete legacy pair migrates nothing and shows no pair notice', () => {
  const ws = folder();
  saveDelegationSettings(ws, { reviewer_pair_enabled: true, reviewer_pair_members: [] }, { dataDir: ISOLATED_DATA_DIR });
  const view = resolveDelegationSettingsView({ workspaceFolder: ws, dataDir: ISOLATED_DATA_DIR });
  assert.equal(view.reviewerPolicy.migration.applied, false, 'enabled without a complete pair migrates nothing');
  assert.equal(view.reviewerPolicy.migration.notice, '');
  assert.equal(view.reviewerPolicy.plan.selection, 'auto');
  assert.equal(view.reviewerPolicy.code.selection, 'auto');
});

test('saved policy overrides per subject; a reset returns to the migrated value; review:other stays legacy', () => {
  const ws = folder();
  saveDelegationSettings(ws, { reviewer_pair_strict: true }, { dataDir: ISOLATED_DATA_DIR });
  saveDelegationSettings(ws, { reviewer_policy: { code: { selection: 'fixed_pair', members_source: 'configured', members: [A, B], session: 'orchestrator' } } }, { dataDir: ISOLATED_DATA_DIR });
  const saved = getDelegationSettings(ws, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(saved.reviewer_policy.code.session, 'orchestrator');
  const code = resolveReviewerPolicy(ws, { subject: 'code', dataDir: ISOLATED_DATA_DIR });
  assert.equal(code.source, 'policy');
  assert.equal(code.session, 'orchestrator');
  assert.equal(code.active, true);
  // Plan was not saved: still derived from the legacy strict flag.
  const plan = resolveReviewerPolicy(ws, { subject: 'plan', dataDir: ISOLATED_DATA_DIR });
  assert.equal(plan.source, 'legacy');
  assert.equal(plan.session, 'leaf');
  // review:other ignores the new policy entirely.
  const other = resolveReviewerPolicy(ws, { subject: 'other', dataDir: ISOLATED_DATA_DIR });
  assert.equal(other.session, 'leaf');
  assert.equal(other.membersSource, 'learned');
  // Reset to default (null) -> derived again.
  saveDelegationSettings(ws, { reviewer_policy: null }, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(resolveReviewerPolicy(ws, { subject: 'code', dataDir: ISOLATED_DATA_DIR }).source, 'legacy');
});

test('policy validation rejects incomplete, duplicate-model, unknown-subject and bad-enum input; nothing is written', () => {
  const ws = folder();
  const bad = [
    { plan: { selection: 'fixed_pair', members_source: 'configured', members: [A] } },
    { plan: { selection: 'fixed_pair', members_source: 'configured', members: [A, { ...A, model: 'claude-opus-5-5::effort=high' }] } },
    { other: { selection: 'auto', session: 'fresh' } },
    { plan: { selection: 'auto', session: 'forever' } },
    { plan: { selection: 'pair' } },
    'text',
    [],
  ];
  for (const value of bad) {
    assert.throws(() => saveDelegationSettings(ws, { reviewer_policy: value }, { dataDir: ISOLATED_DATA_DIR }), (err) => err.code === 'VALIDATION', JSON.stringify(value));
  }
  assert.equal(getDelegationSettings(ws, { dataDir: ISOLATED_DATA_DIR }), null);
  // Auto selection drops members and session defaults to fresh.
  saveDelegationSettings(ws, { reviewer_policy: { plan: { selection: 'auto', members: [A, B] } } }, { dataDir: ISOLATED_DATA_DIR });
  assert.deepEqual(getDelegationSettings(ws, { dataDir: ISOLATED_DATA_DIR }).reviewer_policy.plan, { selection: 'auto', members_source: 'learned', members: [], session: 'fresh' });
  assert.equal(resolveDelegationSettings({ workspaceFolder: ws, dataDir: ISOLATED_DATA_DIR }).source.reviewer_policy, 'workspace');
});

test('legacy resolveReviewerPool without a subject is unchanged; with a subject it carries the policy', () => {
  const ws = folder();
  saveDelegationSettings(ws, { reviewer_pair_enabled: true, reviewer_pair_members: [A, B] }, { dataDir: ISOLATED_DATA_DIR });
  assert.equal(resolveReviewerPool(ws, { dataDir: ISOLATED_DATA_DIR }).members.length, 2);
  const planPool = resolveReviewerPool(ws, { dataDir: ISOLATED_DATA_DIR, subject: 'plan' });
  assert.equal(planPool.active, true);
  assert.equal(planPool.strict, false);
  assert.equal(planPool.policy.session, 'fresh');
});

test('learned pairs are partitioned per subject and migrated from the legacy mixed pair by observed subject', () => {
  const parent = 'ctl-1';
  addReviewerPairMember(parent, A);
  addReviewerPairMember(parent, B);
  const row = (subject, member, id) => ({ id, assignment: 'review', parentChatId: parent, reviewSubject: subject, status: 'completed', executor: { transport: member.harness, model: member.model } });
  const delegations = [row('plan', B, '1'), row('code', A, '2'), row('code', B, '3'), row('', A, '4')];
  // Order of the original pair is kept; only members observed for the subject survive.
  assert.deepEqual(readReviewerPairMembers(parent, delegations, 'plan').map((m) => m.model), [B.model]);
  assert.deepEqual(readReviewerPairMembers(parent, delegations, 'code').map((m) => m.model), [A.model, B.model]);
  // Without delegations nothing is inferred; the legacy pair stays untouched for `other`.
  assert.deepEqual(readReviewerPairMembers('ctl-unknown', undefined, 'plan'), []);
  assert.equal(readReviewerPairMembers(parent).length, 2, 'legacy pair retained for rollback');
  // New members land only in their own subject.
  assert.equal(addReviewerPairMember('ctl-2', A, 'plan'), true);
  assert.equal(readReviewerPairMembers('ctl-2', undefined, 'code').length, 0);
  assert.equal(readReviewerPairMembers('ctl-2', undefined, 'plan').length, 1);
});

test('prompt resolver gives every start path the same plan + code policies', () => {
  const ws = folder();
  saveDelegationSettings(ws, { reviewer_policy: { plan: { selection: 'fixed_pair', members_source: 'configured', members: [A, B], session: 'leaf' }, code: { selection: 'auto', session: 'fresh' } } }, { dataDir: ISOLATED_DATA_DIR });
  const first = resolveReviewerPoliciesForPrompt(ws, { dataDir: ISOLATED_DATA_DIR, parentChatId: 'x' });
  const second = resolveReviewerPoliciesForPrompt(ws, { dataDir: ISOLATED_DATA_DIR, parentChatId: 'y' });
  assert.deepEqual(first, second);
  assert.equal(first.reviewerPool.length, 2);
  assert.equal(first.reviewerPoolStrict, true);
  const text = buildReviewerPoolInstruction(first.reviewerPool, {
    strict: true,
    policies: first.policies,
    workPolicies: first.workPolicies,
  });
  assert.match(text, /plan review: fixed pair claude\/claude-opus-5-5, codex\/gpt-6-astra; sessions: one chat per reviewer within a subtask/);
  assert.match(text, /code review: automatic reviewer selection; sessions: a new chat for every review/);
  assert.match(text, /delegated planner: start a fresh chat/);
  // Work sessions continue per TODO subtask by default (continue_implement_sessions / continue_fix_sessions).
  assert.match(text, /implementation: reuse a compatible chat within the same TODO subtask/);
  assert.match(text, /fix: reuse a compatible chat within the same TODO subtask/);
  assert.equal(buildReviewerPoolInstruction([], { policies: [] }), '');
});

test('policy snapshot round-trips and normalizes garbage', () => {
  const policy = resolveReviewerPolicy('', { subject: 'plan' });
  const snap = buildReviewerPolicySnapshot(policy, { membership: 'member', decision: { status: 'resumed', reasonCode: 'resumed', reason: 'r', sourceDelegationId: 's' } });
  assert.deepEqual(normalizeReviewerPolicySnapshot(snap), snap);
  assert.equal(normalizeReviewerPolicySnapshot('x'), null);
  assert.equal(normalizeReviewerPolicySnapshot({ reuse: { status: 'weird' } }).reuse.status, 'fallback');
});

// ---- session gate: scope, phase, contamination ----

const PARENT = 'ctl';
const MODEL = 'claude-opus-5-5::effort=low';
const row = (id, over = {}) => ({
  sessionContinuityConfirmed: true,
  id, parentChatId: PARENT, childChatId: `chat-${id}`, leafId: 'leaf-1', assignment: 'review', reviewSubject: 'code',
  reviewMode: 'closure', status: 'completed', reportVerdict: 'PASS', executionMode: 'agent', executionFolder: '/wt',
  queuedAt: `2026-10-16T10:0${id}:00Z`, executor: { transport: 'claude', model: MODEL, options: {} }, ...over,
  sessionContinuity: over.sessionContinuity || { identity: `identity-${id}`, generation: 0, historyHeadSeq: 7 },
});
const gate = (rows, over = {}) => inspectDelegationSessionResume({
  resumeSessionOf: rows[0].id, parentChatId: PARENT, assignment: 'review', reviewSubject: 'code', reviewMode: 'closure',
  leafId: 'leaf-1', executor: { transport: 'claude', model: MODEL, options: {} }, executionMode: 'agent', executionFolder: '/wt',
  delegations: rows, findChat: (id) => ({ id, claudeSessionId: `s-${id}` }), capabilities: { canResumeSession: true },
  isRunActive: () => false, currentContinuity: () => ({ ...rows[0].sessionContinuity }), ...over,
});

test('gate: leaf scope refuses another leaf; orchestrator scope allows it; other guards still apply', () => {
  const source = row('1');
  assert.equal(gate([source], { leafId: 'leaf-2' }).reasonCode, R.SCOPE_CHANGED);
  const across = gate([source], { leafId: 'leaf-2', sessionScope: 'orchestrator' });
  assert.equal(across.resume, true, across.reason);
  assert.equal(across.childChatId, 'chat-1');
  assert.equal(gate([source], { leafId: 'leaf-2', sessionScope: 'orchestrator', executionFolder: '/other' }).reasonCode, R.CONFIG_CHANGED);
  assert.equal(gate([source], { leafId: 'leaf-2', sessionScope: 'orchestrator', reviewSubject: 'plan' }).reasonCode, R.SCOPE_CHANGED);
  assert.equal(gate([source], { leafId: 'leaf-2', sessionScope: 'orchestrator', capabilities: { canResumeSession: false } }).reasonCode, R.UNSUPPORTED);
  // Independence is judged against the CURRENT leaf's implementers.
  const impl = row('9', { assignment: 'implement', leafId: 'leaf-2', childChatId: 'chat-9', reviewSubject: 'other', reviewMode: '' });
  assert.equal(gate([source, impl], { leafId: 'leaf-2', sessionScope: 'orchestrator' }).reasonCode, R.INDEPENDENCE);
});

test('gate: audit and closure never share a session (phase_changed), either direction', () => {
  assert.equal(gate([row('1', { reviewMode: 'audit' })]).reasonCode, R.PHASE_CHANGED);
  assert.equal(gate([row('1', { reviewMode: 'closure' })], { reviewMode: 'audit' }).reasonCode, R.PHASE_CHANGED);
  assert.equal(gate([row('1', { reviewMode: 'closure' })]).resume, true);
});

test('gate: a session with implementation/fix history is contaminated and never reused', () => {
  const source = row('1');
  const sameChatImplement = row('2', { assignment: 'fix', childChatId: 'chat-1', reviewSubject: 'other', reviewMode: '', executor: { transport: 'claude', model: 'other-model', options: {} } });
  assert.equal(gate([source, sameChatImplement]).reasonCode, R.CONTAMINATED);
});

test('source lookup: scope selects leaf-only vs whole orchestration and prefers the same phase', () => {
  const rows = [
    row('1', { leafId: 'leaf-1', reviewMode: 'closure' }),
    row('2', { leafId: 'leaf-2', reviewMode: 'audit' }),
    row('3', { leafId: 'leaf-3', reviewMode: 'closure' }),
  ];
  const base = { delegations: rows, parentChatId: PARENT, reviewSubject: 'code', executor: { transport: 'claude', model: MODEL } };
  assert.equal(findPairResumeSource({ ...base, leafId: 'leaf-2', reviewMode: 'audit' }), '2');
  assert.equal(findPairResumeSource({ ...base, leafId: 'leaf-4', reviewMode: 'closure' }), '', 'leaf scope never crosses leaves');
  assert.equal(findPairResumeSource({ ...base, leafId: 'leaf-4', reviewMode: 'closure', scope: 'orchestrator' }), '3');
  assert.equal(findPairResumeSource({ ...base, leafId: 'leaf-4', reviewMode: 'audit', scope: 'orchestrator' }), '2', 'closure -> audit is not offered');
  // Only a different phase exists: it is returned so the gate records phase_changed honestly.
  assert.equal(findPairResumeSource({ ...base, delegations: [rows[1]], leafId: 'leaf-4', reviewMode: 'closure', scope: 'orchestrator' }), '2');
});

test('manual TODO, full mode and Watcher prompts carry identical policy lines (parity, also while the pair is only being learned)', async () => {
  const { buildWorkspaceWatcherCyclePromptPlan } = await import('../lib/workspace-watcher-prompt.js');
  const { buildTodoAgentInitialPrompt, buildTodoFullOrchestratorPrompt, buildTodoRefineInitialPrompt } = await import('../lib/todo-agent.js');
  const ws = folder();
  saveDelegationSettings(ws, { reviewer_policy: { code: { selection: 'fixed_pair', members_source: 'learned', session: 'orchestrator' } } }, { dataDir: ISOLATED_DATA_DIR });
  const { policies, workPolicies, reviewerPool, reviewerPoolStrict } = resolveReviewerPoliciesForPrompt(ws, { dataDir: ISOLATED_DATA_DIR, parentChatId: 'chat-1' });
  assert.equal(reviewerPool.length, 0, 'nothing learned yet');
  const todo = { id: 't', title: 'x', status: 'doing' };
  const options = { reviewerPool, reviewerPoolStrict, reviewerPolicies: policies, workPolicies, hasChildren: true };
  const line = /code review: fixed pair \(learned from the first two reviewers of this orchestration\); sessions: one chat per reviewer across the whole orchestration/;
  assert.match(buildTodoAgentInitialPrompt(todo, 'chat-1', options), line);
  assert.match(buildTodoFullOrchestratorPrompt(todo, 'chat-1', options), line);
  assert.match(buildTodoRefineInitialPrompt(todo, 'chat-1', options), line);
  const watcher = buildWorkspaceWatcherCyclePromptPlan({
    workspaceFolder: ws, watcher: { policy: { requirePlanApproval: false }, reviewWaits: {} }, decision: { kind: 'start_cycle' },
    todo, orchestrator: { harness: 'mock', model: 'cheap', source: 'policy' }, cycleId: 'c', reviewerPool, reviewerPoolStrict, reviewerPolicies: policies, workPolicies,
  }).prompt;
  assert.match(watcher, line);
  // All-default policies leave the prompts untouched.
  const off = resolveReviewerPoliciesForPrompt(folder(), { dataDir: ISOLATED_DATA_DIR });
  assert.doesNotMatch(buildTodoAgentInitialPrompt(todo, 'chat-1', { hasChildren: true, reviewerPolicies: off.policies }), /REVIEWER POLICY/);
});

// F1 regression: a Claude moving alias and the numbered id it resolves to are
// ONE reviewer, in matching, learned pairs, configured-pair validation and the
// session-resume config gate.
test('model aliases canonicalize so claude/sonnet and claude/claude-sonnet-5-5 are one reviewer', () => {
  assert.equal(isSameReviewer({ harness: 'claude', model: 'sonnet' }, { harness: 'claude', model: 'claude-sonnet-5-5' }), true);
  assert.equal(isSameReviewer(
    { harness: 'claude', model: 'sonnet::effort=high' },
    { harness: 'claude', model: 'claude-sonnet-5-5::effort=low' },
  ), true);
  assert.equal(isSameReviewer({ harness: 'claude', model: 'opus' }, { harness: 'claude', model: 'claude-opus-5-5' }), true);
  assert.equal(isSameReviewer({ harness: 'codex', model: 'gpt-6-astra' }, { harness: 'codex', model: 'gpt-6-astra::effort=low' }), true);
  assert.equal(isSameReviewer({ harness: 'codex', model: 'gpt-6' }, { harness: 'claude', model: 'gpt-6' }), false);
  // Learned pair: the alias is the same member, never a second slot.
  addReviewerPairMember('ctl-alias', { harness: 'claude', model: 'sonnet' }, 'code');
  assert.equal(addReviewerPairMember('ctl-alias', { harness: 'claude', model: 'claude-sonnet-5-5' }, 'code'), false);
  assert.equal(readReviewerPairMembers('ctl-alias', undefined, 'code').length, 1);
  // Configured-pair validation rejects the alias duplicate.
  const ws = folder();
  assert.throws(
    () => saveDelegationSettings(ws, {
      reviewer_policy: {
        code: {
          selection: 'fixed_pair',
          members_source: 'configured',
          members: [{ harness: 'claude', model: 'sonnet' }, { harness: 'claude', model: 'claude-sonnet-5-5' }],
        },
      },
    }, { dataDir: ISOLATED_DATA_DIR }),
    (err) => err.code === 'VALIDATION',
  );
  // Session-resume config gate: the alias names the same session.
  const aliasRow = {
    id: 'alias-1', parentChatId: PARENT, childChatId: 'chat-alias', leafId: 'leaf-1', assignment: 'review',
    reviewSubject: 'code', reviewMode: 'closure', status: 'completed', reportVerdict: 'PASS',
    executor: { transport: 'claude', model: 'sonnet::effort=low', options: {} },
  };
  assert.equal(findPairResumeSource({
    delegations: [aliasRow], parentChatId: PARENT, reviewSubject: 'code', leafId: 'leaf-1', reviewMode: 'closure',
    executor: { transport: 'claude', model: 'claude-sonnet-5-5::effort=low' },
  }), 'alias-1');
  assert.equal(findPairResumeSource({
    delegations: [aliasRow], parentChatId: PARENT, reviewSubject: 'code', leafId: 'leaf-1', reviewMode: 'closure',
    executor: { transport: 'claude', model: 'claude-sonnet-5-5::effort=high' },
  }), '', 'a different effort is still a different session config');
});

// F19 regression: the policy revision reuses the shared canonical model identity,
// so an alias + effort spelling of the SAME pair does not produce a new revision.
test('policy revision canonicalizes configured members (alias + effort)', () => {
  const wsAlias = folder();
  const wsNumbered = folder();
  saveDelegationSettings(wsAlias, {
    reviewer_pair_enabled: true,
    reviewer_pair_members: [
      { harness: 'claude', model: 'sonnet' },
      { harness: 'codex', model: 'gpt-6-astra' },
    ],
  }, { dataDir: ISOLATED_DATA_DIR });
  saveDelegationSettings(wsNumbered, {
    reviewer_pair_enabled: true,
    reviewer_pair_members: [
      { harness: 'claude', model: 'claude-sonnet-5-5::effort=high' },
      { harness: 'codex', model: 'gpt-6-astra::effort=low' },
    ],
  }, { dataDir: ISOLATED_DATA_DIR });
  const aliasRevision = resolveReviewerPolicy(wsAlias, { subject: 'code', dataDir: ISOLATED_DATA_DIR }).revision;
  const numberedRevision = resolveReviewerPolicy(wsNumbered, { subject: 'code', dataDir: ISOLATED_DATA_DIR }).revision;
  assert.equal(aliasRevision, numberedRevision, 'the same pair must have one revision whatever the alias/effort spelling');
  // A different pair on another subject still gets a distinct revision.
  assert.notEqual(aliasRevision, resolveReviewerPolicy(wsAlias, { subject: 'plan', dataDir: ISOLATED_DATA_DIR }).revision);
});

test('a learned member that can no longer be started is evicted and the pair learns again; a configured pair is never rewritten', () => {
  const notB = (member) => member.harness !== B.harness;
  const learnedWs = folder();
  saveDelegationSettings(learnedWs, { reviewer_policy: { code: { selection: 'fixed_pair', members_source: 'learned', session: 'fresh' } } }, { dataDir: ISOLATED_DATA_DIR });
  addReviewerPairMember('ctl-evict', A, 'code');
  addReviewerPairMember('ctl-evict', B, 'code');
  const opts = { subject: 'code', parentChatId: 'ctl-evict', delegations: [], dataDir: ISOLATED_DATA_DIR };
  const before = resolveReviewerPolicy(learnedWs, { ...opts, isMemberStartable: () => true });
  assert.equal(before.active, true);
  const after = resolveReviewerPolicy(learnedWs, { ...opts, isMemberStartable: notB });
  assert.deepEqual(after.known.map((m) => m.model), [A.model]);
  assert.equal(after.active, false);
  assert.equal(after.learning, true, 'the next distinct reviewer joins through learning');
  // keepMember exempts the member the current start just learned.
  addReviewerPairMember('ctl-evict', B, 'code');
  const kept = resolveReviewerPolicy(learnedWs, { ...opts, isMemberStartable: notB, keepMember: B });
  assert.equal(kept.active, true);
  const configuredWs = folder();
  saveDelegationSettings(configuredWs, { reviewer_policy: { code: { selection: 'fixed_pair', members_source: 'configured', members: [A, B], session: 'fresh' } } }, { dataDir: ISOLATED_DATA_DIR });
  const configured = resolveReviewerPolicy(configuredWs, { ...opts, parentChatId: 'ctl-configured', isMemberStartable: () => false });
  assert.deepEqual(configured.members.map((m) => m.model), [A.model, B.model]);
  assert.equal(configured.active, true);
});
