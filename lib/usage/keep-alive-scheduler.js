/**
 * Bounded, opt-in keep-alive scheduler for resumed reviewer sessions.
 *
 * A "ping" is a real provider request issued into the SAME harness session as a
 * finished review delegation (never a new chat, never a mailbox message). The
 * scheduler owns only the policy loop; every side effect is an injected
 * dependency so the whole behaviour is testable without a provider:
 *
 * - plans live in memory only. A server restart drops them (`server_restart`
 *   is reported, nothing is caught up), because a stale schedule that fires
 *   after a restart would pay for a cache that is already gone;
 * - one plan per review delegation, at most one ping in flight per plan, and a
 *   deterministic request id so a replayed call can never pay twice;
 * - a ping never creates a delegation, report or verdict, never changes a TODO
 *   status and never preempts a running turn or a user command.
 *
 * Delivery is not success: a ping counts as effective only when the provider
 * usage of that request proves a cache read. Missing usage is `unconfirmed`
 * and its cost is `unknown`, which blocks a budgeted plan from continuing.
 */

import { randomUUID } from 'node:crypto';
import { delegationController } from '../delegation-control.js';
import {
  KEEP_ALIVE_LIMITS,
  KEEP_ALIVE_MODE,
  KEEP_ALIVE_STOP_REASON,
  decideKeepAliveAction,
  describeKeepAliveBudget,
  estimateKeepAliveEconomics,
  evaluateKeepAliveAvailability,
  normalizeKeepAliveLimits,
} from './keep-alive-policy.js';

/** Bounded in-memory state so a long-lived server never grows without limit. */
export const KEEP_ALIVE_STATE_LIMITS = Object.freeze({
  maxPlans: 100,
  maxAuditEntries: 400,
  maxPingsPerPlan: 20,
  /** How long a requested ping may wait for provider usage before `unconfirmed`. */
  settleTimeoutMs: 3 * 60 * 1000,
});

/** Ping prompt: minimal and explicitly NOT a review turn. */
export const KEEP_ALIVE_PING_PROMPT = [
  '[CACHE KEEP-ALIVE]',
  'This is an automated session keep-alive, not a review round.',
  'Reply with exactly: OK',
  'Do not read files, do not run tools, and do not write a report or a verdict.',
].join('\n');

