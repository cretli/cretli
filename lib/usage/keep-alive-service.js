/**
 * Process-wide keep-alive scheduler wired to the real chat runtime.
 *
 * `keep-alive-scheduler.js` owns the policy loop with injected dependencies;
 * this module supplies the production ones and the timer. The timer is only
 * armed while at least one AUTO plan is active, so with the feature off (the
 * default) nothing runs in the background.
 */

import { delegationController } from '../delegation-control.js';
import { decodeModelValue } from '../model-catalog.js';
import { loadChats } from '../persist/chats-persist.js';
import { getDelegationById, loadDelegations } from '../persist/delegations-persist.js';
import { getDelegationWorkflow } from '../persist/delegation-workflows-persist.js';
import { readUsageEvents } from '../persist/usage-persist.js';
import {
  getChatRunAdapterCapabilities,
  getChatRunState,
  observeChatRunStarts,
  startChatRun,
} from '../chat-run-service.js';
import { readChatHarnessSessionId } from '../delegation-session-resume.js';
import { isTerminalDelegationStatus } from '../delegation-status.js';
import { findActiveLockoutRow } from '../model-pick-gate-primitives.js';
import { listHarnessUsageLimits, listHarnessUsageLimitsForWorkspace } from '../harness-usage-limits.js';
import { getCacheFreshness, getCacheStateForChat } from './cache-state.js';
import { lookupFirmTokenRates } from './usage-rates.js';
import { loadKeepAliveGate } from './keep-alive-gate.js';
import { createKeepAliveScheduler } from './keep-alive-scheduler.js';
import { KEEP_ALIVE_MODE } from './keep-alive-policy.js';

/** Tick period while an automatic plan is active. */
export const KEEP_ALIVE_TICK_MS = 15 * 1000;

