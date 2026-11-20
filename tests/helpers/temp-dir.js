/**
 * Shared temp-dir helper for tests. Every directory created here is removed in
 * a process 'exit' handler, so it is cleaned up even when an assertion fails
 * or the test never reaches its own teardown.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = new Set();
let hooked = false;

/**
 * Remove every directory registered so far (idempotent).
 * @returns {void}
 */
export function cleanupTempDirs() {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover dir must not mask the test result.
    }
  }
  created.clear();
}

/**
 * Create a directory below the real OS temp dir and schedule its removal.
 * @param {string} prefix
 * @returns {string}
 */
export function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  created.add(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', cleanupTempDirs);
  }
  return dir;
}
