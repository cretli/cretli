import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pty from 'node-pty';
import type { ExecutionEnvironment, ExecutionEnvironmentDefinition } from './execution-environment.ts';

const execFileAsync = promisify(execFile);
const LABEL = 'cretli.execution-environment=true';
const OWNER_LABEL = 'cretli.execution.owner-pid';
const OWNER_START_LABEL = 'cretli.execution.owner-start';
const DEFAULT_GUEST_WORKSPACE = '/workspace';
const DEFAULT_IMAGE = 'node:22-bookworm';
const PROBE_TIMEOUT_MS = 1500;
const liveContainers = new Set<{ engine: string; name: string }>();
let exitHookInstalled = false;

type ContainerRun = {
  worktreePath?: string;
  cwd?: string;
  image?: string;
  readOnly?: boolean;
  id?: string;
  env?: NodeJS.ProcessEnv;
};

type ContainerHandle = {
  engine: string;
  name: string;
  image: string;
  hostWorkspace: string;
  guestWorkspace: string;
  hostUid: string;
  hostGid: string;
  envDirectory: string;
};

function safePart(value: unknown, fallback: string): string {
  const result = String(value ?? '').trim().replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^-+|-+$/g, '');
  return result || fallback;
}

/**
 * `--mount` takes a comma-separated option list, so a comma or newline in a path would inject extra
 * mount options. Also refuse the filesystem root and the user's home: only a worktree may be mounted.
 */
function assertSafeMountPath(value: string, label: string): void {
  if (!path.isAbsolute(value) || /[,\n\r\0]/.test(value)) throw new Error(`Unsafe ${label} path for a container mount.`);
  const normalized = path.resolve(value);
  if (normalized === path.parse(normalized).root || normalized === path.resolve(os.homedir())) {
    throw new Error(`Refusing to mount ${label} path ${JSON.stringify(normalized)}: mount a worktree directory only.`);
  }
}

function currentIds(): { uid: string; gid: string } {
  return { uid: String(typeof process.getuid === 'function' ? process.getuid() : 0), gid: String(typeof process.getgid === 'function' ? process.getgid() : 0) };
}

