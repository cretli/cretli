/**
 * Keep-alive benchmark report, go/no-go gate and the stored-gate loader.
 */
process.env.CRETLI_TEST_DATA_DIR ||= 'keep-alive-benchmark-test';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KEEP_ALIVE_BENCHMARK_ROLES as ROLES,
  buildKeepAliveProvenance,
  verifyKeepAliveFixtureMaterial,
  KEEP_ALIVE_GATE_REASON as R,
  buildKeepAliveBenchmarkReport,
  evaluateKeepAliveGate,
  simulateKeepAliveObservations,
} from '../lib/usage/keep-alive-benchmark.ts';
import { KEEP_ALIVE_BENCHMARK_FILE, loadKeepAliveGate } from '../lib/usage/keep-alive-gate.ts';
import { evaluateKeepAliveAvailability } from '../lib/usage/keep-alive-policy.ts';

const fixtureDir = fileURLToPath(new URL('./fixtures/keep-alive-benchmark', import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fixture.json'), 'utf8'));
const verification = verifyKeepAliveFixtureMaterial(fixture, { dir: fixtureDir });
assert.deepEqual(verification.problems, []);
const provenance = buildKeepAliveProvenance(fixture, verification);
/** Gate options: the expected fixture the provenance is checked against. */
const GATE = { fixture, materialVerification: verification };

/** Measured observations with a known tariff. `keepCost` tunes the ping bill. */
function measured({ freshCost = 1, reuseCost = 0.6, turnsKeep = 0.5, pingCost = 0.02, effective = true, keepBugs = null, version = '1' } = {}) {
  const bugs = fixture.seededBugs;
  const arm = (turnCost, extra = {}) => {
    const roles = {};
    for (const role of ROLES) {
      roles[role] = { turns: [1, 2, 3].map((round) => ({
        round, input: 100, cachedInput: 50, cacheWrite: 10, output: 20, costUsd: turnCost / 9, bugsFound: bugs,
      })) };
    }
    return { fixtureVersion: version, materialIds: fixture.materialIds, wallTimeMs: 1000, roles, pings: [], ...extra };
  };
  const keep = arm(turnsKeep, {
    pings: ROLES.map((role) => ({ role, input: 1, cachedInput: 100, cacheWrite: 0, output: 1, costUsd: pingCost, effective })),
  });
  if (keepBugs) for (const role of ROLES) keep.roles[role].turns.forEach((t) => { t.bugsFound = keepBugs; });
  return {
    fixture,
    provenance,
    source: 'measured',
    tariff: { known: true },
    arms: { fresh: arm(freshCost), reuse: arm(reuseCost), reuse_keep_alive: keep },
  };
}

// ---- A measured, cheaper, equal-quality run is the only way to `go`.
{
  const report = buildKeepAliveBenchmarkReport(measured());
  assert.equal(report.scope.loopConclusion, null);
  assert.equal(report.scope.kind, 'fixture_capability');
  assert.equal(report.arms.reuse_keep_alive.pings.count, 3);
  // Ping cost is INCLUDED in the keep-alive arm total (0.5 + 3 * 0.02).
  assert.equal(report.arms.reuse_keep_alive.cost.totalUsd, 0.56);
  assert.equal(report.comparison.keepAliveVsFresh.costUsd, -0.44);
  assert.equal(report.comparison.keepAliveVsReuse.costUsd, -0.04);
  const gate = evaluateKeepAliveGate(report, GATE);
  assert.equal(gate.decision, 'go');
  assert.deepEqual(gate.reasons, []);
}

// ---- A negative result is valid and is a no-go, with the reason.
{
  const worse = evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(measured({ turnsKeep: 0.59, pingCost: 0.1 })), GATE);
  assert.equal(worse.decision, 'no_go');
  assert.ok(worse.reasons.includes(R.NO_GAIN_OVER_REUSE));
  const ineffective = evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(measured({ effective: false })), GATE);
  assert.ok(ineffective.reasons.includes(R.PINGS_INEFFECTIVE));
  const quality = evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(measured({ keepBugs: fixture.seededBugs.slice(0, 2) })));
  assert.ok(quality.reasons.includes(R.QUALITY_LOSS));
}

