/**
 * Server-only persistence of prompt block overrides under the data dir. Kept
 * apart from ./overrides.js so the browser bundle never imports node:fs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listPromptOverrides, replacePromptOverrides } from './overrides.js';

/** @param {string} dataDir */
function overridesFile(dataDir) {
  return path.join(dataDir, 'prompt-overrides.json');
}

/**
 * Load persisted overrides into memory, ignoring anything no longer editable.
 *
 * @param {string} dataDir
 */
export function loadPromptOverrides(dataDir) {
  try {
    replacePromptOverrides(JSON.parse(fs.readFileSync(overridesFile(dataDir), 'utf8')));
  } catch {
    // No file yet (or unreadable): start from the defaults.
    replacePromptOverrides({});
  }
}

/** @param {string} dataDir */
export function savePromptOverrides(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(overridesFile(dataDir), JSON.stringify(listPromptOverrides(), null, 2));
}
