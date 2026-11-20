/**
 * Import FIRST: points the legacy persistence layer (which resolves its data
 * directory once, at import time) at scratch space before any other module can
 * load `runtime-paths.js`. ES module imports evaluate in order, so this works
 * where an assignment in the test body would be too late.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const scratchDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-history-scratch-data-'));
process.env.CRETLI_DATA_DIR = scratchDataDir;
process.on('exit', () => fs.rmSync(scratchDataDir, { recursive: true, force: true }));
