import pty from 'node-pty';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

export type ExecutionEnvironmentKind = 'host' | 'container' | 'bubblewrap' | 'ssh' | 'vm';

export type ExecutionEnvironment = {
  id: string;
  kind: ExecutionEnvironmentKind;
  probe(): Promise<{ available: boolean; version?: string; reason?: string }>;
  prepare(run?: unknown): Promise<unknown>;
  spawnPty(handle: unknown, command: string, args: string[], options: pty.IPtyForkOptions): pty.IPty;
  spawn(handle: unknown, command: string, args: string[], options: SpawnOptions): ChildProcessWithoutNullStreams;
  stop(handle: unknown, options?: { force?: boolean }): Promise<void>;
};

export const hostExecutionEnvironment: ExecutionEnvironment = Object.freeze({
  id: 'host',
  kind: 'host',
  async probe() { return { available: true }; },
  async prepare() { return undefined; },
  spawnPty(_handle, command, args, options) { return pty.spawn(command, args, options); },
  spawn(_handle, command, args, options) { return spawn(command, args, options) as ChildProcessWithoutNullStreams; },
  async stop() {},
});

export function resolveExecutionEnvironment(options: { environment?: unknown; policyDefault?: unknown } = {}): ExecutionEnvironment {
  const raw = String(options.environment ?? options.policyDefault ?? 'host').trim().toLowerCase() || 'host';
  if (raw === 'host' || raw === 'inherit') return hostExecutionEnvironment;
  throw new Error(`Unknown execution environment ${JSON.stringify(raw)}; expected host.`);
}
