import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isOpaqueExecPayload,
  isReviewVerifyInvocation,
  parseReviewVerifyNodeArgs,
  runReviewVerify,
  runReviewVerifyCli,
  REVIEW_VERIFY_CATALOG,
  REVIEW_VERIFY_SCRIPT,
} from '../lib/sdk/sdk-review-verify.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRel = 'tests/helpers/review-verify-write-fixture.js';
const projectDataMarker = path.join(projectRoot, 'data', 'review-verify-pwned.txt');
const projectCwdMarker = path.join(projectRoot, 'review-verify-cwd-pwned.txt');
const envMarker = path.join(projectRoot, 'data', 'review-verify-env-marker.txt');
fs.rmSync(projectDataMarker, { force: true });
fs.rmSync(projectCwdMarker, { force: true });
fs.rmSync(envMarker, { force: true });

assert.equal(isReviewVerifyInvocation('node scripts/review-verify.js'), true);
assert.equal(isReviewVerifyInvocation('node ./scripts/review-verify.js mcp-chat-history-format'), true);
assert.equal(isReviewVerifyInvocation('node tests/mcp-chat-history-format.test.js'), false);
assert.equal(isReviewVerifyInvocation('node --test-reporter=spec scripts/review-verify.js'), false);
assert.equal(isReviewVerifyInvocation('node scripts/review-verify.js unknown-id'), false);
assert.equal(parseReviewVerifyNodeArgs(['scripts/review-verify.js', '--test-reporter=spec']).ok, false);
assert.equal(isOpaqueExecPayload({ code: 'await exec("ls")' }), true);
assert.equal(isOpaqueExecPayload({ command: 'ls' }), false);

const isolated = await runReviewVerify({
  ids: ['write-fixture'],
  projectRoot,
  catalog: { 'write-fixture': fixtureRel },
});
assert.equal(isolated.ok, true, isolated.error);
assert.match(isolated.output, /review-verify-write-fixture/);
assert.equal(fs.existsSync(projectDataMarker), false);
assert.equal(fs.existsSync(projectCwdMarker), false);
assert.equal(fs.existsSync(path.join(isolated.dataDir, 'review-verify-pwned.txt')), true);
fs.rmSync(isolated.dataDir, { recursive: true, force: true });

const unknown = await runReviewVerifyCli(['not-a-catalog-id'], { projectRoot });
assert.equal(unknown.ok, false);

const incident = await runReviewVerify({
  ids: ['sdk-assistant-block-reuse'],
  projectRoot,
  catalog: REVIEW_VERIFY_CATALOG,
});
assert.equal(incident.ok, true, incident.error);
assert.match(incident.output, /sdk-assistant-block-reuse/);
fs.rmSync(incident.dataDir, { recursive: true, force: true });

assert.equal(REVIEW_VERIFY_SCRIPT, 'scripts/review-verify.js');
assert.equal(fs.existsSync(envMarker), false);

console.log('review-verify.test.js OK');
