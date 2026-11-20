/**
 * PortExposureBackend implementations.
 *
 * Interface (all async):
 *   probe()                        -> { kind, canExecute, notes[] }
 *   list()                         -> rules observed for ports (never trusted for close)
 *   expose(port, opts)             -> { state: 'active'|'pending_manual', commands, alternatives?, targetIp? }
 *   close(port, opts)              -> { state: 'closed'|'pending_manual', commands }
 *   reconcile(entries, ctx)        -> { updates: [{ port, patch }] }  (ledger entries only)
 *
 * An `executor` performs the real change (the stage-4 Windows helper, or a fake
 * in tests). Without one every WSL backend behaves like `manual`: it returns the
 * ready commands and `pending_manual`.
 *
 * Executor contract:
 *   executor.run({ op, port, connectAddress? }) -> Promise<{ ok: boolean, error?: string }>
 *     ops: 'portproxy-add' | 'portproxy-delete' | 'firewall-add' | 'firewall-delete'
 *   executor.listRules?() -> Promise<{ portproxy: [{ listenAddress, listenPort, connectAddress, connectPort }], firewall: number[] }>
 *   executor.detectFirewall?() -> Promise<'ufw'|'firewalld'|null>   (linux only)
 */

import {
  natExposeCommands, natCloseCommands, mirroredExposeCommands, mirroredCloseCommands,
  MIRRORED_BROADER_ALTERNATIVE, linuxExposeCommands, linuxCloseCommands,
} from './commands.js';

const failure = (error) => ({ ok: false, error: String(error?.message || error) });

async function runOps(executor, ops) {
  for (const op of ops) {
    let result;
    try { result = await executor.run(op); } catch (error) { result = failure(error); }
    if (!result?.ok) return { ok: false, error: result?.error || 'executor-failed', op: op.op };
  }
  return { ok: true };
}

/** `manual`: only commands; confirmed later by diagnostics. */
export function createManualBackend({ wslIp = null } = {}) {
  return {
    kind: 'manual',
    async probe() { return { kind: 'manual', canExecute: false, notes: ['Commands are shown for you to run.'] }; },
    async list() { return []; },
    async expose(port) {
      // Without a known target the NAT form is the most common manual command; the
      // address placeholder is explicit so the operator notices it.
      return { state: 'pending_manual', commands: natExposeCommands(port, wslIp || '<wsl-ip>'), targetIp: wslIp };
    },
    async close(port) { return { state: 'pending_manual', commands: natCloseCommands(port) }; },
    /** Diagnostics confirm a manual NAT rule: a 0.0.0.0 portproxy for the port that targets a current WSL address. */
    async reconcile(entries, ctx) {
      const observed = ctx.report?.portproxy || [];
      const addresses = ctx.report?.wslAddresses || [];
      const updates = [];
      for (const entry of entries) {
        const rule = observed.find((r) => r.listenPort === entry.port && r.listenAddress === '0.0.0.0'
          && (!addresses.length || addresses.includes(r.connectAddress)));
        if (rule && entry.state === 'pending_manual') updates.push({ port: entry.port, patch: { state: 'active', targetIp: rule.connectAddress } });
        else if (!rule && entry.state === 'active') updates.push({ port: entry.port, patch: { state: 'drift' } });
      }
      return { updates };
    },
  };
}

/** `wsl-nat`: portproxy 0.0.0.0:P -> <WSL IP>:P plus a scoped firewall rule. */
export function createWslNatBackend({ executor = null, getWslIp }) {
  return {
    kind: 'wsl-nat',
    async probe() { return { kind: 'wsl-nat', canExecute: Boolean(executor), notes: executor ? [] : ['Windows helper unavailable; behaves like manual.'] }; },
    async list() {
      if (!executor?.listRules) return [];
      const rules = await executor.listRules();
      return rules.portproxy.filter((r) => r.listenAddress === '0.0.0.0');
    },
    async expose(port) {
      const wslIp = getWslIp();
      if (!wslIp) return { state: 'pending_manual', commands: natExposeCommands(port, '<wsl-ip>'), targetIp: null, error: 'wsl-ip-unknown' };
      const commands = natExposeCommands(port, wslIp);
      if (!executor) return { state: 'pending_manual', commands, targetIp: wslIp };
      const done = await runOps(executor, [
        { op: 'portproxy-add', port, connectAddress: wslIp },
        { op: 'firewall-add', port },
      ]);
      if (!done.ok) return { state: 'pending_manual', commands, targetIp: wslIp, error: done.error };
      return { state: 'active', commands, targetIp: wslIp };
    },
    async close(port) {
      const commands = natCloseCommands(port);
      if (!executor) return { state: 'pending_manual', commands };
      const done = await runOps(executor, [{ op: 'portproxy-delete', port }, { op: 'firewall-delete', port }]);
      return done.ok ? { state: 'closed', commands } : { state: 'pending_manual', commands, error: done.error };
    },
    /**
     * Rewrites only the rules whose ledger entry exists. Compares the entry's
     * target with the current WSL IP and the observed portproxy list.
     */
    async reconcile(entries, ctx) {
      const wslIp = getWslIp();
      const observed = ctx.report?.portproxy || [];
      const updates = [];
      for (const entry of entries) {
        if (entry.state === 'closed') continue;
        const rule = observed.find((r) => r.listenPort === entry.port && r.listenAddress === '0.0.0.0');
        if (!wslIp) continue;
        if (rule && rule.connectAddress === wslIp) {
          if (entry.state !== 'active' || entry.targetIp !== wslIp) updates.push({ port: entry.port, patch: { state: 'active', targetIp: wslIp, commands: undefined } });
          continue;
        }
        if (entry.state === 'pending_manual' && !rule) continue; // Still waiting for the operator.
        // Rule missing or pointing at a stale address: recreate it, or report drift.
        const commands = natExposeCommands(entry.port, wslIp);
        if (!executor) {
          updates.push({ port: entry.port, patch: { state: rule ? 'pending_manual' : 'drift', targetIp: wslIp, commands } });
          continue;
        }
        const done = await runOps(executor, [
          { op: 'portproxy-delete', port: entry.port },
          { op: 'portproxy-add', port: entry.port, connectAddress: wslIp },
          { op: 'firewall-add', port: entry.port },
        ]);
        updates.push({ port: entry.port, patch: done.ok
          ? { state: 'active', targetIp: wslIp }
          : { state: 'drift', targetIp: wslIp, commands, lastError: done.error } });
      }
      return { updates };
    },
  };
}

