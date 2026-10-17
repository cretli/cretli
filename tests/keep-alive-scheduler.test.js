/**
 * Keep-alive policy and scheduler. Deterministic: injected clock and
 * dependencies, no provider calls, no timers.
 */
process.env.CRETLI_TEST_DATA_DIR ||= 'keep-alive-scheduler-test';

import assert from 'node:assert/strict';
import {
  KEEP_ALIVE_DEFER_REASON as D,
  KEEP_ALIVE_STOP_REASON as S,
  KEEP_ALIVE_UNAVAILABLE_REASON as U,
  decideKeepAliveAction,
  describeKeepAliveBudget,
  estimateKeepAliveEconomics,
  evaluateKeepAliveAvailability,
  normalizeKeepAliveLimits,
} from '../lib/usage/keep-alive-policy.js';
import { createKeepAliveScheduler, KEEP_ALIVE_STATE_LIMITS } from '../lib/usage/keep-alive-scheduler.js';
import { buildWorkflowBreakdown } from '../lib/usage/workflow-breakdown.js';

const T0 = 1_000_000_000_000;
const MIN = 60 * 1000;

// ---- policy: limits are clamped, off by default, every plan has a positive budget.
{
  const limits = normalizeKeepAliveLimits({ maxPings: 999, minIntervalMs: 1, maxDurationMs: 1e12, budgetUsd: 999 }, T0);
  assert.equal(limits.maxPings, 10);
  assert.equal(limits.minIntervalMs, 30 * 1000);
  assert.equal(limits.deadlineAt, T0 + 2 * 60 * MIN);
  assert.equal(limits.budgetUsd, 5);
  const defaults = normalizeKeepAliveLimits({}, T0);
  assert.equal(defaults.maxPings, 3);
  assert.equal(defaults.budgetUsd, 5);
  assert.equal(normalizeKeepAliveLimits({ budgetUsd: -3 }, T0).budgetUsd, 5);
  assert.equal(normalizeKeepAliveLimits({ budgetUsd: 0.5 }, T0).budgetUsd, 0.5);
}

// ---- policy: availability states a reason; auto never silently weaker.
{
  const base = { canResumeSession: true, hasSessionId: true, ttlKnown: true, tariffKnown: true, budgetUsd: 1, expectNextRoundUntil: T0 + MIN, gate: { decision: 'go' } };
  assert.deepEqual(evaluateKeepAliveAvailability(base).auto, { available: true, reason: '' });
  assert.equal(evaluateKeepAliveAvailability({ ...base, canResumeSession: false }).auto.reason, U.NO_RESUME);
  assert.equal(evaluateKeepAliveAvailability({ ...base, canResumeSession: false }).manual.available, false);
  assert.equal(evaluateKeepAliveAvailability({ ...base, ttlKnown: false }).auto.reason, U.TTL_UNKNOWN);
  assert.equal(evaluateKeepAliveAvailability({ ...base, ttlKnown: false }).manual.available, true);
  assert.equal(evaluateKeepAliveAvailability({ ...base, tariffKnown: false }).auto.reason, U.COST_UNKNOWN);
  assert.equal(evaluateKeepAliveAvailability({ ...base, budgetUsd: null }).auto.reason, U.NO_BUDGET);
  assert.equal(evaluateKeepAliveAvailability({ ...base, gate: { decision: 'no_go' } }).auto.reason, U.GATE_NO_GO);
  assert.equal(evaluateKeepAliveAvailability({ ...base, gate: null }).auto.reason, U.GATE_MISSING);
}

// ---- policy: economics. Unknown rates are unknown, never zero.
{
  const rates = { cachedInput: 0.5, cacheWrite: 6.25, textInput: 5, textOutput: 25 };
  const eco = estimateKeepAliveEconomics({ contextTokens: 100000, rates });
  assert.equal(eco.known, true);
  assert.ok(eco.netUsd > 0);
  assert.equal(estimateKeepAliveEconomics({ contextTokens: 100000, rates: null }).known, false);
  assert.equal(estimateKeepAliveEconomics({ contextTokens: null, rates }).netUsd, null);
}