// ---- Unknown tariff => unknown cost, never a promise.
{
  const obs = measured();
  obs.tariff = { known: false };
  obs.arms.reuse_keep_alive.pings[0].costUsd = null;
  const report = buildKeepAliveBenchmarkReport(obs);
  assert.equal(report.arms.reuse_keep_alive.cost.known, false);
  assert.equal(report.arms.reuse_keep_alive.cost.totalUsd, null);
  assert.equal(report.comparison.keepAliveVsFresh.costUsd, null);
  const gate = evaluateKeepAliveGate(report, GATE);
  assert.equal(gate.decision, 'no_go');
  assert.ok(gate.reasons.includes(R.COST_UNKNOWN));
}

// ---- Different fixture versions or a missing participant cannot pass.
{
  const obs = measured();
  obs.arms.reuse.fixtureVersion = '2';
  assert.ok(evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(obs), GATE).reasons.includes(R.FIXTURE_MISMATCH));
  const noCoordinator = measured();
  noCoordinator.arms.fresh.roles.coordinator.turns = [];
  assert.ok(evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(noCoordinator), GATE).reasons.includes(R.INCOMPLETE_ROLES));
  const noArm = measured();
  delete noArm.arms.reuse;
  assert.ok(evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(noArm), GATE).reasons.includes(R.MISSING_ARM));
  assert.equal(evaluateKeepAliveGate(null).decision, 'no_go');
}

// ---- Simulation exercises the pipeline but can never open the gate.
{
  const report = buildKeepAliveBenchmarkReport(simulateKeepAliveObservations(fixture));
  assert.equal(report.source, 'simulated');
  assert.equal(report.arms.reuse_keep_alive.cost.known, false);
  const gate = evaluateKeepAliveGate(report, GATE);
  assert.equal(gate.decision, 'no_go');
  assert.ok(gate.reasons.includes(R.NOT_MEASURED));
  assert.ok(gate.reasons.includes(R.COST_UNKNOWN));
}

// ---- Stored gate is recomputed from the report; a forged decision is ignored.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-alive-gate-'));
  assert.equal(loadKeepAliveGate({ dataDir: dir }).decision, 'no_go');
  assert.deepEqual(loadKeepAliveGate({ dataDir: dir }).reasons, [R.MISSING_REPORT]);
  const simulated = buildKeepAliveBenchmarkReport(simulateKeepAliveObservations(fixture));
  fs.writeFileSync(path.join(dir, KEEP_ALIVE_BENCHMARK_FILE), JSON.stringify({ ...simulated, gate: { decision: 'go' } }));
  assert.equal(loadKeepAliveGate({ dataDir: dir }).decision, 'no_go');
  fs.writeFileSync(path.join(dir, KEEP_ALIVE_BENCHMARK_FILE), JSON.stringify(buildKeepAliveBenchmarkReport(measured())));
  const gate = loadKeepAliveGate({ dataDir: dir });
  assert.equal(gate.decision, 'go');
  // And a go gate is what makes auto available (still subject to the rest).
  const availability = evaluateKeepAliveAvailability({
    canResumeSession: true, hasSessionId: true, ttlKnown: true, tariffKnown: true, budgetUsd: 1, expectNextRoundUntil: 1, gate,
  });
  assert.equal(availability.auto.available, true);
}

// ---- F4: the fixture material exists, hashes match and every seeded bug is present.
{
  assert.equal(verification.ok, true);
  assert.equal(verification.materials.length, fixture.materialIds.length);
  assert.deepEqual(fixture.bugMarkers.map((m) => m.id).sort(), [...fixture.seededBugs].sort());
  // Tampered / missing / unmarked material is reported, never silently accepted.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-alive-material-'));
  fs.cpSync(fixtureDir, dir, { recursive: true });
  assert.equal(verifyKeepAliveFixtureMaterial(fixture, { dir }).ok, true);
  const file = path.join(dir, 'material/round-2.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("db.insert('audit', {", "db.insert('log', {"));
  const tampered = verifyKeepAliveFixtureMaterial(fixture, { dir });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.problems.some((p) => /round-2.*sha256 mismatch/.test(p)));
  assert.ok(tampered.problems.some((p) => /missing-await-on-save.*not present/.test(p)));
  fs.rmSync(path.join(dir, 'material/round-3.md'));
  assert.ok(verifyKeepAliveFixtureMaterial(fixture, { dir }).problems.some((p) => /round-3.*not found/.test(p)));
  assert.throws(() => buildKeepAliveProvenance(fixture, tampered), /unverified/);
  const escaping = verifyKeepAliveFixtureMaterial({ ...fixture, material: [{ id: 'round-1', file: '../fixture.json', sha256: 'x' }] }, { dir });
  assert.ok(escaping.problems.some((p) => /leaves the fixture directory/.test(p)));
}

