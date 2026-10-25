/**
 * Work-role classification, the single continuation resolver (plan / implement
 * / fix switches + reviewer_policy for reviews), settings persistence, and the
 * plan / implement / fix session-resume gate.
 */
import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  allowedResumeSourceRoles,
  classifyDelegationWorkRole,
  readRowWorkRole,
} from '../lib/delegation-work-role.js';
import { resolveDelegationContinuationPolicy, resolveDelegationSettings } from '../lib/delegation-settings.js';
import { getDelegationById } from '../lib/persist/delegations-persist.js';
import { getDelegationSettings, saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import {
  buildSessionResumePromptBlock,
  findWorkResumeSource,
  inspectDelegationSessionResume,
  SESSION_RESUME_REASON as R,
} from '../lib/delegation-session-resume.js';
import { tempDir } from './helpers/temp-git-repo.js';
import {
  buildDelegationOutcomes,
  delegationPersistedRole,
  resolveLeafStickyExecutor,
} from '../lib/model-pick-history.js';

function sandbox() {
  return { dataDir: tempDir('cretli-work-data-'), workspace: tempDir('cretli-work-ws-') };
}
const rm = (sb) => {
  fs.rmSync(sb.dataDir, { recursive: true, force: true });
  fs.rmSync(sb.workspace, { recursive: true, force: true });
};

test('classification separates plan authoring from plan review, fix from implement', () => {
  const c = (input) => classifyDelegationWorkRole(input);
  assert.equal(c({ rawAssignment: 'implement', assignment: 'implement', requestedRole: 'plan' }), 'plan');
  assert.equal(c({ rawAssignment: 'review', assignment: 'review', requestedRole: 'plan', reviewSubject: 'plan' }), 'review_plan');
  assert.equal(c({ rawAssignment: '', assignment: 'review', requestedRole: '', reviewSubject: 'code' }), 'review_code');
  assert.equal(c({ rawAssignment: 'review', assignment: 'review', reviewSubject: 'other' }), 'review_other');
  assert.equal(c({ rawAssignment: 'fix', assignment: 'implement', requestedRole: 'fix' }), 'fix');
  assert.equal(c({ rawAssignment: 'implement', assignment: 'implement', requestedRole: 'fix' }), 'fix');
  assert.equal(c({ rawAssignment: 'implement', assignment: 'implement' }), 'implement');
  // The bare alias is a plan REVIEW under legacy normalization, never authoring.
  assert.equal(c({ rawAssignment: 'plan', assignment: 'review', requestedRole: 'plan', reviewSubject: 'plan' }), 'review_plan');
  assert.equal(readRowWorkRole({}), '');
  assert.equal(readRowWorkRole({ workRole: 'bogus' }), '');
  assert.deepEqual(allowedResumeSourceRoles('fix'), ['fix', 'implement']);
  assert.deepEqual(allowedResumeSourceRoles('implement'), ['implement']);
  assert.deepEqual(allowedResumeSourceRoles('review_code'), []);
});

test('planner rows are plan statistics, never implementation evidence or sticky executors', () => {
  const planner = {
    id: randomUUID(),
    parentChatId: randomUUID(),
    leafId: randomUUID(),
    assignment: 'implement',
    workRole: 'plan',
    executionMode: 'plan',
    status: 'completed',
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    executor: { transport: 'testfake', model: 'testfake/planner' },
    report: 'TASK: audit\nVERDICT: PASS',
  };
  const outcomes = buildDelegationOutcomes({ rows: [planner], ratings: [], now: Date.now() });
  assert.equal(delegationPersistedRole(planner), 'plan');
  assert.equal(outcomes.roles.implement['testfake/testfake/planner'], undefined);
  assert.ok(outcomes.roles.plan['testfake/testfake/planner']);
  assert.equal(resolveLeafStickyExecutor([planner], planner.leafId), null);
});

test('resolver: implement/fix default on, plan default off, save/reload, reset, independence, rejection', () => {
  const sb = sandbox();
  try {
    const opts = { workspaceFolder: sb.workspace, dataDir: sb.dataDir };
    for (const role of ['plan', 'implement', 'fix']) {
      const r = resolveDelegationContinuationPolicy({ ...opts, workRole: role });
      assert.equal(r.enabled, role !== 'plan', role);
      assert.equal(r.source, 'default');
      if (r.enabled) assert.equal(r.scope, 'leaf', `${role} scope stays leaf by default`);
    }
    // An explicitly stored false wins over the new default.
    saveDelegationSettings(sb.workspace, { continue_fix_sessions: false }, { dataDir: sb.dataDir });
    const fixOff = resolveDelegationContinuationPolicy({ ...opts, workRole: 'fix' });
    assert.equal(fixOff.enabled, false);
    assert.equal(fixOff.source, 'workspace');
    assert.equal(fixOff.field, 'continue_fix_sessions');
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: 'implement' }).enabled, true, 'independent');
    assert.equal(getDelegationSettings(sb.workspace, { dataDir: sb.dataDir }).continue_fix_sessions, false, 'reload');
    saveDelegationSettings(sb.workspace, { continue_fix_sessions: null }, { dataDir: sb.dataDir });
    const fixReset = resolveDelegationContinuationPolicy({ ...opts, workRole: 'fix' });
    assert.equal(fixReset.source, 'default', 'reset');
    assert.equal(fixReset.enabled, true, 'reset follows the new default');
    // Plan stays opt-in and independent of the work switches.
    saveDelegationSettings(sb.workspace, { continue_plan_sessions: true }, { dataDir: sb.dataDir });
    const plan = resolveDelegationContinuationPolicy({ ...opts, workRole: 'plan' });
    assert.equal(plan.enabled, true);
    assert.equal(plan.source, 'workspace');
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: 'implement' }).source, 'default');
    assert.throws(() => saveDelegationSettings(sb.workspace, { continue_plan_sessions: 'maybe' }, { dataDir: sb.dataDir }), /invalid value/);
    assert.throws(() => saveDelegationSettings(sb.workspace, { continue_review_code_sessions: true }, { dataDir: sb.dataDir }), /unknown delegation setting/);
    // Unknown / legacy-only roles fail closed.
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: '' }).reason, 'unclassified_role');
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: 'review_other' }).enabled, false);
  } finally { rm(sb); }
});

