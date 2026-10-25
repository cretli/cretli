import { statSync } from 'fs';
import path from 'path';

export const FRONT_ASSET_FILE_NAMES = [
  'index.css',
  'login.css',
  'vendor.bundle.js',
  'vendor-login.bundle.js',
  'index.bundle.js',
  'login.bundle.js',
  'embed-widget.bundle.js',
];

/**
 * Cache-busting token for HTML script/link tags: newest mtime among the
 * built SPA assets, floored at process start so a restart always bumps it.
 *
 * @param {{ projectRoot: string, serverStartedAt: number }} params
 * @returns {string}
 */
export function resolveFrontAssetVersion({ projectRoot, serverStartedAt }) {
  const startedAt = Number(serverStartedAt);
  let newestMtimeMs = Number.isFinite(startedAt) ? Math.trunc(startedAt) : 0;
  const distDir = path.join(projectRoot, 'public', 'dist', 'app');
  for (const fileName of FRONT_ASSET_FILE_NAMES) {
    try {
      const fileStat = statSync(path.join(distDir, fileName));
      if (!Number.isFinite(fileStat.mtimeMs)) continue;
      newestMtimeMs = Math.max(newestMtimeMs, Math.trunc(fileStat.mtimeMs));
    } catch {
      // Missing files are normal before the first front build.
    }
  }
  return String(newestMtimeMs);
}