// ---- F4: a self-declared `measured` without verified provenance never opens the gate.
{
  const noProvenance = measured();
  delete noProvenance.provenance;
  const missing = evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(noProvenance), GATE);
  assert.equal(missing.decision, 'no_go');
  assert.deepEqual(missing.reasons, [R.PROVENANCE_MISSING]);
  // No expected fixture to verify against: unverifiable.
  assert.deepEqual(evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(measured())).reasons, [R.PROVENANCE_MISSING]);
  // Unknown collector / bad timestamp / short hash are incomplete provenance.
  for (const patch of [
    { collector: { name: 'hand-written', version: '1' } },
    { collectedAt: 'yesterday' },
    { materials: provenance.materials.map((row) => ({ ...row, sha256: 'abc' })) },
  ]) {
    const obs = measured();
    obs.provenance = { ...provenance, ...patch };
    assert.deepEqual(evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(obs), GATE).reasons, [R.PROVENANCE_MISSING]);
  }
  // Hash / id / fixture version mismatch against the fixture.
  for (const patch of [
    { materials: provenance.materials.map((row, i) => (i === 0 ? { ...row, sha256: 'f'.repeat(64) } : row)) },
    { materials: provenance.materials.slice(1) },
    { fixture: { ...provenance.fixture, version: '1' } },
    { fixture: { ...provenance.fixture, id: 'other' } },
  ]) {
    const obs = measured();
    obs.provenance = { ...provenance, ...patch };
    const gate = evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(obs), GATE);
    assert.equal(gate.decision, 'no_go');
    assert.deepEqual(gate.reasons, [R.MATERIAL_HASH_MISMATCH]);
  }
  // A failed on-disk verification refuses even a consistent report.
  const disk = evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(measured()), { fixture, materialVerification: { ok: false } });
  assert.deepEqual(disk.reasons, [R.MATERIAL_HASH_MISMATCH]);
  // The report carries the provenance block and the declared source.
  const report = buildKeepAliveBenchmarkReport(measured());
  assert.equal(report.source, 'measured');
  assert.equal(report.provenance.collector.name, 'measure-cache-keepalive-benchmark');
  assert.equal(report.provenance.materials.length, 3);
}

// ---- F4: the runner verifies material; --simulate stays no_go; the stored gate needs provenance.
{
  const script = fileURLToPath(new URL('../scripts/measure-cache-keepalive-benchmark.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, CRETLI_TEST_DATA_DIR: 'keep-alive-benchmark-test' } });
  const verify = run('--verify-material');
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);
  const sim = run('--simulate');
  assert.equal(sim.status, 0, sim.stderr);
  const simulated = JSON.parse(sim.stdout);
  assert.equal(simulated.gate.decision, 'no_go');
  assert.equal(simulated.provenance.fixture.version, fixture.version);
  assert.equal(JSON.parse(run('--emit-template').stdout).source, 'simulated');
  // Observations bring no provenance of their own: a forged block is replaced.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-alive-runner-'));
  const obsFile = path.join(dir, 'obs.json');
  fs.writeFileSync(obsFile, JSON.stringify({ ...measured(), provenance: { forged: true } }));
  const observed = run('--observations', obsFile);
  assert.equal(observed.status, 0, observed.stderr);
  const result = JSON.parse(observed.stdout);
  assert.equal(result.provenance.forged, undefined);
  assert.equal(result.gate.decision, 'go');
  // A stored report without provenance is refused by the loader even when it says measured.
  const stored = path.join(dir, KEEP_ALIVE_BENCHMARK_FILE);
  const unproven = measured();
  delete unproven.provenance;
  fs.writeFileSync(stored, JSON.stringify(buildKeepAliveBenchmarkReport(unproven)));
  assert.deepEqual(loadKeepAliveGate({ dataDir: dir }).reasons, [R.PROVENANCE_MISSING]);
}

console.log('keep-alive-benchmark tests passed');
