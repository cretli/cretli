#!/usr/bin/env node
/**
 * Cretli memory / orphan monitor CLI.
 *
 * Runs once (a machine-level systemd timer or cron entry is expected to call it
 * about every minute). It is intentionally read-only: it never signals or kills
 * a process. It prints the observed state, appends alarms to
 * `data/memory-monitor-alerts-YYYY-MM-DD.jsonl`, and exits non-zero when a
 * threshold is exceeded so cron/timer mail or a wrapper can react.
 *
 * Usage:
 *   node scripts/memory-orphan-monitor.js [--json] [--dry-run] [--data-dir DIR] [--registry PATH]
 *
 * `--registry PATH` points the orphan check at an explicit OpenCode port
 * registry file (default `resolveDataPath('opencode-ports.json')`), so the
 * monitor can run against a copied fixture.
 *
 * See `systemd/cretli-memory-monitor.service.example` and
 * `systemd/cretli-memory-monitor.timer.example`.
 */

import { resolveDataPath } from '../lib/runtime-paths.js';
import {
  formatMemoryMonitorReport,
  runMemoryMonitorOnce,
} from '../lib/memory-monitor.js';

/**
 * @param {string[]} argv
 * @returns {{ json: boolean, dryRun: boolean, dataDir: string, registryPath: string, help: boolean }}
 */
function parseArgs(argv) {
  const options = { json: false, dryRun: false, dataDir: '', registryPath: '', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--dry-run' || arg === '--no-write') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--data-dir') {
      index += 1;
      options.dataDir = argv[index] || '';
    } else if (arg.startsWith('--registry=')) options.registryPath = arg.slice('--registry='.length);
    else if (arg === '--registry' || arg === '--opencode-registry') {
      index += 1;
      options.registryPath = argv[index] || '';
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(
    'Usage: node scripts/memory-orphan-monitor.js [--json] [--dry-run] [--data-dir DIR] [--registry PATH]\n'
    + '\n'
    + 'Read-only memory and orphan safety net. Exits 1 when a threshold is exceeded.\n',
  );
  process.exit(0);
}

let result;
try {
  result = runMemoryMonitorOnce({
    dataDir: options.dataDir || resolveDataPath(),
    registryPath: options.registryPath || undefined,
    write: !options.dryRun,
  });
} catch (error) {
  process.stderr.write(`memory-orphan-monitor: ${error?.stack || error?.message || error}\n`);
  process.exit(2);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({
    at: result.at,
    exitCode: result.exitCode,
    thresholdExceeded: result.evaluation.thresholdExceeded,
    triggered: result.evaluation.triggered,
    warnings: result.warnings,
    written: result.written,
    alertFilePath: result.alertFilePath,
    statePath: result.statePath,
    evaluation: result.evaluation,
    alerts: result.alerts,
  }, null, 2)}\n`);
} else {
  process.stdout.write(formatMemoryMonitorReport(result));
}

process.exit(result.exitCode);