function plan(overrides = {}) {
  return {
    mode: 'auto',
    generation: 0,
    limits: { maxPings: 3, minIntervalMs: MIN, deadlineAt: T0 + 30 * MIN, budgetUsd: 1, expectNextRoundUntil: T0 + 20 * MIN },
    pingsDone: 0, spentUsd: 0, unknownCostPings: 0, ineffectiveStreak: 0, lastPingAt: null, inFlight: false,
    ...overrides,
  };
}
const goodEco = { known: true, pingCostUsd: 0.01, savingUsd: 0.5, netUsd: 0.49 };
function decide(extra = {}, planOverrides = {}) {
  return decideKeepAliveAction({
    plan: plan(planOverrides), now: T0 + 4 * MIN + 10_000, chatExists: true, generation: 0,
    freshness: { ttlKnown: true, expiresAt: T0 + 5 * MIN, state: 'warm' }, economics: goodEco, ...extra,
  });
}

// ---- policy: stop / defer / ping matrix.
assert.deepEqual(decide(), { action: 'ping', reason: 'ttl_due' });
assert.equal(decide({ cancelled: true }).reason, S.CANCELLED);
assert.equal(decide({ workflowEnded: true }).reason, S.WORKFLOW_ENDED);
assert.equal(decide({ generation: 1 }).reason, S.SESSION_RESET);
assert.equal(decide({ chatExists: false }).reason, S.CHAT_MISSING);
assert.equal(decide({ providerLimited: true }).reason, S.PROVIDER_LIMIT);
assert.equal(decide({ now: T0 + 31 * MIN }).reason, S.DEADLINE);
assert.equal(decide({}, { pingsDone: 3 }).reason, S.PING_LIMIT);
assert.equal(decide({}, { spentUsd: 1 }).reason, S.BUDGET_EXHAUSTED);
assert.equal(decide({}, { unknownCostPings: 1 }).reason, S.COST_UNKNOWN);
assert.equal(decide({}, { ineffectiveStreak: 2 }).reason, S.INEFFECTIVE);
assert.equal(decide({ now: T0 + 21 * MIN, freshness: { ttlKnown: true, expiresAt: T0 + 40 * MIN } }).reason, S.NOT_NEEDED);
assert.equal(decide({ now: T0 + 6 * MIN }).reason, S.CACHE_EXPIRED);
assert.equal(decide({ economics: { known: false } }).reason, S.COST_UNKNOWN);
assert.equal(decide({ economics: { known: true, netUsd: -1 } }).reason, S.NOT_ECONOMIC);
assert.equal(decide({ freshness: { ttlKnown: false, expiresAt: null, state: 'unknown' } }).reason, S.UNAVAILABLE);
// Deferrals never become pings and never outrun a stop.
assert.equal(decide({ busy: true }).reason, D.BUSY);
assert.equal(decide({ lastForeignTurnAt: T0 + 4 * MIN }).reason, D.USER_COMMAND);
assert.equal(decide({}, { lastPingAt: T0 + 4 * MIN }).reason, D.MIN_INTERVAL);
assert.equal(decide({}, { inFlight: true }).reason, D.PING_IN_FLIGHT);
assert.equal(decide({ now: T0 + MIN }).reason, D.NOT_DUE);
assert.equal(decide({ busy: true, cancelled: true }).action, 'stop');
// A forced (manual) ping skips only due-ness, never a deferral or a stop.
assert.equal(decide({ forced: true, now: T0 + MIN }).action, 'ping');
assert.equal(decide({ forced: true, busy: true }).action, 'defer');
assert.equal(decide({ forced: true, providerLimited: true }).action, 'stop');

