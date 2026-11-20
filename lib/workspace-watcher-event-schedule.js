/**
 * Debounced autopilot nudge for workspace activity (todo/delegation changes).
 * There is no global event bus; callers invoke `scheduleWorkspaceWatcherAutopilot`.
 */

import { normalizeWorkspaceFolder } from './persist/workspace-watchers-persist.js';
import { isBootReconciliationComplete } from './delegation-lifecycle.js';

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const debounceTimers = new Map();

const DEFAULT_DEBOUNCE_MS = 1500;
const MAX_DEBOUNCE_MS = 60_000;

/** @type {((input: { workspaceFolder: string, dataDir?: string }) => Promise<void>) | null} */
let autopilotRunner = null;

/**
 * @param {(input: { workspaceFolder: string, dataDir?: string }) => Promise<void>} runner
 */
export function registerWorkspaceWatcherAutopilotRunner(runner) {
  autopilotRunner = typeof runner === 'function' ? runner : null;
}

/**
 * @param {string} dataDir
 * @param {string} workspaceFolder
 * @returns {string}
 */
export function workspaceWatcherAutopilotDebounceKey(dataDir, workspaceFolder) {
  const folder = normalizeWorkspaceFolder(workspaceFolder);
  const dir = String(dataDir ?? '').trim();
  return `${dir}::${folder}`;
}

/**
 * @returns {number}
 */
export function workspaceWatcherAutopilotPendingDebounceCount() {
  return debounceTimers.size;
}

/**
 * Schedule (debounced) one autopilot pass. The nudge is refused until boot
 * reconciliation finished, so a todo/delegation/presence event that fires while
 * the server is still reconciling can never run a cycle ahead of the boot
 * sequence. The periodic worker tick covers the same workspaces once ready, so
 * a dropped pre-ready nudge is not lost.
 *
 * @param {{ workspaceFolder?: string, dataDir?: string, debounceMs?: number }} input
 * @returns {{ scheduled: boolean, reason: string }}
 */
export function scheduleWorkspaceWatcherAutopilot(input = {}) {
  const workspaceFolder = normalizeWorkspaceFolder(input.workspaceFolder);
  if (!workspaceFolder || typeof autopilotRunner !== 'function') {
    return { scheduled: false, reason: 'not_schedulable' };
  }
  if (!isBootReconciliationComplete()) {
    return { scheduled: false, reason: 'boot_not_ready' };
  }
  const dataDir = String(input.dataDir ?? '').trim();
  const debounceMs = Number.isFinite(input.debounceMs) && input.debounceMs >= 0
    ? Math.min(Number(input.debounceMs), MAX_DEBOUNCE_MS)
    : DEFAULT_DEBOUNCE_MS;
  const key = workspaceWatcherAutopilotDebounceKey(dataDir, workspaceFolder);
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    const runner = autopilotRunner;
    if (typeof runner !== 'function') return;
    // Re-check at fire time: boot may still be reconciling if the nudge was
    // armed from a race, and reconciliation-dependent work must not run ahead.
    if (!isBootReconciliationComplete()) return;
    void Promise.resolve().then(() => runner({ workspaceFolder, dataDir })).catch(() => {});
  }, debounceMs);
  if (typeof timer.unref === 'function') timer.unref();
  debounceTimers.set(key, timer);
  return { scheduled: true, reason: 'scheduled' };
}

/**
 * Tests only.
 * @returns {void}
 */
export function stopWorkspaceWatcherAutopilotSchedule() {
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
  autopilotRunner = null;
}

export const __resetWorkspaceWatcherAutopilotScheduleForTest = stopWorkspaceWatcherAutopilotSchedule;
