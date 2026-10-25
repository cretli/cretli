/**
 * Startup hook: finish an interrupted offline restore (roll-forward) BEFORE any store is opened or
 * any automatic work starts. No-op (and no filesystem writes) when no restore is in progress.
 */
import { resolveDataPath } from '../../runtime-paths.js';
import { isRestorePaused, resolveControlDir } from './control-dir.js';
import { recoverPendingRestore } from './offline-restore.js';

/**
 * @param {{ dataDir?: string, controlDir?: string }} [options]
 * @returns {{ action: string, id?: string, paused: boolean }}
 */
export function runOfflineRestoreStartupRecovery(options = {}) {
  const dataDir = options.dataDir || resolveDataPath();
  const controlDir = resolveControlDir(dataDir, options.controlDir);
  const result = recoverPendingRestore({ dataDir, controlDir });
  return { ...result, paused: isRestorePaused(controlDir) };
}
