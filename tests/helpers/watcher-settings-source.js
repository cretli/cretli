import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const settingsDir = path.join(root, 'app_front/features/settings');

/** Every .js file under a directory, sorted for a stable concatenation. */
function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/** Source files that make up the Watcher settings panel (entry + `watcher/`). */
export function watcherSettingsFiles() {
  return [
    path.join(settingsDir, 'workspaceWatcherSettings.js'),
    ...listJs(path.join(settingsDir, 'watcher')),
  ];
}

/**
 * The Watcher settings panel was split into an entry module and the
 * `settings/watcher/` modules. Source-shape tests read them as one text so they
 * keep asserting the wiring, wherever a function now lives.
 */
export function readWatcherSettingsSource() {
  return watcherSettingsFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}
