import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const shellDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../app_front/app/appShell');

// Modules that together replace the former single-file `app_front/app/appShell/app.js`.
const APP_SHELL_MODULES = [
  'runtime.js',
  'bootApp.js',
  'authBoot.js',
  'panelLoader.js',
  'panelControls.js',
  'settingsTabs.js',
  'headerChrome.js',
  'embedWidgetBridge.js',
  'gitRouteScope.js',
  'sidebarWiring.js',
  'spaNavigationController.js',
  'headerLookups.js',
  'storageStats.js',
  'browserStorageTools.js',
  'startup.js',
  'mobileKeyboard.js',
];

/** Concatenated source of the app shell modules (what tests used to read from App.js). */
export function readAppShellSource() {
  return APP_SHELL_MODULES
    .map((name) => readFileSync(path.join(shellDir, name), 'utf8'))
    .join('\n');
}
