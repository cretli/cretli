import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateDataset, evaluateBudgets, parseBudgetOverrides, percentile, DEFAULT_BUDGETS } from '../scripts/perf-bench.mjs';

test('generateDataset writes the requested sizes only inside the given directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-test-'));
  try {
    const workspace = path.join(dir, 'ws');
    const result = generateDataset({ dir, workspace, chats: 30, delegations: 20, todos: 10 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')).chats.length, 30);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'delegations.json'), 'utf8')).items.length, 20);
    const todoFile = path.join(dir, 'todos', `${createHash('sha256').update(workspace).digest('hex')}.json`);
    assert.equal(JSON.parse(fs.readFileSync(todoFile, 'utf8')).items.length, 10);
    assert.ok(result.files.every((f) => f.startsWith(dir)));
    // Deterministic: same seed, same content.
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-bench-test-'));
    generateDataset({ dir: again, workspace, chats: 30, delegations: 20, todos: 10 });
    assert.equal(fs.readFileSync(path.join(again, 'chats.json'), 'utf8').replaceAll(again, dir), fs.readFileSync(path.join(dir, 'chats.json'), 'utf8'));
    fs.rmSync(again, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('budgets: PASS within, FAIL over, FAIL when unmeasured', () => {
  const ok = Object.fromEntries(Object.entries(DEFAULT_BUDGETS).map(([k, v]) => [k, v / 2]));
  assert.ok(evaluateBudgets(ok).every((r) => r.pass));
  const over = evaluateBudgets({ ...ok, boot_ms: DEFAULT_BUDGETS.boot_ms + 1 });
  assert.equal(over.find((r) => r.name === 'boot_ms').pass, false);
  const missing = { ...ok };
  delete missing.idle_elu;
  assert.equal(evaluateBudgets(missing).find((r) => r.name === 'idle_elu').pass, false);
});

test('budget overrides and percentile', () => {
  assert.equal(parseBudgetOverrides('boot_ms=5').boot_ms, 5);
  assert.throws(() => parseBudgetOverrides('nope=1'), /Unknown budget/);
  assert.equal(percentile([1, 2, 3, 4, 100], 99), 100);
  assert.equal(percentile([], 50), 0);
});
