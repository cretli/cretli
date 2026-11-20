/**
 * A hung coalesced watcher heartbeat pass must not silence the driver forever:
 * after the stuck window a new pass replaces it, and the abandoned pass cannot
 * clear the replacement's in-flight flag.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CRETLI_WATCHER_HEARTBEAT_STUCK_MS = '1000';
process.env.CRETLI_WATCHER_HEARTBEAT_MIN_INTERVAL_MS = '0';
const { runWorkspaceWatcherHeartbeatSafely, resetWorkspaceWatcherHeartbeatThrottle } = await import('../lib/delegation-runtime-worker.js');

test('hung heartbeat pass is abandoned after the stuck window', async () => {
  resetWorkspaceWatcherHeartbeatThrottle();
  let runs = 0;
  let releaseFirst = () => {};
  const hung = () => { runs += 1; return new Promise((resolve) => { releaseFirst = resolve; }); };
  const quick = async () => { runs += 1; };
  const first = runWorkspaceWatcherHeartbeatSafely(0, {}, true, hung);
  const t = Date.now();
  await runWorkspaceWatcherHeartbeatSafely(t, {}, true, quick);
  assert.equal(runs, 1, 'in-flight pass still blocks inside the stuck window');
  await new Promise((resolve) => { setTimeout(resolve, 1100); });
  await runWorkspaceWatcherHeartbeatSafely(t, {}, true, quick);
  assert.equal(runs, 2, 'stuck pass replaced by a fresh one');
  releaseFirst();
  await first;
  await runWorkspaceWatcherHeartbeatSafely(Date.now(), {}, true, quick);
  assert.equal(runs, 3, 'driver keeps ticking afterwards');
});