// ---- budget view: unknown cost makes the remaining budget unknown.
{
  const known = describeKeepAliveBudget(plan({ pingsDone: 1, spentUsd: 0.25 }));
  assert.equal(known.remainingUsd, 0.75);
  assert.equal(known.pingsRemaining, 2);
  const unknown = describeKeepAliveBudget(plan({ pingsDone: 1, spentUsd: 0.25, unknownCostPings: 1 }));
  assert.equal(unknown.remainingUsd, null);
  assert.equal(unknown.costComplete, false);
}

// ---- scheduler harness
function createHarness(overrides = {}) {
  const state = {
    now: T0,
    row: {
      id: 'del-1', assignment: 'review', status: 'completed', controllerChatId: 'ctrl', childChatId: 'child-1',
      leafId: 'leaf-1', executor: { transport: 'claude', model: 'claude-sonnet-5-5' }, workspaceFolder: '/w',
    },
    chat: { id: 'child-1', claudeSessionId: 'sess' },
    canResume: true,
    generation: 0,
    busy: false,
    activeDelegation: false,
    newer: false,
    workflowEnded: false,
    providerLimited: false,
    expiresAt: T0 + 5 * MIN,
    ttlKnown: true,
    rates: { cachedInput: 0.5, cacheWrite: 6.25, textInput: 5, textOutput: 25 },
    gate: { decision: 'go', reasons: [] },
    contextTokens: 100000,
    startCalls: [],
    startImpl: null,
    usage: null,
    audit: [],
    ...overrides,
  };
  const scheduler = createKeepAliveScheduler({
    now: () => state.now,
    loadDelegation: (id) => (id === state.row?.id ? state.row : null),
    loadChat: (id) => (id === state.chat?.id ? state.chat : null),
    getCapabilities: () => ({ canResumeSession: state.canResume }),
    readSessionId: (_t, chat) => chat.claudeSessionId || '',
    getGeneration: () => state.generation,
    getFreshness: () => ({
      cache: { ttlKnown: state.ttlKnown, expiresAt: state.expiresAt, state: state.ttlKnown ? 'warm' : 'unknown' },
      context: { inputTokens: state.contextTokens },
    }),
    isRunBusy: () => state.busy,
    hasActiveDelegationOnChat: () => state.activeDelegation,
    hasNewerDelegationOnChat: () => state.newer,
    isWorkflowEnded: () => state.workflowEnded,
    isProviderLimited: () => state.providerLimited,
    startPing: async (input) => {
      state.startCalls.push(input);
      if (state.startImpl) return state.startImpl(input);
      return { accepted: true, runId: `run-${state.startCalls.length}` };
    },
    readPingUsage: () => state.usage,
    resolveRates: () => state.rates,
    loadGate: () => state.gate,
    audit: (entry) => state.audit.push(entry),
    ...(overrides.extraDeps || {}),
  });
  return { state, scheduler };
}
const AUTO_LIMITS = { maxPings: 3, budgetUsd: 1, expectNextRoundUntil: T0 + 20 * MIN, minIntervalMs: 60_000 };
function cfg(h, extra = {}) {
  return h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'auto', limits: AUTO_LIMITS, ...extra });
}

// ---- default off: nothing exists, status says so, no request.
{
  const h = createHarness();
  const status = h.scheduler.status({ controllerChatId: 'ctrl' });
  assert.equal(status.defaultMode, 'off');
  assert.equal(status.requestIssued, false);
  assert.deepEqual(status.plans, []);
  assert.deepEqual(await h.scheduler.tick(), []);
  assert.equal(h.state.startCalls.length, 0);
}

