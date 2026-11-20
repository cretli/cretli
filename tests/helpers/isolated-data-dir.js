/**
 * Must be the first import in tests that load auth, widgets, or persist.
 * Paths are resolved at module load, so the env must exist before those imports.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempDir } from './temp-dir.js';

const dir = makeTempDir('cretli-isolated-');
process.env.CRETLI_TEST_DATA_DIR = dir;
process.env.CURSOR_REMOTE_TEST_DATA_DIR = dir;
process.env.CRETLI_DATA_DIR = dir;
process.env.CURSOR_REMOTE_DATA_DIR = dir;
// A host-level store override would beat setDelegationStoreBackend() and make
// json-store tests read sqlite; tests pick the backend explicitly.
delete process.env.CRETLI_DELEGATION_STORE;
if (process.env.CRETLI_DELEGATION_EMPTY_FAVORITES == null) {
  process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = 'all';
}

// Auto verify spawns the catalog; tests opt in explicitly.
if (process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT == null) {
  process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT = '0';
}

export const ISOLATED_DATA_DIR = dir;

/**
 * @returns {void}
 */
export function removeIsolatedDataDir() {
  fs.rmSync(dir, { recursive: true, force: true });
}
