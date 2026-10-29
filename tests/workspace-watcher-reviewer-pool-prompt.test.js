/**
 * Workspace Watcher cycle prompt carries the opt-in reviewer pool instruction.
 *
 * The pool is resolved from delegation settings by the cycle caller and handed
 * to the pure prompt builder. Switch off = the contract is byte-identical; on =
 * the same REVIEWER POOL instruction the todos-routes prompts use
 * (`prefer_models` + `count=2`).
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addTodo, getTodoById } from '../lib/persist/todos-legacy-adapter.js';
import { getWorkspaceWatcher, upsertWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { saveDelegationSettings } from '../lib/persist/delegation-settings-persist.js';
import { resolveReviewerPool } from '../lib/delegation-settings.js';
import { buildReviewerPoolInstruction } from '../lib/todo-execution-prompt.js';
import { buildWorkspaceWatcherCyclePromptPlan } from '../lib/workspace-watcher-prompt.js';
import { startWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const members = [{ harness: 'claude', model: 'rev-a' }, { harness: 'codex', model: 'rev-b' }];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watcher-pool-prompt-'));

/** @param {string} name */
function freshDataDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {string} name */
function makeWorkspace(name) {
  const dir = path.join(tmpRoot, `ws-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * One minimal, deterministic cycle-prompt input (plan approval off, no gate).
 *
 * @param {object} [extra]
 * @returns {object}
 */
function basePromptInput(extra = {}) {
  return {
    workspaceFolder: '/tmp/my-app',
    watcher: { policy: { requirePlanApproval: false }, reviewWaits: {} },
    decision: { kind: 'start_cycle' },
    todo: { id: 'leaf', title: 'x' },
    orchestrator: { harness: 'mock', model: 'cheap', source: 'policy' },
    cycleId: 'c',
    ...extra,
  };
}

test('watcher prompt off: no reviewer pool instruction and a byte-identical contract', () => {
  const off = buildWorkspaceWatcherCyclePromptPlan(basePromptInput()).prompt;
  assert.equal(buildWorkspaceWatcherCyclePromptPlan(basePromptInput({ reviewerPool: [] })).prompt, off);
  assert.equal(
    buildWorkspaceWatcherCyclePromptPlan(basePromptInput({ reviewerPool: [{ harness: '', model: '' }] })).prompt,
    off,
  );
  assert.ok(!off.includes('REVIEWER POOL'));
});

test('watcher prompt on: the mandatory pool instruction never forces prompt_too_long', () => {
  // The enforced + independent review gate already consumes most of the budget;
  // the pool instruction is mandatory when enabled, so it must not refuse a base
  // contract that fits on its own.
  const gated = {
    ...basePromptInput(),
    watcher: {
      policy: { requirePlanApproval: false, requireReviewForDone: 'enforce', requireIndependentReview: true },
      reviewWaits: {},
    },
  };
  const gateOnly = buildWorkspaceWatcherCyclePromptPlan(gated);
  assert.equal(gateOnly.tooLong, false);
  const both = buildWorkspaceWatcherCyclePromptPlan({ ...gated, reviewerPool: members });
  assert.equal(both.tooLong, false);
  assert.match(both.prompt, /Review gate \(enforced\)/);
  assert.match(both.prompt, /REVIEWER POOL/);
});

test('watcher prompt on: carries the shared reviewer pool instruction', () => {
  const off = buildWorkspaceWatcherCyclePromptPlan(basePromptInput()).prompt;
  const on = buildWorkspaceWatcherCyclePromptPlan(basePromptInput({ reviewerPool: members })).prompt;
  assert.match(on, /REVIEWER POOL/);
  assert.match(on, /claude\/rev-a, codex\/rev-b/);
  assert.match(on, /prefer_models/);
  assert.match(on, /count=2/);
  assert.match(on, /exclude_models/);
  // The pool section is the only difference from the pool-off prompt.
  const instruction = buildReviewerPoolInstruction(members);
  assert.equal(on, off.replace('\n\nProgress:', `\n\n${instruction}\n\nProgress:`));
});

/**
 * Start one cycle against a fresh workspace and return the prompt handed to the
 * chat run, with the pool switch applied from delegation settings.
 *
 * @param {string} name
 * @param {boolean} poolEnabled
 * @returns {Promise<string>}
 */
async function startCyclePrompt(name, poolEnabled) {
  const dataDir = freshDataDir(name);
  const cwd = makeWorkspace(name);
  const leaf = addTodo(dataDir, cwd, { title: 'leaf', status: 'ready' }).item;
  upsertWorkspaceWatcher(cwd, {
    mode: 'autopilot',
    policy: { requirePlanApproval: false, cooldownMs: 0, maxCyclesPerDay: 5, maxParallel: 1 },
  }, { dataDir });
  saveDelegationSettings(cwd, { reviewer_pair_enabled: poolEnabled, reviewer_pair_members: members }, { dataDir });
  const runCalls = [];
  const deps = {
    addChat: (_session, title, _wf, _folder, _model, extras) => ({ id: extras.id, title }),
    startChatRun: async (input) => { runCalls.push(input); return { runId: 'run-pool', accepted: true }; },
    resolveWorkspaceWatcherOrchestrator: async () => ({ ok: true, harness: 'mock', model: 'cheap', source: 'policy' }),
    selectModelPick: () => ({ ok: true, pick: { harness: 'mock', model: 'cheap' } }),
    probeChatRunLiveness: () => ({ known: true, busy: true, reason: 'busy' }),
    loadDelegations: () => [],
    notify: () => false,
  };
  const started = await startWorkspaceWatcherCycle({
    workspaceFolder: cwd,
    dataDir,
    now: T0,
    token: `${name}-lease`,
    tick: {
      watcher: getWorkspaceWatcher(cwd, { dataDir }),
      decision: { kind: 'start_cycle', planOnly: false, nextTodoId: leaf.id },
      snapshot: { readyLeaves: [{ id: leaf.id, updatedAt: getTodoById(dataDir, cwd, leaf.id).updatedAt, title: leaf.title }] },
    },
    deps,
  });
  assert.equal(started.started, true, JSON.stringify(started));
  assert.equal(runCalls.length, 1);
  return runCalls[0].prompt;
}

test('watcher prompt on: a plan-only cycle never carries the review pool instruction', () => {
  const planOnly = buildWorkspaceWatcherCyclePromptPlan(basePromptInput({
    decision: { kind: 'plan_gate', planOnly: true },
    reviewerPool: members,
  })).prompt;
  assert.ok(!planOnly.includes('REVIEWER POOL'));
});

test('watcher cycle start resolves the saved pool into the orchestrator prompt', async () => {
  const onCwd = makeWorkspace('resolve-pool');
  saveDelegationSettings(onCwd, { reviewer_pair_enabled: true, reviewer_pair_members: members }, { dataDir: freshDataDir('resolve-pool-state') });
  const stateDir = path.join(tmpRoot, 'resolve-pool-state');
  assert.deepEqual(
    resolveReviewerPool(onCwd, { dataDir: stateDir }).members,
    members,
    'the saved pair resolves before the cycle starts',
  );

  const off = await startCyclePrompt('pool-off', false);
  assert.ok(!off.includes('REVIEWER POOL'), 'switch off adds no instruction');
  assert.ok(!off.includes('EFFECTIVE REVIEWER POLICY'), 'switch off adds no policy instruction');
  const on = await startCyclePrompt('pool-on', true);
  // The cycle caller resolves the same per-subject policy as the manual TODO
  // and full-mode paths, so a saved legacy pair arrives as the unified
  // fixed-pair instruction (with the shared pool safeguards).
  assert.match(on, /EFFECTIVE REVIEWER POLICY/);
  assert.match(on, /fixed pair claude\/rev-a, codex\/rev-b/);
  assert.match(on, /claude\/rev-a, codex\/rev-b/);
  assert.match(on, /prefer_models/);
  assert.match(on, /count=2/);
  assert.match(on, /never pick the implementer as a reviewer/);
});

// Pre-change prompt lengths (basePromptInput, no pool): the cycle prompt must not grow.
const PROMPT_CAP_WITH_PLAN_GATE = 5304;
const PROMPT_CAP_NO_PLAN_GATE = 5239;

test('watcher prompt: plan_gate pointer, no trial call, fix role, plan review only in the plan branch, no growth', () => {
  const gated = buildWorkspaceWatcherCyclePromptPlan(basePromptInput({
    watcher: { policy: { requirePlanApproval: true }, reviewWaits: {} },
  })).prompt;
  const open = buildWorkspaceWatcherCyclePromptPlan(basePromptInput()).prompt;
  for (const prompt of [gated, open]) {
    assert.doesNotMatch(prompt, /actually call/);
    assert.match(prompt, /Pick roles: [^\n]*\bfix\b/);
    assert.match(prompt, /tool list \(no trial call\)/);
  }
  assert.match(gated, /plan_gate/);
  assert.doesNotMatch(gated, /If approval is missing, stop/);
  assert.match(gated, /review_subject/);
  assert.match(gated, /`plan` for a plan review/);
  assert.doesNotMatch(open, /review_subject[`"':= ]*plan/);
  assert.doesNotMatch(open, /for a plan review/);
  assert.ok(gated.length <= PROMPT_CAP_WITH_PLAN_GATE, `gated prompt grew: ${gated.length}`);
  assert.ok(open.length <= PROMPT_CAP_NO_PLAN_GATE, `no-gate prompt grew: ${open.length}`);
});