// ---- configuring never pings; auto is refused WITH the reason when not safe.
{
  const h = createHarness();
  assert.equal(cfg(h).ok, true);
  assert.equal(h.state.startCalls.length, 0);
  for (const [override, reason] of [
    [{ canResume: false }, U.NO_RESUME],
    [{ ttlKnown: false }, U.TTL_UNKNOWN],
    [{ rates: null }, U.COST_UNKNOWN],
    [{ gate: { decision: 'no_go', reasons: ['not_measured'] } }, U.GATE_NO_GO],
  ]) {
    const refused = createHarness(override);
    const result = cfg(refused);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'auto_unavailable');
    assert.equal(result.reason, reason);
    assert.equal(refused.scheduler.status({ controllerChatId: 'ctrl' }).plans.length, 0);
  }
  // Manual stays available when only the auto prerequisites are missing.
  const noTtl = createHarness({ ttlKnown: false, rates: null });
  assert.equal(noTtl.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual' }).ok, true);
}

// ---- ownership / scope: foreign controller, non-review, unfinished.
{
  const h = createHarness();
  assert.equal(h.scheduler.configure({ controllerChatId: 'other', delegationId: 'del-1', mode: 'manual' }).code, 'not_found');
  h.state.row.assignment = 'implement';
  assert.equal(h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual' }).code, 'not_review');
  h.state.row.assignment = 'review';
  h.state.row.status = 'running';
  assert.equal(h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual' }).code, 'not_finished');
}

// ---- auto ping: right session, accepted request, settled from usage, budget shown.
{
  const h = createHarness();
  cfg(h);
  h.state.now = T0 + 4 * MIN + 10_000;
  const results = await h.scheduler.tick();
  assert.deepEqual(results.map((r) => r.action), ['ping']);
  assert.equal(h.state.startCalls.length, 1);
  assert.equal(h.state.startCalls[0].chatId, 'child-1');
  assert.equal(h.state.startCalls[0].delegationId, 'del-1');
  assert.match(h.state.startCalls[0].requestId, /^keepalive:del-1:/);
  assert.match(h.state.startCalls[0].prompt, /Do not .* write a report or a verdict/);
  // Not settled yet: no usage proof means no success claim and unknown cost.
  let view = h.scheduler.status({ controllerChatId: 'ctrl' }).plans[0];
  assert.equal(view.pings[0].status, 'requested');
  assert.equal(view.pings[0].effective, null);
  // Provider usage with a cache read settles it as effective with a cost.
  h.state.usage = { events: 1, usd: 0.04, estimated: false, cachedInputTokens: 90000, contextTokens: null };
  view = h.scheduler.status({ controllerChatId: 'ctrl' }).plans[0];
  assert.equal(view.pings[0].status, 'settled');
  assert.equal(view.pings[0].effective, true);
  assert.equal(view.budget.spentUsd, 0.04);
  assert.equal(view.budget.remainingUsd, 0.96);
  assert.equal(view.budget.pingsRemaining, 2);
  // The scheduler records no report/verdict: the ping is not a delegation.
  assert.equal('verdict' in view, false);
}

// ---- mailbox-style acceptance without a request is NOT success.
{
  const h = createHarness({ startImpl: async () => ({ accepted: false }) });
  cfg(h);
  h.state.now = T0 + 4 * MIN + 10_000;
  const [result] = await h.scheduler.tick();
  assert.equal(result.ok, false);
  const view = h.scheduler.status({ controllerChatId: 'ctrl' }).plans[0];
  assert.equal(view.pingsDone, 0);
  assert.equal(view.pings.length, 0);
  assert.equal(view.stopReason, S.ERROR);
  assert.ok(h.scheduler.getAudit().some((e) => e.event === 'ping_failed' && e.code === 'not_accepted'));
}

// ---- accepted but no usage evidence: unconfirmed, cost unknown, plan stops on budget.
{
  const h = createHarness();
  cfg(h);
  h.state.now = T0 + 4 * MIN + 10_000;
  await h.scheduler.tick();
  h.state.now += 4 * MIN;
  h.state.expiresAt = h.state.now + 2 * MIN;
  await h.scheduler.tick();
  const view = h.scheduler.status({ controllerChatId: 'ctrl' }).plans[0];
  assert.equal(view.pings[0].status, 'unconfirmed');
  assert.equal(view.budget.costComplete, false);
  assert.equal(view.budget.remainingUsd, null);
  assert.equal(view.stopReason, S.COST_UNKNOWN);
  assert.equal(h.state.startCalls.length, 1);
}

// ---- busy / user command / delegation claim defer and never ping; review not preempted.
for (const [name, patch, reason] of [
  ['busy', { busy: true }, D.BUSY],
  ['active delegation on chat', { activeDelegation: true }, D.BUSY],
]) {
  const h = createHarness(patch);
  cfg(h);
  h.state.now = T0 + 4 * MIN + 10_000;
  const [result] = await h.scheduler.tick();
  assert.equal(result.action, 'defer', name);
  assert.equal(result.reason, reason, name);
  assert.equal(h.state.startCalls.length, 0, name);
}
{
  const h = createHarness();
  cfg(h);
  h.state.now = T0 + 4 * MIN + 10_000;
  h.scheduler.noteForeignTurn('child-1', h.state.now - 10_000);
  const [result] = await h.scheduler.tick();
  assert.equal(result.reason, D.USER_COMMAND);
  assert.equal(h.state.startCalls.length, 0);
}

// ---- terminal conditions stop instead of pinging.
for (const [patch, reason] of [
  [{ providerLimited: true }, S.PROVIDER_LIMIT],
  [{ workflowEnded: true }, S.WORKFLOW_ENDED],
  [{ generation: 1 }, S.SESSION_RESET],
  [{ newer: true }, S.NOT_NEEDED],
  [{ chat: null }, S.CHAT_MISSING],
]) {
  const h = createHarness();
  cfg(h);
  Object.assign(h.state, patch);
  h.state.now = T0 + 4 * MIN + 10_000;
  const [result] = await h.scheduler.tick();
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, reason);
  assert.equal(h.state.startCalls.length, 0);
  assert.equal(h.scheduler.status({ controllerChatId: 'ctrl' }).plans[0].stopReason, reason);
}
{
  const h = createHarness();
  cfg(h);
  h.state.row = { ...h.state.row, status: 'cancelled' };
  h.state.now = T0 + 4 * MIN + 10_000;
  const [result] = await h.scheduler.tick();
  assert.equal(result.reason, S.CANCELLED);
}

// ---- restart: state is in memory, so nothing is caught up.
{
  const h = createHarness();
  cfg(h);
  h.scheduler.reset(); // what a restart does
  h.state.now = T0 + 4 * MIN + 10_000;
  assert.deepEqual(await h.scheduler.tick(), []);
  assert.equal(h.state.startCalls.length, 0);
  // A long gap (suspend) inside a live process becomes cache_expired, no burst.
  const h2 = createHarness();
  cfg(h2);
  h2.state.now = T0 + 3 * 60 * MIN;
  const results = await h2.scheduler.tick();
  assert.equal(results.length, 1);
  assert.notEqual(results[0].action, 'ping');
  assert.equal(h2.state.startCalls.length, 0);
}

// ---- dedupe: concurrent ticks and replayed manual calls pay once.
{
  const h = createHarness({ startImpl: () => new Promise((resolve) => setTimeout(() => resolve({ accepted: true, runId: 'r' }), 10)) });
  cfg(h);
  h.state.now = T0 + 4 * MIN + 10_000;
  const [a, b] = await Promise.all([h.scheduler.tick(), h.scheduler.tick()]);
  assert.equal(h.state.startCalls.length, 1);
  assert.equal([...a, ...b].filter((r) => r.action === 'ping').length, 1);
}
{
  const h = createHarness();
  h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual' });
  const first = await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'k1' });
  const replayed = await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'k1' });
  assert.equal(first.ok, true);
  assert.deepEqual(replayed, first);
  assert.equal(h.state.startCalls.length, 1);
  // Same request id on the wire: the provider-side lookup can dedupe too.
  assert.match(first.ping.requestId, /^keepalive:del-1:[0-9a-f]{8}:k1$/);
}

