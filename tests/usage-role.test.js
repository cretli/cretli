import assert from 'node:assert/strict';
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import { USAGE_ROLES } from '../lib/usage/usage-event.js';
import { buildDelegationRoleIndex, delegationWorkRole, resolveEffectiveUsageRole } from '../lib/usage/usage-role.ts';
import { resolveHarnessRole } from '../lib/usage/harness-usage.ts';
import { buildUsageTop } from '../lib/usage/usage-top.ts';
import { USAGE_SCHEMA_VERSION, USAGE_READABLE_SCHEMA_VERSIONS } from '../lib/usage/usage-contract.js';

test('orchestrator is a usage role and the schema is bumped to 4', () => {
  assert.ok(USAGE_ROLES.includes('orchestrator'));
  assert.equal(USAGE_SCHEMA_VERSION, 4);
  assert.ok(USAGE_READABLE_SCHEMA_VERSIONS.includes(3));
});

test('delegationWorkRole maps work roles and falls back to assignment', () => {
  assert.equal(delegationWorkRole({ workRole: 'plan', assignment: 'implement' }), 'plan');
  assert.equal(delegationWorkRole({ workRole: 'fix', assignment: 'implement' }), 'fix');
  assert.equal(delegationWorkRole({ workRole: 'review_plan', assignment: 'review' }), 'review');
  assert.equal(delegationWorkRole({ assignment: 'implement' }), 'implement');
  assert.equal(delegationWorkRole({}), '');
});

test('resolveHarnessRole stores plan/fix/orchestrator as their own roles', () => {
  // The runtime assignment folds plan->review and fix->implement; the work role wins.
  assert.equal(resolveHarnessRole({ delegationAssignment: 'review', delegationWorkRole: 'plan', delegationId: 'd' }), 'plan');
  assert.equal(resolveHarnessRole({ delegationAssignment: 'implement', delegationWorkRole: 'fix', delegationId: 'd' }), 'fix');
  assert.equal(resolveHarnessRole({ delegationAssignment: 'implement' }), 'implement');
  assert.equal(resolveHarnessRole({ watcherCycleId: 'c1' }), 'orchestrator');
  assert.equal(resolveHarnessRole({ watcherCycleId: 'c1', delegationId: 'd' }), 'chat');
  assert.equal(resolveHarnessRole({}), 'chat');
});

test('historical events resolve to the effective role through the delegation join', () => {
  const index = buildDelegationRoleIndex([
    { id: 'p1', workRole: 'plan', assignment: 'implement' },
    { id: 'f1', workRole: 'fix', assignment: 'implement' },
    { id: 'r1', workRole: 'review_code', assignment: 'review' },
  ]);
  assert.equal(resolveEffectiveUsageRole({ role: 'review', delegationId: 'p1' }, index), 'plan');
  assert.equal(resolveEffectiveUsageRole({ role: 'implement', delegationId: 'f1' }, index), 'fix');
  assert.equal(resolveEffectiveUsageRole({ role: 'review', delegationId: 'r1' }, index), 'review');
  assert.equal(resolveEffectiveUsageRole({ role: 'chat', cycleId: 'c1' }, index), 'orchestrator');
  assert.equal(resolveEffectiveUsageRole({ role: 'chat' }, index), 'chat');
  assert.equal(resolveEffectiveUsageRole({ role: 'implement', delegationId: 'unknown' }, index), 'implement');
});

test('usage_top role axis uses the effective role', () => {
  const ev = (o) => ({ eventType: 'delta', harness: 'claude', tokens: { textInput: 10, textOutput: 0, cachedInput: 0, cacheWrite: 0 }, ...o });
  const top = buildUsageTop({
    events: [ev({ role: 'review', delegationId: 'p1' }), ev({ role: 'implement', delegationId: 'f1' }), ev({ role: 'chat', cycleId: 'c1' }), ev({ role: 'plan' })],
    delegations: [{ id: 'p1', workRole: 'plan', assignment: 'implement' }, { id: 'f1', workRole: 'fix', assignment: 'implement' }],
    groupBy: 'role',
  });
  assert.deepEqual(top.rows.map((r) => r.key).sort(), ['fix', 'orchestrator', 'plan']);
  assert.equal(top.rows.find((r) => r.key === 'plan').events, 2);
});
