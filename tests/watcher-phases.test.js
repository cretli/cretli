import assert from 'node:assert/strict';
import {
  buildPhaseScopePromptLines,
  filterTodosByEnabledPhases,
  neededPhase,
  phaseForAssignment,
  resolveEffectivePhases,
  validatePhasesInput,
} from '../lib/watcher-phases.js';
import { normalizeWorkspaceWatcherPolicy } from '../lib/persist/workspace-watchers-persist.js';
import { pickNextWorkspaceReadyTodo, decideWorkspaceWatcherAction } from '../lib/workspace-watcher.js';
import { buildWorkspaceWatcherCyclePromptPlan } from '../lib/workspace-watcher-prompt.js';

// Defaults and normalization
assert.deepEqual(resolveEffectivePhases(null, []), { plan: true, review: true, implement: true, integrate: false });
const normalized = normalizeWorkspaceWatcherPolicy({});
assert.deepEqual(normalized.phases, { plan: true, review: true, implement: true, integrate: false });
assert.equal(normalizeWorkspaceWatcherPolicy({ phases: { review: false, bogus: 1 } }).phases.review, false);

// Validation
assert.match(validatePhasesInput({ nope: true }), /unknown phase/);
assert.match(validatePhasesInput({ plan: 'yes' }), /boolean/);
assert.equal(validatePhasesInput({ plan: false }), '');

// Per-todo override wins and is inherited
const root = { id: 'r', watcherPhases: { implement: false } };
const leaf = { id: 'l', parentId: 'r', watcherPhases: { implement: true } };
const child = { id: 'c', parentId: 'r' };
assert.equal(resolveEffectivePhases({ phases: { implement: true } }, [child, root]).implement, false);
// Override can only restrict: a todo `true` never widens the policy
assert.equal(resolveEffectivePhases({ phases: { implement: false } }, [leaf, root]).implement, false);
assert.equal(resolveEffectivePhases(null, [{ id: 'w', watcherPhases: { integrate: true } }]).integrate, false);
assert.equal(resolveEffectivePhases({ phases: { integrate: true } }, [{ id: 'w', watcherPhases: { integrate: true } }]).integrate, true);
// Override can narrow
assert.equal(resolveEffectivePhases({ phases: { review: true } }, [{ id: 'n', watcherPhases: { review: false } }]).review, false);
// A descendant's `true` cannot undo an ancestor's `false`
assert.equal(resolveEffectivePhases(null, [{ id: 'x', parentId: 'r', watcherPhases: { plan: true } }, { id: 'r', watcherPhases: { plan: false } }]).plan, false);

// Needed phase: approval wins; review state is irrelevant
const unapproved = { id: 'u', status: 'ready', plan: { markdown: 'p' } };
const approved = { id: 'a', status: 'ready', plan: { markdown: 'p', approvedAt: '2026-01-01' } };
assert.equal(neededPhase(unapproved, [unapproved]), 'plan');
assert.equal(neededPhase(approved, [approved]), 'implement');
const feedbackRoot = { id: 'feedback-root', body: '<!-- cretli-feedback-root:v1 -->', plan: { approvedAt: '2026-01-01' } };
const feedbackReport = { id: 'feedback-report', parentId: feedbackRoot.id, status: 'ready', body: '<!-- cretli-feedback {"hash":"same"} -->' };
const feedbackExtract = { id: 'feedback-extract', sourceTodoId: feedbackReport.id, status: 'ready', plan: { markdown: 'draft' } };
assert.equal(neededPhase(feedbackReport, [feedbackRoot, feedbackReport], { requirePlanApproval: false }), 'plan');
assert.equal(neededPhase(feedbackExtract, [feedbackRoot, feedbackReport, feedbackExtract], { requirePlanApproval: false }), 'plan');
const policyNoReview = { phases: { review: false } };
assert.equal(filterTodosByEnabledPhases([approved], { items: [approved], policy: policyNoReview }).kept.length, 1);
const noPlan = filterTodosByEnabledPhases([unapproved], { items: [unapproved], policy: { phases: { plan: false } } });
assert.equal(noPlan.skipped[0].phase, 'plan');

// Pick: implement:false skips the approved todo, picks the plan-needing one
const items = [{ ...approved, siblingIndex: 0 }, { ...unapproved, siblingIndex: 1 }];
const picked = pickNextWorkspaceReadyTodo({ items, policy: { phases: { implement: false } } });
assert.equal(picked.id, 'u');

// Decide: everything skipped -> idle_no_work + phase_disabled reason, not an error
const decision = decideWorkspaceWatcherAction({
  watcher: { mode: 'autopilot', enabled: true, policy: { phases: { implement: false } } },
  snapshot: { readyTodoCount: 1, readyLeaves: [approved], items: [approved] },
});
assert.equal(decision.kind, 'idle_no_work');
assert.equal(decision.reason, 'phase_disabled:implement');

// Guard mapping
assert.equal(phaseForAssignment('review', 'plan'), 'review');
assert.equal(phaseForAssignment('review', 'code'), 'implement');
assert.equal(phaseForAssignment('fix'), 'implement');

// Prompt: default phases add nothing; integrate is prepare-only
assert.deepEqual(buildPhaseScopePromptLines({}), []);
const lines = buildPhaseScopePromptLines({ integrate: true }).join('\n');
assert.match(lines, /PREPARE ONLY/);
assert.match(lines, /Never apply or merge/);
const plan = (phases) => buildWorkspaceWatcherCyclePromptPlan({
  workspaceFolder: '/w', watcher: { policy: {} }, decision: { kind: 'start_cycle' }, todo: { id: 't' }, phases,
});
const base = JSON.stringify(plan(undefined));
assert.equal(JSON.stringify(plan({ plan: true, review: true, implement: true, integrate: false })), base);
assert.notEqual(JSON.stringify(plan({ integrate: true })), base);

// Policy PATCH: unknown key / non-boolean rejected with VALIDATION (-> HTTP 400)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyWorkspaceWatcherPatch } from '../lib/workspace-watcher-control.js';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phases-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'phases-ws-'));
for (const phases of [{ bogus: true }, { plan: 'no' }]) {
  assert.throws(() => applyWorkspaceWatcherPatch({ dataDir, workspaceFolder: ws, patch: { policy: { phases } } }), (e) => e.code === 'VALIDATION');
}
const saved = applyWorkspaceWatcherPatch({ dataDir, workspaceFolder: ws, patch: { policy: { phases: { integrate: true } } } });
assert.deepEqual(saved.policy.phases, { plan: true, review: true, implement: true, integrate: true });
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });

console.log('watcher-phases: all passed');
