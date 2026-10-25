import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnReviewVerifyFile } from '../lib/sdk/sdk-review-verify.ts';

const fixture = fileURLToPath(new URL('./helpers/review-verify-grandchild-fixture.js', import.meta.url));

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The baseline path (review-verify-baseline via deps.spawnFile) uses this same
// function, so this also covers grandchildren spawned by baseline runs.
test('spawnReviewVerifyFile (also the baseline path) SIGKILLs a SIGTERM-ignoring grandchild after the direct child exits', { skip: process.platform === 'win32' }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-gc-'));
  let pid = 0;
  try {
    const result = await spawnReviewVerifyFile({
      filePath: fixture, workDir, dataDir: workDir, timeoutMs: 400, graceMs: 300, drainMs: 100,
    });
    pid = Number(/GRANDCHILD_PID=(\d+)/.exec(result.output)?.[1]);
    assert.ok(pid > 0, `grandchild pid parsed from: ${result.output}`);
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(isAlive(pid), false, 'grandchild must be reaped by the group SIGKILL');
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
