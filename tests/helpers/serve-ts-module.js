/**
 * Static-server helper for browser DOM tests that serve app_front modules raw
 * (unbundled) to Chromium. Browsers cannot run `.ts`, so a request for a
 * `.ts` file is answered with its type-stripped JavaScript. The production
 * app only serves the webpack bundle (esbuild-loader), so this exists purely
 * for the ad-hoc test servers.
 */
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

/**
 * @param {string} filePath absolute path of the requested file
 * @returns {{ type: string, body: string | Buffer }}
 */
export function readServedModule(filePath) {
  if (filePath.endsWith('.ts')) {
    return { type: 'text/javascript', body: stripTypeScriptTypes(readFileSync(filePath, 'utf8')) };
  }
  return {
    type: filePath.endsWith('.js') ? 'text/javascript' : 'text/html',
    body: readFileSync(filePath),
  };
}
