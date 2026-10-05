/**
 * Debounced autopilot nudge for workspace activity (todo/delegation changes).
 * There is no global event bus; callers invoke `scheduleWorkspaceWatcherAutopilot`.
 */

import { normalizeWorkspaceFolder } from './persist/workspace-watchers-persist.js';

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
 * @param {{ workspaceFolder?: string, dataDir?: string, debounceMs?: number }} input
 */
export function scheduleWorkspaceWatcherAutopilot(input = {}) {
  const workspaceFolder = normalizeWorkspaceFolder(input.workspaceFolder);
  if (!workspaceFolder || typeof autopilotRunner !== 'function') return;
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
    void Promise.resolve().then(() => runner({ workspaceFolder, dataDir })).catch(() => {});
  }, debounceMs);
  if (typeof timer.unref === 'function') timer.unref();
  debounceTimers.set(key, timer);
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
