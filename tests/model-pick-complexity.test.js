import './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMPLEXITY_LEVELS,
  COMPLEXITY_SIGNALS,
  classifyTaskComplexity,
  normalizeComplexity,
  sanitizeComplexitySignals,
} from '../lib/model-pick-complexity.js';
import { persistModelPickProposal } from '../lib/model-pick-decisions.js';
import { normalizeCostPolicyConfig } from '../lib/model-pick-cost-policy.js';
import { pickAndPersistModelForPurpose, pickModelForPurpose } from '../lib/model-pick-service.js';
import { getModelPickRecord } from '../lib/persist/model-pick-decisions-persist.js';

const noExists = () => true;
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cx-')), 'picks.json');

test('empty input is standard with no_leaf_context', () => {
  const r = classifyTaskComplexity({ role: 'implement' });
  assert.equal(r.level, 'standard');
  assert.deepEqual(r.signals, ['no_leaf_context']);
});

test('small leaf with one file is trivial', () => {
  const r = classifyTaskComplexity({ role: 'implement', leafBody: 'Fix typo in lib/a.js', leafSize: 'small', exists: noExists });
  assert.equal(r.level, 'trivial');
  assert.deepEqual(r.signals, ['leaf_size_small', 'few_files']);
});

test('large leaf is at least standard', () => {
  const r = classifyTaskComplexity({ role: 'implement', leafBody: 'do things', leafSize: 'large' });
  assert.equal(r.level, 'standard');
  assert.ok(r.signals.includes('leaf_size_large'));
});

test('many files is demanding', () => {
  const body = ['a','b','c','d','e','f','g'].map((n) => `lib/${n}.js`).join(' ');
  const r = classifyTaskComplexity({ role: 'implement', leafBody: body, leafSize: 'large', exists: noExists });
  assert.equal(r.level, 'demanding');
  assert.ok(r.signals.includes('many_files'));
});

test('risk keywords raise trivial to standard', () => {
  const r = classifyTaskComplexity({ role: 'implement', leafBody: 'Touch auth in lib/a.js', leafSize: 'small', exists: noExists });
  assert.equal(r.level, 'standard');
  assert.ok(r.signals.includes('risk_keywords'));
});

test('review and plan roles are never trivial', () => {
  for (const role of ['review', 'plan']) {
    const r = classifyTaskComplexity({ role, leafBody: 'Fix typo in lib/a.js', leafSize: 'small', exists: noExists });
    assert.equal(r.level, 'standard');
    assert.ok(r.signals.includes('role_floor_standard'));
  }
});

test('sourceKind=plan applies the standard floor', () => {
  const r = classifyTaskComplexity({ role: 'implement', leafBody: 'x in lib/a.js', leafSize: 'small', sourceKind: 'plan', exists: noExists });
  assert.equal(r.level, 'standard');
});

test('two review FAILs in history make the task demanding', () => {
  const r = classifyTaskComplexity({ role: 'fix', leafBody: 'x', leafSize: 'small', history: { reviewFailCount: 2 } });
  assert.equal(r.level, 'demanding');
  assert.ok(r.signals.includes('review_fail_history'));
});

test('heavy flag forces demanding and explicit level overrides', () => {
  const heavy = classifyTaskComplexity({ role: 'implement', leafBody: 'x', leafSize: 'small', heavy: true });
  assert.equal(heavy.level, 'demanding');
  assert.ok(heavy.signals.includes('explicit_heavy'));
  const forced = classifyTaskComplexity({ role: 'implement', leafBody: 'x', leafSize: 'small', heavy: true, complexity: 'trivial' });
  assert.equal(forced.level, 'trivial');
  assert.ok(forced.signals.includes('explicit_level'));
});

test('signals are always from the closed list and unique', () => {
  const r = classifyTaskComplexity({ role: 'review', leafBody: 'security migration lib/a.js', leafSize: 'large', heavy: true, history: { reviewFailCount: 5 }, exists: noExists });
  assert.ok(COMPLEXITY_LEVELS.includes(r.level));
  assert.equal(new Set(r.signals).size, r.signals.length);
  for (const s of r.signals) assert.ok(COMPLEXITY_SIGNALS.includes(s));
  assert.deepEqual(sanitizeComplexitySignals(['bogus', 'many_files', 'many_files']), ['many_files']);
  assert.equal(normalizeComplexity({ level: 'huge', signals: [] }), null);
});

