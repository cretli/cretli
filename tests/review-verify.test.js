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
assert.equal(isReviewVerifyInvocation('node scripts/review-verify.js timeout-progress-series notices'), true);
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

// Task 6: the model_pick incident suites are audited catalog ids now.
assert.equal(REVIEW_VERIFY_CATALOG['model-pick-rotation'], 'tests/model-pick-rotation.test.js');
assert.equal(REVIEW_VERIFY_CATALOG['model-pick-observed'], 'tests/model-pick-observed.test.js');
assert.equal(REVIEW_VERIFY_CATALOG['workspace-watcher-pinned-chat'], 'tests/workspace-watcher-pinned-chat.test.js');
assert.equal(REVIEW_VERIFY_CATALOG['watcher-pinned-chat-ui'], 'tests/watcher-pinned-chat-ui.test.js');
const modelPickIncident = await runReviewVerify({
  ids: ['model-pick-rotation', 'model-pick-observed'],
  projectRoot,
  catalog: REVIEW_VERIFY_CATALOG,
});
assert.equal(modelPickIncident.ok, true, modelPickIncident.error);
assert.match(modelPickIncident.output, /model-pick-rotation/);
assert.match(modelPickIncident.output, /model-pick-observed/);
fs.rmSync(modelPickIncident.dataDir, { recursive: true, force: true });

// Workspace Memory is an audited catalog id, so a review child can verify the
// suite without writing onto the live project data dir.
assert.equal(REVIEW_VERIFY_CATALOG['workspace-memory'], 'tests/workspace-memory.test.js');
assert.equal(REVIEW_VERIFY_CATALOG['workspace-watcher-scout'], 'tests/workspace-watcher-scout.test.js');
const workspaceMemoryRun = await runReviewVerify({
  ids: ['workspace-memory'],
  projectRoot,
  catalog: REVIEW_VERIFY_CATALOG,
});
assert.equal(workspaceMemoryRun.ok, true, workspaceMemoryRun.error);
assert.match(workspaceMemoryRun.output, /workspace-memory/);
assert.equal(fs.existsSync(path.join(workspaceMemoryRun.dataDir, 'review-verify-pwned.txt')), false);
fs.rmSync(workspaceMemoryRun.dataDir, { recursive: true, force: true });

const workspaceScoutRun = await runReviewVerify({
  ids: ['workspace-watcher-scout'],
  projectRoot,
  catalog: REVIEW_VERIFY_CATALOG,
});
assert.equal(workspaceScoutRun.ok, true, workspaceScoutRun.error);
assert.match(workspaceScoutRun.output, /workspace scout tests passed/);
fs.rmSync(workspaceScoutRun.dataDir, { recursive: true, force: true });

// The monitoring dashboard suites are audited catalog ids, so a review child can
// verify the aggregation and render contract without touching live data.
assert.equal(REVIEW_VERIFY_CATALOG['workspace-watcher-stats'], 'tests/workspace-watcher-stats.test.js');
assert.equal(REVIEW_VERIFY_CATALOG['workspace-watcher-dashboard-ui'], 'tests/workspace-watcher-dashboard-ui.test.js');
const watcherStatsRun = await runReviewVerify({
  ids: ['workspace-watcher-stats', 'workspace-watcher-dashboard-ui'],
  projectRoot,
  catalog: REVIEW_VERIFY_CATALOG,
});
assert.equal(watcherStatsRun.ok, true, watcherStatsRun.error);
assert.match(watcherStatsRun.output, /workspace-watcher-stats/);
assert.match(watcherStatsRun.output, /workspace-watcher-dashboard-ui/);
assert.equal(fs.existsSync(path.join(watcherStatsRun.dataDir, 'review-verify-pwned.txt')), false);
fs.rmSync(watcherStatsRun.dataDir, { recursive: true, force: true });

console.log('review-verify.test.js OK');
