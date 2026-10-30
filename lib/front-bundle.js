/**
 * Which frontend bundle the server serves under /dist/app.
 *
 * Production (minified, no eval-source-map, Lit prod mode) is built into
 * public/dist/app; the development watcher writes public/dist/app-dev. One env
 * var picks the served directory, so it is also the rollback switch:
 *   CRETLI_FRONT_BUNDLE=dev   serve the development bundle
 * Anything else (including unset) serves production.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export const PROD_BUNDLE_DIRNAME = 'app';
export const DEV_BUNDLE_DIRNAME = 'app-dev';
const ENTRY_FILE = 'index.bundle.js';

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {'dev' | 'prod'}
 */
export function resolveFrontBundleMode(env = process.env) {
  return String(env.CRETLI_FRONT_BUNDLE || '').trim().toLowerCase() === 'dev' ? 'dev' : 'prod';
}

/**
 * @param {string} publicDir
 * @param {'dev' | 'prod'} mode
 */
export function frontBundleDir(publicDir, mode) {
  return path.join(publicDir, 'dist', mode === 'dev' ? DEV_BUNDLE_DIRNAME : PROD_BUNDLE_DIRNAME);
}

/**
 * Picks the directory to serve. When the requested bundle was never built but
 * the other one exists, the other one is served (a checkout that only runs the
 * dev watcher keeps working) and `fellBack` is set so the boot log can say so.
 *
 * @param {{ publicDir: string, env?: Record<string, string | undefined>, exists?: (p: string) => boolean }} options
 * @returns {{ mode: 'dev' | 'prod', requested: 'dev' | 'prod', dir: string, fellBack: boolean }}
 */
export function resolveServedFrontBundle({ publicDir, env = process.env, exists = existsSync }) {
  const requested = resolveFrontBundleMode(env);
  const other = requested === 'dev' ? 'prod' : 'dev';
  const hasEntry = (mode) => exists(path.join(frontBundleDir(publicDir, mode), ENTRY_FILE));
  if (!hasEntry(requested) && hasEntry(other)) {
    return { mode: other, requested, dir: frontBundleDir(publicDir, other), fellBack: true };
  }
  return { mode: requested, requested, dir: frontBundleDir(publicDir, requested), fellBack: false };
}