test('journal persists only level + closed-list signals, never leaf text', () => {
  const file = tempFile();
  const secret = 'TOP-SECRET-LEAF-TEXT lib/a.js';
  const complexity = classifyTaskComplexity({ role: 'implement', leafBody: secret, leafSize: 'small', exists: noExists });
  const persisted = persistModelPickProposal({
    role: 'implement',
    pickResult: { picks: [{ harness: 'a', model: 'm' }] },
    // Hostile extras must be dropped by the normalizer.
    complexity: { ...complexity, leafBody: secret, note: secret, signals: [...complexity.signals, secret] },
    file,
  });
  const stored = getModelPickRecord(persisted.pickId, { file });
  assert.deepEqual(Object.keys(stored.complexity).sort(), ['level', 'signals']);
  for (const s of stored.complexity.signals) assert.ok(COMPLEXITY_SIGNALS.includes(s));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('TOP-SECRET'));
});

test('every persisted pick carries level + signals, selection unchanged', () => {
  const file = tempFile();
  const base = {
    role: 'implement',
    harnesses: [{ id: 'codex', enabled: true, ready: true, can_delegate: true }],
    modelsByHarness: { codex: { favorites_configured: true, items: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }] } },
    now: Date.parse('2026-10-14T12:00:00Z'),
    shadow: false,
    explore: false,
    file,
  };
  const picked = pickAndPersistModelForPurpose({ ...base, leafBody: 'security lib/a.js', heavy: true });
  const baseline = pickAndPersistModelForPurpose({ ...base });
  assert.equal(picked.ok, true);
  assert.ok(picked.complexity?.level);
  assert.ok(Array.isArray(picked.complexity.signals));
  assert.equal(picked.ok, baseline.ok);
  assert.deepEqual(picked.pick, baseline.pick);
  const stored = getModelPickRecord(picked.pickId, { file });
  assert.equal(stored.complexity.level, 'demanding');
  assert.deepEqual(Object.keys(stored.complexity).sort(), ['level', 'signals']);
});

/**
 * A review delegation row whose report carries a FAIL verdict. Used to prove the
 * pick's internally-built history reaches the complexity classifier.
 *
 * @param {{ leafId?: string }} [overrides]
 * @returns {object}
 */
function reviewFailRow(overrides = {}) {
  const { leafId = 'leaf-1' } = overrides;
  return {
    id: `d-${Math.random().toString(16).slice(2)}`,
    controllerChatId: 'chat-1',
    executor: { transport: 'codex', model: 'gpt-5.6-sol' },
    assignment: 'review',
    executionMode: 'agent',
    status: 'completed',
    report: 'Findings...\nVERDICT: FAIL',
    createdAt: '2026-10-14T11:00:00Z',
    leafId,
  };
}

test('internally-built pick history drives the complexity classification', () => {
  const file = tempFile();
  const picked = pickAndPersistModelForPurpose({
    role: 'implement',
    leafId: 'leaf-1',
    leafBody: 'Fix typo in lib/a.js',
    leafSize: 'small',
    harnesses: [{ id: 'codex', enabled: true, ready: true, can_delegate: true }],
    modelsByHarness: { codex: { favorites_configured: true, items: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }] } },
    now: Date.parse('2026-10-14T12:00:00Z'),
    shadow: false,
    explore: false,
    // No `history` injected: the pick builds it from these rows internally and
    // must classify that exact object, not the undefined `input.history`.
    delegations: [reviewFailRow(), reviewFailRow()],
    file,
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.history.reviewFailCount, 2, 'the returned history counted both FAILs');
  assert.equal(picked.complexity.level, 'demanding');
  assert.ok(picked.complexity.signals.includes('review_fail_history'));
});

