/**
 * Stage 6 stall profile (scripts/architecture-stall-profile.mjs): pure statistics,
 * verdict rules, the isolation guard and a smoke run of the whole profile.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, stats, THRESHOLDS } from '../scripts/architecture-stall-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'architecture-stall-profile.mjs');

test('stats labels P99 stable only from 1000 samples', () => {
  const few = stats(Array.from({ length: 999 }, (_, i) => i + 1));
  const many = stats(Array.from({ length: 1000 }, (_, i) => i + 1));
  assert.equal(few.p99Label, 'exploratory');
  assert.equal(many.p99Label, 'stable');
  assert.equal(many.p50, 500);
  assert.equal(many.p99, 990);
  assert.equal(many.max, 1000);
  assert.deepEqual(stats([]).n, 0);
});

test('classify applies the storage-gates event-loop thresholds', () => {
  const call = (p99, max, n = 1000) => ({ n, p50: 1, p95: 1, p99, p99Label: n >= 1000 ? 'stable' : 'exploratory', max });
  const eld = (max) => ({ p99: 1, max });
  assert.equal(THRESHOLDS.eventLoopP99Ms, 25);
  assert.equal(THRESHOLDS.eventLoopMaxMs, 100);
  assert.equal(classify({ callMs: call(25, 30), eventLoopMs: eld(30) }), 'within');
  assert.equal(classify({ callMs: call(25.1, 30), eventLoopMs: eld(30) }), 'exceeds');
  assert.equal(classify({ callMs: call(5, 100.1), eventLoopMs: eld(100.1) }), 'exceeds');
  assert.equal(classify({ callMs: call(5, 50), eventLoopMs: eld(101) }), 'exceeds');
  assert.equal(classify({ callMs: call(30, 31, 200), eventLoopMs: eld(31) }), 'exceeds (exploratory)');
  assert.equal(classify({ callMs: call(1, 2, 200), eventLoopMs: eld(2) }), 'within (exploratory)');
  assert.equal(classify({ callMs: stats([]), eventLoopMs: null }), 'not-measured');
});

test('child refuses to run against the repository data directory', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--child', '--profile', 'smoke', '--work', os.tmpdir()], {
    env: { ...process.env, CRETLI_DATA_DIR: path.join(ROOT, 'data', 'stall-profile-guard') },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated CRETLI_DATA_DIR/);
});

test('smoke profile runs in an isolated dir and reports owners, reasons and no errors', () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'cretli-stall-test-')), 'profile.json');
  try {
    execFileSync(process.execPath, [SCRIPT, '--profile', 'smoke', '--out', out], { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.thresholds.resolutionMs, 1);
    assert.ok(report.sites.length >= 40);
    const owners = new Set(report.sites.map((site) => site.owner));
    for (const owner of ['A2', 'A4', 'R3', 'stage-6']) assert.ok(owners.has(owner), `owner ${owner} present`);
    for (const site of report.sites) {
      assert.notEqual(site.status, 'error', `${site.id}: ${site.error}`);
      assert.ok(site.requestPath, `${site.id} has requestPath`);
      if (site.status === 'not measured') assert.ok(site.reason, `${site.id} has a reason`);
      else assert.ok(site.callMs.n > 0 && site.eventLoopMs, `${site.id} measured`);
    }
    // Leaf d0205ec8: production-scale sites for the six watchdog stall codes.
    const byId = new Map(report.sites.map((site) => [site.id, site]));
    for (const id of [
      'ST-todos-parse-prod', 'ST-todos-load-cold-prod',
      'ST-workspace-settings-view-prod-warm', 'ST-workspace-settings-view-prod-rebuild',
      'ST-normalize-folder-prod-warm', 'ST-normalize-folder-prod-sweep', 'ST-watchers-load-cold-prod',
      'ST-oom-read-markers-prod-200', 'ST-oom-write-marker-prod-cap',
      'ST-recovery-classify-prod-60-cycles10',
    ]) {
      const site = byId.get(id);
      assert.ok(site, `${id} reported`);
      assert.equal(site.status, 'measured', id);
      assert.ok(site.callMs.n > 0 && site.callMs.p50 >= 0 && site.eventLoopMs, `${id} has a small profile`);
    }
    const todoFixture = byId.get('ST-todos-load-cold-prod').observed;
    assert.ok(todoFixture.fixtureBytes >= 1024 * 1024, 'smoke todo fixture size asserted');
    assert.match(todoFixture.profileLabel, /smoke/);
    assert.ok(todoFixture.setupMs >= 0 && Number.isFinite(todoFixture.normalizeMsDerived), 'setup and normalization reported apart from parse');
    const busy = byId.get('ST-delegation-sqlite-busy-retry-prod');
    assert.equal(busy.status, 'not measured');
    assert.ok(busy.reason && busy.owner === 'A2');
    const probe = report.sites.find((site) => site.id === 'AW-owner-lock-socket-probe');
    assert.ok(probe.callMs.p50 >= 70, 'socket probe blocks for its full Atomics.wait window');
    assert.ok(Number.isInteger(probe.observed.reportedLive), 'liveness result of the listening socket is recorded');
  } finally {
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
});