// ---- caps: ping count, interval and deadline bound a manual plan too.
{
  const h = createHarness();
  h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual', limits: { maxPings: 2, minIntervalMs: 60_000 } });
  assert.equal((await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'a' })).ok, true);
  const tooSoon = await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'b' });
  assert.equal(tooSoon.code, 'deferred');
  assert.equal(tooSoon.reason, D.MIN_INTERVAL);
  h.state.now += 2 * MIN;
  assert.equal((await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'c' })).ok, true);
  h.state.now += 2 * MIN;
  const limit = await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'd' });
  assert.equal(limit.code, 'stopped');
  assert.equal(limit.reason, S.PING_LIMIT);
  assert.equal(h.state.startCalls.length, 2);
  // Deadline.
  const h2 = createHarness();
  h2.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual', limits: { maxDurationMs: 2 * MIN } });
  h2.state.now += 3 * MIN;
  assert.equal((await h2.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'x' })).reason, S.DEADLINE);
}

// ---- stop is terminal and visible.
{
  const h = createHarness();
  cfg(h);
  assert.equal(h.scheduler.stop({ controllerChatId: 'ctrl', delegationId: 'del-1' }).plan.stopReason, S.USER_STOPPED);
  h.state.now = T0 + 4 * MIN + 10_000;
  assert.deepEqual(await h.scheduler.tick(), []);
  assert.equal(h.state.startCalls.length, 0);
  assert.ok(h.scheduler.getAudit().some((e) => e.event === 'plan_stopped' && e.reason === S.USER_STOPPED));
}