test('model_pick MCP error envelope carries complexity', async () => {
  const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');
  const client = {
    async listHarnessCatalog() { return []; },
    async listHarnessModels() { return []; },
  };
  const handlers = createCretliMcpToolHandlers(client, { chatId: 'cx-err', mode: 'agent' });
  const res = await handlers.model_pick({ role: 'implement', heavy: true });
  assert.equal(res.isError, true);
  const c = res.structuredContent.complexity;
  assert.ok(COMPLEXITY_LEVELS.includes(c.level));
  assert.ok(Array.isArray(c.signals));
  for (const s of c.signals) assert.ok(COMPLEXITY_SIGNALS.includes(s));
});

test('costPolicy:false still classifies the injected history and persists it', () => {
  const file = tempFile();
  const base = {
    role: 'implement',
    harnesses: [{ id: 'codex', enabled: true, ready: true, can_delegate: true }],
    modelsByHarness: { codex: { favorites_configured: true, items: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }] } },
    now: Date.parse('2026-10-14T12:00:00Z'),
    shadow: false,
    explore: false,
    // Two review FAILs force `demanding` through the review_fail_history signal.
    history: { reviewFailCount: 2 },
    file,
  };
  // The early return in `pickModelForPurpose` must classify the same history the
  // cost policy layer would have classified.
  const direct = pickModelForPurpose({ ...base, costPolicy: false });
  assert.equal(direct.complexity?.level, 'demanding');
  assert.ok(direct.complexity.signals.includes('review_fail_history'));
  const picked = pickAndPersistModelForPurpose({ ...base, costPolicy: false });
  assert.equal(picked.ok, true);
  assert.equal(picked.complexity?.level, 'demanding');
  assert.ok(picked.complexity.signals.includes('review_fail_history'));
  const stored = getModelPickRecord(picked.pickId, { file });
  assert.equal(stored.complexity.level, 'demanding');
  assert.ok(stored.complexity.signals.includes('review_fail_history'));
  assert.deepEqual(stored.complexity, picked.complexity);
  // Skipping the policy must only skip the verdict, never change the selection.
  const baseline = pickAndPersistModelForPurpose({ ...base });
  assert.equal(baseline.ok, true);
  assert.deepEqual(picked.pick, baseline.pick);
  assert.deepEqual(stored.complexity, getModelPickRecord(baseline.pickId, { file }).complexity);
});

test('enforce re-run keeps the injected history and persists demanding complexity', () => {
  const file = tempFile();
  // Same object reference the caller injected: the re-run must not rebuild it.
  const history = { reviewFailCount: 2 };
  const expensive = { harness: 'claude', model: 'opus-x', cost_tier: 4, quality_tier: 5 };
  const allowed = { harness: 'claude', model: 'sonnet-x', cost_tier: 3, quality_tier: 5 };
  const calls = [];
  const selectModelPick = (input) => {
    calls.push({
      history: input.history,
      excludePairs: (input.excludePairs || []).map((row) => ({ ...row })),
    });
    const excluded = new Set((input.excludePairs || []).map((row) => `${row.harness}/${row.model}`));
    const left = [expensive, allowed].filter((row) => !excluded.has(`${row.harness}/${row.model}`));
    if (left.length === 0) return { ok: false, code: 'MODEL_UNAVAILABLE', error: 'none' };
    return { ok: true, pick: left[0], picks: [left[0]], candidates: left };
  };
  // Implement/demanding ceiling lowered to 3 so the first pick (tier 4) is a
  // cost_ceiling violation even though the history classifies the leaf demanding.
  const costPolicyConfig = normalizeCostPolicyConfig({
    mode: 'enforce',
    canary: { enabled: false },
    ceilings: { implement: { demanding: 3 } },
  });
  const picked = pickAndPersistModelForPurpose({
    role: 'implement',
    history,
    selectModelPick,
    costPolicyConfig,
    costPolicyPersist: false,
    costPolicyState: {
      canaryStartedAt: '',
      rolledBackAt: '',
      rollbackReasons: [],
      counters: { canary: { n: 0, noCandidate: 0 }, control: { n: 0, noCandidate: 0 } },
    },
    shadow: false,
    explore: false,
    now: Date.parse('2026-10-14T12:00:00Z'),
    leafSize: 'small',
    leafExists: () => true,
    file,
  });
  assert.equal(picked.ok, true);
  assert.equal(picked.pick.model, 'sonnet-x');
  assert.equal(picked.cost_policy.mode, 'enforce');
  // First call returns the violating pair + an allowed candidate; the enforced
  // re-run is the second call and must receive the identical history object.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].history, history);
  assert.deepEqual(calls[1].excludePairs, [{ harness: 'claude', model: 'opus-x' }]);
  assert.ok(picked.cost_policy.rejected.some((row) => row.reasons.includes('cost_ceiling')));
  assert.equal(picked.complexity.level, 'demanding');
  assert.ok(picked.complexity.signals.includes('review_fail_history'));
  const stored = getModelPickRecord(picked.pickId, { file });
  assert.equal(stored.complexity.level, 'demanding');
  assert.ok(stored.complexity.signals.includes('review_fail_history'));
});