test('saving unrelated settings never materialises the continuation switches', () => {
  const sb = sandbox();
  try {
    const opts = { workspaceFolder: sb.workspace, dataDir: sb.dataDir };
    // Existing workspace: implement explicitly off, fix and plan unset.
    saveDelegationSettings(sb.workspace, { continue_implement_sessions: false }, { dataDir: sb.dataDir });
    saveDelegationSettings(sb.workspace, { review_fanout: 1 }, { dataDir: sb.dataDir });
    const stored = getDelegationSettings(sb.workspace, { dataDir: sb.dataDir });
    assert.equal(stored.continue_implement_sessions, false, 'stored value kept');
    assert.equal('continue_fix_sessions' in stored, false, 'unset fix not written');
    assert.equal('continue_plan_sessions' in stored, false, 'unset plan not written');
    const implement = resolveDelegationContinuationPolicy({ ...opts, workRole: 'implement' });
    assert.equal(implement.enabled, false);
    assert.equal(implement.source, 'workspace');
    const fix = resolveDelegationContinuationPolicy({ ...opts, workRole: 'fix' });
    assert.equal(fix.enabled, true);
    assert.equal(fix.source, 'default');
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: 'plan' }).enabled, false);
  } finally { rm(sb); }
});

test('review continuation is reviewer_policy.session: legacy settings keep their effective behaviour', () => {
  const sb = sandbox();
  try {
    const opts = { workspaceFolder: sb.workspace, dataDir: sb.dataDir };
    // Nothing configured: fresh, exactly as before.
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: 'review_code' }).enabled, false);
    // Legacy strict pair (migration source) still means leaf reuse.
    saveDelegationSettings(sb.workspace, { reviewer_pair_enabled: true, reviewer_pair_strict: true, reviewer_pair_members: [{ harness: 'codex', model: 'a' }, { harness: 'claude', model: 'b' }] }, { dataDir: sb.dataDir });
    const legacy = resolveDelegationContinuationPolicy({ ...opts, workRole: 'review_code' });
    assert.equal(legacy.enabled, true);
    assert.equal(legacy.scope, 'leaf');
    assert.equal(legacy.source, 'legacy');
    // Saving the new work switches never touches the review outcome.
    saveDelegationSettings(sb.workspace, { continue_implement_sessions: true }, { dataDir: sb.dataDir });
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: 'review_plan' }).scope, 'leaf');
    // An explicit policy session wins per subject; review:other stays legacy-only.
    saveDelegationSettings(sb.workspace, { reviewer_policy: { plan: { selection: 'auto', session: 'orchestrator' } } }, { dataDir: sb.dataDir });
    const plan = resolveDelegationContinuationPolicy({ ...opts, workRole: 'review_plan' });
    assert.equal(plan.scope, 'orchestrator');
    assert.equal(plan.source, 'workspace');
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: 'review_code' }).scope, 'leaf', 'code still derives from legacy');
    assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: 'review_other' }).reason, 'legacy_only');
    // The legacy fields are preserved verbatim.
    assert.equal(resolveDelegationSettings(opts).effective.reviewer_pair_strict, true);
  } finally { rm(sb); }
});

