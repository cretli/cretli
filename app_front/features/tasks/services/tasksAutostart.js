/** Per-browser autostart list for tasks, with the watcher autostart lock (e2b7ae58). */
import { readStorageValueWithAlias, writeStorageValueWithAlias } from '../../../lib/storageKeyAlias.js';

const TASK_AUTOSTART_STORAGE_KEY = 'cretli-autostart-tasks';
/**
 * Mirrors BUILD_TASK_LABEL (lib/dev-build.js). This watcher rewrites the served
 * public/dist bundle with a development build, so it must never autostart.
 */
const FRONT_BUILD_WATCH_TASK_LABEL = 'Cretli: build front (watch)';

export function isAutoStartExcludedTask(taskLabel) {
  return taskLabel === FRONT_BUILD_WATCH_TASK_LABEL;
}

export function readTaskAutostartSet() {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = readStorageValueWithAlias(localStorage, TASK_AUTOSTART_STORAGE_KEY, '');
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const valid = parsed.filter((x) => typeof x === 'string' && x.trim());
    const kept = valid.filter((x) => !isAutoStartExcludedTask(x));
    const result = new Set(kept);
    // Drop a stale stored entry for an excluded task so it is never honoured.
    if (kept.length !== valid.length) writeTaskAutostartSet(result);
    return result;
  } catch (_) {
    return new Set();
  }
}

function writeTaskAutostartSet(set) {
  if (typeof localStorage === 'undefined') return;
  try {
    writeStorageValueWithAlias(localStorage, TASK_AUTOSTART_STORAGE_KEY, JSON.stringify(Array.from(set)));
  } catch (_) {}
}

export function isTaskAutoStart(taskLabel) {
  if (!taskLabel || typeof taskLabel !== 'string') return false;
  if (isAutoStartExcludedTask(taskLabel)) return false;
  return readTaskAutostartSet().has(taskLabel);
}

export function toggleTaskAutoStart(taskLabel) {
  if (!taskLabel || typeof taskLabel !== 'string') return false;
  if (isAutoStartExcludedTask(taskLabel)) return false;
  const set = readTaskAutostartSet();
  if (set.has(taskLabel)) {
    set.delete(taskLabel);
    writeTaskAutostartSet(set);
    return false;
  }
  set.add(taskLabel);
  writeTaskAutostartSet(set);
  return true;
}
