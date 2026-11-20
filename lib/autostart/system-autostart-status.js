import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { processCommand } from '../cretli-supervisor.js';
import { resolveProjectPath } from '../runtime-paths.js';

const exec = promisify(execFile);

/** Read the system service owning this checkout, without installing or changing it. */
export async function readSystemAutostart({ pid = process.ppid, root = resolveProjectPath(),
  platform = process.platform, read = fs.readFileSync, command = processCommand, run = exec } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (!/\/system\.slice\/cretli\.service(?:\n|$)/.test(read(`/proc/${pid}/cgroup`, 'utf8'))) return null;
    if (!command(pid).includes(path.join(root, 'scripts/cretli-supervisor.mjs'))) return null;
    const { stdout } = await run('systemctl', ['show', 'cretli.service', '-p', 'MainPID', '-p', 'UnitFileState'], { timeout: 3000 });
    if (!new RegExp(`^MainPID=${pid}$`, 'm').test(stdout)) return null;
    const state = /^UnitFileState=([a-z-]+)$/m.exec(stdout)?.[1];
    return { enabled: state === 'enabled' || state === 'enabled-runtime' ? true : state === 'disabled' ? false : null };
  } catch { return null; }
}