/** Harness id -> usage provider used for the tariff lookup. */
const PROVIDER_BY_HARNESS = Object.freeze({
  codex: 'openai',
  openrouter: 'openrouter',
  mistral: 'mistral',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {string} chatId
 * @returns {object|null}
 */
function findChat(chatId) {
  return loadChats().find((row) => row.id === chatId) || null;
}

/**
 * @param {{ chatId: string, runId: string, sinceMs: number }} input
 * @returns {{ events: number, usd: number|null, estimated: boolean, cachedInputTokens: number, contextTokens: number|null }|null}
 */
function readPingUsage(input) {
  const from = new Date(Math.max(0, input.sinceMs - 60 * 1000)).toISOString();
  const to = new Date().toISOString();
  const events = readUsageEvents({ from, to }).filter((event) => event
    && event.eventType !== 'run'
    && text(event.chatId) === input.chatId
    && text(event.runId) === input.runId);
  if (events.length === 0) return null;
  let usd = 0;
  let unpriced = 0;
  let estimated = false;
  let cached = 0;
  for (const event of events) {
    const value = Number(event.usd);
    if (event.usd == null || !Number.isFinite(value)) unpriced += 1;
    else {
      usd += value;
      if (event.estimated === true) estimated = true;
    }
    cached += Number(event.tokens?.cachedInput) || 0;
  }
  return {
    events: events.length,
    // One unpriced event makes the whole ping cost unknown, never partial.
    usd: unpriced > 0 ? null : Number(usd.toFixed(6)),
    estimated,
    cachedInputTokens: cached,
    contextTokens: null,
  };
}

/** @type {ReturnType<typeof createKeepAliveScheduler>|null} */
let scheduler = null;
/** @type {NodeJS.Timeout|null} */
let timer = null;
let unobserve = null;

/**
 * @returns {ReturnType<typeof createKeepAliveScheduler>}
 */
export function getKeepAliveScheduler() {
  if (scheduler) return scheduler;
  scheduler = createKeepAliveScheduler({
    loadDelegation: (id) => getDelegationById(id),
    loadChat: findChat,
    getCapabilities: getChatRunAdapterCapabilities,
    readSessionId: readChatHarnessSessionId,
    getGeneration: (chatId) => getCacheStateForChat(chatId)?.generation ?? 0,
    getFreshness: (chatId, options) => getCacheFreshness(chatId, options),
    isRunBusy: (chatId) => {
      try {
        const state = getChatRunState({ chatId });
        return !!(state?.busy || state?.waitingForInput);
      } catch {
        // Unknown liveness is treated as busy: a paid ping never guesses idle.
        return true;
      }
    },
    hasActiveDelegationOnChat: (chatId, exceptId) => loadDelegations().some((row) => text(row.childChatId) === chatId
      && text(row.id) !== exceptId
      && !isTerminalDelegationStatus(row.status)),
    hasNewerDelegationOnChat: (chatId, delegationId) => {
      const rows = loadDelegations().filter((row) => text(row.childChatId) === chatId);
      const source = rows.find((row) => text(row.id) === delegationId);
      const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
      return rows.some((row) => text(row.id) !== delegationId && stamp(row) > stamp(source));
    },
    isWorkflowEnded: (row) => {
      const controller = delegationController(row);
      const workflow = getDelegationWorkflow(controller, text(row.leafId));
      if (!workflow) return false;
      return text(workflow.stopReason) !== '' || text(workflow.lastVerdict).toUpperCase() === 'PASS';
    },
    isProviderLimited: ({ transport, model, workspaceFolder }) => {
      try {
        const limits = workspaceFolder
          ? listHarnessUsageLimitsForWorkspace({ workspaceFolder })
          : listHarnessUsageLimits();
        return findActiveLockoutRow(limits, transport, model, Date.now()) != null;
      } catch {
        // A broken limit store must stop paid pings rather than ignore a limit.
        return true;
      }
    },
    startPing: async ({ chatId, delegationId, prompt, requestId }) => {
      const row = getDelegationById(delegationId);
      return startChatRun({
        chatId,
        prompt,
        // Same agent mode as the reviewer round keeps the session config.
        mode: text(row?.executionMode) || 'plan',
        requestId,
        displayText: 'Cache keep-alive',
        deps: { keepAlive: true },
      });
    },
    readPingUsage,
    resolveRates: ({ transport, model }) => lookupFirmTokenRates(
      text(decodeModelValue(text(model)).modelId) || text(model),
      PROVIDER_BY_HARNESS[transport] || 'other',
      transport,
    ),
    loadGate: () => loadKeepAliveGate(),
    audit: (entry) => {
      if (process.env.CRETLI_TEST_DATA_DIR) return;
      console.info('[keep-alive]', JSON.stringify(entry));
    },
  });
  unobserve = observeChatRunStarts(({ chatId, origin }) => {
    if (origin !== 'keep_alive') scheduler?.noteForeignTurn(chatId);
  });
  return scheduler;
}

/**
 * Arms the periodic tick. Idempotent and cheap; it is only called when an
 * AUTO plan is created.
 *
 * @returns {void}
 */
export function ensureKeepAliveTimer() {
  if (timer) return;
  timer = setInterval(() => {
    void getKeepAliveScheduler().tick().catch(() => {});
  }, KEEP_ALIVE_TICK_MS);
  timer.unref?.();
}

/**
 * Single entry for REST and the in-process MCP client.
 *
 * @param {{ action: string, controllerChatId: string, delegationId?: string, mode?: string, limits?: object, idempotencyKey?: string, reason?: string }} input
 * @returns {Promise<object>|object}
 */
export function handleKeepAliveRequest(input = {}) {
  const sch = getKeepAliveScheduler();
  const action = text(input.action).toLowerCase() || 'status';
  const base = { controllerChatId: text(input.controllerChatId), delegationId: text(input.delegationId) };
  if (!base.controllerChatId) return { ok: false, code: 'validation_error', reason: 'controller chat id is required' };
  if (action === 'status') return sch.status(base);
  if (action === 'configure') {
    const result = sch.configure({ ...base, mode: input.mode, limits: input.limits, idempotencyKey: input.idempotencyKey });
    if (result.ok && result.plan?.mode === KEEP_ALIVE_MODE.AUTO) ensureKeepAliveTimer();
    return result;
  }
  if (action === 'ping') return sch.ping({ ...base, idempotencyKey: input.idempotencyKey });
  if (action === 'stop') return sch.stop({ ...base, reason: input.reason });
  return { ok: false, code: 'validation_error', reason: `Unknown action: ${action}` };
}

/** Test hook. */
export function resetKeepAliveServiceForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  unobserve?.();
  unobserve = null;
  scheduler?.reset();
  scheduler = null;
}
