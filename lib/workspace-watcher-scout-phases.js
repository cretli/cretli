// In-memory per-phase timing aggregates for the Scout pass
// (runWorkspaceWatcherScoutPass). Kept in its own tiny module so diagnostics can
// read it without importing the whole Scout implementation.

const MAX_KEYS = 64;
const WORKSPACE_ID_LENGTH = 8;

/** @type {Map<string, { phase: string, workspace: string, count: number, totalMs: number, maxMs: number }>} */
const stats = new Map();
let passes = 0;

/** Short, path-free id for a workspace folder (djb2 hash, hex). */
export function shortWorkspaceId(workspaceFolder) {
  const text = String(workspaceFolder || '');
  if (!text) return '';
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(WORKSPACE_ID_LENGTH, '0');
}

/** Records one phase duration (ms). Bounded: new keys beyond MAX_KEYS are dropped. */
export function recordScoutPassPhase(phase, workspaceFolder, ms) {
  const workspace = shortWorkspaceId(workspaceFolder);
  const key = `${phase}|${workspace}`;
  let entry = stats.get(key);
  if (!entry) {
    if (stats.size >= MAX_KEYS) return;
    entry = { phase, workspace, count: 0, totalMs: 0, maxMs: 0 };
    stats.set(key, entry);
  }
  entry.count += 1;
  entry.totalMs += ms;
  if (ms > entry.maxMs) entry.maxMs = ms;
}

/** Marks one completed pass (for averaging in the report). */
export function countScoutPass() {
  passes += 1;
}

/** Runs `fn`, recording its wall time under `phase`; errors still record and rethrow. */
export function timeScoutPhase(phase, workspaceFolder, fn) {
  const start = process.hrtime.bigint();
  const finish = () => recordScoutPassPhase(phase, workspaceFolder, Number(process.hrtime.bigint() - start) / 1e6);
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then((value) => { finish(); return value; }, (error) => { finish(); throw error; });
    }
    finish();
    return out;
  } catch (error) {
    finish();
    throw error;
  }
}

/** @returns {{ passes: number, rows: { phase: string, workspace: string, count: number, totalMs: number, maxMs: number }[] }} */
export function getScoutPassPhaseStats() {
  return { passes, rows: [...stats.values()].map((row) => ({ ...row })) };
}

export function resetScoutPassPhaseStats() {
  stats.clear();
  passes = 0;
}
