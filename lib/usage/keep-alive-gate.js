/**
 * Loads the stored benchmark report and recomputes the keep-alive gate.
 *
 * The stored `decision` is never trusted: the gate is re-evaluated from the
 * report so an edited or stale decision cannot unlock the automatic mode. A
 * missing or unreadable file is `report_missing` (no-go).
 */

import fs from 'node:fs';
import { resolveDataPath } from '../runtime-paths.js';
import { evaluateKeepAliveGate, KEEP_ALIVE_GATE_REASON } from './keep-alive-benchmark.js';

export const KEEP_ALIVE_BENCHMARK_FILE = 'keep-alive-benchmark.json';

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {string}
 */
export function resolveKeepAliveBenchmarkPath(options = {}) {
  const dir = String(options.dataDir || '').trim();
  return dir ? `${dir.replace(/\/+$/, '')}/${KEEP_ALIVE_BENCHMARK_FILE}` : resolveDataPath(KEEP_ALIVE_BENCHMARK_FILE);
}

/**
 * @param {{ dataDir?: string }} [options]
 * @returns {{ decision: string, reasons: string[], source: string }}
 */
export function loadKeepAliveGate(options = {}) {
  const file = resolveKeepAliveBenchmarkPath(options);
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const gate = evaluateKeepAliveGate(report);
    return { ...gate, source: 'file' };
  } catch {
    return { decision: 'no_go', reasons: [KEEP_ALIVE_GATE_REASON.MISSING_REPORT], source: 'missing' };
  }
}
