import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run one test file in a child whose TMPDIR is a fresh empty dir.
 * @param {string} file
 * @returns {{ status: number | null, leftovers: string[] }}
 */
function runWithEmptyTmp(file) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cretli-tmp-gate-'));
  try {
    const res = spawnSync(process.execPath, ['--test', path.join(ROOT, 'tests', file)], {
      cwd: ROOT,
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      encoding: 'utf8',
      timeout: 120000,
    });
    return { status: res.status, leftovers: fs.readdirSync(tmp) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Representative suites: isolated-data-dir users, recovery-* and the shared helper.
for (const file of ['recovery-ui.test.js', 'usage-ledger.test.js', 'model-pick-decisions.test.js']) {
  test(`${file} leaves no temp directories behind`, () => {
    const { status, leftovers } = runWithEmptyTmp(file);
    assert.equal(status, 0, `${file} must pass in the gate subprocess`);
    assert.deepEqual(leftovers, []);
  });
}
