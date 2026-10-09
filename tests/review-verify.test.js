import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isOpaqueExecPayload,
  isReviewVerifyInvocation,
  parseReviewVerifyNodeArgs,
  resolveReviewVerifyIdsForPath,
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

// Canonical model stats and their read-only diagnostics UI contract are audited
// ids, so a review child can verify the denominators without touching live data.
assert.equal(REVIEW_VERIFY_CATALOG['model-stats'], 'tests/model-stats.test.js');
assert.equal(REVIEW_VERIFY_CATALOG['harness-diagnostics-ui'], 'tests/harness-diagnostics-ui.test.js');
const canonicalStatsRun = await runReviewVerify({
  ids: ['model-stats', 'harness-diagnostics-ui'],
  projectRoot,
  catalog: REVIEW_VERIFY_CATALOG,
});
assert.equal(canonicalStatsRun.ok, true, canonicalStatsRun.error);
assert.match(canonicalStatsRun.output, /model-stats/);
assert.match(canonicalStatsRun.output, /harness-diagnostics-ui/);
assert.equal(fs.existsSync(path.join(canonicalStatsRun.dataDir, 'review-verify-pwned.txt')), false);
fs.rmSync(canonicalStatsRun.dataDir, { recursive: true, force: true });

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

const pathIds = resolveReviewVerifyIdsForPath('app_front/features/chat/chatMetadataIdb.js');
assert.equal(pathIds.length, 3);
assert.ok(pathIds.includes('chat-metadata-idb'));
assert.ok(pathIds.includes('chat-metadata-cross-tab'));
assert.ok(pathIds.includes('chat-session-boundary'));

const legacyMigrationIds = resolveReviewVerifyIdsForPath(
  'app_front/features/chat/chatLocalBootLegacyMigration.js'
);
assert.ok(legacyMigrationIds.includes('chat-local-boot-sync'));

const archiveFocusIds = resolveReviewVerifyIdsForPath(
  'app_front/features/sidebar/sidebarArchiveVirtualFocus.js'
);
assert.ok(archiveFocusIds.includes('sidebar-archive-virtual-a11y'));
assert.ok(archiveFocusIds.includes('sidebar-archive-virtualizer'));

// Integration 8.2 — metadata IDB, offline boot, poll races, archive sidebar.
const integration82Ids = [
  'chat-list-load-scope-guard',
  'chat-local-boot-sync',
  'chat-metadata-cross-tab',
  'chat-metadata-idb',
  'chat-pending-remote-history',
  'chat-session-boundary',
  'monitoring-archive-qualification',
  'sidebar-archive-virtualizer',
  'sidebar-lit-migration-contract',
];
for (const id of integration82Ids) {
  assert.equal(REVIEW_VERIFY_CATALOG[id], `tests/${id}.test.js`);
}
const integration82Run = await runReviewVerify({
  ids: integration82Ids,
  projectRoot,
  catalog: REVIEW_VERIFY_CATALOG,
});
assert.equal(integration82Run.ok, true, integration82Run.error);
for (const id of integration82Ids) {
  assert.match(integration82Run.output, new RegExp(id));
}
assert.equal(fs.existsSync(path.join(integration82Run.dataDir, 'review-verify-pwned.txt')), false);
fs.rmSync(integration82Run.dataDir, { recursive: true, force: true });

const integration82FixIds = [
  'sidebar-archive-virtual-a11y',
  'sidebar-swipe',
  'chat-resume-policy',
  'chat-list-resume-sync',
  'sidebar-chat-drag-block',
];
for (const id of integration82FixIds) {
  assert.equal(REVIEW_VERIFY_CATALOG[id], `tests/${id}.test.js`);
}
const integration82FixRun = await runReviewVerify({
  ids: integration82FixIds,
  projectRoot,
  catalog: REVIEW_VERIFY_CATALOG,
});
assert.equal(integration82FixRun.ok, true, integration82FixRun.error);
for (const id of integration82FixIds) {
  assert.match(integration82FixRun.output, new RegExp(id));
}
fs.rmSync(integration82FixRun.dataDir, { recursive: true, force: true });

console.log('review-verify.test.js OK');
