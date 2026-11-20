import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvAlias } from './env-alias.js';
import { assertDataWriteAllowed } from './test-write-guard.js';

const LIB_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(LIB_DIRECTORY, '..');
// Resolved once at import time: every module caches paths derived from it, so a
// later change to the variable would leave the process with a split view.
const DATA_DIRECTORY = resolveDataDirectory();

function resolveDataDirectory() {
  const configured = readEnvAlias({
    current: 'CRETLI_DATA_DIR',
    legacy: 'CURSOR_REMOTE_DATA_DIR',
  }).trim();
  if (!configured) return path.join(PROJECT_ROOT, 'data');
  return path.resolve(PROJECT_ROOT, configured);
}

export function resolveProjectPath(...segments) {
  if (!Array.isArray(segments) || segments.length === 0) return PROJECT_ROOT;
  return path.join(PROJECT_ROOT, ...segments);
}

export function resolveDataPath(...segments) {
  // Under node --test / CRETLI_TEST=1 the real <repo>/data must never be resolved: a test that skipped
  // tests/helpers/isolated-data-dir.js fails here instead of overwriting production data.
  assertDataWriteAllowed(DATA_DIRECTORY);
  if (!Array.isArray(segments) || segments.length === 0) return DATA_DIRECTORY;
  return path.join(DATA_DIRECTORY, ...segments);
}

export { assertDataWriteAllowed };
