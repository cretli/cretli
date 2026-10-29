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
    assert.ok(report.includes('2 no-op updates, 2 measured changed writes'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('full-document result refusal writes every gate as FAIL and exits nonzero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-benchmark-refusal-'));
  try {
    const out = path.join(dir, 'report.md');
    const child = spawnSync(process.execPath, ['scripts/benchmark-todos.js', '--smoke', '--smoke-bytes=4500000', `--out=${out}`], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(child.stdout).runtimeFailure.operation, 'result_too_large');
    const report = fs.readFileSync(out, 'utf8');
    assert.ok(report.includes('Cutover BLOCKED'));
    assert.ok(report.includes('cannot certify the <=1% gate'));
    assert.equal(report.split('\n').filter((line) => line.startsWith('| ') && line.endsWith('| FAIL |')).length, 16);
    assert.ok(report.includes('Post-cutover ACK preserved'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
