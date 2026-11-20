import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicSupervisorState, processCommand, supervisorLogTail } from '../cretli-supervisor.js';
import { resolveDataPath, resolveProjectPath } from '../runtime-paths.js';
import { readSupervisorStatus } from './supervisor-status.js';

const exec = promisify(execFile);

/** Only the calling server's verified parent may receive a supervisor signal. */
export function assertSupervisorOwner({ root = resolveProjectPath(), pid = process.ppid, command = processCommand,
  env = process.env } = {}) {
  if (env.CRETLI_SUPERVISOR_PID !== String(pid) || pid <= 1) throw new Error('Supervisor unavailable');
  const cmd = command(pid);
  const script = path.join(root, 'scripts/cretli-supervisor.mjs');
  if (!cmd.includes(script)) throw new Error('Supervisor identity mismatch');
}

/** Detect the actual manager, independently of the autostart installation preference. */
export async function supervisorManager(pid, { read = fs.readFileSync, run = exec, platform = process.platform } = {}) {
  if (platform === 'linux') {
    let cgroup;
    try { cgroup = read(`/proc/${pid}/cgroup`, 'utf8'); } catch { return null; }
    if (!/\/cretli\.service(?:\n|$)/.test(cgroup)) return null;
    const user = !cgroup.includes('/system.slice/cretli.service');
    const { stdout } = await run('systemctl', [...(user ? ['--user'] : []), 'show', 'cretli.service', '-p', 'MainPID', '-p', 'Restart'], { timeout: 3000 });
    if (!stdout.includes(`MainPID=${pid}\n`) || !/^Restart=always$/m.test(stdout)) throw new Error('Service restart policy unsupported');
    return 'systemd';
  }
  if (platform === 'darwin') {
    try {
      const { stdout } = await run('launchctl', ['print', `gui/${process.getuid()}/com.cretli.supervisor`], { timeout: 3000 });
      if (new RegExp(`\\bpid = ${pid}\\b`).test(stdout) && /keepalive/i.test(stdout)) return 'launchd';
    } catch { /* A manually started supervisor has no launchd job. */ }
  }
  return null;
}

export function createSupervisorControl({ root = resolveProjectPath(), dataDir = resolveDataPath(),
  status = readSupervisorStatus, env = process.env, ppid = process.ppid, kill = process.kill,
  launch = spawn, manager = supervisorManager } = {}) {
  const eventPath = path.join(dataDir, 'supervisor-events.log');
  const event = (message) => fs.appendFileSync(eventPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  return {
    status,
    logs: () => ({ events: supervisorLogTail(eventPath, env), server: supervisorLogTail(path.join(dataDir, 'supervisor.log'), env) }),
    setEnabled(enabled) {
      const current = status();
      if (!current.active || current.stale || current.controlVersion !== 1) throw new Error('Restart supervisor to enable controls');
      assertSupervisorOwner({ root, pid: ppid, env });
      atomicSupervisorState(path.join(dataDir, 'supervisor-control.json'), { pid: ppid, enabled });
      event(`requested enabled=${enabled}`);
      return { accepted: true };
    },
    async restart() {
      const current = status();
      if (current.active) assertSupervisorOwner({ root, pid: ppid, env });
      const managed = current.active ? await manager(ppid) : null;
      event(`requested restart manager=${managed || 'standalone'}`);
      if (managed) {
        // Restart=always / KeepAlive replaces the supervisor after its graceful shutdown.
        return () => { assertSupervisorOwner({ root, pid: ppid, env }); kill(ppid, 'SIGTERM'); };
      }
      // An independent helper outlives the server's shutdown and verifies both exits.
      // It starts supervision for a standalone server too, without binding a second server.
      return () => new Promise((resolve, reject) => {
        const child = launch(process.execPath, [path.join(root, 'scripts/restart-supervisor-helper.mjs')], {
          detached: true, stdio: 'ignore', cwd: root,
          env: { ...env, CRETLI_SUPERVISOR_REPLACE_PID: String(current.active ? ppid : 0),
            CRETLI_SUPERVISOR_REPLACE_SERVER_PID: String(process.pid), CRETLI_DATA_DIR: dataDir },
        });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(undefined); });
      });
    },
  };
}
