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

describe('offline snapshot', () => {
  it('plan is the default: no signals, no output, no leaks', async () => {
    const w = await makeWorld();
    const startTicks = () => fs.readFileSync(`/proc/${w.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
    const before = startTicks();
    const res = await cli(w);
    assert.equal(res.code, 0, res.stdout);
    assert.equal(res.json.mode, 'plan');
    assert.equal(res.json.signalsSent, false);
    assert.match(res.json.fingerprint, /^[0-9a-f]{16}$/);
    assert.ok(res.json.source.excludedPresent.includes('runtime-home'));
    assert.equal(res.json.source.sqliteDatabases, 1);
    assert.deepEqual(fs.readdirSync(w.out), []);
    assert.equal(startTicks(), before);
    assert.equal(startMarkers(w).length, 1);
    assertNoLeaks(w, res);
  });

  it('guarded stop, WAL-inclusive SQLite backup, checksums, permissions and restart with preserved env', async () => {
    const w = await makeWorld();
    const oldPid = w.pid;
    const res = await cli(w, await applyArgs(w));
    assert.equal(res.code, 0, res.stdout);
    assert.equal(res.json.state, 'published');
    assert.equal(res.json.restart.outcome, 'running-verified');
    assert.ok(!alive(oldPid));
    assert.ok(alive(res.json.restart.pid));
    // Restarted instance: same cwd, same secret env (compared by hash), exactly one new process.
    const marks = startMarkers(w);
    assert.equal(marks.length, 2);
    const next = marks.find((m) => m.pid === res.json.restart.pid);
    assert.equal(next.secretSha256, marks.find((m) => m.pid === oldPid).secretSha256);
    assert.equal(fs.realpathSync(next.cwd), fs.realpathSync(w.project));

    const op = opDirOf(w);
    assert.equal(mode(op), 0o700);
    const base = path.basename(op);
    const archive = path.join(op, `${base}.tar.gz`);
    for (const f of [archive, `${archive}.sha256`, path.join(op, `${base}.manifest.json`), path.join(op, 'status.json'), path.join(op, 'ops.log')]) {
      assert.equal(mode(f), 0o600, f);
    }
    assert.ok(!fs.existsSync(path.join(op, 'work')));
    // Isolated extraction + checksum round trip.
    const ex = fs.mkdtempSync(path.join(w.root, 'ex-'));
    execFileSync('tar', ['-xzf', archive, '-C', ex]);
    const manifest = JSON.parse(fs.readFileSync(path.join(ex, 'MANIFEST.json'), 'utf8'));
    assert.equal(res.json.archive.sha256, execFileSync('sha256sum', [archive]).toString().split(' ')[0]);
    const { createHash } = await import('node:crypto');
    for (const f of manifest.files) {
      const buf = fs.readFileSync(path.join(ex, 'data', f.path));
      assert.equal(createHash('sha256').update(buf).digest('hex'), f.sha256, f.path);
    }
    // Everything lived only in the WAL at stop time, so the rows prove the backup API included it.
    const db = new DatabaseSync(path.join(ex, 'data', 'cretli-store.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS c FROM child').get().c, 50);
    db.close();
    assert.ok(fs.existsSync(path.join(ex, 'data', 'chat-history', 'c1.jsonl')));
    // Exclusions: native homes, stores, auth, locks, .env.
    const listing = execFileSync('tar', ['-tzf', archive]).toString();
    for (const bad of ['runtime-home', 'sdk-agent-store', 'auth.json', '.lock', '.env', '-shm', '-wal']) assert.ok(!listing.includes(bad), bad);
    assert.ok(manifest.classification.includes('UNENCRYPTED'));
    assertNoLeaks(w, res);
  });

  it('--detach returns immediately and the helper finishes independently', async () => {
    const w = await makeWorld();
    const t0 = Date.now();
    const res = await cli(w, await applyArgs(w, ['--detach']));
    assert.equal(res.code, 0, res.stdout);
    assert.equal(res.json.mode, 'apply-detached');
    assert.ok(Date.now() - t0 < 10000);
    const op = res.json.operationDir;
    const status = await waitFor(() => {
      const s = JSON.parse(fs.readFileSync(path.join(op, 'status.json'), 'utf8'));
      return s.state !== 'running' ? s : null;
    }, 60000);
    assert.equal(status.state, 'published', JSON.stringify(status));
    assert.equal(startMarkers(w).length, 2);
    assertNoLeaks(w, res);
  });

  it('--detach launched from inside the server survives a per-PID descendant tree kill on SIGTERM', async () => {
    const w = await makeWorld({ mode: 'tree-kill,launch-on-trigger' });
    const oldPid = w.pid;
    const args = [SCRIPT, '--project-root', w.project, '--data-root', w.data, '--output-root', w.out, '--pid', String(w.pid),
      '--allow-root-service', '--detach', ...(await applyArgs(w))];
    fs.writeFileSync(path.join(w.markers, 'launch.json'), JSON.stringify(args));
    const launch = await launchResult(w);
    assert.equal(launch.mode, 'apply-detached', JSON.stringify(launch));
    const status = await waitFor(() => {
      const s = JSON.parse(fs.readFileSync(path.join(launch.operationDir, 'status.json'), 'utf8'));
      return s.state !== 'running' ? s : null;
    }, 60000);
    assert.equal(status.state, 'published', JSON.stringify(status));
    assert.ok(!alive(oldPid));
    assert.equal(startMarkers(w).length, 2);
    assert.equal(status.restart.outcome, 'running-verified');
  });

  it('the detach barrier refuses to signal while the helper is still a descendant of the server', async () => {
    const w = await makeWorld({ mode: 'tree-kill,launch-on-trigger', extraEnv: { FIXTURE_LAUNCH_ENV: JSON.stringify({ CRETLI_SNAPSHOT_FAULT: 'launcher-linger' }) } });
    const args = [SCRIPT, '--project-root', w.project, '--data-root', w.data, '--output-root', w.out, '--pid', String(w.pid),
      '--allow-root-service', '--detach', ...(await applyArgs(w, ['--barrier-timeout-ms', '800']))];
    fs.writeFileSync(path.join(w.markers, 'launch.json'), JSON.stringify(args));
    const launch = await launchResult(w);
    const status = await waitFor(() => {
      const s = JSON.parse(fs.readFileSync(path.join(launch.operationDir, 'status.json'), 'utf8'));
      return s.state !== 'running' ? s : null;
    }, 20000);
    assert.equal(status.state, 'failed');
    assert.equal(status.error.code, 'DETACH_BARRIER_FAILED');
    assert.ok(alive(w.pid));
    assert.equal(startMarkers(w).length, 1);
  });

  it('a crashed copy child or validation child still restarts the service', async () => {
    for (const faultName of ['crash-stage', 'crash-finalize']) {
      const w = await makeWorld();
      const res = await cli(w, await applyArgs(w), { env: { CRETLI_SNAPSHOT_FAULT: faultName } });
      assert.equal(res.json.state, 'failed', faultName);
      assert.equal(res.json.error.code, 'WORKER_CRASHED');
      assert.equal(res.json.restart.outcome, 'running-verified');
      assert.ok(alive(res.json.restart.pid));
      assert.ok(!fs.readdirSync(opDirOf(w)).some((n) => n.endsWith('.tar.gz')));
    }
  });
});
