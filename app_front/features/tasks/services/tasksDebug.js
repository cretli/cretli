/** Opt-in debug/perf logging for the Tasks panel (URL flag, window flag or localStorage). */
import { readStorageValueWithAlias } from '../../../lib/storageKeyAlias.js';

const TASK_DEBUG_STORAGE_KEY = 'cretli-debug-tasks';
const TASK_PERF_STORAGE_KEY = 'cretli-debug-tasks-perf';
export const TASK_DEBUG_REPORT_INTERVAL_MS = 1000;
const TASK_DEBUG_EVENT_LOOP_TICK_MS = 500;
const TASK_DEBUG_EVENT_LOOP_LAG_WARN_MS = 180;
let tasksDebugLoopMonitorStarted = false;
/** @type {ReturnType<typeof setInterval> | null} */
let tasksDebugLoopTimerId = null;

export function isTasksDebugEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.CRETLI_DEBUG_TASKS === true) return true;
  if (window.CURSOR_REMOTE_DEBUG_TASKS === true) return true;
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search || '');
    if (params.get('tasksDebug') === '1') return true;
  }
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, TASK_DEBUG_STORAGE_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

export function tasksDebugLog(message, details) {
  if (!isTasksDebugEnabled()) return;
  if (typeof details === 'undefined') {
    console.log('[tasks-debug]', message);
    return;
  }
  console.log('[tasks-debug]', message, details);
}

export function isTasksPerfEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.CRETLI_DEBUG_TASKS_PERF === true) return true;
  if (window.CURSOR_REMOTE_DEBUG_TASKS_PERF === true) return true;
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search || '');
    if (params.get('tasksPerf') === '1') return true;
  }
  if (typeof localStorage === 'undefined') return false;
  try {
    return readStorageValueWithAlias(localStorage, TASK_PERF_STORAGE_KEY, '') === '1';
  } catch (_) {
    return false;
  }
}

export function tasksPerfLog(message, details) {
  if (!isTasksPerfEnabled()) return;
  if (typeof details === 'undefined') {
    console.log('[tasks-perf]', message);
    return;
  }
  console.log('[tasks-perf]', message, details);
}

export function ensureTasksDebugLoopMonitor() {
  if (!isTasksDebugEnabled()) return;
  if (tasksDebugLoopMonitorStarted) return;
  tasksDebugLoopMonitorStarted = true;
  let expected = Date.now() + TASK_DEBUG_EVENT_LOOP_TICK_MS;
  tasksDebugLoopTimerId = setInterval(() => {
    const now = Date.now();
    const lagMs = now - expected;
    if (lagMs > TASK_DEBUG_EVENT_LOOP_LAG_WARN_MS) {
      tasksDebugLog('Main thread lag detected', { lagMs });
    }
    expected = now + TASK_DEBUG_EVENT_LOOP_TICK_MS;
  }, TASK_DEBUG_EVENT_LOOP_TICK_MS);
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (!tasksDebugLoopTimerId) return;
      clearInterval(tasksDebugLoopTimerId);
      tasksDebugLoopTimerId = null;
      tasksDebugLoopMonitorStarted = false;
    }, { once: true });
  }
  tasksDebugLog('Event loop monitor started', {
    tickMs: TASK_DEBUG_EVENT_LOOP_TICK_MS,
    warnLagMs: TASK_DEBUG_EVENT_LOOP_LAG_WARN_MS,
  });
}
