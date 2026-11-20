/**
 * Retention for scheduled online backups.
 *
 * Runs only right after a NEW backup was created and verified (the caller passes its id). It can only
 * ever delete archives that this scheduler created itself (`origin: 'scheduled'`, recorded in the state
 * file) and that sit inside the target directory. Never deleted:
 *   - the last good (newest verified) backup, whatever `keep` says,
 *   - manual backups and anything flagged `protected` (pre-restore copies live under the control
 *     directory and are not even candidates),
 *   - anything when the newest backup is not recorded as verified (failed run, bad key, full disk).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} ArchiveRecord
 * @property {string} id
 * @property {string} name basename inside the target directory
 * @property {'scheduled' | 'manual'} origin
 * @property {string} verifiedAt ISO time of successful verification; empty when never verified
 * @property {boolean} [protected]
 */

/**
 * @param {{ targetDir: string, archives: ArchiveRecord[], keep: number, newId: string, now?: () => Date }} args
 * @returns {{ deleted: string[], kept: string[], archives: ArchiveRecord[], skipped?: string }}
 */
export function applyRetention(args) {
  const { targetDir, keep } = args;
  const all = Array.isArray(args.archives) ? args.archives : [];
  const fresh = all.find((a) => a.id === args.newId);
  if (!fresh || !fresh.verifiedAt) {
    return { deleted: [], kept: all.map((a) => a.id), archives: all, skipped: 'new backup is not verified' };
  }
  if (!Number.isInteger(keep) || keep < 1) {
    return { deleted: [], kept: all.map((a) => a.id), archives: all, skipped: 'invalid keep count' };
  }
  const root = path.resolve(targetDir);
  const scheduledGood = all
    .filter((a) => a.origin === 'scheduled' && a.verifiedAt)
    .sort((a, b) => (a.verifiedAt < b.verifiedAt ? 1 : a.verifiedAt > b.verifiedAt ? -1 : 0));
  const keepIds = new Set(scheduledGood.slice(0, keep).map((a) => a.id));
  keepIds.add(fresh.id);
  const deleted = [];
  const remaining = [];
  for (const rec of all) {
    const candidate = rec.origin === 'scheduled' && rec.protected !== true && !keepIds.has(rec.id);
    if (!candidate) { remaining.push(rec); continue; }
    const full = path.resolve(root, rec.name);
    // Never follow a recorded name out of the target directory.
    if (path.dirname(full) !== root || rec.name === '' || rec.name.includes(path.sep) || rec.name.startsWith('.')) {
      remaining.push(rec);
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      deleted.push(rec.id);
    } catch {
      remaining.push(rec);
    }
  }
  return { deleted, kept: remaining.map((a) => a.id), archives: remaining };
}