// ---- gate -----------------------------------------------------------------

const parentChatId = randomUUID();
const leafId = randomUUID();
const MODEL = 'testfake/test';

function row(role, overrides = {}) {
  return {
    id: randomUUID(),
    parentChatId,
    childChatId: randomUUID(),
    leafId,
    assignment: role === 'plan' || role === 'implement' || role === 'fix' ? 'implement' : 'review',
    workRole: role,
    status: 'completed',
    executionMode: 'agent',
    executionFolder: '/tmp/wt',
    executor: { transport: 'testfake', model: MODEL, options: {} },
    sessionContinuity: { identity: randomUUID(), generation: 0, historyHeadSeq: 7 },
    sessionContinuityConfirmed: true,
    ...overrides,
  };
}

function gate(source, rows, workRole, overrides = {}) {
  const chats = new Map(rows.map((r) => [r.childChatId, { id: r.childChatId, opencodeSessionId: `s-${r.childChatId}` }]));
  return inspectDelegationSessionResume({
    resumeSessionOf: source.id,
    parentChatId,
    assignment: workRole === 'plan' ? 'implement' : 'implement',
    workRole,
    leafId,
    executor: { transport: 'testfake', model: MODEL, options: {} },
    executionMode: 'agent',
    executionFolder: '/tmp/wt',
    delegations: rows,
    findChat: (id) => chats.get(id) || null,
    capabilities: { canResumeSession: true },
    lockoutActive: false,
    isRunActive: () => false,
    currentContinuity: () => ({ ...source.sessionContinuity }),
    ...overrides,
  });
}

test('gate: implement and fix re-enter their own history; implement -> fix is the only cross-role edge', () => {
  const impl = row('implement');
  assert.equal(gate(impl, [impl], 'implement').resume, true);
  assert.equal(gate(impl, [impl], 'fix').resume, true, 'implement -> fix');
  const fix = row('fix');
  assert.equal(gate(fix, [fix], 'fix').resume, true, 'fix -> fix');
  const refused = gate(fix, [fix], 'implement');
  assert.equal(refused.reasonCode, R.ROLE_CHANGED, 'fix -> implement is refused');
  const plan = row('plan');
  assert.equal(gate(plan, [plan], 'plan').resume, true);
  assert.equal(gate(plan, [plan], 'implement').reasonCode, R.ROLE_CHANGED);
  assert.equal(gate(impl, [impl], 'plan').reasonCode, R.ROLE_CHANGED);
  const result = gate(impl, [impl], 'fix');
  assert.equal(result.round, 2);
  assert.equal(result.childChatId, impl.childChatId);
});

test('gate: never crosses leaves, controllers or into review history', () => {
  const impl = row('implement');
  assert.equal(gate(impl, [impl], 'implement', { leafId: randomUUID() }).reasonCode, R.SCOPE_CHANGED);
  assert.equal(gate(impl, [impl], 'implement', { leafId: '' }).reasonCode, R.NO_LEAF);
  assert.equal(gate(impl, [impl], 'implement', { parentChatId: randomUUID() }).reasonCode, R.SOURCE_NOT_FOUND);
  const review = row('review_code', { childChatId: impl.childChatId });
  assert.equal(gate(impl, [impl, review], 'implement').reasonCode, R.WORK_HISTORY, 'review in the chat');
  const reviewSource = row('review_code');
  assert.equal(gate(reviewSource, [reviewSource], 'implement').reasonCode, R.ROLE_CHANGED, 'a review is never a work source');
  // The review gate still refuses implement/fix history.
  const reviewStart = inspectDelegationSessionResume({ ...{ resumeSessionOf: impl.id, parentChatId, assignment: 'review', reviewSubject: 'code', leafId, delegations: [impl] } });
  assert.equal(reviewStart.resume, false);
});

