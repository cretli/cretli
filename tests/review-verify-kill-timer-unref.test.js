import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./helpers/review-verify-grandchild-fixture.js', import.meta.url));
const moduleUrl = new URL('../lib/sdk/sdk-review-verify.js', import.meta.url).href;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A host process runs one timed-out verify with a long SIGKILL grace. Once the
// run settles the host must exit promptly instead of waiting out graceMs.
test('group SIGKILL timer does not hold the event loop after the run settles', { skip: process.platform === 'win32' }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-unref-'));
  const script = `
    import { spawnReviewVerifyFile } from ${JSON.stringify(moduleUrl)};
    const r = await spawnReviewVerifyFile({ filePath: ${JSON.stringify(fixture)}, workDir: ${JSON.stringify(workDir)}, dataDir: ${JSON.stringify(workDir)}, timeoutMs: 300, graceMs: 30000, drainMs: 100 });
    console.log(r.output);
  `;
  let grandchildPid = 0;
  try {
    const started = Date.now();
    const host = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, CRETLI_DATA_DIR: workDir },
    });
    let out = '';
    host.stdout.on('data', (c) => { out += c.toString(); });
    await new Promise((resolve) => host.on('close', resolve));
    grandchildPid = Number(/GRANDCHILD_PID=(\d+)/.exec(out)?.[1]);
    assert.ok(grandchildPid > 0, `grandchild pid parsed from: ${out}`);
    assert.ok(Date.now() - started < 10000, 'host exited well before the 30s grace elapsed');
  } finally {
    if (grandchildPid > 0 && isAlive(grandchildPid)) { try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
