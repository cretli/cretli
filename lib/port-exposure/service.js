/**
 * Port exposure service, shared by REST and the future MCP tools. All policy,
 * hard blocks and close authorization live here so they hold whichever channel
 * calls in.
 *
 * Invariant: `close` and `reconcile` act only on rules confirmed by a ledger
 * entry. Foreign rules are reported with a suggestion and never changed.
 */

import { createBackend, selectBackendKind } from './backends.js';
import { foreignProxyRemoveCommand } from './commands.js';

const OWNER_RE = /^(user|chat:[^\s:]+|app:[^\s:]+)$/;
const HISTORY_LIMIT = 20;

/** Stable machine codes for the hard blocks. */
export const BLOCK_CODES = Object.freeze({
  invalid: 'port-invalid',
  denylisted: 'port-denylisted',
  outOfRange: 'port-out-of-range',
  loopbackOnly: 'port-loopback-only',
});

/** @typedef {{ kind: 'operator' } | { kind: 'agent', chatId: string } | { kind: 'system', reason: string }} Actor */

/** @param {Actor} actor */
export function actorLabel(actor) {
  if (actor.kind === 'operator') return 'user';
  if (actor.kind === 'agent') return `chat:${actor.chatId}`;
  return `system:${actor.reason}`;
}

const fail = (status, error, message, extra = {}) => ({ ok: false, status, error, message, ...extra });
const isLoopback = (addr) => /^127\./.test(addr) || addr === '::1' || addr === '[::1]';

/**
 * @param {{
 *   ledger: ReturnType<typeof import('./ledger.js').createExposureLedger>,
 *   getPolicy: () => ReturnType<typeof import('./policy.js').normalizePortExposurePolicy>,
 *   getReport: (opts?: { refresh?: boolean }) => Promise<any>,
 *   executor?: any,
 *   makeBackend?: (kind: string, report: any) => any,
 *   now?: () => number,
 *   broadcast?: (event: any) => void,
 * }} deps
 */
