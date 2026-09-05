/**
 * Must be the first import in tests that load auth, widgets, or persist.
 * Paths are resolved at module load, so the env must exist before those imports.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-isolated-'));
process.env.CRETLI_TEST_DATA_DIR = dir;
process.env.CURSOR_REMOTE_TEST_DATA_DIR = dir;
process.env.CRETLI_DATA_DIR = dir;
process.env.CURSOR_REMOTE_DATA_DIR = dir;

export const ISOLATED_DATA_DIR = dir;

/**
 * @returns {void}
 */
export function removeIsolatedDataDir() {
  fs.rmSync(dir, { recursive: true, force: true });
}
