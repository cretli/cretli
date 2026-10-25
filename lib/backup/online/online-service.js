/**
 * Process-wide wiring for online backups (B6): the participant registry, the shared maintenance
 * coordinator and the scheduler. Writers register themselves with `registerOnlineParticipant` once they
 * honor the coordinator's gates and their snapshot capability is certified. Until every registry store is
 * covered, online mode reports `enabled: false` with the uncovered ids and refuses to run (B4 offline
 * backups are unaffected).
 */
import { resolveDataPath } from '../../runtime-paths.js';
import { createMaintenanceCoordinator } from '../../storage/maintenance-coordinator.js';
import { resolveControlDir } from '../offline/control-dir.js';
import { createBackupScheduler } from './backup-scheduler.js';
import { createOnlineBackup } from './online-backup.js';

/** Operator-provided key for encrypted scheduled/online backups; never written to disk by Cretli. */
export const ONLINE_BACKUP_KEY_ENV = 'CRETLI_ONLINE_BACKUP_KEY';

/** @type {import('../../storage/maintenance-coordinator.js').MaintenanceParticipant[]} */
const participants = [];

/** @param {import('../../storage/maintenance-coordinator.js').MaintenanceParticipant} participant */
export function registerOnlineParticipant(participant) {
  const at = participants.findIndex((p) => p.id === participant.id);
  if (at >= 0) participants[at] = participant; else participants.push(participant);
}

/** Test helper. */
export function resetOnlineParticipants() {
  participants.length = 0;
}

/**
 * @param {{ dataDir?: string, controlDir?: string, registry?: Record<string, any>, budgets?: Record<string, any>, env?: NodeJS.ProcessEnv,
 *   participants?: () => any[] }} [options]
 */
export function createOnlineBackupService(options = {}) {
  const dataDir = options.dataDir || resolveDataPath();
  const controlDir = options.controlDir || resolveControlDir(dataDir);
  const env = options.env || process.env;
  const coordinator = createMaintenanceCoordinator({
    controlDir, registry: options.registry, budgets: options.budgets, participants: options.participants || (() => participants),
  });
  const scheduler = createBackupScheduler({
    controlDir,
    dataDir,
    capability: () => coordinator.capability(),
    passwordProvider: () => env[ONLINE_BACKUP_KEY_ENV] || undefined,
    runBackup: ({ destRoot, password }) => createOnlineBackup({ dataDir, controlDir, destRoot, coordinator, registry: options.registry, password }),
  });
  return Object.freeze({ coordinator, scheduler, controlDir, dataDir });
}

/** @type {ReturnType<typeof createOnlineBackupService> | null} */
let singleton = null;

export function getOnlineBackupService() {
  if (!singleton) singleton = createOnlineBackupService();
  return singleton;
}
