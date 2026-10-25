import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isWatcherInitiativeLeaf,
  findNewPackageJsonDependencies,
  evaluateWorkspaceWatcherGuardrails,
} from '../lib/workspace-watcher-guardrails.js';

test('initiative leaf: large body without Leaf scope', () => {
  assert.equal(isWatcherInitiativeLeaf({ body: 'x'.repeat(1500) }), true);
  assert.equal(isWatcherInitiativeLeaf({ body: `${'x'.repeat(1500)}\n## Leaf scope\n- lib/a.js` }), false);
  assert.equal(isWatcherInitiativeLeaf({ body: 'short' }), false);
});

test('new package.json dependency in a subdirectory is found', () => {
  const diff = [
    '+++ b/desktop/package.json',
    '+    "electron": "^30.0.0"',
    '+++ b/lib/x.js',
    '+    "foo": "1"',
  ].join('\n');
  assert.deepEqual(findNewPackageJsonDependencies(diff), [{ file: 'desktop/package.json', name: 'electron' }]);
});

test('package.json detector is section-aware and ignores version bumps', () => {
  const diff = [
    '+++ b/desktop/package.json',
    '@@ -1,12 +1,14 @@',
    ' {',
    '+  "author": "me",',
    '   "scripts": {',
    '+    "start": "electron ."',
    '   },',
    '   "dependencies": {',
    '-    "left-pad": "1.0.0",',
    '+    "left-pad": "1.1.0",',
    '+    "@scope/new": "^2.0.0"',
    '   },',
    '   "devDependencies": {',
    '+    "vitest": "^1.0.0"',
    '   }',
    ' }',
  ].join('\n');
  assert.deepEqual(findNewPackageJsonDependencies(diff), [
    { file: 'desktop/package.json', name: '@scope/new' },
    { file: 'desktop/package.json', name: 'vitest' },
  ]);
  // Section not visible in the hunk: unrelated manifest keys are still ignored.
  const bare = ['+++ b/package.json', '@@ -3,1 +3,2 @@', '+  "version": "1.2.3",', '+  "left": "^1.0.0"'].join('\n');
  assert.deepEqual(findNewPackageJsonDependencies(bare), [{ file: 'package.json', name: 'left' }]);
});

const NOW = Date.parse('2026-10-24T10:00:00.000Z');
const WATCHER = {
  policy: {
    maxParallel: 1, maxCyclesPerDay: 10, cooldownMs: 0, backoffBaseMs: 60_000, backoffCapMs: 3_600_000,
    maxSameFindings: 2, requirePlanApproval: true, allowedHarnesses: [], quietHours: { start: '', end: '' },
  },
  cycles: { day: '', count: 0 },
  lastCycleAt: '',
  backoffUntil: '',
  findings: { byTodo: {} },
};
const BIG = 'x'.repeat(1500);

function gate(leafOverrides = {}, parentOverrides = {}) {
  const parent = { id: 'parent', status: 'ready', body: '## Goal\nModule', updatedAt: '2026-01-01T00:00:00.000Z', ...parentOverrides };
  const leaf = { id: 'leaf', parentId: 'parent', status: 'ready', body: BIG, ...leafOverrides };
  return evaluateWorkspaceWatcherGuardrails({ watcher: WATCHER, pickedTodo: leaf, items: [parent, leaf], now: NOW });
}

test('guardrails: initiative leaf under a queued container gets a plan-only cycle', () => {
  const d = gate();
  assert.equal(d.allowed, true);
  assert.equal(d.kind, 'plan_gate');
  assert.equal(d.planOnly, true);
});

test('guardrails: Leaf scope, explicit approval or saved plan allow implementation', () => {
  const scoped = gate({ body: `${BIG}\n## Leaf scope\n- lib/a.js` });
  assert.equal(scoped.planOnly, false);
  assert.equal(scoped.kind, 'allowed');
  const approved = gate({}, { plan: { markdown: '# plan', approvedAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(approved.planOnly, false);
  assert.equal(approved.kind, 'allowed');
  const leafApproved = gate({ plan: { approvedAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(leafApproved.planOnly, false);
  // An unapproved draft keeps the ordinary plan gate (not the initiative override).
  const drafted = gate({ plan: { markdown: '# draft' } });
  assert.equal(drafted.planOnly, true);
  assert.equal(drafted.reason, 'plan_not_approved');
});
