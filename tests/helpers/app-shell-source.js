import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const shellDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../app_front/app/appShell');

/**
 * Concatenated source of every app shell module (what tests used to read from the former
 * single-file `app_front/app/appShell/app.js`). Reading the whole directory keeps wiring
 * assertions valid when the shell is split further (e.g. settingsDeferred.js).
 */
export function readAppShellSource() {
  return readdirSync(shellDir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => readFileSync(path.join(shellDir, name), 'utf8'))
    .join('\n');
}
