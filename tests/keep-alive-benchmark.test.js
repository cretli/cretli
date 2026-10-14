/**
 * Keep-alive benchmark report, go/no-go gate and the stored-gate loader.
 */
process.env.CRETLI_TEST_DATA_DIR ||= 'keep-alive-benchmark-test';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KEEP_ALIVE_BENCHMARK_ROLES as ROLES,
  KEEP_ALIVE_GATE_REASON as R,
  buildKeepAliveBenchmarkReport,
  evaluateKeepAliveGate,
  simulateKeepAliveObservations,
} from '../lib/usage/keep-alive-benchmark.js';
import { KEEP_ALIVE_BENCHMARK_FILE, loadKeepAliveGate } from '../lib/usage/keep-alive-gate.js';
import { evaluateKeepAliveAvailability } from '../lib/usage/keep-alive-policy.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/keep-alive-benchmark/fixture.json', import.meta.url), 'utf8'));

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
  const gate = evaluateKeepAliveGate(report);
  assert.equal(gate.decision, 'go');
  assert.deepEqual(gate.reasons, []);
}

// ---- A negative result is valid and is a no-go, with the reason.
{
  const worse = evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(measured({ turnsKeep: 0.59, pingCost: 0.1 })));
  assert.equal(worse.decision, 'no_go');
  assert.ok(worse.reasons.includes(R.NO_GAIN_OVER_REUSE));
  const ineffective = evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(measured({ effective: false })));
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
  const gate = evaluateKeepAliveGate(report);
  assert.equal(gate.decision, 'no_go');
  assert.ok(gate.reasons.includes(R.COST_UNKNOWN));
}

// ---- Different fixture versions or a missing participant cannot pass.
{
  const obs = measured();
  obs.arms.reuse.fixtureVersion = '2';
  assert.ok(evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(obs)).reasons.includes(R.FIXTURE_MISMATCH));
  const noCoordinator = measured();
  noCoordinator.arms.fresh.roles.coordinator.turns = [];
  assert.ok(evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(noCoordinator)).reasons.includes(R.INCOMPLETE_ROLES));
  const noArm = measured();
  delete noArm.arms.reuse;
  assert.ok(evaluateKeepAliveGate(buildKeepAliveBenchmarkReport(noArm)).reasons.includes(R.MISSING_ARM));
  assert.equal(evaluateKeepAliveGate(null).decision, 'no_go');
}

// ---- Simulation exercises the pipeline but can never open the gate.
{
  const report = buildKeepAliveBenchmarkReport(simulateKeepAliveObservations(fixture));
  assert.equal(report.source, 'simulated');
  assert.equal(report.arms.reuse_keep_alive.cost.known, false);
  const gate = evaluateKeepAliveGate(report);
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

console.log('keep-alive-benchmark tests passed');
