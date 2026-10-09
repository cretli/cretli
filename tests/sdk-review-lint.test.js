import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveReviewLintFiles } from '../lib/sdk/sdk-review-lint.js';
import { resolvePlanModeToolDecision } from '../lib/sdk/sdk-plan-guard.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-lint-test-'));
const projectRoot = path.join(directory, 'workspace');
fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
fs.writeFileSync(path.join(projectRoot, 'lib', 'source.js'), 'export const value = 1;');
fs.writeFileSync(path.join(directory, 'outside.js'), 'export const value = 2;');
fs.symlinkSync(path.join(directory, 'outside.js'), path.join(projectRoot, 'lib', 'escape.js'));
try {
  assert.deepEqual(resolveReviewLintFiles(['lib/source.js'], projectRoot), [path.join(projectRoot, 'lib', 'source.js')]);
  for (const files of [[], ['--fix'], ['../outside.js'], ['lib/escape.js'], ['lib/missing.js'], ['lib'], ['lib/source.js', '--cache']]) {
    assert.equal(resolveReviewLintFiles(files, projectRoot), null, JSON.stringify(files));
  }
  assert.equal(resolveReviewLintFiles(['lib/source.js'], path.join(directory, 'missing')), null);
  for (const [command, expectedDeny] of [
    ['node scripts/review-lint.js lib/source.js', false],
    ['node scripts/review-lint.js lib/source.js 2>&1 | tail -20', false],
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
