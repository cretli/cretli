/**
 * Durable server-wide start gate for Workspace Watcher cycles and Scout scans.
 * The gate is intentionally separate from per-workspace policy so it survives
 * server restarts and applies uniformly to every workspace and harness.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from './runtime-paths.js';
import { writeJsonAtomic } from './persist/atomic-write.js';
import {
  getWorkspaceWatcherActiveCycles,
  loadWorkspaceWatchers,
} from './persist/workspace-watchers-persist.js';

function controlFile(dataDir) {
  return path.join(String(dataDir || '').trim() || resolveDataPath(), 'workspace-watcher-runtime.json');
}

/**
 * @param {{ dataDir?: string }} [input]
 * @returns {{ startsEnabled: boolean, updatedAt: string, controlError: boolean }}
 */
export function getWorkspaceWatcherRuntimeControl(input = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(controlFile(input.dataDir), 'utf8'));
    return {
      startsEnabled: parsed?.startsEnabled !== false,
      updatedAt: String(parsed?.updatedAt || ''),
      controlError: false,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { startsEnabled: true, updatedAt: '', controlError: false };
    }
    // Fail closed if a stored maintenance setting is damaged.
    return { startsEnabled: false, updatedAt: '', controlError: true };
  }
}

/** @param {{ dataDir?: string, startsEnabled: boolean }} input */
export function setWorkspaceWatcherStartsEnabled(input = {}) {
  if (typeof input.startsEnabled !== 'boolean') {
    const error = new Error('startsEnabled must be a boolean');
    error.code = 'VALIDATION';
    throw error;
  }
  const row = {
    startsEnabled: input.startsEnabled,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(controlFile(input.dataDir), row, 'utf8');
  return row;
}

/**
 * Current drain state. `readyForRestart` is true only when the gate is off,
 * watcher cycles and unexpired scout scans are all gone, and the watcher store
 * was readable.
 *
 * @param {{ dataDir?: string, now?: number }} [input]
 */
export function getWorkspaceWatcherRuntimeStatus(input = {}) {
  const control = getWorkspaceWatcherRuntimeControl(input);
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  let activeWatcherCycles = 0;
  let activeScoutScans = 0;
  let statusUnavailable = control.controlError;
  try {
    const rows = loadWorkspaceWatchers({ dataDir: input.dataDir });
    for (const row of rows) {
      activeWatcherCycles += getWorkspaceWatcherActiveCycles(row).length;
      const scan = row.activeScoutScan;
      if (scan?.scanId && Date.parse(String(scan.expiresAt || '')) > now) activeScoutScans += 1;
    }
  } catch {
    statusUnavailable = true;
  }
  const activeProcesses = activeWatcherCycles + activeScoutScans;
  return {
    ...control,
    activeWatcherCycles,
    activeScoutScans,
    activeProcesses,
    draining: !control.startsEnabled && activeProcesses > 0,
    readyForRestart: !control.startsEnabled && activeProcesses === 0 && !statusUnavailable,
    statusUnavailable,
  };
}

/** Synchronous, uncached launch check. A damaged control file blocks starts. */
export function areWorkspaceWatcherStartsEnabled(input = {}) {
  const control = getWorkspaceWatcherRuntimeControl(input);
  return !control.controlError && control.startsEnabled;
}