function processStartToken(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const endOfCommand = stat.lastIndexOf(')');
    const fields = stat.slice(endOfCommand + 2).trim().split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeEnvironmentFile(directory: string, env: NodeJS.ProcessEnv | undefined): string | null {
  const entries = Object.entries(env || {}).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  if (entries.length === 0) return null;
  const file = path.join(directory, `exec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(file, entries.map(([key, value]) => `export ${key}=${shellQuote(value ?? '')}`).join('\n') + '\n', { mode: 0o600 });
  return file;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const item of liveContainers) {
      spawnSync(item.engine, ['rm', '--force', item.name], { stdio: 'ignore', timeout: 2000 });
    }
    liveContainers.clear();
  });
}

async function runEngine(engine: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(engine, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true }) as Promise<{ stdout: string; stderr: string }>;
}

function mapGuestPath(handle: ContainerHandle, cwd: unknown): string {
  const value = String(cwd ?? '').trim();
  if (!value || value === handle.hostWorkspace) return handle.guestWorkspace;
  if (value.startsWith(`${handle.hostWorkspace}/`)) return `${handle.guestWorkspace}${value.slice(handle.hostWorkspace.length)}`;
  return handle.guestWorkspace;
}

export async function sweepOrphanContainers(options: { engine?: string; timeoutMs?: number } = {}): Promise<{ engine: string; containers: string[] }> {
  const engine = options.engine || 'docker';
  try {
    const result = await runEngine(engine, ['ps', '--all', '--quiet', '--filter', `label=${LABEL}`], options.timeoutMs ?? PROBE_TIMEOUT_MS);
    const candidates = result.stdout.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    const orphans: string[] = [];
    for (const id of candidates) {
      const details = await runEngine(engine, ['inspect', '--format', '{{ index .Config.Labels "cretli.execution.owner-pid" }} {{ index .Config.Labels "cretli.execution.owner-start" }}', id], options.timeoutMs ?? PROBE_TIMEOUT_MS).catch(() => null);
      if (!details) continue;
      const [pidText, startToken] = details.stdout.trim().split(/\s+/);
      const pid = Number(pidText);
      if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0 || !startToken) continue;
      const currentStart = processStartToken(pid);
      if (currentStart === null || currentStart !== startToken) orphans.push(id);
    }
    if (orphans.length) await runEngine(engine, ['rm', '--force', ...orphans], options.timeoutMs ?? PROBE_TIMEOUT_MS);
    return { engine, containers: orphans };
  } catch {
    return { engine, containers: [] };
  }
}

export function createContainerEnvironment(definition: ExecutionEnvironmentDefinition = {}): ExecutionEnvironment {
  const configuredEngine = String(definition.engine || '').trim();
  const configuredImage = String(definition.image || '').trim() || DEFAULT_IMAGE;
  const guestWorkspace = String(definition.workspacePath || '').trim() || DEFAULT_GUEST_WORKSPACE;
  const environment: ExecutionEnvironment = {
    id: 'container',
    kind: 'container',
    async probe() {
      const candidates = configuredEngine ? [configuredEngine] : ['docker', 'podman'];
      let lastReason = 'No Docker-compatible engine found.';
      for (const engine of candidates) {
        try {
          const result = await runEngine(engine, ['version', '--format', '{{.Server.Version}}']);
          return { available: true, version: result.stdout.trim() || undefined, reason: engine };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException & { killed?: boolean }).code;
          const timedOut = code === 'ETIMEDOUT' || (error as { killed?: boolean; signal?: string }).killed || (error as { signal?: string }).signal === 'SIGTERM';
          if (code === 'ENOENT') lastReason = `${engine} is not installed.`;
          else if (timedOut) lastReason = `${engine} probe timed out.`;
          else lastReason = `${engine} probe failed.`;
        }
      }
      return { available: false, reason: lastReason };
    },
    async prepare(run: unknown = {}): Promise<ContainerHandle> {
      const input = (run && typeof run === 'object' ? run : {}) as ContainerRun;
      const engine = configuredEngine || (await environment.probe()).reason;
      if (!engine || !['docker', 'podman'].includes(engine) && !configuredEngine) throw new Error('No Docker-compatible container engine is available.');
      const ids = currentIds();
      const ownerStart = processStartToken(process.pid) || 'unknown';
      const hostWorkspace = String(input.worktreePath || process.cwd()).trim();
      assertSafeMountPath(hostWorkspace, 'worktree');
      assertSafeMountPath(guestWorkspace, 'guest workspace');
      const name = `cretli-${safePart(input.id, `${process.pid}-${Date.now()}`)}`;
      const envDirectory = path.join(os.tmpdir(), `cretli-env-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(envDirectory, { recursive: true, mode: 0o700 });
      const args = ['create', '--name', name, '--label', LABEL, '--label', `${OWNER_LABEL}=${process.pid}`, '--label', `${OWNER_START_LABEL}=${ownerStart}`, '--network', definition.network || 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
      if (path.basename(engine) === 'podman') args.push('--userns', 'keep-id');
      else args.push('--user', `${ids.uid}:${ids.gid}`);
      args.push('--mount', `type=bind,src=${hostWorkspace},dst=${guestWorkspace}${input.readOnly ?? definition.readOnly ? ',readonly' : ''}`, '--mount', `type=bind,src=${envDirectory},dst=/run/cretli-env,readonly`);
      args.push(configuredImage, 'sleep', 'infinity');
      try {
        await runEngine(engine, args, 10000);
        await runEngine(engine, ['start', name], 10000);
      } catch (error) {
        await runEngine(engine, ['rm', '--force', name], 5000).catch(() => undefined);
        rmSync(envDirectory, { recursive: true, force: true });
        throw error;
      }
      const handle = { engine, name, image: configuredImage, hostWorkspace, guestWorkspace, hostUid: ids.uid, hostGid: ids.gid, envDirectory };
      liveContainers.add(handle);
      installExitHook();
      return handle;
    },
    spawnPty(handleValue: unknown, command: string, args: string[], options: pty.IPtyForkOptions): pty.IPty {
      const handle = handleValue as ContainerHandle;
      const envFile = writeEnvironmentFile(handle.envDirectory, options.env);
      const commandArgs = envFile ? ['sh', '-c', 'set -a; . "$1"; shift; exec "$@"', '--', `/run/cretli-env/${path.basename(envFile)}`, command, ...args] : [command, ...args];
      const childArgs = ['exec', '-i', '-t', '--workdir', mapGuestPath(handle, options.cwd), handle.name, ...commandArgs];
      return pty.spawn(handle.engine, childArgs, { ...options, cwd: undefined, env: process.env });
    },
    spawn(handleValue: unknown, command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams {
      const handle = handleValue as ContainerHandle;
      const envFile = writeEnvironmentFile(handle.envDirectory, options.env as NodeJS.ProcessEnv);
      const commandArgs = envFile ? ['sh', '-c', 'set -a; . "$1"; shift; exec "$@"', '--', `/run/cretli-env/${path.basename(envFile)}`, command, ...args] : [command, ...args];
      const childArgs = ['exec', '--workdir', mapGuestPath(handle, options.cwd), handle.name, ...commandArgs];
      return spawn(handle.engine, childArgs, { ...options, cwd: undefined, env: process.env }) as ChildProcessWithoutNullStreams;
    },
    async stop(handleValue: unknown): Promise<void> {
      const handle = handleValue as ContainerHandle | undefined;
      if (!handle) return;
      liveContainers.delete(handle);
      await runEngine(handle.engine, ['rm', '--force', handle.name], 5000).catch(() => undefined);
      rmSync(handle.envDirectory, { recursive: true, force: true });
    },
  };
  return Object.freeze(environment);
}

export const containerExecutionEnvironment = createContainerEnvironment();
