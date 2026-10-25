#!/usr/bin/env node
/**
 * Keep-alive net-savings benchmark and go/no-go gate.
 *
 * Compares three arms on the SAME fixture version: fresh chats, a resumed
 * reviewer pair, and a resumed pair with keep-alive pings. It counts both
 * reviewers and the coordinator, every ping, wall time and the seeded bugs that
 * were found. An unknown tariff gives an unknown cost, never a savings promise.
 *
 * It measures resume capability on a fixture, NOT a real review loop: the pair
 * is not wired into loops (plan decision, todo 8ed03f09), so the report draws
 * no conclusion about savings in loops.
 *
 * Usage:
 *   node scripts/measure-cache-keepalive-benchmark.mjs --simulate
 *   node scripts/measure-cache-keepalive-benchmark.mjs --observations obs.json [--out file]
 *   node scripts/measure-cache-keepalive-benchmark.mjs --emit-template
 *   node scripts/measure-cache-keepalive-benchmark.mjs --verify-material
 *
 * `--verify-material` resolves the fixture material files, checks that each one
 * exists, hashes to the sha256 in fixture.json and contains its seeded bugs, then
 * exits (non-zero with the problems on mismatch). `--observations` and
 * `--simulate` run the same check first and refuse to build a report on a
 * mismatch; the report's provenance (fixture id/version, per-material sha256,
 * collector, collectedAt) is written by this script from the verified files and
 * any `provenance` inside an observations file is ignored.
 *
 * `--simulate` only exercises the pipeline; its gate is always `no_go`.
 * `--out` writes the report that the scheduler reads (default
 * data/keep-alive-benchmark.json).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKeepAliveBenchmarkReport,
  buildKeepAliveProvenance,
  evaluateKeepAliveGate,
  simulateKeepAliveObservations,
  verifyKeepAliveFixtureMaterial,
} from '../lib/usage/keep-alive-benchmark.ts';
import { resolveKeepAliveBenchmarkPath } from '../lib/usage/keep-alive-gate.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'tests/fixtures/keep-alive-benchmark');
const fixturePath = path.join(fixtureDir, 'fixture.json');

/**
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else out[key] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
if (args['emit-template']) {
  process.stdout.write(`${JSON.stringify(simulateKeepAliveObservations(fixture), null, 2)}\n`);
  process.exit(0);
}
const verification = verifyKeepAliveFixtureMaterial(fixture, { dir: fixtureDir });
if (args['verify-material']) {
  const out = { ok: verification.ok, problems: verification.problems, materials: verification.materials };
  (verification.ok ? process.stdout : process.stderr).write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(verification.ok ? 0 : 1);
}
let observations;
if (args.observations || args.simulate) {
  if (!verification.ok) {
    console.error(`Fixture material verification failed:\n- ${verification.problems.join('\n- ')}`);
    process.exit(1);
  }
}
if (args.observations) {
  observations = JSON.parse(fs.readFileSync(String(args.observations), 'utf8'));
  // The fixture is always the verified one; observations cannot bring their own provenance.
  observations.fixture = fixture;
} else if (args.simulate) {
  observations = simulateKeepAliveObservations(fixture);
} else {
  console.error('Pass --observations <file>, --simulate, --emit-template or --verify-material.');
  process.exit(2);
}
const report = buildKeepAliveBenchmarkReport({
  ...observations,
  provenance: buildKeepAliveProvenance(fixture, verification),
});
const gate = evaluateKeepAliveGate(report, { fixture, materialVerification: verification });
const result = { ...report, gate };
if (args.out) {
  const target = args.out === true ? resolveKeepAliveBenchmarkPath() : String(args.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = 0;
