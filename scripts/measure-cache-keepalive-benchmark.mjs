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
  evaluateKeepAliveGate,
  simulateKeepAliveObservations,
} from '../lib/usage/keep-alive-benchmark.js';
import { resolveKeepAliveBenchmarkPath } from '../lib/usage/keep-alive-gate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(root, 'tests/fixtures/keep-alive-benchmark/fixture.json');

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
let observations;
if (args.observations) {
  observations = JSON.parse(fs.readFileSync(String(args.observations), 'utf8'));
  observations.fixture = observations.fixture || fixture;
} else if (args.simulate) {
  observations = simulateKeepAliveObservations(fixture);
} else {
  console.error('Pass --observations <file>, --simulate or --emit-template.');
  process.exit(2);
}
const report = buildKeepAliveBenchmarkReport(observations);
const gate = evaluateKeepAliveGate(report);
const result = { ...report, gate };
if (args.out) {
  const target = args.out === true ? resolveKeepAliveBenchmarkPath() : String(args.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = 0;