test('gate: legacy rows, changed config, busy, claimed, reset, missing chat and adapter are fresh with a reason', () => {
  const impl = row('implement');
  const legacy = row('', { assignment: 'implement' });
  assert.equal(gate(legacy, [legacy], 'implement').reasonCode, R.UNCLASSIFIED);
  assert.equal(gate(impl, [impl], 'implement', { executor: { transport: 'testfake', model: 'testfake/other', options: {} } }).reasonCode, R.CONFIG_CHANGED);
  assert.equal(gate(impl, [impl], 'implement', { executor: { transport: 'testfake', model: MODEL, options: { x: 1 } } }).reasonCode, R.CONFIG_CHANGED);
  assert.equal(gate(impl, [impl], 'implement', { executionFolder: '/tmp/other' }).reasonCode, R.CONFIG_CHANGED);
  assert.equal(gate(impl, [impl], 'implement', { allowChildDelegations: true }).reasonCode, R.CONFIG_CHANGED, 'rights');
  assert.equal(gate(impl, [impl], 'implement', { executionMode: 'plan' }).reasonCode, R.CONFIG_CHANGED);
  assert.equal(gate(impl, [impl], 'implement', { capabilities: { canResumeSession: false } }).reasonCode, R.UNSUPPORTED);
  assert.equal(gate(impl, [impl], 'implement', { lockoutActive: true }).reasonCode, R.LOCKED_OUT);
  assert.equal(gate(impl, [impl], 'implement', { isRunActive: () => true }).reasonCode, R.SOURCE_BUSY);
  assert.equal(gate(impl, [impl], 'implement', {
    currentContinuity: () => ({ ...impl.sessionContinuity, generation: 3 }),
  }).reasonCode, R.SESSION_RESET);
  assert.equal(gate(impl, [impl], 'implement', {
    currentContinuity: () => ({ ...impl.sessionContinuity, historyHeadSeq: 8 }),
  }).reasonCode, R.WORK_HISTORY);
  assert.equal(gate(impl, [impl], 'implement', { currentContinuity: () => null }).reasonCode, R.CONTINUITY_UNKNOWN);
  assert.equal(gate(impl, [impl], 'implement', { findChat: () => null }).reasonCode, R.CHAT_MISSING);
  assert.equal(gate(impl, [impl], 'implement', { findChat: () => ({ id: impl.childChatId }) }).reasonCode, R.SESSION_MISSING);
  const claimant = row('implement', { childChatId: impl.childChatId, status: 'queued' });
  assert.equal(gate(impl, [impl, claimant], 'implement').reasonCode, R.SOURCE_CLAIMED, 'atomic claim');
  const cancelled = row('implement', { status: 'cancelled' });
  assert.equal(gate(cancelled, [cancelled], 'implement').reasonCode, R.SOURCE_CANCELLED);
  const interrupted = row('implement', { status: 'interrupted' });
  assert.equal(gate(interrupted, [interrupted], 'implement').reasonCode, R.AFTER_RESTART);
  const later = row('implement', { childChatId: impl.childChatId, queuedAt: new Date(Date.now() + 1000).toISOString() });
  impl.queuedAt = new Date().toISOString();
  assert.equal(gate(impl, [impl, later], 'implement').reasonCode, R.SOURCE_SUPERSEDED);
});

