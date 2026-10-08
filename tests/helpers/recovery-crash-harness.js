/**
 * Isolated crash-test harness for the durable recovery store (leaf R2).
 *
 * It spawns a *child* `process.execPath` with its own temporary data dir and its
 * own `recovery.sqlite`, lets the child run an arbitrary ESM script (the script
 * reads `process.env.RECOVERY_CRASH_DATA_DIR` / `RECOVERY_CRASH_STORE_PATH`),
 * waits for a readiness marker on stdout and then kills it with a real
 * `process.kill(pid, 'SIGKILL')`.
 *
 * Nothing is shared with the running server: the child never touches the real
 * `data/` directory and never imports the test process state. The helper is
 * reusable (any `script`/`dataDir`) and cleans up its temp dir on `dispose()`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @returns {boolean} whether this platform supports a real SIGKILL
 */
export function supportsSigkill() {
  return process.platform !== 'win32';
}

/**
 * @returns {string} a fresh isolated data dir
 */
export function createCrashDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-crash-'));
}

/**
 * Spawn a child that runs `script`, wait until it prints `readyMarker`, then
 * return a handle. The caller decides when to kill it.
 *
 * @param {{
 *   script: string,
 *   dataDir?: string,
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   timeoutMs?: number,
 *   readyMarker?: string,
 * }} options
 * @returns {Promise<{
 *   pid: number|undefined,
 *   dataDir: string,
 *   storePath: string,
 *   ownsDataDir: boolean,
 *   stdout: () => string,
 *   stderr: () => string,
 *   kill: () => Promise<{code:number|null, signal:string|null}|null>,
 *   waitForExit: (ms?: number) => Promise<{code:number|null, signal:string|null}>,
 *   dispose: () => Promise<void>,
 * }>}
 */
export async function spawnRecoveryCrashChild(options = {}) {
  const {
    script,
    dataDir,
    cwd = process.cwd(),
    env = {},
    timeoutMs = 15000,
    readyMarker = 'READY',
  } = options;
  if (typeof script !== 'string' || !script.trim()) {
    throw new TypeError('spawnRecoveryCrashChild: script must be non-empty source');
  }
  const dir = dataDir || createCrashDataDir();
  const ownsDataDir = !dataDir;
  const storePath = path.join(dir, 'recovery.sqlite');

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: {
      ...process.env,
      RECOVERY_CRASH_DATA_DIR: dir,
      RECOVERY_CRASH_STORE_PATH: storePath,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `child did not print ${readyMarker} within ${timeoutMs}ms\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
        )
      );
    }, timeoutMs);
    const onData = () => {
      if (stdout.includes(readyMarker)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code, signal) => {
      if (stdout.includes(readyMarker)) return;
      clearTimeout(timer);
      reject(
        new Error(
          `child exited before ${readyMarker} (code=${code} signal=${signal})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
        )
      );
    });
    onData();
  });

  return {
    pid: child.pid,
    dataDir: dir,
    storePath,
    ownsDataDir,
    stdout: () => stdout,
    stderr: () => stderr,
    async kill() {
      if (!child.pid) return null;
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch (err) {
        if (err?.code !== 'ESRCH') throw err;
      }
      return exited;
    },
    async waitForExit(ms = 5000) {
      return Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('child did not exit in time')), ms)
        ),
      ]);
    },
    async dispose() {
      try {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          await this.kill();
        } else {
          await exited;
        }
      } catch {
        // best-effort cleanup
      }
      if (ownsDataDir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Start `count` children on the **same** store file and hold them at a barrier
 * until `release()` is called. Each child receives the path of the `go` file in
 * `RECOVERY_CRASH_BARRIER` and must print `READY` once its store is open.
 *
 * This is the real inter-process race primitive: the caller seeds the store
 * (e.g. one run intent at `revision=1`), every child opens it, and only after
 * all children are ready does `release()` create `go`, so their
 * `transitionRun` calls actually contend instead of running one after another.
 *
 * @param {{
 *   script: string,
 *   dataDir?: string,
 *   count?: number,
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   envForIndex?: (index: number) => Record<string, string>,
 *   timeoutMs?: number,
 *   readyMarker?: string,
 * }} options
 * @returns {Promise<{
 *   dataDir: string,
 *   storePath: string,
 *   goPath: string,
 *   handles: object[],
 *   release: () => string,
 *   waitForExit: (ms?: number) => Promise<Array<{code:number|null, signal:string|null}>>,
 *   dispose: () => Promise<void>,
 * }>}
 */
export async function spawnRecoveryBarrier(options = {}) {
  const {
    script,
    dataDir,
    count = 2,
    cwd,
    env = {},
    envForIndex,
    timeoutMs = 15000,
    readyMarker = 'READY',
  } = options;
  if (!Number.isInteger(count) || count < 2) {
    throw new TypeError('spawnRecoveryBarrier: count must be an integer >= 2');
  }
  const dir = dataDir || createCrashDataDir();
  const ownsDataDir = !dataDir;
  const storePath = path.join(dir, 'recovery.sqlite');
  const goPath = path.join(dir, 'go');
  /** @type {object[]} */
  const handles = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const perIndex = typeof envForIndex === 'function' ? envForIndex(index) || {} : {};
      handles.push(
        await spawnRecoveryCrashChild({
          script,
          dataDir: dir,
          cwd,
          timeoutMs,
          readyMarker,
          env: { ...env, ...perIndex, RECOVERY_CRASH_BARRIER: goPath },
        })
      );
    }
  } catch (err) {
    for (const handle of handles) {
      await handle.dispose();
    }
    if (ownsDataDir) fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    dataDir: dir,
    storePath,
    goPath,
    handles,
    release() {
      if (!fs.existsSync(goPath)) fs.writeFileSync(goPath, 'go');
      return goPath;
    },
    async waitForExit(ms = 15000) {
      return Promise.all(handles.map((handle) => handle.waitForExit(ms)));
    },
    async dispose() {
      for (const handle of handles) {
        await handle.dispose();
      }
      if (ownsDataDir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
