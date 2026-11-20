import fs from 'node:fs';
import { resolveDataPath } from '../runtime-paths.js';
import { isSupervised } from '../server-restart-policy.js';

// Only supervisor-generated reason codes cross the API boundary, never log text.
const reason = (value) => typeof value === 'string' && /^(health_probe_failed|child_exit:(null|[0-9]+|SIG[A-Z0-9]+|spawn_error))$/.test(value) ? value : null;
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export function readSupervisorStatus({ statePath = resolveDataPath('supervisor-state.json'), env = process.env, ppid = process.ppid } = {}) {
  let row;
  try {
    if (fs.statSync(statePath).size > 65536) throw new Error('State too large');
    row = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!row || typeof row !== 'object' || Array.isArray(row)) row = null;
  } catch { row = null; }
  const active = isSupervised(env, ppid);
  return {
    active, hasData: !!row, stale: !!row && (!active || row.pid !== ppid || row.childPid !== process.pid),
    pid: active ? ppid : null,
    childPid: active ? process.pid : null,
    startedAt: timestamp(row?.startedAt),
    enabled: active && row?.enabled !== false,
    controlVersion: active && row?.pid === ppid && row?.controlVersion === 1 ? 1 : 0,
    state: ['running', 'backoff', 'crash_loop', 'stopping', 'stopped', 'starting'].includes(row?.state) ? row.state : null,
    lastCrash: timestamp(row?.lastCrash?.at) ? { at: timestamp(row.lastCrash.at), reason: reason(row.lastCrash.reason) } : null,
    crashLoopAt: timestamp(row?.crashLoopAt), crashLoopReason: reason(row?.crashLoopReason),
    busy: row?.busy === 'boot' || row?.busy === 'blocked' ? row.busy : null,
    // Safe mode is the visible alert: boot sweeps are skipped and the Watcher stays paused.
    safeMode: row?.safeMode === true, safeModeAt: timestamp(row?.safeModeAt),
    safeModeReason: /^health_kill_loop:[0-9]+$/.test(row?.safeModeReason) ? row.safeModeReason : null,
  };
}
