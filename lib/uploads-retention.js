/**
 * Uploads retention: deletes files that Cretli stored under data/uploads/
 * (chat screenshots and videos) once they are older than N days.
 *
 * Only names produced by the upload routes (UUID + known extension) are ever
 * touched, so anything else a user or backup restore put in the folder is left
 * alone. Configured in Settings → Chat and agents → Files (`uploads` setting).
 */
import path from 'path';
import { readdirSync, statSync, unlinkSync, existsSync } from 'fs';
import { resolveDataPath } from './runtime-paths.js';
import { getUploadsSettings } from './persist/settings.js';

export const UPLOADS_RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
export const UPLOADS_RETENTION_DEFAULT_DAYS = 30;
/** Hourly: retention is measured in days. */
export const UPLOADS_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

const UPLOAD_NAME_RE = /^[a-f0-9-]{36}\.(?:jpg|mp4|mov|webm|mkv|m4v|3gp)$/i;

/** @returns {number} retention in days from settings; 0 when the sweep is switched off. */
export function getUploadsRetentionDays() {
  const cfg = getUploadsSettings();
  return cfg.retentionEnabled ? cfg.retentionDays : 0;
}

/**
 * @param {string} [uploadsDir]
 * @returns {{ files: number, videos: number, bytes: number, oldestMs: number | null }}
 */
export function getUploadsStats(uploadsDir = resolveDataPath('uploads')) {
  const stats = { files: 0, videos: 0, bytes: 0, oldestMs: null };
  if (!existsSync(uploadsDir)) return stats;
  for (const name of readdirSync(uploadsDir)) {
    if (!UPLOAD_NAME_RE.test(name)) continue;
    try {
      const st = statSync(path.join(uploadsDir, name));
      if (!st.isFile()) continue;
      stats.files += 1;
      if (!name.toLowerCase().endsWith('.jpg')) stats.videos += 1;
      stats.bytes += st.size;
      if (stats.oldestMs === null || st.mtimeMs < stats.oldestMs) stats.oldestMs = st.mtimeMs;
    } catch {
      // Removed while scanning.
    }
  }
  return stats;
}

/**
 * @param {{ uploadsDir?: string, days?: number, now?: number }} [options]
 * @returns {{ deleted: number, freedBytes: number, scanned: number }}
 */
export function sweepUploads(options = {}) {
  const uploadsDir = options.uploadsDir || resolveDataPath('uploads');
  const days = options.days ?? getUploadsRetentionDays();
  const result = { deleted: 0, freedBytes: 0, scanned: 0 };
  if (!(days > 0) || !existsSync(uploadsDir)) return result;
  const cutoff = (options.now ?? Date.now()) - days * UPLOADS_RETENTION_DAY_MS;
  for (const name of readdirSync(uploadsDir)) {
    if (!UPLOAD_NAME_RE.test(name)) continue;
    result.scanned += 1;
    const filePath = path.join(uploadsDir, name);
    try {
      const st = statSync(filePath);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      unlinkSync(filePath);
      result.deleted += 1;
      result.freedBytes += st.size;
    } catch {
      // Raced with another delete or a permission problem; retry next sweep.
    }
  }
  return result;
}

export const uploadsRetentionJob = Object.freeze({
  id: 'uploads_retention',
  label: 'Uploads retention',
  settingKey: 'uploadsRetention',
  intervalMs: UPLOADS_RETENTION_INTERVAL_MS,
  runOnStart: true,
  jitterMs: 30_000,
  isEnabled: () => getUploadsRetentionDays() > 0,
  run: async () => {
    const result = sweepUploads();
    if (result.deleted) console.log(`[uploads-retention] removed ${result.deleted} file(s), ${result.freedBytes} bytes`);
    return result;
  },
});
