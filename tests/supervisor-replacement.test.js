import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processAlive } from '../lib/cretli-supervisor.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const entry = new URL('../scripts/cretli-supervisor.mjs', import.meta.url).pathname;
const helper = new URL('../scripts/restart-supervisor-helper.mjs', import.meta.url).pathname;

test('detached replacement waits for both old processes and starts one new supervisor', { timeout: 15_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-supervisor-replace-'));
  const fixture = path.join(dir, 'child.mjs');
  fs.writeFileSync(fixture, `setInterval(() => {}, 1000); process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));`);
  const env = { ...process.env, CRETLI_DATA_DIR: dir, CRETLI_SUPERVISOR_TEST_MODE: '1',
    CRETLI_SUPERVISOR_TEST_LOCK: path.join(dir, 'supervisor.lock'), CRETLI_SUPERVISOR_TEST_CHILD: fixture };
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'supervisor-state.json'), 'utf8')); } catch { return null; } };
  const waitFor = async (check) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) { const result = check(); if (result) return result; await sleep(25); }
    throw new Error('Timed out waiting for isolated supervisor');
  };
  const old = spawn(process.execPath, [entry], { env, stdio: 'ignore' });
  let before, after;
  try {
    before = await waitFor(() => state()?.childPid && state());
    await sleep(100);
    const replacement = spawn(process.execPath, [helper], { env: { ...env,
      CRETLI_SUPERVISOR_REPLACE_PID: String(old.pid), CRETLI_SUPERVISOR_REPLACE_SERVER_PID: String(before.childPid) }, stdio: 'ignore' });
    const [code] = await once(replacement, 'exit');
    assert.equal(code, 0, fs.readFileSync(path.join(dir, 'supervisor-events.log'), 'utf8'));
    after = await waitFor(() => { const row = state(); return row?.pid !== old.pid && row?.childPid && row; });
    assert.equal(processAlive(old.pid), false);
    assert.equal(processAlive(before.childPid), false);
    assert.ok(processAlive(after.pid)); assert.ok(processAlive(after.childPid));
    assert.equal(Number(fs.readFileSync(path.join(dir, 'supervisor.lock'), 'utf8')), after.pid);
    process.kill(after.pid, 'SIGTERM');
    await waitFor(() => state()?.state === 'stopped');
  } finally {
    for (const pid of [old.pid, before?.childPid, after?.pid, after?.childPid]) {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
