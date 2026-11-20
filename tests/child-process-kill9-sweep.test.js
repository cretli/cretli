/**
 * End-to-end orphan reaping across three real processes: a "server" registers
 * a real child and is killed with SIGKILL (no shutdown hook runs); a separate
 * NEW process (fresh instanceToken) performs the same startup sweep server.js
 * runs (`reconcileChildProcessRegistry()` against the shared data dir) and
 * must kill the orphan and drop its registry entry.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-kill9-'));
const registryUrl = JSON.stringify(path.join(root, 'lib/child-process-registry.js'));
const registryFile = path.join(dataDir, 'child-processes.json');

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

const fakeServerSource = `
import { spawn } from 'node:child_process';
import { registerChildProcess, CHILD_PROCESS_REGISTRY_SERVER_TOKEN } from ${registryUrl};
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
registerChildProcess({ pid: child.pid, type: 'test-child', label: 'kill9' });
console.log('CHILD ' + child.pid + ' ' + CHILD_PROCESS_REGISTRY_SERVER_TOKEN);
setInterval(() => {}, 1000);
`;

const newStartSource = `
import { reconcileChildProcessRegistry, CHILD_PROCESS_REGISTRY_SERVER_TOKEN } from ${registryUrl};
const result = await reconcileChildProcessRegistry({ killWaitMs: 300 });
console.log('SWEEP ' + JSON.stringify({ token: CHILD_PROCESS_REGISTRY_SERVER_TOKEN, result }));
`;

/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
let orphanPid = 0;
const timers = new Set();
/** Every process runNode spawned, killed in the finally block. */
const spawned = new Set();

/**
 * Run a node ESM script in a fresh process sharing the data dir.
 *
 * @param {string} source
 * @param {{ until?: RegExp, keepRunning?: boolean }} [opts]
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, match: RegExpExecArray | null }>}
 */
function runNode(source, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, CRETLI_DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    spawned.add(proc);
    if (opts.keepRunning) server = proc;
    let out = '';
    const timer = setTimeout(() => {
      timers.delete(timer);
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('child script timed out'));
    }, 15000);
    timers.add(timer);
    const done = (fn, v) => {
      clearTimeout(timer);
      timers.delete(timer);
      fn(v);
    };
    proc.once('error', (err) => done(reject, err));
    proc.stdout.on('data', (buf) => {
      out += String(buf);
      if (opts.until) {
        const match = opts.until.exec(out);
        if (match) done(resolve, { proc, match });
      }
    });
    proc.once('exit', (code) => {
      if (!opts.until) {
        if (code !== 0) done(reject, new Error(`script exited ${code}`));
        else done(resolve, { proc, match: /SWEEP (.*)/.exec(out) });
      }
    });
  });
}

try {
  const started = await runNode(fakeServerSource, { until: /CHILD (\d+) (\S+)/, keepRunning: true });
  orphanPid = Number(started.match[1]);
  const oldToken = started.match[2];
  assert.ok(isAlive(orphanPid), 'child alive before kill');

  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGKILL');
  await exited;
  assert.ok(isAlive(orphanPid), 'child survives kill -9 of its server (orphan)');
  const persisted = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  assert.equal(persisted[String(orphanPid)]?.serverInstanceToken, oldToken);

  const sweep = await runNode(newStartSource);
  const { token: newToken, result } = JSON.parse(sweep.match[1]);
  assert.notEqual(newToken, oldToken, 'new start has a different instanceToken');
  assert.ok(result.killed.includes(orphanPid), `expected orphan reaped: ${JSON.stringify(result)}`);
  assert.equal(isAlive(orphanPid), false, 'orphan is gone after the new start sweep');
  const after = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  assert.equal(after[String(orphanPid)], undefined, 'registry entry removed');
  console.log('child-process-kill9-sweep: ok');
} finally {
  for (const t of timers) clearTimeout(t);
  for (const proc of spawned) {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
  if (orphanPid && isAlive(orphanPid)) {
    try { process.kill(orphanPid, 'SIGKILL'); } catch { /* ignore */ }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