export function createPortExposureService(deps) {
  const now = deps.now || Date.now;
  const broadcast = deps.broadcast || (() => {});
  const safeReport = async (opts) => { try { return await deps.getReport(opts); } catch { return null; } };
  const backendFor = (kind, report) => (deps.makeBackend
    ? deps.makeBackend(kind, report)
    : createBackend(kind, { executor: deps.executor || null, getWslIp: () => report?.wslAddresses?.[0] || null }));

  /** Serializes mutations so TTL sweeps, reconcile and API calls never interleave. */
  /** @type {Promise<any>} */
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  function checkHardBlocks(port, policy, report) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return fail(400, BLOCK_CODES.invalid, 'Port must be an integer between 1 and 65535.');
    }
    if (policy.denylist.includes(port)) {
      return fail(403, BLOCK_CODES.denylisted, `Port ${port} is on the exposure denylist.`);
    }
    if (port < policy.range.min || port > policy.range.max) {
      return fail(403, BLOCK_CODES.outOfRange, `Port ${port} is outside the allowed range ${policy.range.min}-${policy.range.max}.`);
    }
    const listeners = (report?.listeners || []).filter((l) => l.port === port);
    if (listeners.length && listeners.every((l) => isLoopback(l.address))) {
      return fail(409, BLOCK_CODES.loopbackOnly, `Port ${port} listens only on 127.0.0.1. Change the application bind address (for example 0.0.0.0) first.`);
    }
    return null;
  }

  /** Closes one ledger entry through its backend and records the actor. */
  async function closeEntry(entry, actor, closeReason) {
    const report = await safeReport();
    const backend = backendFor(entry.backend, report);
    const result = await backend.close(entry.port, { entry });
    if (result.error) {
      // The rule may still exist; keep the entry so it stays managed and retryable.
      entry.lastError !== result.error && deps.ledger.patch(entry.port, { lastError: result.error });
      return fail(502, 'close-failed', `Could not remove the rule for port ${entry.port}: ${result.error}`, { commands: result.commands });
    }
    const requestedBy = entry.closeRequestedBy || actorLabel(actor);
    if (result.state === 'pending_manual') {
      // Cretli did not remove the rule: keep the entry open (so TTL and reconcile still see it)
      // and wait for diagnostics to confirm the removal. Repeated calls refresh the commands.
      const pending = deps.ledger.patch(entry.port, {
        state: 'close_pending',
        closeRequestedAt: entry.closeRequestedAt || new Date(now()).toISOString(),
        closeRequestedBy: requestedBy,
        closeReason: entry.closeReason || closeReason,
        commands: result.commands,
        lastError: undefined,
      });
      broadcast({ type: 'portExposuresChanged', reason: 'close-pending', port: entry.port });
      return { ok: true, entry: pending, closeState: 'pending_manual', commands: result.commands };
    }
    return finalizeClose(entry, requestedBy, entry.closeReason || closeReason, result);
  }

  /** Marks the entry closed and records who asked for it. */
  function finalizeClose(entry, closedBy, closeReason, result = { commands: [] }) {
    const closed = deps.ledger.patch(entry.port, {
      state: 'closed',
      closedAt: new Date(now()).toISOString(),
      closedBy,
      closeReason,
      commands: undefined,
      lastError: undefined,
    });
    broadcast({ type: 'portExposuresChanged', reason: 'closed', port: entry.port });
    return { ok: true, entry: closed, closeState: 'closed', commands: result.commands };
  }

  /**
   * True only when diagnostics positively show the rule is absent. Portproxy is the one
   * observable (NAT / manual); other backends stay pending until an executor closes them.
   */
  function isRuleGone(entry, report) {
    if (!['wsl-nat', 'manual'].includes(entry.backend)) return false;
    if (report?.availability?.portproxy !== true) return false;
    return !(report.portproxy || []).some((r) => r.listenPort === entry.port && (r.listenAddress === '0.0.0.0' || r.listenAddress === '*'));
  }

  const service = {
    /**
     * Hard blocks only (denylist, range, loopback-only), no side effects. Lets a caller refuse
     * before asking a user for consent.
     * @param {number} port
     */
    precheck: async (port) => checkHardBlocks(Number(port), deps.getPolicy(), await safeReport({ refresh: true })),

    /**
     * @param {{ port: number, reason?: string, ttlMs?: number, owner?: string }} input
     * @param {Actor} actor
     * @param {{ consented?: boolean }} [opts] `consented`: the user approved this agent call (policy `ask`);
     *   hard blocks and `never` still apply.
     */
    expose: (input, actor, opts = {}) => exclusive(async () => {
      const policy = deps.getPolicy();
      const port = Number(input?.port);
      let owner;
      if (actor.kind === 'agent') {
        if (!actor.chatId) return fail(400, 'actor-invalid', 'Agent context needs a chat id.');
        if (policy.agentMode === 'never') return fail(403, 'agent-exposure-disabled', 'Policy does not let agents expose ports.');
        if (policy.agentMode === 'ask' && opts.consented !== true) return fail(403, 'agent-approval-required', 'An operator must approve or perform this exposure.');
        owner = `chat:${actor.chatId}`;
      } else {
        owner = input?.owner || 'user';
        if (!OWNER_RE.test(owner) || owner.startsWith('chat:')) {
          return fail(400, 'owner-invalid', 'Owner must be "user" or "app:<id>".');
        }
      }
      const report = await safeReport({ refresh: true });
      const blocked = checkHardBlocks(port, policy, report);
      if (blocked) return blocked;
      if (deps.ledger.get(port)) return fail(409, 'already-exposed', `Port ${port} already has an exposure in the ledger.`);

      const requested = Number(input?.ttlMs);
      const ttlMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, policy.maxTtlMs) : policy.defaultTtlMs;
      const kind = selectBackendKind(report, policy.backend);
      const result = await backendFor(kind, report).expose(port, { owner });
      const createdAt = new Date(now()).toISOString();
      const entry = deps.ledger.put({
        port,
        backend: kind,
        owner,
        createdBy: actorLabel(actor),
        reason: String(input?.reason || '').slice(0, 300),
        createdAt,
        expiresAt: new Date(now() + ttlMs).toISOString(),
        state: result.state,
        ...(result.targetIp ? { targetIp: result.targetIp } : {}),
        ...(result.commands?.length ? { commands: result.commands } : {}),
        ...(result.error ? { lastError: result.error } : {}),
      });
      broadcast({ type: 'portExposuresChanged', reason: 'exposed', port });
      return { ok: true, entry, commands: result.commands || [], alternatives: result.alternatives || [] };
    }),

    /**
     * @param {number} port
     * @param {Actor} actor
     */
    close: (port, actor) => exclusive(async () => {
      const entry = deps.ledger.get(Number(port));
      if (!entry) {
        return fail(404, 'not-in-ledger', `Port ${port} has no Cretli exposure. Rules that are not in the ledger are never closed by Cretli.`);
      }
      if (actor.kind === 'agent' && entry.owner !== `chat:${actor.chatId}`) {
        return fail(403, 'close-forbidden', 'An agent can close only exposures owned by its own chat.');
      }
      return closeEntry(entry, actor, 'requested');
    }),

    /** Closes every open exposure owned by the app (called when the app stops). */
    closeForApp: (appId) => exclusive(async () => {
      const closed = [];
      for (const entry of deps.ledger.open().filter((e) => e.owner === `app:${appId}` && e.state !== 'close_pending')) {
        const r = await closeEntry(entry, { kind: 'system', reason: `app-stop:${appId}` }, 'app-stopped');
        if (r.ok) closed.push(entry.port);
      }
      return { ok: true, closed };
    }),

    /** Closes every open exposure owned by the chat (called when the chat is archived). */
    closeForChat: (chatId) => exclusive(async () => {
      const closed = [];
      for (const entry of deps.ledger.open().filter((e) => e.owner === `chat:${chatId}` && e.state !== 'close_pending')) {
        const r = await closeEntry(entry, { kind: 'system', reason: `chat-archived:${chatId}` }, 'chat-archived');
        if (r.ok) closed.push(entry.port);
      }
      return { ok: true, closed };
    }),

    /** Closes entries past their TTL. */
    sweepExpired: () => exclusive(async () => {
      const closed = [];
      for (const entry of deps.ledger.open()) {
        if (entry.state !== 'close_pending' && entry.expiresAt && Date.parse(entry.expiresAt) <= now()) {
          const r = await closeEntry(entry, { kind: 'system', reason: 'ttl' }, 'expired');
          if (r.ok) closed.push(entry.port);
        }
      }
      return { ok: true, closed };
    }),

    /**
     * Rewrites rules for ledger entries after an address change and recreates or
     * flags missing ones. Updates for ports outside the ledger are discarded.
     */
    reconcile: () => exclusive(async () => {
      const report = await safeReport({ refresh: true });
      const all = deps.ledger.open();
      const changed = [];
      // Entries waiting for a manual removal are confirmed gone by diagnostics, never repaired.
      for (const entry of all.filter((e) => e.state === 'close_pending')) {
        if (isRuleGone(entry, report)) {
          finalizeClose(entry, entry.closeRequestedBy || 'system:reconcile', entry.closeReason || 'requested');
          changed.push(entry.port);
        }
      }
      const entries = all.filter((e) => e.state !== 'close_pending');
      const byBackend = new Map();
      for (const e of entries) byBackend.set(e.backend, [...(byBackend.get(e.backend) || []), e]);
      for (const [kind, group] of byBackend) {
        let result;
        try { result = await backendFor(kind, report).reconcile(group, { report }); } catch { continue; }
        for (const { port, patch } of result.updates || []) {
          const current = group.find((e) => e.port === port);
          if (!current) continue; // Only ledger entries may be touched.
          const differs = Object.keys(patch).some((k) => k !== 'commands' && patch[k] !== current[k]);
          if (!differs) continue;
          deps.ledger.patch(port, patch);
          changed.push(port);
        }
      }
      if (changed.length) broadcast({ type: 'portExposuresChanged', reason: 'reconciled' });
      return { ok: true, changed, foreign: service.foreignFrom(report) };
    }),

    /** One periodic pass: TTL first, then reconcile. */
    tick: async () => {
      const swept = await service.sweepExpired();
      const reconciled = await service.reconcile();
      return { swept: swept.closed, reconciled: reconciled.changed };
    },

    /** Foreign 0.0.0.0 portproxy rules: shown with a suggestion, never removed by Cretli. */
    foreignFrom(report) {
      const policy = deps.getPolicy();
      const managed = new Set(deps.ledger.open().map((e) => e.port));
      return (report?.portproxy || [])
        .filter((r) => (r.listenAddress === '0.0.0.0' || r.listenAddress === '*') && !managed.has(r.listenPort))
        .map((r) => {
          const command = foreignProxyRemoveCommand(r.listenPort);
          const denylisted = policy.denylist.includes(r.listenPort);
          return {
            port: r.listenPort,
            connectAddress: r.connectAddress,
            connectPort: r.connectPort,
            managed: false,
            suggestion: `This rule is not managed by Cretli. To remove it, run in an elevated PowerShell: ${command}`,
            command,
            ...(denylisted ? { warning: 'foreign-denylisted-port' } : {}),
          };
        });
    },

    async list({ refresh = false } = {}) {
      const report = await safeReport({ refresh });
      const policy = deps.getPolicy();
      const kind = selectBackendKind(report, policy.backend);
      let probe = null;
      try { probe = await backendFor(kind, report).probe(); } catch { /* Probe is informational. */ }
      return {
        ok: true,
        policy,
        backend: probe || { kind, canExecute: false, notes: [] },
        exposures: deps.ledger.open(),
        history: deps.ledger.history().slice(-HISTORY_LIMIT),
        foreign: service.foreignFrom(report),
      };
    },
  };
  return service;
}
