#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createSupervisor, supervisorConfig, loadSupervisorEnv, acquireSupervisorLock,
  requestRestart, requestStop, atomicSupervisorState, supervisorLogTail, probeSupervisorHealth, supervisorProgress } from '../lib/cretli-supervisor.js';
import { isHttpsRequested } from '../lib/server-tls.js';
import { rotateLogIfNeeded, startLogCapTimer } from '../lib/log-rotate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Test overrides require an explicit mode and an isolated lock and data path.
const testing = process.env.CRETLI_SUPERVISOR_TEST_MODE === '1';
if (testing && (!process.env.CRETLI_SUPERVISOR_TEST_LOCK || (!['request-restart', 'request-stop'].includes(process.argv[2]) && !process.env.CRETLI_DATA_DIR))) {
  throw new Error('Supervisor tests require isolated lock and data paths');
}
const lockPath = testing ? path.resolve(process.env.CRETLI_SUPERVISOR_TEST_LOCK) : path.join(root, 'data/supervisor.lock');
if (process.argv[2] === 'request-restart') {
  process.exitCode = requestRestart(lockPath);
} else if (process.argv[2] === 'request-stop' && process.argv.length === 3) {
  process.exitCode = requestStop(lockPath);
  if (process.exitCode === 3) console.error('No running Cretli supervisor found.');
  else if (process.exitCode === 4) console.error('Could not signal the Cretli supervisor.');
} else if (process.argv.length > 2) {
  console.error('Usage: cretli-supervisor.mjs [request-restart|request-stop]'); process.exitCode = 4;
} else {
  let supervisor, earlySignal, release, probeTimer, capTimer, controlTimer;
  // Register before any filesystem operation, including lock publication.
  for (const name of ['SIGTERM', 'SIGINT', 'SIGUSR2']) process.on(name, () => {
    if (supervisor) supervisor.signal(name);
    else if (earlySignal !== 'SIGTERM' && earlySignal !== 'SIGINT') earlySignal = name;
  });
  try {
    release = acquireSupervisorLock(lockPath);
    const env = loadSupervisorEnv(root, process.env);
    // runtime-paths resolves at import time, after the restricted .env load.
    if (env.CRETLI_DATA_DIR !== undefined) process.env.CRETLI_DATA_DIR = env.CRETLI_DATA_DIR;
    const { resolveDataPath } = await import('../lib/runtime-paths.js');
    const statePath = resolveDataPath('supervisor-state.json');
    const logPath = resolveDataPath('supervisor.log');
    const controlPath = resolveDataPath('supervisor-control.json');
    const eventPath = resolveDataPath('supervisor-events.log');
    const event = (message) => {
      try {
        rotateLogIfNeeded(eventPath);
        fs.appendFileSync(eventPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
      } catch { /* Diagnostics must not interrupt supervision. */ }
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    let history = {};
    try { history = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const config = supervisorConfig(env);
    const childEnv = { ...env, CRETLI_SUPERVISOR_PID: String(process.pid),
      CURSOR_RIPGREP_PATH: './node_modules/.bin/rg', CRETLI_SERVER_LOG_FILE: logPath };
    const heartbeatPath = resolveDataPath('server-heartbeat.json');
    supervisor = createSupervisor({ config, history,
      progress: () => supervisorProgress({ logPath, heartbeatPath }),
      clock: { now: Date.now, setTimeout, clearTimeout },
      writeState: (state) => {
        atomicSupervisorState(statePath, state);
        event(`state=${state.state} enabled=${state.enabled} childPid=${state.childPid ?? '-'} busy=${state.busy ?? '-'} safeMode=${state.safeMode} reason=${state.lastCrash?.reason ?? '-'}`);
      },
      tail: () => supervisorLogTail(logPath, childEnv),
      fetch: ({ signal }) => probeSupervisorHealth({ signal, port: env.PORT || 3011, useHttps: isHttpsRequested(env.USE_HTTPS ?? '1'), timeoutMs: config.probeTimeoutMs }),
      spawn: ({ safeMode = false } = {}) => {
        rotateLogIfNeeded(logPath);
        const fd = fs.openSync(logPath, 'a', 0o600);
        try {
          /** @type {[string, string[]]} */
          const command = testing && process.env.CRETLI_SUPERVISOR_TEST_CHILD
            ? [process.execPath, [process.env.CRETLI_SUPERVISOR_TEST_CHILD]]
            : ['bash', ['scripts/start-server-node22.sh']];
          return spawn(command[0], command[1], { cwd: root, env: safeMode ? { ...childEnv, CRETLI_SAFE_MODE: '1' } : childEnv, stdio: ['ignore', fd, fd] });
        } finally { fs.closeSync(fd); }
      },
      finish: (code) => {
        clearInterval(probeTimer); clearInterval(capTimer); clearInterval(controlTimer); release(); release = null;
        process.exitCode = code;
      },
    });
    if (earlySignal === 'SIGTERM' || earlySignal === 'SIGINT') supervisor.signal(earlySignal);
    else {
      probeTimer = setInterval(() => { void supervisor.tick(); }, config.probeIntervalMs);
      capTimer = startLogCapTimer(logPath);
      supervisor.start();
      const readControl = () => {
        try {
          if (fs.statSync(controlPath).size > 1024) return;
          const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
          if (control.pid === process.pid) supervisor.setEnabled(control.enabled);
        } catch { /* Missing or partial control files leave the current policy intact. */ }
      };
      controlTimer = setInterval(readControl, 500);
    }
  } catch (error) {
    console.error('[cretli-supervisor]', error.message);
    clearInterval(probeTimer); clearInterval(capTimer); clearInterval(controlTimer);
    release?.(); process.exitCode = 1;
  }
}
