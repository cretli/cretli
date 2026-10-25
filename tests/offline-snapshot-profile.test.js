import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NODE_EXE, PROFILE_FLAGS, alive, makeWorld, makeProfileWorld, startProfileServer, startMarkers, cli, profileApplyArgs,
  codes, assertNoLeaks, cleanupWorlds, waitFor,
} from './fixtures/offline-snapshot-helpers.js';

// Synthetic project + real child processes only. The profile is opt-in: it binds the PID to hashed
// static code, the node exe, cwd, uid, start time, the rewritten title and an owned loopback listener.

afterEach(cleanupWorlds);

const stat = (pid) => fs.readFileSync(`/proc/${pid}/stat`, 'utf8');

describe('offline snapshot launch profile', () => {
  it('without the profile an opaque (title-rewritten) server is refused with an honest diagnosis', async () => {
    const w = await makeProfileWorld();
    assert.match(stat(w.pid), /\(cretli\)/);
    const res = await cli(w);
    assert.equal(res.code, 2);
    const entry = res.json.refusals.find((r) => r.code === 'PID_ENTRY_MISMATCH');
    assert.ok(entry, res.stdout);
    assert.equal(entry.detail.argvOpaque, true);
    assert.ok(alive(w.pid));
  });

  it('profile plan passes, reports hashed code + listener + health, never claims recovered argv, sends no signal', async () => {
    const w = await makeProfileWorld();
    const before = stat(w.pid).split(') ')[1].split(' ')[19];
    const res = await cli(w, PROFILE_FLAGS);
    assert.equal(res.code, 0, res.stdout);
    const lp = res.json.launchProfile;
    assert.equal(lp.id, 'cretli-npm-start-v1');
    assert.equal(lp.argvRecovered, false);
    assert.match(lp.digest, /^[0-9a-f]{32}$/);
    assert.ok(lp.listeners.length >= 1 && lp.health);
    assert.deepEqual(Object.keys(lp.files).sort(), ['bootEnv', 'entry', 'launcher', 'packageJson']);
    assert.equal(res.json.signalsSent, false);
    assert.equal(res.json.contentsRead, false);
    assert.ok(res.json.nextStep.includes(`--confirm-profile-digest ${lp.digest}`));
    assert.equal(stat(w.pid).split(') ')[1].split(' ')[19], before);
    assert.deepEqual(fs.readdirSync(w.out), []);
    assertNoLeaks(w, res);
  });

  it('apply needs the separate profile digest confirmation; a wrong or stale digest signals nothing', async () => {
    const w = await makeProfileWorld();
    const plan = await cli(w, PROFILE_FLAGS);
    const base = [...PROFILE_FLAGS, '--apply', '--confirm-stop-all-sessions', '--confirm-archive-history', '--confirm-identity', plan.json.fingerprint];
    const missing = await cli(w, base);
    assert.ok(codes(missing.json).includes('CONFIRM_PROFILE_DIGEST_MISSING'));
    const wrong = await cli(w, [...base, '--confirm-profile-digest', '0'.repeat(32)]);
    assert.ok(codes(wrong.json).includes('PROFILE_DIGEST_MISMATCH'));
    // The launcher changes after the operator reviewed the digest: the digest no longer matches.
    fs.appendFileSync(path.join(w.project, 'scripts', 'start-server-node22.sh'), '# edited\n');
    const stale = await cli(w, [...base, '--confirm-profile-digest', plan.json.launchProfile.digest]);
    assert.ok(codes(stale.json).includes('PROFILE_DIGEST_MISMATCH'));
    assert.ok(codes(stale.json).includes('IDENTITY_FINGERPRINT_MISMATCH'), 'fingerprint covers the profile digest');
    assert.ok(alive(w.pid));
    assert.equal(startMarkers(w).length, 1);
  });

  it('the profile never weakens the guards: node exe, argv shape, code trust, start script, foreign pid, second server', async () => {
    const w = await makeProfileWorld();
    const noExe = await cli(w, ['--launch-profile', 'cretli-npm-start-v1']);
    assert.ok(codes(noExe.json).includes('PROFILE_NODE_EXE_REQUIRED'));
    const wrongExe = await cli(w, ['--launch-profile', 'cretli-npm-start-v1', '--node-exe', '/bin/sh']);
    assert.ok(codes(wrongExe.json).includes('PID_EXE_MISMATCH'));
    const bad = await cli(w, ['--launch-profile', 'nope']);
    assert.equal(bad.code, 2);
    // Group-writable launcher is untrusted code.
    const launcher = path.join(w.project, 'scripts', 'start-server-node22.sh');
    fs.chmodSync(launcher, 0o775);
    assert.ok(codes((await cli(w, PROFILE_FLAGS)).json).includes('PROFILE_CODE_UNTRUSTED'));
    fs.chmodSync(launcher, 0o755);
    // A different package.json start script is not the known deployment.
    const pkg = path.join(w.project, 'package.json');
    const good = fs.readFileSync(pkg, 'utf8');
    fs.writeFileSync(pkg, JSON.stringify({ scripts: { start: 'node server.js' } }));
    assert.ok(codes((await cli(w, PROFILE_FLAGS)).json).includes('PROFILE_START_SCRIPT_MISMATCH'));
    fs.writeFileSync(pkg, good);
    // A plain (non-opaque) server is not eligible for the profile.
    const plain = await makeWorld();
    const plainPlan = await cli(plain, PROFILE_FLAGS);
    assert.ok(codes(plainPlan.json).includes('PROFILE_ARGV_NOT_OPAQUE'));
    // A foreign process keeps failing the cwd guard.
    const other = await makeProfileWorld();
    const foreign = await cli(w, PROFILE_FLAGS, { pid: other.pid });
    assert.ok(codes(foreign.json).includes('PID_CWD_MISMATCH'));
    // A second matching (opaque) server for the same project blocks the plan.
    const firstPid = w.pid;
    await startProfileServer(w);
    const second = await cli(w, PROFILE_FLAGS, { pid: firstPid });
    assert.ok(codes(second.json).includes('ANOTHER_SERVER_PRESENT'), second.stdout);
    // A confirmation for the previous PID cannot be replayed against the new one.
    const stale = await cli(w, [...PROFILE_FLAGS, '--apply', '--confirm-stop-all-sessions', '--confirm-archive-history',
      '--confirm-identity', '0'.repeat(16), '--confirm-profile-digest', '0'.repeat(32)]);
    assert.ok(codes(stale.json).includes('IDENTITY_FINGERPRINT_MISMATCH'));
    assert.ok(codes(stale.json).includes('ANOTHER_SERVER_PRESENT'));
    assert.ok(alive(firstPid) && alive(w.pid) && alive(other.pid));
  });

  it('a restart recipe whose PATH resolves a different node is refused BEFORE the stop', async () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-fake-node-'));
    fs.writeFileSync(path.join(fake, 'node'), `#!/bin/sh\nexec ${NODE_EXE} "$@"\n`, { mode: 0o755 });
    try {
      const w = await makeProfileWorld({ pathPrefix: `${fake}:` });
      const res = await cli(w, await profileApplyArgs(w));
      assert.equal(res.json.state, 'failed', res.stdout);
      assert.equal(res.json.error.code, 'PROFILE_RESTART_RECIPE_INVALID');
      assert.ok(alive(w.pid));
      assert.equal(startMarkers(w).length, 1);
    } finally {
      fs.rmSync(fake, { recursive: true, force: true });
    }
  });

  it('profile apply: graceful stop, snapshot, and restart through the verified launcher with the initial env and health', async () => {
    const w = await makeProfileWorld();
    const oldPid = w.pid;
    const res = await cli(w, await profileApplyArgs(w));
    assert.equal(res.code, 0, res.stdout);
    assert.equal(res.json.state, 'published');
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.equal(res.json.restart.healthProbe, 'ok');
    assert.ok(!alive(oldPid));
    const next = res.json.restart.pid;
    assert.ok(alive(next));
    assert.match(stat(next), /\(cretli\)/);
    assert.equal(fs.readlinkSync(`/proc/${next}/exe`), NODE_EXE);
    const marks = startMarkers(w);
    assert.equal(marks.length, 2);
    assert.equal(marks.find((m) => m.pid === next).secretSha256, marks.find((m) => m.pid === oldPid).secretSha256);
    await waitFor(() => fs.existsSync(path.join(w.markers, `start-${next}.json`)));
    assertNoLeaks(w, res);
  });
});