// ---- full cost accounting: ping usage is its own keep_alive row per leaf and
// is not counted as unmatched or folded into a review round.
{
  const events = [
    { id: 'e1', at: new Date(T0).toISOString(), chatId: 'child-1', runId: 'run-1', tokens: { cachedInput: 100 }, usd: 0.04, eventType: 'delta' },
    { id: 'e2', at: new Date(T0).toISOString(), chatId: 'other', runId: 'zzz', tokens: { textInput: 5 }, usd: 0.01, eventType: 'delta' },
  ];
  const breakdown = buildWorkflowBreakdown({
    events,
    delegations: [],
    keepAlivePings: [{ leafId: 'leaf-1', delegationId: 'del-1', chatId: 'child-1', runId: 'run-1' }],
  });
  const row = breakdown.rows.find((r) => r.role === 'keep_alive');
  assert.ok(row);
  assert.equal(row.leafId, 'leaf-1');
  assert.equal(row.round, null);
  assert.equal(breakdown.unmatched.events, 1);
}

console.log('keep-alive-scheduler tests passed');

// ---- F2: a re-created plan never reuses a previous plan's request id.
{
  const h = createHarness();
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual' });
    const result = await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'same-key' });
    assert.equal(result.ok, true);
    ids.push(result.ping.requestId);
    h.scheduler.stop({ controllerChatId: 'ctrl', delegationId: 'del-1' });
    h.state.now += 10 * MIN;
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(h.state.startCalls.length, 2);
  // Automatic pings carry the nonce too (seq restarts at 1 per plan).
  const auto1 = createHarness();
  const auto2 = createHarness();
  for (const x of [auto1, auto2]) {
    cfg(x);
    x.state.now = T0 + 4 * MIN + 10_000;
    await x.scheduler.tick();
  }
  assert.match(auto1.state.startCalls[0].requestId, /^keepalive:del-1:[0-9a-f]{8}:auto-1$/);
  assert.notEqual(auto1.state.startCalls[0].requestId, auto2.state.startCalls[0].requestId);
}