test('invalid complexity override is reported by code, raw value not echoed', () => {
  const r = classifyTaskComplexity({ role: 'implement', leafBody: 'x', leafSize: 'small', complexity: 'HUGE-SECRET' });
  assert.ok(r.signals.includes('explicit_level_invalid'));
  assert.ok(!r.signals.includes('explicit_level'));
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  const ok = classifyTaskComplexity({ role: 'implement', leafBody: 'x', leafSize: 'small', complexity: 'standard' });
  assert.ok(!ok.signals.includes('explicit_level_invalid'));
});

test('review_fail_history from wired history is persisted via pickAndPersistModelForPurpose', async () => {
  const { buildModelPickHistory } = await import('../lib/model-pick-history.js');
  const file = tempFile();
  const now = Date.parse('2026-10-14T12:00:00Z');
  const rows = [1, 2].map((n) => ({
    id: `d-${n}`, controllerChatId: 'chat-1', leafId: 'leaf-1', assignment: 'review',
    executionMode: 'agent', status: 'completed', report: 'x\nVERDICT: FAIL',
    executor: { transport: 'testfakeb', model: 'testfakeb-flash' }, createdAt: '2026-10-14T11:00:00Z',
  }));
  const history = buildModelPickHistory({
    role: 'implement', chatId: 'chat-1', leafId: 'leaf-1', delegations: rows, lockouts: [], planLimits: [], now,
  });
  const picked = pickAndPersistModelForPurpose({
    role: 'implement', leafBody: 'x', leafSize: 'small', history, leafId: 'leaf-1', chatId: 'chat-1',
    harnesses: [{ id: 'codex', enabled: true, ready: true, can_delegate: true }],
    modelsByHarness: { codex: { favorites_configured: true, items: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6.1-sol' }] } },
    now, shadow: false, explore: false, file,
  });
  assert.equal(picked.complexity.level, 'demanding');
  assert.ok(picked.complexity.signals.includes('review_fail_history'));
  const stored = getModelPickRecord(picked.pickId, { file });
  assert.equal(stored.complexity.level, 'demanding');
  assert.ok(stored.complexity.signals.includes('review_fail_history'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('VERDICT'));
});

test('model_pick leaf_size signals fire for review/plan roles', async () => {
  const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');
  const { addTodo } = await import('../lib/persist/todos-legacy-adapter.js');
  const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
  const dataDir = process.env.CRETLI_DATA_DIR;
  setBuiltinMcpRuntimeDeps({ dataDir, workspaceDirForAgent: () => '', taskRuns: new Map() });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-ws-'));
  fs.mkdirSync(path.join(ws, 'lib'));
  fs.writeFileSync(path.join(ws, 'lib', 'a.js'), '');
  const cases = [['No file list here', 'large'], ['Fix lib/a.js', 'small']];
  for (const [body, size] of cases) {
    const todo = addTodo(dataDir, ws, { title: `t-${size}`, body, idempotencyKey: `cx-${size}` });
    const todoId = todo.item?.id || todo.id;
    for (const role of ['review', 'plan']) {
      const client = {
        async listHarnessCatalog() { return []; },
        async listHarnessModels() { return []; },
        async getTodo() { return { body }; },
      };
      const handlers = createCretliMcpToolHandlers(client, { chatId: 'cx-leaf', workspaceFolder: ws, mode: 'agent', builtinClient: client });
      const res = await handlers.model_pick({ role, todo_id: todoId });
      const sc = res.structuredContent;
      assert.equal(sc.leaf_size, size, `${role} ${size}`);
      assert.ok(sc.complexity.signals.includes(`leaf_size_${size}`), `${role} ${size} signal`);
    }
  }
});

test('model_pick fix role computes no leaf size, so its selection inputs stay unchanged', async () => {
  const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');
  const { addTodo } = await import('../lib/persist/todos-legacy-adapter.js');
  const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
  const dataDir = process.env.CRETLI_DATA_DIR;
  setBuiltinMcpRuntimeDeps({ dataDir, workspaceDirForAgent: () => '', taskRuns: new Map() });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-fix-ws-'));
  fs.mkdirSync(path.join(ws, 'lib'));
  fs.writeFileSync(path.join(ws, 'lib', 'a.js'), '');
  // F6: a plain body (no existing file path, so `classifyLeafSize` would say
  // `large`) and a one-file body (which would say `small`) must classify the
  // same for `fix`, because `fix` computes no leaf size at all. Before the fix
  // the first raised the level to `standard`, changing enforced cost-policy
  // eligibility.
  const bodies = ['Update behavior', 'Fix lib/a.js'];
  for (let index = 0; index < bodies.length; index += 1) {
    const body = bodies[index];
    const todo = addTodo(dataDir, ws, { title: `t-fix-${index}`, body, idempotencyKey: `cx-fix-${index}` });
    const todoId = todo.item?.id || todo.id;
    const client = {
      async listHarnessCatalog() { return []; },
      async listHarnessModels() { return []; },
      async getTodo() { return { body }; },
    };
    const handlers = createCretliMcpToolHandlers(client, { chatId: 'cx-fix', workspaceFolder: ws, mode: 'agent', builtinClient: client });
    const res = await handlers.model_pick({ role: 'fix', todo_id: todoId });
    const sc = res.structuredContent;
    assert.equal(sc.leaf_size, null, `${body}: no leaf_size`);
    assert.ok(!sc.complexity.signals.includes('leaf_size_large'), `${body}: no leaf_size_large`);
    assert.ok(!sc.complexity.signals.includes('leaf_size_small'), `${body}: no leaf_size_small`);
    assert.equal(sc.complexity.level, 'trivial', `${body}: leaf size must not raise the fix level`);
    if (sc.pick) assert.ok(!String(sc.pick.reason || '').includes('leaf='), `${body}: no leaf= suffix`);
  }
});

test('model_pick review/plan responses carry no leaf= reason suffix or flash exclusion', async () => {
  const { createCretliMcpToolHandlers } = await import('../lib/mcp/mcp-builtin-tools.js');
  const { addTodo } = await import('../lib/persist/todos-legacy-adapter.js');
  const { setBuiltinMcpRuntimeDeps } = await import('../lib/mcp/builtin/runtime-deps.js');
  const dataDir = process.env.CRETLI_DATA_DIR;
  setBuiltinMcpRuntimeDeps({ dataDir, workspaceDirForAgent: () => '', taskRuns: new Map() });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-rp-ws-'));
  const body = 'No file list here';
  const todo = addTodo(dataDir, ws, { title: 't-rp', body, idempotencyKey: 'cx-rp' });
  const todoId = todo.item?.id || todo.id;
  for (const role of ['review', 'plan']) {
    const client = {
      async listHarnessCatalog() { return [{ id: 'codex', enabled: true, ready: true, can_delegate: true }]; },
      async listHarnessModels() { return { favorites_configured: true, items: [{ id: 'gpt-5.6-sol', roles: [role] }] }; },
      async getTodo() { return { body }; },
    };
    const handlers = createCretliMcpToolHandlers(client, { chatId: 'cx-rp', workspaceFolder: ws, mode: 'agent', builtinClient: client });
    const res = await handlers.model_pick({ role, todo_id: todoId });
    assert.notEqual(res.isError, true, `${role}: ${res.content?.[0]?.text}`);
    const sc = res.structuredContent;
    assert.equal(sc.leaf_size, 'large', `${role}: leaf size present`);
    const reason = String(sc.pick?.reason || '');
    assert.ok(!reason.includes('leaf='), `${role}: no leaf= suffix (${reason})`);
    assert.ok(!reason.includes('flash_excluded'), `${role}: no flash exclusion (${reason})`);
  }
});
