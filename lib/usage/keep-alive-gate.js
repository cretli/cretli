/**
 * Loads the stored benchmark report and recomputes the keep-alive gate.
 *
 * The stored `decision` is never trusted: the gate is re-evaluated from the
 * report so an edited or stale decision cannot unlock the automatic mode. A
 * missing or unreadable file is `report_missing` (no-go).
 */

import fs from 'node:fs';
import { resolveDataPath, resolveProjectPath } from '../runtime-paths.js';
import { evaluateKeepAliveGate, KEEP_ALIVE_GATE_REASON, verifyKeepAliveFixtureMaterial } from './keep-alive-benchmark.js';

export const KEEP_ALIVE_BENCHMARK_FILE = 'keep-alive-benchmark.json';

/** Fixture directory the report provenance is verified against. */
export const KEEP_ALIVE_FIXTURE_DIR = 'tests/fixtures/keep-alive-benchmark';

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function resolveKeepAliveBenchmarkPath(options = {}) {
  const dir = String(options.dataDir || '').trim();
  return dir ? `${dir.replace(/\/+$/, '')}/${KEEP_ALIVE_BENCHMARK_FILE}` : resolveDataPath(KEEP_ALIVE_BENCHMARK_FILE);
}

/**
 * @param {{ dataDir?: string, fixtureDir?: string }} [options]
 * @returns {{ decision: string, reasons: string[], source: string }}
 */
export function loadKeepAliveGate(options = {}) {
  const file = resolveKeepAliveBenchmarkPath(options);
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fixtureDir = String(options.fixtureDir || '') || resolveProjectPath(KEEP_ALIVE_FIXTURE_DIR);
    let fixture = null;
    let materialVerification = null;
    try {
      fixture = JSON.parse(fs.readFileSync(`${fixtureDir.replace(/\/+$/, '')}/fixture.json`, 'utf8'));
      materialVerification = verifyKeepAliveFixtureMaterial(fixture, { dir: fixtureDir });
    } catch {
      // No readable fixture: the provenance is unverifiable, so the gate stays closed.
    }
    const gate = evaluateKeepAliveGate(report, { fixture, materialVerification });
    return { ...gate, source: 'file' };
  } catch {
    return { decision: 'no_go', reasons: [KEEP_ALIVE_GATE_REASON.MISSING_REPORT], source: 'missing' };
  }
}
