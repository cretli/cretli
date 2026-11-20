import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveReviewLintFiles } from '../lib/sdk/sdk-review-lint.ts';
import { resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-lint-test-'));
const projectRoot = path.join(directory, 'workspace');
fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'lib', 'source.js'), 'export const value = 1;');
fs.writeFileSync(path.join(projectRoot, 'lib', 'typed.ts'), 'export const value: number = 3;');
fs.writeFileSync(path.join(directory, 'outside.js'), 'export const value = 2;');
fs.symlinkSync(path.join(directory, 'outside.js'), path.join(projectRoot, 'lib', 'escape.js'));
// Plugin harness layout: harnesses/<id>/{src,tests}.
fs.mkdirSync(path.join(projectRoot, 'harnesses', 'mistral', 'tests'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'harnesses', 'mistral', 'src'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'harnesses', 'mistral', 'tests', 'plugin.test.js'), 'export const t = 1;');
fs.writeFileSync(path.join(projectRoot, 'harnesses', 'mistral', 'src', 'foo.js'), 'export const f = 1;');
fs.writeFileSync(path.join(projectRoot, 'other.test.js'), 'export const o = 1;');
try {
  assert.deepEqual(resolveReviewLintFiles(['lib/source.js'], projectRoot), [path.join(projectRoot, 'lib', 'source.js')]);
  assert.deepEqual(resolveReviewLintFiles(['lib/typed.ts'], projectRoot), [path.join(projectRoot, 'lib', 'typed.ts')]);
  assert.deepEqual(resolveReviewLintFiles(['harnesses/mistral/src/foo.js'], projectRoot), [path.join(projectRoot, 'harnesses', 'mistral', 'src', 'foo.js')]);
  // Harness tests are runnable by review children: relative and absolute, but only under harnesses/<id>/tests/.
  const harnessTest = 'harnesses/mistral/tests/plugin.test.js';
  const decide = (command) => resolvePlanModeToolDecision({
    transport: 'codebuddy', mode: 'agent', assignment: 'review', projectRoot,
    toolName: 'Bash', input: { command },
  }).deny;
  for (const command of [
    `node --test ${harnessTest}`,
    `node ${harnessTest}`,
    `node --test ${path.join(projectRoot, harnessTest)}`,
  ]) assert.equal(decide(command), false, command);
  for (const command of [
    'node --test harnesses/mistral/src/foo.js',
    'node --test harnesses/mistral/tests/missing.test.js',
    'node --test harnesses/../other.test.js',
    'node --test harnesses/mistral/tests/../../../other.test.js',
    'node --test other.test.js',
    'node --test harnesses/tests/plugin.test.js',
    `node --test ${harnessTest} --test-reporter=./evil.js`,
  ]) assert.equal(decide(command), true, command);
  assert.equal(resolveReviewLintFiles(['harnesses/../outside.js'], projectRoot), null);
  assert.equal(resolveReviewLintFiles(['harnesses/../etc/passwd.js'], projectRoot), null);
  assert.equal(resolveReviewLintFiles(['/harnesses/mistral/src/foo.js'], projectRoot), null);
  assert.equal(resolveReviewLintFiles(['other.test.js'], projectRoot), null);
  for (const files of [[], ['--fix'], ['../outside.js'], ['lib/escape.js'], ['lib/missing.js'], ['lib'], ['lib/source.js', '--cache']]) {
    assert.equal(resolveReviewLintFiles(files, projectRoot), null, JSON.stringify(files));
  }
  assert.equal(resolveReviewLintFiles(['lib/source.js'], path.join(directory, 'missing')), null);
  for (const [command, expectedDeny] of [
    ['node scripts/review-lint.js lib/source.js', false],
    ['node scripts/review-lint.js lib/source.js 2>&1 | tail -20', false],
    ['node scripts/review-lint.js lib/source.js 2>/dev/null | head -5', false],
    ['node scripts/review-lint.js lib/source.js >/dev/null', false],
    ['node scripts/review-lint.js lib/source.js >out.txt', true],
    ['node scripts/review-lint.js lib/source.js 2>&1 >report.txt', true],
    ['node scripts/review-lint.js lib/source.js --fix', true],
    ['node scripts/review-lint.js lib/escape.js', true],
    ['node scripts/review-lint.js lib/source.js > report.txt', true],
    ['npx eslint --fix lib/source.js', true],
  ]) {
    assert.equal(resolvePlanModeToolDecision({
      transport: 'codebuddy', mode: 'agent', assignment: 'review', projectRoot,
      toolName: 'Bash', input: { command },
    }).deny, expectedDeny, command);
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('sdk-review-lint.test.js OK');
