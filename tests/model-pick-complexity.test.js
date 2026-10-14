import './helpers/isolated-data-dir.js';
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
import { pickAndPersistModelForPurpose } from '../lib/model-pick-service.js';
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
