import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClaudeCodeExecutable } from '../lib/claude/claude-sdk.ts';

test('the SDK binary is resolved once per process: process.report runs at most once', () => {
  const original = process.report.getReport;
  let calls = 0;
  process.report.getReport = (...args) => {
    calls += 1;
    return original.apply(process.report, args);
  };
  try {
    const first = resolveClaudeCodeExecutable();
    const second = resolveClaudeCodeExecutable();
    const third = resolveClaudeCodeExecutable();
    assert.equal(second, first);
    assert.equal(third, first);
    assert.ok(calls <= 1, `getReport ran ${calls} times`);
    if (first !== null) assert.match(first, /claude-agent-sdk-[a-z0-9-]+\/claude(\.exe)?$/);
  } finally {
    process.report.getReport = original;
  }
});
