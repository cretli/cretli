/**
 * Server-code freshness detector: the acceptance rules of the
 * "backend changed since start — restart may be required" marker, on an injected
 * filesystem and clock. Nothing here touches the real repo or waits for a timer.
 *
 * The suite is organised by the criterion each block proves, because the whole
 * point of the detector is that its answer comes from content and inventory, not
 * from the filesystem clock.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  dismissNotifications,
  readNotificationStoreSync,
} from '../lib/notifications/notification-store.ts';
import {
  CODE_FRESHNESS_EPISODE_PREFIX,
  describeCodeFreshness,
  diffCodeManifest,
  formatCodeFreshnessMessage,
  hashFileContent,
  isServerCodePath,
  scanServerCodeManifest,
} from '../lib/server-code-freshness.js';
import {
  __resetServerCodeFreshnessForTest,
  getServerCodeFreshnessDetail,
  isServerCodeStale,
  runServerCodeFreshnessPass,
} from '../lib/server-code-freshness-worker.js';

const ROOT = '/project';

/**
 * In-memory filesystem: `files` maps a relative posix path to its content,
 * `failures` lists paths whose read or listing must throw. mtime is modelled
 * explicitly so the tests can prove the detector ignores the clock.
 *
 * @param {{ files?: Record<string, string>, mtimes?: Record<string, number>, failures?: string[] }} [input]
 */