/** Stable audit event ids. */
export const KEEP_ALIVE_AUDIT = Object.freeze({
  PLAN_CREATED: 'plan_created',
  PLAN_REFUSED: 'plan_refused',
  PING_REQUESTED: 'ping_requested',
  PING_DEFERRED: 'ping_deferred',
  PING_FAILED: 'ping_failed',
  PING_SETTLED: 'ping_settled',
  PLAN_STOPPED: 'plan_stopped',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {object} plan
 * @returns {object}
 */
function publicPlan(plan) {
  return {
    id: plan.id,
    mode: plan.mode,
    status: plan.status,
    controllerChatId: plan.controllerChatId,
    delegationId: plan.delegationId,
    chatId: plan.chatId,
    leafId: plan.leafId,
    harness: plan.harness,
    model: plan.model,
    generation: plan.generation,
    createdAt: plan.createdAt,
    limits: { ...plan.limits },
    budget: describeKeepAliveBudget(plan),
    pingsDone: plan.pingsDone,
    ineffectiveStreak: plan.ineffectiveStreak,
    lastPingAt: plan.lastPingAt,
    nextAttemptAt: plan.status === 'active' ? plan.nextAttemptAt : null,
    stopReason: plan.stopReason || null,
    stoppedAt: plan.stoppedAt,
    lastDefer: plan.lastDefer ? { ...plan.lastDefer } : null,
    autoAvailability: { ...plan.autoAvailability },
    pings: plan.pings.map((ping) => ({ ...ping })),
  };
}

/**
 * @param {{
 *   now?: () => number,
 *   loadDelegation: (id: string) => object|null,
 *   loadChat: (chatId: string) => object|null,
 *   getCapabilities: (transport: string) => { canResumeSession?: boolean },
 *   readSessionId: (transport: string, chat: object) => string,
 *   getGeneration: (chatId: string) => number,
 *   getFreshness: (chatId: string, options: { now: number }) => object,
 *   isRunBusy: (chatId: string) => boolean,
 *   hasActiveDelegationOnChat: (chatId: string, exceptDelegationId: string) => boolean,
 *   hasNewerDelegationOnChat: (chatId: string, delegationId: string) => boolean,
 *   isWorkflowEnded: (row: object) => boolean,
 *   isProviderLimited: (input: { transport: string, model: string, workspaceFolder: string }) => boolean,
 *   startPing: (input: { chatId: string, delegationId: string, prompt: string, requestId: string }) => Promise<{ accepted?: boolean, runId?: string }>,
 *   readPingUsage: (input: { chatId: string, runId: string, sinceMs: number }) => { events: number, usd: number|null, estimated: boolean, cachedInputTokens: number, contextTokens: number|null } | null,
 *   resolveRates: (input: { transport: string, model: string }) => object|null,
 *   loadGate: () => { decision?: string, reasons?: string[] } | null,
 *   audit?: (entry: object) => void,
 * }} deps
 */
export function createKeepAliveScheduler(deps) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  /** @type {Map<string, object>} plan id (= review delegation id) -> plan */
  const plans = new Map();
  /** @type {Map<string, number>} chat id -> last non-keep-alive turn start */
  const foreignTurns = new Map();
  /** @type {object[]} */
  const auditLog = [];
  /** @type {Map<string, object>} idempotency key -> result */
  const replay = new Map();

  function audit(event, plan, detail = {}) {
    const entry = {
      at: now(),
      event,
      planId: plan?.id || text(detail.planId),
      delegationId: plan?.delegationId || text(detail.delegationId),
      chatId: plan?.chatId || text(detail.chatId),
      ...detail,
    };
    auditLog.push(entry);
    while (auditLog.length > KEEP_ALIVE_STATE_LIMITS.maxAuditEntries) auditLog.shift();
    try {
      deps.audit?.(entry);
    } catch {
      // The audit sink must never break the scheduler.
    }
  }

  function refuse(code, reason, detail = {}) {
    audit(KEEP_ALIVE_AUDIT.PLAN_REFUSED, null, { code, reason, ...detail });
    return { ok: false, code, reason };
  }

  function stopPlan(plan, reason, detail = {}) {
    if (plan.status !== 'active') return;
    plan.status = 'stopped';
    plan.stopReason = reason;
    plan.stoppedAt = now();
    plan.nextAttemptAt = null;
    audit(KEEP_ALIVE_AUDIT.PLAN_STOPPED, plan, { reason, ...detail });
  }

  /**
   * Settles requested pings whose run finished (or timed out). Cost and
   * effectiveness come from the provider usage of that very request only.
   */
  function settle(plan) {
    for (const ping of plan.pings) {
      if (ping.status !== 'requested') continue;
      const busy = ping.runId ? deps.isRunBusy(plan.chatId) : false;
      if (busy) continue;
      const usage = ping.runId
        ? deps.readPingUsage({ chatId: plan.chatId, runId: ping.runId, sinceMs: ping.at })
        : null;
      const timedOut = now() - ping.at >= KEEP_ALIVE_STATE_LIMITS.settleTimeoutMs;
      if (!usage || usage.events <= 0) {
        if (!timedOut) continue;
        ping.status = 'unconfirmed';
        ping.effective = null;
        ping.costUsd = null;
        plan.unknownCostPings += 1;
        plan.ineffectiveStreak += 1;
        audit(KEEP_ALIVE_AUDIT.PING_SETTLED, plan, { seq: ping.seq, status: 'unconfirmed', requestId: ping.requestId });
        continue;
      }
      ping.status = 'settled';
      ping.effective = usage.cachedInputTokens > 0;
      ping.cachedInputTokens = usage.cachedInputTokens;
      ping.estimated = usage.estimated === true;
      if (usage.usd == null) {
        ping.costUsd = null;
        plan.unknownCostPings += 1;
      } else {
        ping.costUsd = usage.usd;
        plan.spentUsd = Number((plan.spentUsd + usage.usd).toFixed(6));
      }
      plan.ineffectiveStreak = ping.effective ? 0 : plan.ineffectiveStreak + 1;
      audit(KEEP_ALIVE_AUDIT.PING_SETTLED, plan, {
        seq: ping.seq,
        status: 'settled',
        effective: ping.effective,
        costUsd: ping.costUsd,
        estimated: ping.estimated,
        requestId: ping.requestId,
      });
    }
  }

  /** Re-reads everything that can invalidate a plan, right before acting. */
  function snapshot(plan) {
    const t = now();
    const row = deps.loadDelegation(plan.delegationId);
    const chat = deps.loadChat(plan.chatId);
    const freshness = chat ? deps.getFreshness(plan.chatId, { now: t }) : null;
    const rates = deps.resolveRates({ transport: plan.harness, model: plan.model });
    const contextTokens = freshness?.context?.inputTokens ?? null;
    return {
      now: t,
      row,
      chat,
      cancelled: !row || text(row.status) === 'cancelled',
      workflowEnded: row ? deps.isWorkflowEnded(row) : true,
      superseded: deps.hasNewerDelegationOnChat(plan.chatId, plan.delegationId),
      generation: deps.getGeneration(plan.chatId),
      providerLimited: deps.isProviderLimited({
        transport: plan.harness,
        model: plan.model,
        workspaceFolder: text(row?.workspaceFolder),
      }),
      busy: deps.isRunBusy(plan.chatId) || deps.hasActiveDelegationOnChat(plan.chatId, plan.delegationId),
      lastForeignTurnAt: foreignTurns.get(plan.chatId) ?? null,
      freshness: freshness
        ? {
          ttlKnown: freshness.cache?.ttlKnown === true,
          expiresAt: freshness.cache?.expiresAt ?? null,
          state: freshness.cache?.state,
        }
        : null,
      economics: estimateKeepAliveEconomics({ contextTokens, rates }),
    };
  }

  function decide(plan, snap, forced) {
    if (snap.superseded) return { action: 'stop', reason: KEEP_ALIVE_STOP_REASON.NOT_NEEDED };
    return decideKeepAliveAction({
      plan,
      now: snap.now,
      forced,
      chatExists: snap.chat != null,
      cancelled: snap.cancelled,
      workflowEnded: snap.workflowEnded,
      generation: snap.generation,
      providerLimited: snap.providerLimited,
      busy: snap.busy,
      lastForeignTurnAt: snap.lastForeignTurnAt,
      freshness: snap.freshness,
      economics: snap.economics,
    });
  }

  /**
   * Issues the request. Called only after a fresh `ping` decision. The plan is
   * marked in flight BEFORE the first await so a concurrent tick or a replayed
   * manual call sees it and defers instead of paying twice.
   */
  async function issuePing(plan, trigger, key) {
    const seq = plan.pingsDone + 1;
    // The plan nonce keeps a re-created plan from replaying an old plan's request.
    const requestId = `keepalive:${plan.id}:${plan.nonce}:${key || `auto-${seq}`}`;
    plan.inFlight = true;
    const at = now();
    const ping = {
      seq, requestId, trigger, at, runId: '', status: 'requested', effective: null, costUsd: null, estimated: false, cachedInputTokens: null,
    };
    audit(KEEP_ALIVE_AUDIT.PING_REQUESTED, plan, { seq, trigger, requestId });
    try {
      const result = await deps.startPing({
        chatId: plan.chatId,
        delegationId: plan.delegationId,
        prompt: KEEP_ALIVE_PING_PROMPT,
        requestId,
      });
      // Acceptance by the executor is the only evidence a request exists.
      if (!result || result.accepted !== true) {
        const error = new Error('Ping was not accepted by the session');
        error.code = 'not_accepted';
        throw error;
      }
      ping.runId = text(result.runId);
      plan.pingsDone += 1;
      plan.lastPingAt = at;
      plan.pings.push(ping);
      while (plan.pings.length > KEEP_ALIVE_STATE_LIMITS.maxPingsPerPlan) plan.pings.shift();
      return { ok: true, status: 'requested', ping: { ...ping } };
    } catch (error) {
      const code = text(error?.code) || 'error';
      audit(KEEP_ALIVE_AUDIT.PING_FAILED, plan, { seq, code, requestId });
      if (code === 'recipient_busy') {
        plan.lastDefer = { reason: 'busy', at: now() };
        return { ok: false, code: 'deferred', reason: 'busy' };
      }
      stopPlan(plan, KEEP_ALIVE_STOP_REASON.ERROR, { code });
      return { ok: false, code: 'ping_failed', reason: code };
    } finally {
      plan.inFlight = false;
    }
  }

  function findPlan(delegationId, controllerChatId) {
    const plan = plans.get(text(delegationId));
    if (!plan || plan.controllerChatId !== text(controllerChatId)) return null;
    return plan;
  }

  return {
    /**
     * Creates a plan for a finished review delegation's session.
     *
     * @param {{ controllerChatId: string, delegationId: string, mode?: string, idempotencyKey?: string, limits?: object }} input
     */
    configure(input) {
      const controller = text(input?.controllerChatId);
      const delegationId = text(input?.delegationId);
      const mode = text(input?.mode).toLowerCase() || KEEP_ALIVE_MODE.MANUAL;
      const key = text(input?.idempotencyKey);
      if (key && replay.has(`configure:${controller}:${key}`)) return replay.get(`configure:${controller}:${key}`);
      const finish = (result) => {
        if (key && result.ok) replay.set(`configure:${controller}:${key}`, result);
        return result;
      };
      if (mode === KEEP_ALIVE_MODE.OFF) {
        const existing = findPlan(delegationId, controller);
        if (existing) stopPlan(existing, KEEP_ALIVE_STOP_REASON.USER_STOPPED);
        return finish({ ok: true, plan: existing ? publicPlan(existing) : null, mode: KEEP_ALIVE_MODE.OFF });
      }
      if (mode !== KEEP_ALIVE_MODE.MANUAL && mode !== KEEP_ALIVE_MODE.AUTO) {
        return refuse('invalid_mode', `Unknown mode: ${mode}`, { delegationId });
      }
      const row = deps.loadDelegation(delegationId);
      const rowController = delegationController(row);
      // A foreign controller's row is reported as missing: no existence leak.
      if (!row || !controller || rowController !== controller) {
        return refuse('not_found', 'Review delegation not found for this chat.', { delegationId });
      }
      if (text(row.assignment).toLowerCase() !== 'review') {
        return refuse('not_review', 'Keep-alive applies to review delegations only.', { delegationId });
      }
      if (text(row.status) !== 'completed') {
        return refuse('not_finished', 'The review delegation must be completed (idle) before keep-alive.', { delegationId });
      }
      const chatId = text(row.childChatId);
      const chat = chatId ? deps.loadChat(chatId) : null;
      const harness = text(row.executor?.transport).toLowerCase();
      const existing = plans.get(delegationId);
      if (existing?.status === 'active') {
        return refuse('plan_exists', 'A keep-alive plan is already active for this delegation; stop it first.', { delegationId });
      }
      const t = now();
      const limits = normalizeKeepAliveLimits(input?.limits || {}, t);
      const freshness = chat ? deps.getFreshness(chatId, { now: t }) : null;
      const rates = deps.resolveRates({ transport: harness, model: text(row.executor?.model) });
      const availability = evaluateKeepAliveAvailability({
        canResumeSession: deps.getCapabilities(harness)?.canResumeSession === true,
        hasSessionId: chat != null && deps.readSessionId(harness, chat) !== '',
        ttlKnown: freshness?.cache?.ttlKnown === true,
        tariffKnown: rates != null,
        budgetUsd: limits.budgetUsd,
        expectNextRoundUntil: limits.expectNextRoundUntil,
        gate: deps.loadGate(),
      });
      const chosen = mode === KEEP_ALIVE_MODE.AUTO ? availability.auto : availability.manual;
      if (!chosen.available) {
        return refuse(`${mode}_unavailable`, chosen.reason, { delegationId, availability });
      }
      if (plans.size >= KEEP_ALIVE_STATE_LIMITS.maxPlans) {
        for (const [id, candidate] of plans) {
          if (candidate.status !== 'active') plans.delete(id);
          if (plans.size < KEEP_ALIVE_STATE_LIMITS.maxPlans) break;
        }
        if (plans.size >= KEEP_ALIVE_STATE_LIMITS.maxPlans) {
          return refuse('too_many_plans', 'Too many keep-alive plans.', { delegationId });
        }
      }
      const plan = {
        id: delegationId,
        mode,
        status: 'active',
        controllerChatId: controller,
        delegationId,
        chatId,
        leafId: text(row.leafId),
        harness,
        model: text(row.executor?.model),
        generation: deps.getGeneration(chatId),
        limits,
        createdAt: t,
        nonce: randomUUID().slice(0, 8),
        pingsDone: 0,
        spentUsd: 0,
        unknownCostPings: 0,
        ineffectiveStreak: 0,
        lastPingAt: null,
        lastEvaluatedAt: null,
        nextAttemptAt: null,
        inFlight: false,
        stopReason: '',
        stoppedAt: null,
        lastDefer: null,
        autoAvailability: availability.auto,
        pings: [],
      };
      plans.set(delegationId, plan);
      audit(KEEP_ALIVE_AUDIT.PLAN_CREATED, plan, { mode, limits });
      return finish({ ok: true, plan: publicPlan(plan) });
    },

    /**
     * Manual ping. Honours every stop and deferral; only the due-ness check is
     * skipped because the caller decided to pay now.
     *
     * @param {{ controllerChatId: string, delegationId: string, idempotencyKey?: string }} input
     */
    async ping(input) {
      const plan = findPlan(input?.delegationId, input?.controllerChatId);
      if (!plan) return { ok: false, code: 'not_found', reason: 'No keep-alive plan for this delegation.' };
      const key = text(input?.idempotencyKey);
      const replayKey = key ? `ping:${plan.id}:${plan.nonce}:${key}` : '';
      if (replayKey && replay.has(replayKey)) return replay.get(replayKey);
      if (plan.status !== 'active') {
        return { ok: false, code: 'stopped', reason: plan.stopReason, plan: publicPlan(plan) };
      }
      settle(plan);
      const snap = snapshot(plan);
      const decision = decide(plan, snap, true);
      plan.lastEvaluatedAt = snap.now;
      if (decision.action === 'stop') {
        stopPlan(plan, decision.reason);
        return { ok: false, code: 'stopped', reason: decision.reason, plan: publicPlan(plan) };
      }
      if (decision.action === 'defer') {
        plan.lastDefer = { reason: decision.reason, at: snap.now };
        plan.nextAttemptAt = decision.retryAt ?? null;
        audit(KEEP_ALIVE_AUDIT.PING_DEFERRED, plan, { reason: decision.reason, trigger: 'manual' });
        return { ok: false, code: 'deferred', reason: decision.reason, retryAt: decision.retryAt ?? null, plan: publicPlan(plan) };
      }
      const result = await issuePing(plan, 'manual', key || `manual-${plan.pingsDone + 1}`);
      const out = { ...result, plan: publicPlan(plan) };
      if (replayKey && result.ok) replay.set(replayKey, out);
      return out;
    },

    /**
     * One scheduler pass. At most ONE ping per plan per pass and no backlog:
     * a missed window (sleep, restart, slow tick) becomes `cache_expired`, not a
     * burst of catch-up pings.
     */
    async tick() {
      const results = [];
      for (const plan of plans.values()) {
        if (plan.status !== 'active') continue;
        settle(plan);
        if (plan.mode !== KEEP_ALIVE_MODE.AUTO) {
          const snap = snapshot(plan);
          const terminal = decide(plan, snap, true);
          if (terminal.action === 'stop') stopPlan(plan, terminal.reason);
          continue;
        }
        const snap = snapshot(plan);
        plan.lastEvaluatedAt = snap.now;
        const decision = decide(plan, snap, false);
        if (decision.action === 'stop') {
          stopPlan(plan, decision.reason);
          results.push({ planId: plan.id, action: 'stop', reason: decision.reason });
        } else if (decision.action === 'defer') {
          plan.lastDefer = { reason: decision.reason, at: snap.now };
          plan.nextAttemptAt = decision.retryAt ?? null;
          results.push({ planId: plan.id, action: 'defer', reason: decision.reason });
        } else {
          const outcome = await issuePing(plan, 'auto', '');
          results.push({ planId: plan.id, action: 'ping', ok: outcome.ok });
        }
      }
      return results;
    },

    /**
     * @param {{ controllerChatId: string, delegationId: string, reason?: string }} input
     */
    stop(input) {
      const plan = findPlan(input?.delegationId, input?.controllerChatId);
      if (!plan) return { ok: false, code: 'not_found', reason: 'No keep-alive plan for this delegation.' };
      const reason = text(input?.reason);
      const allowed = [KEEP_ALIVE_STOP_REASON.USER_STOPPED, KEEP_ALIVE_STOP_REASON.CANCELLED, KEEP_ALIVE_STOP_REASON.WORKFLOW_ENDED];
      stopPlan(plan, allowed.includes(reason) ? reason : KEEP_ALIVE_STOP_REASON.USER_STOPPED);
      return { ok: true, plan: publicPlan(plan) };
    },

    /**
     * Read-only view: no request is issued. It settles finished pings so the
     * budget shown is current.
     *
     * @param {{ controllerChatId: string, delegationId?: string }} input
     */
    status(input) {
      const controller = text(input?.controllerChatId);
      const wanted = text(input?.delegationId);
      const rows = [];
      for (const plan of plans.values()) {
        if (plan.controllerChatId !== controller) continue;
        if (wanted && plan.delegationId !== wanted) continue;
        if (plan.status === 'active') settle(plan);
        rows.push(publicPlan(plan));
      }
      return {
        ok: true,
        defaultMode: KEEP_ALIVE_MODE.OFF,
        requestIssued: false,
        gate: deps.loadGate(),
        plans: rows,
      };
    },

    /**
     * Operator overview (Settings → Usage): every plan, newest first. Same
     * local read as `status`; it never issues a request.
     */
    overview() {
      const rows = [];
      for (const plan of plans.values()) {
        if (plan.status === 'active') settle(plan);
        rows.push(publicPlan(plan));
      }
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return { ok: true, defaultMode: KEEP_ALIVE_MODE.OFF, requestIssued: false, gate: deps.loadGate(), plans: rows };
    },

    /** Records a turn that was not started by keep-alive (user command etc.). */
    noteForeignTurn(chatId, at = now()) {
      const id = text(chatId);
      if (!id) return;
      foreignTurns.set(id, at);
      while (foreignTurns.size > KEEP_ALIVE_STATE_LIMITS.maxPlans * 4) {
        foreignTurns.delete(foreignTurns.keys().next().value);
      }
    },

    /** Stops every plan of a chat/delegation, e.g. on cancel or reset. */
    stopForChat(chatId, reason) {
      for (const plan of plans.values()) {
        if (plan.chatId === text(chatId) || plan.controllerChatId === text(chatId)) stopPlan(plan, reason);
      }
    },

    getAudit(limit = 50) {
      return auditLog.slice(-Math.max(1, Math.min(limit, KEEP_ALIVE_STATE_LIMITS.maxAuditEntries)));
    },

    /** Pings (with run ids) for workflow cost attribution. */
    listPings() {
      const out = [];
      for (const plan of plans.values()) {
        for (const ping of plan.pings) {
          out.push({
            leafId: plan.leafId,
            delegationId: plan.delegationId,
            chatId: plan.chatId,
            runId: ping.runId,
            at: ping.at,
            seq: ping.seq,
          });
        }
      }
      return out;
    },

    /** Test hook: drop all state, as a restart would. */
    reset() {
      plans.clear();
      foreignTurns.clear();
      replay.clear();
      auditLog.length = 0;
    },
  };
}

export { KEEP_ALIVE_LIMITS };