/** `wsl-mirrored`: only a Hyper-V firewall rule is needed; no portproxy. */
export function createWslMirroredBackend({ executor = null } = {}) {
  return {
    kind: 'wsl-mirrored',
    async probe() { return { kind: 'wsl-mirrored', canExecute: Boolean(executor), notes: executor ? [] : ['Windows helper unavailable; behaves like manual.'] }; },
    async list() { return []; },
    async expose(port) {
      const commands = mirroredExposeCommands(port);
      const alternatives = [MIRRORED_BROADER_ALTERNATIVE];
      if (!executor) return { state: 'pending_manual', commands, alternatives };
      const done = await runOps(executor, [{ op: 'firewall-add', port }]);
      return done.ok ? { state: 'active', commands, alternatives } : { state: 'pending_manual', commands, alternatives, error: done.error };
    },
    async close(port) {
      const commands = mirroredCloseCommands(port);
      if (!executor) return { state: 'pending_manual', commands };
      const done = await runOps(executor, [{ op: 'firewall-delete', port }]);
      return done.ok ? { state: 'closed', commands } : { state: 'pending_manual', commands, error: done.error };
    },
    async reconcile(entries) {
      // The rule does not depend on the WSL IP, so an address change needs no rewrite.
      if (!executor?.listRules) return { updates: [] };
      const rules = await executor.listRules();
      const updates = [];
      for (const entry of entries) {
        if (entry.state === 'closed') continue;
        const present = rules.firewall.includes(entry.port);
        if (present && entry.state !== 'active') updates.push({ port: entry.port, patch: { state: 'active' } });
        if (!present && entry.state === 'active') {
          const done = await runOps(executor, [{ op: 'firewall-add', port: entry.port }]);
          updates.push({ port: entry.port, patch: done.ok ? {} : { state: 'drift', lastError: done.error } });
        }
      }
      return { updates };
    },
  };
}

/** `linux`: nothing to do by default; with an active ufw/firewalld a command is suggested. */
export function createLinuxBackend({ executor = null } = {}) {
  const detect = async () => {
    try { return (await executor?.detectFirewall?.()) || null; } catch { return null; }
  };
  return {
    kind: 'linux',
    async probe() {
      const firewall = await detect();
      return { kind: 'linux', canExecute: false, firewall, notes: firewall ? [`${firewall} is active; a command is suggested.`] : [] };
    },
    async list() { return []; },
    async expose(port) {
      const firewall = await detect();
      if (!firewall) return { state: 'active', commands: [] };
      return { state: 'pending_manual', commands: linuxExposeCommands(port, firewall), firewall };
    },
    async close(port) {
      const firewall = await detect();
      if (!firewall) return { state: 'closed', commands: [] };
      return { state: 'pending_manual', commands: linuxCloseCommands(port, firewall), firewall };
    },
    async reconcile() { return { updates: [] }; },
  };
}

/**
 * Picks the backend kind from the stage-1 report; `override` wins when set.
 * @param {any} report
 * @param {string} [override]
 */
export function selectBackendKind(report, override = 'auto') {
  if (override && override !== 'auto') return override;
  if (report?.platform === 'wsl2') {
    if (report.networkingMode === 'nat') return 'wsl-nat';
    if (report.networkingMode === 'mirrored') return 'wsl-mirrored';
    return 'manual';
  }
  return report?.platform === 'linux' ? 'linux' : 'manual';
}

/**
 * @param {string} kind
 * @param {{ executor?: any, getWslIp?: () => string|null }} deps
 */
export function createBackend(kind, { executor = null, getWslIp = () => null } = {}) {
  if (kind === 'wsl-nat') return createWslNatBackend({ executor, getWslIp });
  if (kind === 'wsl-mirrored') return createWslMirroredBackend({ executor });
  if (kind === 'linux') return createLinuxBackend({ executor });
  return createManualBackend({ wslIp: getWslIp() });
}
