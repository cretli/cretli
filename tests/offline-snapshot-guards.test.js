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

describe('offline snapshot guards', () => {
  it('apply without confirmations or with a wrong fingerprint refuses and signals nothing', async () => {
    const w = await makeWorld();
    const none = await cli(w, ['--apply']);
    assert.equal(none.code, 2);
    for (const c of ['CONFIRM_STOP_ALL_SESSIONS_MISSING', 'CONFIRM_ARCHIVE_HISTORY_MISSING', 'CONFIRM_IDENTITY_MISSING']) assert.ok(codes(none.json).includes(c));
    const bad = await cli(w, ['--apply', '--confirm-stop-all-sessions', '--confirm-archive-history', '--confirm-identity', '0000000000000000']);
    assert.ok(codes(bad.json).includes('IDENTITY_FINGERPRINT_MISMATCH'));
    assert.ok(alive(w.pid));
    assert.equal(startMarkers(w).length, 1);
  });

  it('refuses a helper that descends from the server unless detached', async () => {
    const w = await makeWorld({ start: false });
    const helperArgs = [SCRIPT, '--project-root', w.project, '--data-root', w.data, '--output-root', w.out, '--pid', '__PID__',
      '--allow-root-service', '--apply', '--confirm-stop-all-sessions', '--confirm-archive-history', '--confirm-identity', 'x'];
    w.env.FIXTURE_MODE = 'spawn-helper';
    w.env.FIXTURE_HELPER_ARGV = JSON.stringify(helperArgs);
    await startServer(w);
    const out = path.join(w.markers, 'helper.out');
    const json = await waitFor(() => { try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return null; } });
    assert.ok(codes(json).includes('HELPER_IS_DESCENDANT'));
    assert.ok(alive(w.pid));
    assert.equal(startMarkers(w).length, 1);
  });

  it('never signals a foreign pid or another project', async () => {
    const w = await makeWorld();
    const other = await makeWorld();
    const stranger = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: os.tmpdir(), stdio: 'ignore' });
    extraPids.add(stranger.pid);
    const confirm = ['--apply', '--confirm-stop-all-sessions', '--confirm-archive-history', '--confirm-identity', '0000000000000000'];
    const foreign = await cli(w, confirm, { pid: stranger.pid });
    assert.ok(codes(foreign.json).includes('PID_CWD_MISMATCH'));
    assert.ok(codes(foreign.json).includes('PID_ENTRY_MISMATCH'));
    const wrongProject = await cli(w, confirm, { pid: other.pid });
    assert.ok(codes(wrongProject.json).includes('PID_CWD_MISMATCH'));
    assert.ok(alive(stranger.pid) && alive(other.pid) && alive(w.pid));
    assert.equal(startMarkers(other).length, 1);
  });

  it('refuses a service running under a different uid (root helper only)', async (t) => {
    if (!IS_ROOT) return t.skip('needs root to run a fixture under another uid');
    const w = await makeWorld({ start: false });
    for (const d of [w.root, w.project, w.data, w.markers]) fs.chmodSync(d, 0o755);
    fs.chownSync(w.data, 65534, 65534);
    fs.chownSync(w.markers, 65534, 65534);
    const child = spawn(process.execPath, ['server.js'], { cwd: w.project, env: w.env, stdio: 'ignore', uid: 65534, gid: 65534, detached: true });
    child.unref();
    w.pid = child.pid;
    await waitFor(() => fs.existsSync(path.join(w.markers, `start-${child.pid}.json`)));
    const res = await cli(w);
    assert.ok(codes(res.json).includes('PID_UID_MISMATCH'));
    const noFlag = await new Promise((resolve) => {
      const c = spawn(process.execPath, [SCRIPT, '--project-root', w.project, '--data-root', w.data, '--output-root', w.out, '--pid', String(w.pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
      let s = '';
      c.stdout.on('data', (d) => { s += d; });
      c.on('close', () => resolve(JSON.parse(s)));
    });
    assert.ok(codes(noFlag).includes('ROOT_HELPER_NOT_ALLOWED'));
    assert.ok(alive(child.pid));
  });

  it('refuses another writable fd on canonical data before any signal', async () => {
    const w = await makeWorld();
    const holder = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(path.join(w.data, 'held.txt'))}, 'a'); setInterval(()=>{},1000)`], { cwd: os.tmpdir(), stdio: 'ignore' });
    extraPids.add(holder.pid);
    await sleep(500);
    const plan = await cli(w);
    assert.ok(codes(plan.json).includes('UNKNOWN_WRITER'));
    const res = await cli(w, ['--apply', '--confirm-stop-all-sessions', '--confirm-archive-history', '--confirm-identity', plan.json.fingerprint ?? 'x']);
    assert.equal(res.code, 2);
    assert.ok(alive(w.pid));
    assert.equal(startMarkers(w).length, 1);
  });

  it('rejects an output root inside the source or project', async () => {
    const w = await makeWorld();
    const inside = path.join(w.data, 'backup-out');
    fs.mkdirSync(inside, { mode: 0o700 });
    const res = await cli(w, ['--output-root', inside]);
    assert.ok(codes(res.json).includes('OUTPUT_OVERLAPS_DATA'));
    assert.ok(codes(res.json).includes('OUTPUT_OVERLAPS_PROJECT'));
    const same = await cli(w, ['--output-root', w.data]);
    assert.ok(codes(same.json).includes('OUTPUT_OVERLAPS_DATA'));
    assert.ok(alive(w.pid));
  });

  it('a malformed JSONL line is refused with line number only', async () => {
    const w = await makeWorld();
    fs.appendFileSync(path.join(w.data, 'chat-history', 'c1.jsonl'), `{"bad": ${CONVO}\n`);
    const res = await cli(w, await applyArgs(w));
    assert.equal(res.json.error.code, 'JSONL_INVALID');
    assert.equal(res.json.error.detail.line, 3);
    assertNoLeaks(w, res);
  });

  it('symlinks in the source are refused at preflight; bad JSON refuses publication and restarts', async () => {
    const w = await makeWorld();
    fs.symlinkSync('/etc/hostname', path.join(w.data, 'link.txt'));
    const plan = await cli(w);
    assert.ok(codes(plan.json).includes('SYMLINK_IN_SOURCE'));
    assert.ok(alive(w.pid));
    fs.rmSync(path.join(w.data, 'link.txt'));
    fs.writeFileSync(path.join(w.data, 'broken.json'), `{"x": ${CONVO}`);
    const res = await cli(w, await applyArgs(w));
    assert.equal(res.json.state, 'failed');
    assert.equal(res.json.error.code, 'JSON_INVALID');
    assert.equal(res.json.error.detail.path, 'broken.json');
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.ok(!fs.readdirSync(opDirOf(w)).some((n) => n.endsWith('.tar.gz')));
    assertNoLeaks(w, res);
    // The failure keeps private diagnostics under work/ with owner-only mode.
    assert.equal(mode(path.join(opDirOf(w), 'work')), 0o700);
  });
});
