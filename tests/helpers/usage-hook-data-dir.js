// Side-effect import for tests/usage-harness-hook.test.js: points the data dir at a temp
// folder before modules that resolve it at load time (lib/runtime-paths.js) run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-usage-hook-data-'));
process.env.CRETLI_DATA_DIR = dir;
process.env.CRETLI_TEST_DATA_DIR = dir;
process.env.CURSOR_REMOTE_DATA_DIR = dir;
process.env.CURSOR_REMOTE_TEST_DATA_DIR = dir;
process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