// ---- F3: no explicit budget still yields a positive cap; manual stops on cost.
{
  const h = createHarness();
  const configured = h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual', limits: { minIntervalMs: 30_000 } });
  assert.equal(configured.ok, true);
  assert.equal(configured.plan.limits.budgetUsd, 5);
  // Accepted but no usage evidence: the cost is unknown, so the next manual ping stops.
  assert.equal((await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'a' })).ok, true);
  h.state.now += 10 * MIN;
  await h.scheduler.tick();
  h.state.now += 10 * MIN;
  const next = await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'b' });
  assert.equal(next.ok, false);
  assert.equal(h.state.startCalls.length, 1);
}
assert.equal(decide({ forced: true }, { mode: 'manual', unknownCostPings: 1 }).reason, S.COST_UNKNOWN);
assert.equal(decide({ forced: true }, { mode: 'manual', spentUsd: 1 }).reason, S.BUDGET_EXHAUSTED);

// ---- F5: a ping superseded mid-flight is accounted honestly and never revives the plan.
for (const [name, interfere, expectStop] of [
  ['plan stopped mid-flight', (h) => h.scheduler.stop({ controllerChatId: 'ctrl', delegationId: 'del-1' }), S.USER_STOPPED],
  ['session reset mid-flight', (h) => { h.state.generation = 1; }, S.SESSION_RESET],
  ['plan re-created mid-flight', (h) => {
    h.scheduler.stop({ controllerChatId: 'ctrl', delegationId: 'del-1' });
    h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual' });
  }, null],
]) {
  const h = createHarness();
  cfg(h);
  h.state.now = T0 + 4 * MIN + 10_000;
  h.state.startImpl = async () => {
    interfere(h);
    return { accepted: true, runId: 'run-late' };
  };
  const [result] = await h.scheduler.tick();
  assert.equal(result.action, 'ping', name);
  assert.equal(result.ok, false, name);
  assert.equal(h.state.startCalls.length, 1, `${name}: paid once`);
  const view = h.scheduler.status({ controllerChatId: 'ctrl' }).plans[0];
  if (expectStop) {
    assert.equal(view.status, 'stopped', name);
    assert.equal(view.stopReason, expectStop, name);
  } else {
    // The NEW plan is untouched by the old plan's request.
    assert.equal(view.status, 'active', name);
    assert.equal(view.pingsDone, 0, name);
    assert.equal(view.pings.length, 0, name);
    assert.equal(view.budget.spentUsd, 0, name);
    continue;
  }
  assert.equal(view.pingsDone, 0, `${name}: no pingsDone drift`);
  assert.equal(view.budget.spentUsd, 0, `${name}: no budget drift`);
  assert.equal(view.pings.length, 1, name);
  assert.equal(view.pings[0].status, 'superseded', name);
  assert.equal(view.pings[0].effective, null, name);
  assert.equal(view.pings[0].costUsd, null, name);
  assert.equal(view.pings[0].runId, 'run-late', `${name}: run id kept for cost attribution`);
  assert.ok(h.scheduler.getAudit().some((e) => e.event === 'ping_superseded' && e.runId === 'run-late'), name);
  // A later settle pass must not turn it into an effective / priced ping.
  h.state.usage = { events: 1, usd: 0.5, estimated: false, cachedInputTokens: 1000, contextTokens: null };
  const after = h.scheduler.status({ controllerChatId: 'ctrl' }).plans[0];
  assert.equal(after.pings[0].status, 'superseded', name);
  assert.equal(after.budget.spentUsd, 0, name);
  assert.equal(after.status, 'stopped', `${name}: not resurrected`);
}
// A failing request on a stopped plan reports superseded, not a fresh error stop.
{
  const h = createHarness();
  cfg(h);
  h.state.now = T0 + 4 * MIN + 10_000;
  h.state.startImpl = async () => {
    h.scheduler.stop({ controllerChatId: 'ctrl', delegationId: 'del-1' });
    throw Object.assign(new Error('boom'), { code: 'transport' });
  };
  const [result] = await h.scheduler.tick();
  assert.equal(result.ok, false);
  assert.equal(h.scheduler.status({ controllerChatId: 'ctrl' }).plans[0].stopReason, S.USER_STOPPED);
}
// A manual ping on an already stopped plan never reaches the provider.
{
  const h = createHarness();
  h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual' });
  h.scheduler.stop({ controllerChatId: 'ctrl', delegationId: 'del-1' });
  const out = await h.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1', idempotencyKey: 'late' });
  assert.equal(out.code, 'stopped');
  assert.equal(h.state.startCalls.length, 0);
}

