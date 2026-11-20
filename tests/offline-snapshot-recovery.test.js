import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SCRIPT, IS_ROOT, CONVO, extraPids, sleep, alive, waitFor, makeWorld, startServer, launchResult, startMarkers,
  cli, applyArgs, opDirOf, codes, mode, assertNoLeaks, cleanupWorlds,
} from './fixtures/offline-snapshot-helpers.js';

// Real child processes, synthetic temp projects only. Nothing here touches a real
// Cretli installation, data/chat-history or native provider homes.

afterEach(cleanupWorlds);

describe('offline snapshot recovery', () => {
  it('refuses an orphaned writer that survives the stop, and restarts the service', async () => {
    const w = await makeWorld({ mode: 'orphan-writer' });
    await waitFor(() => fs.existsSync(path.join(w.markers, 'orphan.pid')));
    await sleep(500);
    const res = await cli(w, await applyArgs(w));
    assert.equal(res.json.state, 'failed');
    assert.equal(res.json.error.code, 'UNKNOWN_WRITER_AFTER_STOP');
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.equal(startMarkers(w).length, 2);
    assert.ok(!fs.readdirSync(opDirOf(w)).some((n) => n.endsWith('.tar.gz')));
  });

  it('a source that changes during the copy refuses publication and restarts', async () => {
    const w = await makeWorld();
    const res = await cli(w, await applyArgs(w), { env: { CRETLI_SNAPSHOT_FAULT: 'mutate-source' } });
    assert.equal(res.json.state, 'failed');
    assert.equal(res.json.error.code, 'SOURCE_CHANGED');
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.ok(!fs.readdirSync(opDirOf(w)).some((n) => n.endsWith('.tar.gz')));
  });

  it('stop timeout never force-kills; a late exit within the monitor restarts exactly once', async () => {
    const w = await makeWorld({ mode: 'delayed-exit', extraEnv: { FIXTURE_EXIT_DELAY_MS: '2500' } });
    const oldPid = w.pid;
    const res = await cli(w, await applyArgs(w, ['--stop-timeout-ms', '500', '--late-exit-monitor-ms', '15000']));
    assert.equal(res.json.state, 'failed');
    assert.equal(res.json.error.code, 'STOP_TIMEOUT');
    assert.equal(res.json.error.detail.forceKill, false);
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.ok(!alive(oldPid));
    assert.equal(startMarkers(w).length, 2);
    assert.ok(alive(res.json.restart.pid));
  });

  it('a server that ignores SIGTERM stays the same process: bounded, no kill, explicit manual recovery', async () => {
    const w = await makeWorld({ mode: 'ignore-sigterm' });
    const t0 = Date.now();
    const res = await cli(w, await applyArgs(w, ['--stop-timeout-ms', '500', '--late-exit-monitor-ms', '1000']));
    assert.ok(Date.now() - t0 < 15000);
    assert.equal(res.json.state, 'failed');
    assert.equal(res.json.error.code, 'STOP_TIMEOUT');
    assert.equal(res.json.error.detail.forceKill, false);
    assert.equal(res.json.restart.outcome, 'stop-incomplete');
    assert.equal(res.json.restart.code, 'STOP_INCOMPLETE_MANUAL_RECOVERY');
    assert.ok(!/untouched/i.test(res.stdout));
    assert.ok(alive(w.pid));
    assert.equal(startMarkers(w).length, 1);
  });

  it('a surviving known descendant without an open writer fd refuses the copy and restarts', async () => {
    const w = await makeWorld({ mode: 'orphan-idle' });
    await waitFor(() => fs.existsSync(path.join(w.markers, 'orphan.pid')));
    await sleep(300);
    const res = await cli(w, await applyArgs(w));
    assert.equal(res.json.state, 'failed');
    assert.equal(res.json.error.code, 'KNOWN_DESCENDANT_SURVIVED');
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.ok(!fs.readdirSync(opDirOf(w)).some((n) => n.endsWith('.tar.gz')));
  });
});
