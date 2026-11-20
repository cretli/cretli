import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProcessStartTime } from '../lib/delegation-owner-lock.js';
import { tryAcquireDistBuildLock, detectStaleDevBundle } from '../lib/dist-build-lock.js';
import * as devBuild from '../lib/dev-build.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'dist-lock-'));
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('second build is rejected while the first holds the lock, then released', () => {
  const lockPath = path.join(tmp(), 'dist-build.lock');
  const first = tryAcquireDistBuildLock('a', { lockPath });
  assert.equal(first.acquired, true);
  const second = tryAcquireDistBuildLock('b', { lockPath });
  assert.equal(second.acquired, false);
  assert.match(second.detail, /already writes to public\/dist/);
  first.release();
  assert.equal(existsSync(lockPath), false);
  assert.equal(tryAcquireDistBuildLock('b', { lockPath }).acquired, true);
});

test('stale lock of a dead pid is recovered', () => {
  const lockPath = path.join(tmp(), 'dist-build.lock');
  writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, label: 'ghost' }));
  assert.equal(tryAcquireDistBuildLock('x', { lockPath }).acquired, true);
});

test('detectStaleDevBundle: prod and missing bundles are fine, dev bundle without watcher warns', () => {
  const dir = tmp();
  const bundle = path.join(dir, 'index.bundle.js');
  assert.equal(detectStaleDevBundle(bundle), null);
  writeFileSync(bundle, '!function(){console.log(1)}();');
  assert.equal(detectStaleDevBundle(bundle), null);
  writeFileSync(bundle, '/*\n * eval-source-map\n */\n(() => { eval("1"); })();' + ' '.repeat(10000));
  assert.match(detectStaleDevBundle(bundle) || '', /looks like a dev build/);
});

test('dev-build re-exports the lock helpers', () => {
  assert.equal(typeof devBuild.tryAcquireDistBuildLock, 'function');
});

test('webpack wrapper fails fast when public/dist is locked; widget and --output-path builds skip the lock', () => {
  const dataDir = tmp();
  const env = { ...process.env, CRETLI_DATA_DIR: dataDir };
  const lockPath = path.join(dataDir, 'dist-build.lock');
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    pidStart: getProcessStartTime(process.pid),
    label: 'test-holder',
    startedAt: new Date().toISOString(),
  }));
  const wrapper = path.join(ROOT, 'app_front', 'scripts', 'webpack-cli-watch.mjs');
  const run = (args) => spawnSync(process.execPath, [wrapper, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const locked = run(['--config', 'webpack.prod.js', '--no-watch']);
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /already writes to public\/dist/);
  assert.match(readFileSync(lockPath, 'utf8'), /test-holder/);
  // Neither a temp --output-path build nor a widget config consults the dist lock.
  for (const args of [
    ['--config', 'does-not-exist.js', '--no-watch', '--output-path', tmp()],
    ['--config', 'webpack.widget.missing.js', '--no-watch'],
  ]) {
    assert.doesNotMatch(run(args).stderr, /already writes to public\/dist/);
  }
  assert.match(readFileSync(lockPath, 'utf8'), /test-holder/);
});