// ---- F6: the replay map is bounded (oldest first) and keeps the guarantee for live keys.
{
  const h = createHarness();
  const cap = KEEP_ALIVE_STATE_LIMITS.maxReplayEntries;
  const first = h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual', idempotencyKey: 'k-0' });
  assert.equal(first.ok, true);
  // Replayed while still bounded: the very same result object.
  assert.equal(h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual', idempotencyKey: 'k-0' }), first);
  // OFF configures succeed repeatedly and each key is remembered.
  for (let i = 1; i <= cap + 5; i += 1) {
    h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'off', idempotencyKey: `k-${i}` });
  }
  assert.ok(h.scheduler.replaySize() <= cap);
  // The newest key still replays; the evicted oldest one is evaluated afresh.
  const newest = h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'off', idempotencyKey: `k-${cap + 5}` });
  assert.equal(newest.mode, 'off');
  const evicted = h.scheduler.configure({ controllerChatId: 'ctrl', delegationId: 'del-1', mode: 'manual', idempotencyKey: 'k-0' });
  assert.notEqual(evicted, first);
}

// ---- F6: a restart reports `server_restart` for persisted plans and never resumes them.
{
  let stored = null;
  const first = createHarness({ extraDeps: { savePlans: (rows) => { stored = JSON.parse(JSON.stringify(rows)); } } });
  cfg(first);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'active');
  assert.equal('inFlight' in stored[0], false);
  // "Restart": a new scheduler loads the snapshot.
  const second = createHarness({ extraDeps: { loadPlans: () => stored, savePlans: (rows) => { stored = JSON.parse(JSON.stringify(rows)); } } });
  const view = second.scheduler.status({ controllerChatId: 'ctrl' }).plans[0];
  assert.equal(view.status, 'stopped');
  assert.equal(view.stopReason, S.SERVER_RESTART);
  assert.equal(view.nextAttemptAt, null);
  second.state.now = T0 + 4 * MIN + 10_000;
  assert.deepEqual(await second.scheduler.tick(), []);
  assert.equal(second.state.startCalls.length, 0);
  assert.equal((await second.scheduler.ping({ controllerChatId: 'ctrl', delegationId: 'del-1' })).code, 'stopped');
  assert.ok(second.scheduler.getAudit().some((e) => e.event === 'plan_stopped' && e.reason === S.SERVER_RESTART));
  // The stopped state is persisted, and an already stopped plan keeps its own reason.
  assert.equal(stored[0].stopReason, S.SERVER_RESTART);
  const userStopped = createHarness({ extraDeps: { savePlans: (rows) => { stored = JSON.parse(JSON.stringify(rows)); } } });
  cfg(userStopped);
  userStopped.scheduler.stop({ controllerChatId: 'ctrl', delegationId: 'del-1' });
  const third = createHarness({ extraDeps: { loadPlans: () => stored } });
  assert.equal(third.scheduler.status({ controllerChatId: 'ctrl' }).plans[0].stopReason, S.USER_STOPPED);
  // A broken store never breaks construction.
  const broken = createHarness({ extraDeps: { loadPlans: () => { throw new Error('io'); }, savePlans: () => { throw new Error('io'); } } });
  assert.equal(cfg(broken).ok, true);
}
assert.equal(createKeepAliveScheduler.length, 1);
