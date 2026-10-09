#!/usr/bin/env node
/**
 * Starts webpack in CLI watch mode with an exclusive project lock in data/.
 * One-shot builds use webpack directly with --no-watch (see package.json).
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProcessStartTime } from '../../lib/delegation-owner-lock.js';
import {
  lockIdForWebpackConfig,
  releaseWebpackCliWatchLock,
  resolveCretliProjectRootRealpath,
  resolveWebpackConfigRealpath,
  sweepOrphanWebpackCliWatchers,
  tryAcquireWebpackCliWatchLock,
  updateWebpackCliWatchLockRecord,
} from '../../lib/webpack-cli-watch-lock.js';

const APP_FRONT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const frontRequire = createRequire(path.join(APP_FRONT_DIR, 'package.json'));
const WEBPACK_BIN = frontRequire.resolve('webpack/bin/webpack.js');

/**
 * @param {string[]} argv
 * @returns {{ configPath: string | null, watchMode: boolean, passthrough: string[] }}
 */
function parseCliArgs(argv) {
  /** @type {string | null} */
  let configPath = null;
  let watchMode = true;
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-watch') {
      watchMode = false;
      passthrough.push(arg);
      continue;
    }
    if (arg === '--watch') {
      watchMode = true;
      passthrough.push(arg);
      continue;
    }
    if (arg === '--config') {
      const next = argv[i + 1];
      if (next) {
        configPath = next;
        passthrough.push(arg, next);
        i += 1;
        continue;
      }
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      passthrough.push(arg);
      continue;
    }
    passthrough.push(arg);
  }
  return { configPath, watchMode, passthrough };
}

/** @type {import('node:child_process').ChildProcess | null} */
let webpackChild = null;

/** Set while handling SIGINT/SIGTERM/SIGHUP so child exit does not release the lock early. */
let shuttingDownFromSignal = false;

/**
 * @param {NodeJS.Signals} signal
 * @param {import('node:child_process').ChildProcess | null} child
 * @returns {void}
 */
function killWebpackChildGroup(signal, child) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fall through to direct child signal
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/**
 * @param {NodeJS.Signals} signal
 * @param {() => void} releaseIfOwner
 * @returns {never}
 */
function shutdownFromSignal(signal, releaseIfOwner) {
  shuttingDownFromSignal = true;
  killWebpackChildGroup(signal, webpackChild);
  releaseIfOwner();
  const code = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : signal === 'SIGHUP' ? 129 : 128;
  process.exit(code);
}

/**
 * @param {string[]} passthrough
 * @param {{ detached?: boolean, onChild?: (child: import('node:child_process').ChildProcess) => void, releaseIfOwner?: () => void }} [options]
 * @returns {never}
 */
function runWebpack(passthrough, options = {}) {
  const useDetached = options.detached ?? false;
  const child = spawn(process.execPath, [WEBPACK_BIN, ...passthrough], {
    cwd: APP_FRONT_DIR,
    stdio: 'inherit',
    detached: useDetached,
    env: {
      ...process.env,
      CRETLI_FRONT_HMR: '0',
      CURSOR_REMOTE_FRONT_HMR: '0',
    },
  });
  webpackChild = child;
  if (options.onChild) {
    options.onChild(child);
  }
  child.on('exit', (code, signal) => {
    if (options.releaseIfOwner && !shuttingDownFromSignal) {
      options.releaseIfOwner();
    }
    if (signal) {
      const sig = /** @type {NodeJS.Signals} */ (signal);
      const exitCode = sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : sig === 'SIGHUP' ? 129 : 128;
      process.exit(exitCode);
      return;
    }
    process.exit(code ?? 1);
  });
}

const parsed = parseCliArgs(process.argv.slice(2));
if (!parsed.configPath) {
  console.error('[webpack-cli-watch] Missing --config <file>');
  process.exit(1);
}

if (!parsed.watchMode) {
  runWebpack(parsed.passthrough);
} else {
  const configRealpath = resolveWebpackConfigRealpath(parsed.configPath, APP_FRONT_DIR);
  const projectRootRealpath = resolveCretliProjectRootRealpath();
  const lockId = lockIdForWebpackConfig(configRealpath);
  sweepOrphanWebpackCliWatchers({
    lockId,
    configRealpath,
    projectRootRealpath,
  });
  const lockResult = tryAcquireWebpackCliWatchLock({
    lockId,
    configRealpath,
    projectRootRealpath,
  });
  if (!lockResult.acquired) {
    console.error(`[webpack-cli-watch] ${lockResult.message}`);
    process.exit(1);
  }
  /** @type {import('../../lib/webpack-cli-watch-lock.js').WebpackCliWatchLockRecord} */
  let owner = lockResult.record;
  const lockPath = lockResult.lockPath;
  let released = false;
  const releaseIfOwner = () => {
    if (released) return;
    released = true;
    releaseWebpackCliWatchLock(lockPath, owner);
  };
  process.on('exit', releaseIfOwner);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      shutdownFromSignal(/** @type {NodeJS.Signals} */ (signal), releaseIfOwner);
    });
  }
  runWebpack(parsed.passthrough, {
    detached: process.platform !== 'win32',
    releaseIfOwner,
    onChild: (child) => {
      const childPid = child.pid || 0;
      if (childPid <= 0) return;
      const updated = updateWebpackCliWatchLockRecord(lockPath, owner, {
        childPid,
        childPidStart: getProcessStartTime(childPid),
        childPgid: childPid,
      });
      if (updated) {
        owner = updated;
      }
    },
  });
}