test('source lookup: newest finished row of the same leaf, controller and executor config', () => {
  const impl = row('implement', { queuedAt: '2026-01-01T00:00:00Z' });
  const fix = row('fix', { queuedAt: '2026-01-02T00:00:00Z' });
  const otherLeaf = row('fix', { leafId: randomUUID(), queuedAt: '2026-01-03T00:00:00Z' });
  const otherModel = row('fix', { queuedAt: '2026-01-04T00:00:00Z', executor: { transport: 'testfake', model: 'x', options: {} } });
  const running = row('fix', { queuedAt: '2026-01-05T00:00:00Z', status: 'running' });
  const rows = [impl, fix, otherLeaf, otherModel, running];
  const base = { delegations: rows, parentChatId, leafId, executor: { transport: 'testfake', model: MODEL, options: {} } };
  assert.equal(findWorkResumeSource({ ...base, workRole: 'fix' }), fix.id);
  assert.equal(findWorkResumeSource({ ...base, workRole: 'implement' }), impl.id, 'implement never picks a fix chat');
  assert.equal(findWorkResumeSource({ ...base, workRole: 'plan' }), '');
  assert.equal(findWorkResumeSource({ ...base, workRole: 'fix', leafId: '' }), '');
  assert.equal(findWorkResumeSource({ ...base, workRole: 'review_code' }), '');
});

test('resumed work prompt block is neutral and never carries a verdict', () => {
  const block = buildSessionResumePromptBlock({ round: 3, workRole: 'fix' });
  assert.match(block, /\[RESUMED FIX SESSION, ROUND 3\]/);
  assert.match(block, /do not apply to the current material/);
  assert.doesNotMatch(block, /REVIEW ROUND/);
  assert.match(buildSessionResumePromptBlock({ round: 2 }), /RESUMED REVIEW ROUND 2/);
  assert.equal(getDelegationById(randomUUID()), null);
});


test('work scope is independently saved, validated and gated by its switch', () => {
  const sb = sandbox();
  try {
    const opts = { workspaceFolder: sb.workspace, dataDir: sb.dataDir };
    for (const role of ['plan', 'implement', 'fix']) {
      // Explicit off: implement/fix default on, so the gate is exercised through a stored false.
      saveDelegationSettings(sb.workspace, { [`continue_${role}_sessions`]: false, [`${role}_session_scope`]: 'orchestrator' }, { dataDir: sb.dataDir });
      assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: role }).scope, 'fresh');
      saveDelegationSettings(sb.workspace, { [`continue_${role}_sessions`]: true }, { dataDir: sb.dataDir });
      assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: role }).scope, 'orchestrator');
      saveDelegationSettings(sb.workspace, { [`${role}_session_scope`]: null }, { dataDir: sb.dataDir });
      assert.equal(resolveDelegationContinuationPolicy({ ...opts, workRole: role }).scope, 'leaf');
    }
    assert.throws(() => saveDelegationSettings(sb.workspace, { fix_session_scope: 'global' }, { dataDir: sb.dataDir }), /invalid value/);
  } finally { rm(sb); }
});

test('orchestrator work scope crosses leaves but preserves isolation and durable history checks', () => {
  const impl = row('implement');
  const nextLeaf = randomUUID();
  const scope = { sessionScope: 'orchestrator', leafId: nextLeaf };
  assert.equal(gate(impl, [impl], 'implement', scope).resume, true);
  assert.equal(gate(impl, [impl], 'fix', scope).resume, true);
  const priorRound = row('implement', { childChatId: impl.childChatId, leafId: randomUUID(), queuedAt: '2025-01-01' });
  impl.queuedAt = '2026-01-01';
  assert.equal(gate(impl, [priorRound, impl], 'implement', scope).resume, true);
  assert.equal(gate(impl, [impl], 'implement', { ...scope, executionFolder: '/tmp/other' }).reasonCode, R.CONFIG_CHANGED);
  assert.equal(gate(impl, [impl], 'implement', { ...scope, parentChatId: randomUUID() }).reasonCode, R.SOURCE_NOT_FOUND);
  assert.equal(gate(impl, [impl], 'implement', { ...scope, currentContinuity: () => ({ ...impl.sessionContinuity, historyHeadSeq: 8 }) }).reasonCode, R.WORK_HISTORY);
  const review = row('review_code', { childChatId: impl.childChatId });
  assert.equal(gate(impl, [impl, review], 'implement', scope).reasonCode, R.WORK_HISTORY);
  const base = { delegations: [impl], parentChatId, executor: impl.executor, workRole: 'implement', ...scope };
  assert.equal(findWorkResumeSource(base), impl.id);
  assert.equal(findWorkResumeSource({ ...base, sessionScope: 'leaf' }), '');
});
