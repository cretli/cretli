import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('benchmark CLI smoke executes both backends and post-ACK logical rollback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-benchmark-test-'));
  try {
    const out = path.join(dir, 'report.md');
    const child = spawnSync(process.execPath, ['scripts/benchmark-todos.js', '--smoke', `--out=${out}`], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.rehearsal, 'PASS');
    assert.equal(result.fixtureHashesEqual, true);
    const report = fs.readFileSync(out, 'utf8');
    for (const term of ['SMOKE ONLY', 'stringifyMs SQLite / JSON', 'Cutover blockers', 'Post-cutover ACK preserved', 'worker write_bytes', 'priority ACK', 'Transaction batch payload', 'FAIL']) assert.ok(report.includes(term), term);
    assert.ok(report.includes('2 no-op updates (duplicate chat link: resolved by the domain layer without a write), 2 measured changed writes'));
    assert.ok(report.includes('Full document main-thread serializations (overlay materialize + overlay read)'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a 22 MB class fixture now executes on the SQLite facade (no result_too_large) and every gate carries a value and a verdict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-benchmark-large-'));
  try {
    const out = path.join(dir, 'report.md');
    // 4.5 MB total (over the 4 MiB worker result cap) keeps the test short; the per-row size matches the ADR fixture shape.
    const child = spawnSync(process.execPath, ['scripts/benchmark-todos.js', '--smoke', '--smoke-bytes=4500000', `--out=${out}`], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.runtimeFailure, null);
    assert.equal(result.fixtureHashesEqual, true);
    const report = fs.readFileSync(out, 'utf8');
    assert.ok(!report.includes('Cutover BLOCKED'));
    assert.ok(!report.includes('io/result_too_large'));
    const rows = report.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Gate') && !line.startsWith('| ---'));
    assert.ok(rows.length >= 20, 'all gates reported');
    for (const row of rows) assert.match(row, /\| (PASS|FAIL) \|$/, row);
    assert.ok(rows.every((row) => !row.includes('unavailable')), 'no gate is unavailable any more');
    assert.ok(report.includes('| No-op physical write bytes (measured 1000-no-op window only; includes overlay) | 0 | 0 | PASS |'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
