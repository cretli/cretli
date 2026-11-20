import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processAlive, processCommand } from '../lib/cretli-supervisor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.CRETLI_DATA_DIR || path.join(root, 'data'));
const supervisorPid = Number(process.env.CRETLI_SUPERVISOR_REPLACE_PID);
const serverPid = Number(process.env.CRETLI_SUPERVISOR_REPLACE_SERVER_PID);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => fs.appendFileSync(path.join(dataDir, 'supervisor-events.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
const alive = (pid) => {
  if (!processAlive(pid)) return false;
  // A reparented zombie no longer owns listeners, but kill(pid, 0) still succeeds.
  try { if (/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))) return false; } catch { /* Non-Linux or exited. */ }
  return true;
};

try {
  if (!Number.isSafeInteger(serverPid) || serverPid <= 1 || !Number.isSafeInteger(supervisorPid) || supervisorPid < 0) throw new Error('Invalid restart target');
  const target = supervisorPid || serverPid;
  const expected = supervisorPid ? path.join(root, 'scripts/cretli-supervisor.mjs') : path.join(root, 'server.js');
  if (!processCommand(target).includes(expected) && !(supervisorPid === 0 && processCommand(target).trim() === 'cretli')) throw new Error('Restart identity mismatch');
  log('Restart helper stopping previous processes');
  process.kill(target, 'SIGTERM');
  const deadline = Date.now() + 60_000;
  while (alive(target) || alive(serverPid)) {
    if (Date.now() >= deadline) throw new Error('Previous processes did not exit; replacement refused');
    await delay(200);
  }
  const env = { ...process.env };
  delete env.CRETLI_SUPERVISOR_PID;
  delete env.CRETLI_SUPERVISOR_REPLACE_PID;
  delete env.CRETLI_SUPERVISOR_REPLACE_SERVER_PID;
  const fd = fs.openSync(path.join(dataDir, 'supervisor-events.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(root, 'scripts/cretli-supervisor.mjs')], {
      cwd: root, detached: true, stdio: ['ignore', fd, fd], env,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    log('Replacement supervisor started');
  } finally { fs.closeSync(fd); }
} catch (error) {
  log(`Supervisor restart failed: ${error.message}`);
  process.exitCode = 1;
}