function createFakeFs(input = {}) {
  const files = new Map(Object.entries(input.files || {}));
  const mtimes = new Map(Object.entries(input.mtimes || {}));
  const failures = new Set(input.failures || []);
  /** @param {string} rel */
  const touch = (rel) => {
    mtimes.set(rel, (mtimes.get(rel) || 1_700_000_000_000) + 1000);
  };
  const adapter = {
    async readDirectory(dirPath) {
      const prefix = String(dirPath).replace(/\/$/, '').replace(ROOT, '').replace(/^\//, '');
      if (failures.has(prefix || '.')) throw new Error(`EACCES: ${dirPath}`);
      const seen = new Map();
      for (const rel of files.keys()) {
        if (prefix) {
          if (!rel.startsWith(`${prefix}/`)) continue;
          const rest = rel.slice(prefix.length + 1);
          const slash = rest.indexOf('/');
          if (slash < 0) seen.set(rest, false);
          else seen.set(rest.slice(0, slash), true);
          continue;
        }
        const slash = rel.indexOf('/');
        if (slash < 0) seen.set(rel, false);
        else seen.set(rel.slice(0, slash), true);
      }
      return [...seen.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    async readFile(filePath) {
      const rel = String(filePath).replace(ROOT, '').replace(/^\//, '');
      if (failures.has(rel)) throw new Error(`EIO: ${filePath}`);
      if (!files.has(rel)) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
      return files.get(rel);
    },
  };
  const dump = () => Object.fromEntries([...files.keys()].map((rel) => [rel, {
    content: files.get(rel),
    mtime: mtimes.get(rel) || 1_700_000_000_000,
  }]));
  return {
    fsAdapter: adapter,
    dump,
    write: (rel, content) => files.set(rel, content),
    touch,
    remove: (rel) => files.delete(rel),
    fail: (rel) => failures.add(rel),
  };
}

/**
 * @param {Record<string, string>} files
 * @returns {ReturnType<typeof createFakeFs>}
 */
function fsWith(files) {
  return createFakeFs({ files });
}

function resetWorker() {
  __resetServerCodeFreshnessForTest();
}

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const clock = () => NOW;

// ---------------------------------------------------------------------------
// Path scope: what belongs to the backend manifest.

assert.equal(isServerCodePath('server.js'), true);
assert.equal(isServerCodePath('lib/routes/health-routes.js'), true);
assert.equal(isServerCodePath('lib/mcp/mcp-runtime.js'), true);
assert.equal(isServerCodePath('lib/workspace-watcher.js'), true);
// A change only in the front, in runtime data, in built assets or in
// dependencies must never raise the flag (acceptance criterion 6).
assert.equal(isServerCodePath('app_front/features/chat/chat.js'), false);
assert.equal(isServerCodePath('data/chats.json'), false);
assert.equal(isServerCodePath('public/dist/app/app.bundle.js'), false);
assert.equal(isServerCodePath('node_modules/foo/index.js'), false);
assert.equal(isServerCodePath('lib/mcp/mcp-runtime.mjs'), false);
assert.equal(isServerCodePath('docs/ARCHITECTURE.md'), false);
assert.equal(isServerCodePath(''), false);
// Windows separators are normalised, so a walk on any host yields the same keys.
assert.equal(isServerCodePath('lib\\routes\\health-routes.js'), true);
assert.equal(isServerCodePath('app_front\\i18n\\pl.js'), false);

// ---------------------------------------------------------------------------
// Inventory walk excludes non-backend files.

{
  const { fsAdapter, dump } = fsWith({
    'server.js': 'boot',
    'lib/a.js': 'a',
    'lib/nested/b.js': 'b',
    'lib/notes.md': 'not code',
    'app_front/i18n/pl.js': 'pl',
    'data/state.json': 'state',
    'node_modules/dep/index.js': 'dep',
    'scripts/tool.js': 'not backend',
  });
  const scan = await scanServerCodeManifest({ rootDir: ROOT, fsAdapter });
  assert.equal(scan.status, 'ok');
  assert.deepEqual(Object.keys(scan.manifest).sort(), ['lib/a.js', 'lib/nested/b.js', 'server.js']);
  assert.equal(Object.keys(dump()).length, 8);
}

// ---------------------------------------------------------------------------
// Criterion 1: a content change under lib/ sets the flag after one period, and
// a restart (a fresh worker with a new baseline) clears it.

{
  resetWorker();
  const store = { items: [] };
  const published = [];
  const fs = fsWith({ 'server.js': 'boot', 'lib/a.js': 'const x = 1;' });
  const options = {
    rootDir: ROOT,
    instanceToken: 'inst-1',
    fsAdapter: fs.fsAdapter,
    now: clock,
    readStore: () => store,
    publish: async (input) => { published.push(input); return { created: true }; },
  };
  const baselinePass = await runServerCodeFreshnessPass(options);
  assert.equal(baselinePass.state, 'fresh');
  assert.equal(isServerCodeStale(), false);
  assert.equal(published.length, 0);

  fs.write('lib/a.js', 'const x = 2;');
  const stalePass = await runServerCodeFreshnessPass(options);
  assert.equal(stalePass.state, 'stale');
  assert.equal(stalePass.changedCount, 1);
  assert.equal(isServerCodeStale(), true);
  assert.equal(getServerCodeFreshnessDetail().staleSinceAt, new Date(NOW).toISOString());
  // The message tells the truth: a restart may be required, it is not demanded.
  assert.match(published[0].body, /restart may be required/);
  assert.doesNotMatch(published[0].body, /restart is required/);
  assert.equal(published[0].title, 'Backend changed since start');
  assert.ok(published[0].fingerprint.startsWith(CODE_FRESHNESS_EPISODE_PREFIX));
  // Episode key and notification carry no file paths.
  assert.doesNotMatch(JSON.stringify(published[0]), /lib\/a\.js/);
  assert.doesNotMatch(JSON.stringify(getServerCodeFreshnessDetail()), /lib\/a\.js/);

  // The same change set on the next periods is one episode: one notification.
  await runServerCodeFreshnessPass(options);
  await runServerCodeFreshnessPass(options);
  assert.equal(published.length, 1);

  // A restart re-baselines: the flag is gone without any further edit.
  resetWorker();
  const afterRestart = await runServerCodeFreshnessPass({ ...options, instanceToken: 'inst-2' });
  assert.equal(afterRestart.state, 'fresh');
  assert.equal(isServerCodeStale(), false);
  assert.equal(getServerCodeFreshnessDetail().changedCount, 0);
}

// ---------------------------------------------------------------------------
// Criterion 2: restoring the original content clears the flag, no restart.

{
  resetWorker();
  const published = [];
  const fs = fsWith({ 'server.js': 'boot', 'lib/a.js': 'const x = 1;' });
  const options = {
    rootDir: ROOT,
    instanceToken: 'inst-restore',
    fsAdapter: fs.fsAdapter,
    now: clock,
    readStore: () => ({ items: [] }),
    publish: async (input) => { published.push(input); return { created: true }; },
  };
  await runServerCodeFreshnessPass(options);
  fs.write('lib/a.js', 'const x = 2;');
  assert.equal((await runServerCodeFreshnessPass(options)).state, 'stale');
  fs.write('lib/a.js', 'const x = 1;');
  const restored = await runServerCodeFreshnessPass(options);
  assert.equal(restored.state, 'fresh');
  assert.equal(restored.changedCount, 0);
  assert.equal(isServerCodeStale(), false);
  assert.equal(published.length, 1);

  // Changing it again is a new episode, so it notifies again.
  fs.write('lib/a.js', 'const x = 3;');
  const reopened = await runServerCodeFreshnessPass(options);
  assert.equal(reopened.state, 'stale');
  assert.equal(published.length, 2);
  assert.notEqual(published[1].fingerprint, published[0].fingerprint);
}

// ---------------------------------------------------------------------------
// Criterion 3: touching a file (same content) does not raise the flag.

{
  const baseline = { 'server.js': hashFileContent('boot'), 'lib/a.js': hashFileContent('const x = 1;') };
  const current = { 'server.js': hashFileContent('boot'), 'lib/a.js': hashFileContent('const x = 1;') };
  const diff = diffCodeManifest({ baseline, current });
  assert.equal(diff.changedCount, 0);
  assert.equal(describeCodeFreshness({ scanStatus: 'ok', diff, instanceToken: 'i', now: NOW }).state, 'fresh');
}

// ---------------------------------------------------------------------------
// Criterion 4: the answer comes from content/inventory, never the FS clock.

{
  // Same size, same mtime, different content: still stale.
  const original = 'const value = 12;';
  const edited = 'const value = 13;';
  assert.equal(original.length, edited.length);
  const fs = createFakeFs({ files: { 'lib/a.js': original }, mtimes: { 'lib/a.js': 1_700_000_000_000 } });
  const first = await scanServerCodeManifest({ rootDir: ROOT, fsAdapter: fs.fsAdapter });
  fs.write('lib/a.js', edited);
  // mtime deliberately left at the same value.
  const second = await scanServerCodeManifest({ rootDir: ROOT, fsAdapter: fs.fsAdapter });
  const sameSizeDiff = diffCodeManifest({ baseline: first.manifest, current: second.manifest });
  assert.equal(sameSizeDiff.changedCount, 1);
  assert.equal(describeCodeFreshness({ scanStatus: 'ok', diff: sameSizeDiff, instanceToken: 'i', now: NOW }).state, 'stale');

  // Rolled-back and future mtime are irrelevant: identical content is fresh.
  const rolledBack = createFakeFs({ files: { 'lib/a.js': original }, mtimes: { 'lib/a.js': 1_000 } });
  const scannedRolledBack = await scanServerCodeManifest({ rootDir: ROOT, fsAdapter: rolledBack.fsAdapter });
  assert.deepEqual(diffCodeManifest({ baseline: first.manifest, current: scannedRolledBack.manifest }).changedCount, 0);
  const future = createFakeFs({ files: { 'lib/a.js': original }, mtimes: { 'lib/a.js': Date.now() + 86_400_000 } });
  const scannedFuture = await scanServerCodeManifest({ rootDir: ROOT, fsAdapter: future.fsAdapter });
  assert.equal(diffCodeManifest({ baseline: first.manifest, current: scannedFuture.manifest }).changedCount, 0);
  // And a mtime-only touch on a *changed* file is still detected because the
  // detector never consulted mtime.
  const touched = createFakeFs({ files: { 'lib/a.js': edited }, mtimes: { 'lib/a.js': 1 } });
  const scannedTouched = await scanServerCodeManifest({ rootDir: ROOT, fsAdapter: touched.fsAdapter });
  assert.equal(diffCodeManifest({ baseline: first.manifest, current: scannedTouched.manifest }).changedCount, 1);

  // Deletion and rename are inventory facts.
  const deleted = diffCodeManifest({
    baseline: { 'server.js': 'h', 'lib/a.js': 'h1' },
    current: { 'server.js': 'h' },
  });
  assert.deepEqual(deleted.removed, ['lib/a.js']);
  assert.equal(deleted.changedCount, 1);
  const renamed = diffCodeManifest({
    baseline: { 'lib/a.js': 'same-content-hash' },
    current: { 'lib/b.js': 'same-content-hash' },
  });
  assert.deepEqual(renamed.removed, ['lib/a.js']);
  assert.deepEqual(renamed.added, ['lib/b.js']);
  assert.equal(renamed.changedCount, 2);
  const renameState = describeCodeFreshness({ scanStatus: 'ok', diff: renamed, instanceToken: 'r', now: NOW });
  assert.equal(renameState.state, 'stale');
  assert.equal(renameState.changedCount, 2);

  // A different change set is a different episode key.
  const other = diffCodeManifest({ baseline: { 'lib/a.js': 'h1' }, current: { 'lib/a.js': 'h2' } });
  assert.notEqual(renamed.signature, other.signature);
  // The same change set hashes to the same signature (episode replay).
  const sameAgain = diffCodeManifest({ baseline: { 'lib/a.js': 'same-content-hash' }, current: { 'lib/b.js': 'same-content-hash' } });
  assert.equal(renamed.signature, sameAgain.signature);
}

// ---------------------------------------------------------------------------
// Criterion 5: an FS read error is `unknown` — no alarm, no exception.

{
  resetWorker();
  const published = [];
  const fs = createFakeFs({ files: { 'server.js': 'boot', 'lib/a.js': 'a' } });
  const options = {
    rootDir: ROOT,
    instanceToken: 'err-1',
    fsAdapter: fs.fsAdapter,
    now: clock,
    readStore: () => ({ items: [] }),
    publish: async (input) => { published.push(input); return { created: true }; },
  };
  await runServerCodeFreshnessPass(options);
  fs.fail('lib/a.js');
  fs.fail('server.js');
  // Both reads now throw. That is missing data, not a deletion: the inventory is
  // still complete, so reporting two removals would be a false alarm.
  const broken = await runServerCodeFreshnessPass(options);
  assert.equal(broken.state, 'unknown');
  // Unknown is never a zeroed-out measurement.
  assert.equal(broken.changedCount, null);
  assert.equal(getServerCodeFreshnessDetail().changedCount, null);
  assert.equal(isServerCodeStale(), false);
  assert.equal(published.length, 0);

  // A missing root directory does not throw either.
  resetWorker();
  const noRoot = await runServerCodeFreshnessPass({ ...options, rootDir: '', publish: async () => ({ created: true }) });
  assert.equal(noRoot.state, 'unknown');

  // An unreadable inventory stays unknown on the very first pass (no baseline).
  resetWorker();
  const unreadable = createFakeFs({ files: { 'lib/a.js': 'a' }, failures: ['lib'] });
  const firstPass = await runServerCodeFreshnessPass({ ...options, rootDir: ROOT, instanceToken: 'err-2', fsAdapter: unreadable.fsAdapter });
  assert.equal(firstPass.state, 'unknown');

  // A transient failure recovers on the next period, and the earlier open
  // episode keeps its original "stale since" stamp.
  resetWorker();
  const fsRecover = createFakeFs({ files: { 'server.js': 'boot', 'lib/a.js': 'a' } });
  const recoverOptions = { ...options, instanceToken: 'err-3', fsAdapter: fsRecover.fsAdapter, readStore: () => ({ items: [] }) };
  await runServerCodeFreshnessPass(recoverOptions);
  fsRecover.write('lib/a.js', 'changed');
  const staleNow = await runServerCodeFreshnessPass(recoverOptions);
  assert.equal(staleNow.state, 'stale');
  fsRecover.write('server.js', 'boot');
  fsRecover.write('lib/a.js', 'a');
  const brokenAgain = await runServerCodeFreshnessPass({
    ...recoverOptions,
    fsAdapter: createFakeFs({ files: { 'server.js': 'boot', 'lib/a.js': 'a' }, failures: ['lib'] }).fsAdapter,
  });
  assert.equal(brokenAgain.state, 'unknown');
  const recovered = await runServerCodeFreshnessPass(recoverOptions);
  assert.equal(recovered.state, 'fresh');

  // `describeCodeFreshness` itself refuses to alarm on unknown input.
  const unknown = describeCodeFreshness({ scanStatus: 'unknown', diff: diffCodeManifest({ baseline: { 'lib/a.js': 'x' }, current: {} }), instanceToken: 'i', now: NOW });
  assert.equal(unknown.state, 'unknown');
  assert.deepEqual(unknown.violations, []);
  assert.equal(unknown.changedCount, null);
}

// ---------------------------------------------------------------------------
// Criterion 6: a change confined to app_front/ or data/ raises nothing.

{
  resetWorker();
  const published = [];
  const fs = createFakeFs({
    files: {
      'server.js': 'boot',
      'lib/a.js': 'a',
      'app_front/i18n/pl.js': 'stary',
      'data/chats.json': '{}',
      'public/dist/app/app.bundle.js': 'old',
    },
  });
  const options = {
    rootDir: ROOT,
    instanceToken: 'front-1',
    fsAdapter: fs.fsAdapter,
    now: clock,
    readStore: () => ({ items: [] }),
    publish: async (input) => { published.push(input); return { created: true }; },
  };
  await runServerCodeFreshnessPass(options);
  fs.write('app_front/i18n/pl.js', 'nowy');
  fs.write('data/chats.json', '{"chats":1}');
  fs.write('public/dist/app/app.bundle.js', 'new');
  const afterFrontChange = await runServerCodeFreshnessPass(options);
  assert.equal(afterFrontChange.state, 'fresh');
  assert.equal(afterFrontChange.changedCount, 0);
  assert.equal(isServerCodeStale(), false);
  assert.equal(published.length, 0);
}

// ---------------------------------------------------------------------------
// Ack state: a dismissed notification episode is `acked`, not re-notified, while
// the flag itself stays up (a dismissal does not make the code current).

{
  resetWorker();
  const published = [];
  const fs = createFakeFs({ files: { 'server.js': 'boot', 'lib/a.js': 'a' } });
  const episodeHolder = { key: '' };
  const options = {
    rootDir: ROOT,
    instanceToken: 'ack-1',
    fsAdapter: fs.fsAdapter,
    now: clock,
    readStore: () => ({ items: episodeHolder.key ? [{ fingerprint: episodeHolder.key, dismissedAt: new Date(NOW).toISOString() }] : [] }),
    publish: async (input) => { published.push(input); episodeHolder.key = input.fingerprint; return { created: true }; },
  };
  await runServerCodeFreshnessPass(options);
  fs.write('lib/a.js', 'changed');
  await runServerCodeFreshnessPass(options);
  assert.equal(published.length, 1);
  fs.write('server.js', 'boot');
  const acked = await runServerCodeFreshnessPass(options);
  assert.equal(acked.state, 'stale');
  assert.equal(acked.episodeState, 'acked');
  assert.equal(isServerCodeStale(), true);
  assert.equal(published.length, 1, 'an acked episode must not notify again');
}

// ---------------------------------------------------------------------------
// Message wording is honest for one file and for many.

{
  const one = formatCodeFreshnessMessage(1);
  assert.equal(one.title, 'Backend changed since start');
  assert.match(one.body, /^1 backend file changed/);
  assert.match(one.body, /may be required/);
  assert.match(formatCodeFreshnessMessage(3).body, /^3 backend files changed/);
  // A missing measurement never becomes a "0 files" claim in the message.
  assert.match(formatCodeFreshnessMessage(null).body, /^0 backend files changed/);
}

// ---------------------------------------------------------------------------
// Episode lifecycle against the REAL notification store: one row per episode,
// open -> dismissed (acked) -> restored (cleared without a restart). The fakes
// above prove the rules; this proves the wiring into the existing mechanism.

{
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cretli-code-freshness-'));
  const storePath = path.join(dataDir, 'notification-center.json');
  try {
    resetWorker();
    const fs = createFakeFs({ files: { 'server.js': 'boot', 'lib/a.js': 'const x = 1;' } });
    const options = {
      rootDir: ROOT,
      instanceToken: 'store-lifecycle',
      storePath,
      broadcast: false,
      fsAdapter: fs.fsAdapter,
      now: clock,
    };
    const rowsOf = () => readNotificationStoreSync({ storePath }).items
      .filter((row) => String(row.fingerprint || '').startsWith(`${CODE_FRESHNESS_EPISODE_PREFIX}:`));

    await runServerCodeFreshnessPass(options);
    assert.deepEqual(rowsOf(), [], 'a fresh backend publishes nothing');

    fs.write('lib/a.js', 'const x = 2;');
    const opened = await runServerCodeFreshnessPass(options);
    assert.equal(opened.episodeState, 'open');
    assert.equal(rowsOf().length, 1);
    const row = rowsOf()[0];
    assert.equal(row.category, 'system');
    assert.equal(row.severity, 'warning');
    assert.match(row.title, /Backend changed since start/);
    assert.match(row.body, /restart may be required/);
    assert.doesNotMatch(`${row.title}${row.body}${row.fingerprint}`, /lib\/a\.js/, 'no paths in the store row');

    // Two replays of the same episode: the store, not a fake, keeps one row.
    await runServerCodeFreshnessPass(options);
    await runServerCodeFreshnessPass(options);
    assert.equal(rowsOf().length, 1);

    // Dismissal is the ack: the episode stops notifying while the flag stays up.
    const dismissed = await dismissNotifications({ id: row.id }, { storePath, broadcast: false });
    assert.equal(dismissed.ok, true);
    const acked = await runServerCodeFreshnessPass(options);
    assert.equal(acked.state, 'stale');
    assert.equal(acked.episodeState, 'acked');
    assert.equal(isServerCodeStale(), true);
    assert.equal(rowsOf().length, 1);

    // Restoring the content closes the episode without a restart.
    fs.write('lib/a.js', 'const x = 1;');
    const closed = await runServerCodeFreshnessPass(options);
    assert.equal(closed.state, 'fresh');
    assert.equal(closed.episodeState, 'closed');
    assert.equal(isServerCodeStale(), false);

    // A different change set is a new episode, so the ack does not smother it.
    fs.write('lib/a.js', 'const x = 9;');
    const reopened = await runServerCodeFreshnessPass(options);
    assert.equal(reopened.episodeState, 'open');
    const episodeRows = rowsOf();
    assert.equal(episodeRows.length, 2);
    // Newest first, and the two episodes are distinct change sets, so the ack on
    // the first one cannot smother the second.
    assert.equal(episodeRows[0].fingerprint, reopened.episodeKey);
    assert.notEqual(episodeRows[0].fingerprint, episodeRows[1].fingerprint);
  } finally {
    resetWorker();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log('server-code-freshness.test.js: ok');

// Extension and directory scope: `.ts` sources and `harnesses/` belong to the
// backend manifest, and a missing optional `harnesses/` directory is not an error.
{
  assert.equal(isServerCodePath('lib/x/y.ts'), true);
  assert.equal(isServerCodePath('harnesses/plugin/index.js'), true);
  const files = { 'server.js': 'a', 'lib/a.ts': 'b' };
  const fsAdapter = {
    async readDirectory(dir) {
      if (dir === '/r') return [{ name: 'server.js', isDirectory: () => false }, { name: 'lib', isDirectory: () => true }];
      if (dir === '/r/lib') return [{ name: 'a.ts', isDirectory: () => false }];
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    async readFile(file) { return files[file.replace('/r/', '')]; },
  };
  const scan = await scanServerCodeManifest({ rootDir: '/r', fsAdapter });
  assert.equal(scan.status, 'ok');
  assert.deepEqual(Object.keys(scan.manifest).sort(), ['lib/a.ts', 'server.js']);
}

// Ignored directories nested under a scan dir are pruned, never listed or read:
// an unreadable one must not turn the scan into `unknown`.
{
  const listed = [];
  const fsAdapter = {
    async readDirectory(dir) {
      listed.push(dir);
      if (dir === '/r') return [{ name: 'lib', isDirectory: () => true }];
      if (dir === '/r/lib') return [
        { name: 'a.js', isDirectory: () => false },
        { name: 'node_modules', isDirectory: () => true },
      ];
      const error = new Error(dir.includes('node_modules') ? 'EACCES' : 'missing');
      error.code = dir.includes('node_modules') ? 'EACCES' : 'ENOENT';
      throw error;
    },
    async readFile() { return 'x'; },
  };
  const scan = await scanServerCodeManifest({ rootDir: '/r', fsAdapter });
  assert.equal(scan.status, 'ok');
  assert.deepEqual(Object.keys(scan.manifest), ['lib/a.js']);
  assert.equal(listed.some((dir) => dir.includes('node_modules')), false);
}
