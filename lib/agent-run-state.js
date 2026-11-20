/**
 * Lightweight per-chat agent presence for the sidebar (no WebSocket required).
 */

import { delegationController } from './delegation-control.js';
import { peekChatsAsync } from './persist/chats-persist.js';
import { listDelegationsForChatIds } from './persist/delegations-persist.js';
import { getChatRunStateForChat } from './chat-run-service.js';
import { buildRecoveryPresenceMap } from './recovery/recovery-presence.ts';
import {
  isActiveDelegationStatus,
  isInFlightDelegationStatus,
  normalizeDelegationStatus,
} from './delegation-status.js';
import { getChatPresenceActivity, hasBrowserConsentPending } from './agent-presence-hooks.js';
import { mergePresenceActivity } from './agent-presence-activity.js';

const TERMINAL_ATTENTION = new Set(['completed', 'failed', 'interrupted']);

/**
 * @param {Record<string, any> | null | undefined} row
 * @returns {boolean}
 */
export function isDelegationAcknowledged(row) {
  return Boolean(String(row?.acknowledgedAt || '').trim());
}

/**
 * Attention survives reloads until the user opens a waiting executor
 * or explicitly reviews a finished job.
 *
 * @param {Record<string, any> | null | undefined} row
 * @returns {boolean}
 */
export function isDelegationAttention(row) {
  if (!row || isDelegationAcknowledged(row)) return false;
  const status = normalizeDelegationStatus(row.status);
  if (status === 'waiting_for_input') return true;
  return TERMINAL_ATTENTION.has(status);
}

/**
 * @param {Record<string, any> | null | undefined} row
 * @returns {number}
 */
function rankDelegation(row) {
  const status = normalizeDelegationStatus(row?.status);
  if (status === 'waiting_for_input' && !isDelegationAcknowledged(row)) return 4;
  if (isActiveDelegationStatus(status) && status !== 'waiting_for_input') return 3;
  if (TERMINAL_ATTENTION.has(status) && !isDelegationAcknowledged(row)) return 2;
  return 1;
}

/**
 * @param {Record<string, any> | null} run
 * @param {Record<string, any> | null} delegation
 * @returns {{
 *   state: 'busy' | 'waiting' | 'attention' | 'idle',
 *   runId: string,
 *   delegationId: string,
 *   delegationStatus: string,
 *   attention: boolean,
 *   waitingAgentCount: number,
 *   inFlightChildCount: number,
 *   inputRequested?: true,
 * }}
 */
export function resolveChatAgentPresence(run, delegation) {
  const runId = String(run?.runId || delegation?.runId || '');
  const delegationId = String(delegation?.id || '');
  const delegationStatus = normalizeDelegationStatus(delegation?.status);
  const waitingFromDelegation = delegationStatus === 'waiting_for_input' && !isDelegationAcknowledged(delegation);
  const waitingFromRun = run?.waitingForInput === true && !delegation;
  // The flag follows the run's own request even when a child delegation hides it behind `busy`
  // (so `waitingFromRun`, which requires no delegation, is not reused here).
  const inputRequested = waitingFromDelegation || run?.waitingForInput === true;
  const flagged = (row) => (inputRequested ? { ...row, inputRequested: true } : row);
  if (waitingFromDelegation || waitingFromRun) {
    return flagged({
      state: 'waiting',
      runId,
      delegationId,
      delegationStatus,
      attention: true,
      waitingAgentCount: 0,
      inFlightChildCount: 0,
    });
  }
  const busy = run?.busy === true
    || (isActiveDelegationStatus(delegationStatus) && delegationStatus !== 'waiting_for_input');
  if (busy) {
    return flagged({
      state: 'busy',
      runId,
      delegationId,
      delegationStatus,
      attention: false,
      waitingAgentCount: 0,
      inFlightChildCount: 0,
    });
  }
  if (isDelegationAttention(delegation) && TERMINAL_ATTENTION.has(delegationStatus)) {
    return flagged({
      state: 'attention',
      runId,
      delegationId,
      delegationStatus,
      attention: true,
      ...(delegation?.interruptCode ? { interruptCode: String(delegation.interruptCode) } : {}),
      waitingAgentCount: 0,
      inFlightChildCount: 0,
    });
  }
  return flagged({
    state: 'idle',
    runId,
    delegationId,
    delegationStatus,
    attention: false,
    waitingAgentCount: 0,
    inFlightChildCount: 0,
  });
}

/**
 * Presence row for a persisted recovery run. Only the states the sidebar
 * renders are mapped; terminal runs never produce a row.
 *
 * @param {Record<string, any> | null | undefined} run
 * @returns {{
 *   state: 'busy' | 'waiting' | 'attention',
 *   runId: string,
 *   delegationId: string,
 *   delegationStatus: string,
 *   recoveryStatus: string,
 *   attention: boolean,
 *   waitingAgentCount: number,
 *   inFlightChildCount: number,
 * } | null}
 */
export function resolveRecoveryAgentPresence(run) {
  const state = String(run?.state || '').trim();
  const base = {
    runId: '',
    delegationId: '',
    delegationStatus: '',
    recoveryStatus: '',
    attention: false,
    waitingAgentCount: 0,
    inFlightChildCount: 0,
  };
  if (state === 'recovering') return { ...base, state: 'busy', recoveryStatus: 'resuming' };
  if (state === 'waiting') return { ...base, state: 'waiting', recoveryStatus: 'waiting', attention: true };
  if (state === 'unknown') return { ...base, state: 'attention', recoveryStatus: 'unknown', attention: true };
  if (state === 'interrupted') {
    const restart = String(run?.reason || '').trim() === 'server_restart';
    return {
      ...base,
      state: 'attention',
      recoveryStatus: restart ? 'interrupted_restart' : 'interrupted',
      attention: true,
    };
  }
  return null;
}

/**
 * Compact presence map: only busy | waiting | attention.
 * Idle chats are omitted; a missing id means idle.
 *
 * Pure over the chat rows the caller read (`options.chats`, read-only: nothing here mutates them). Async callers
 * use `summarizeChatRunStatesAsync`, which reads the rows through the active chats runtime.
 *
 * @param {string[]} [chatIds]
 * @param {{ chats?: Array<Record<string, any>> }} [options]
 * @returns {Record<string, ReturnType<typeof resolveChatAgentPresence>>}
 */
export function summarizeChatRunStates(chatIds, options = {}) {
  const wanted = Array.isArray(chatIds)
    ? [...new Set(chatIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  const chats = options.chats || [];
  const chatById = new Map(chats.map((row) => [row.id, row]));
  const ids = wanted.length > 0 ? wanted : chats.map((row) => row.id);
  const wantedSet = new Set(ids);
  const recoveryByChat = buildRecoveryPresenceMap(ids);
  /**
   * One pass over the shared (read-only) delegation rows: per chat, the best-ranked row and the
   * controller's active/in-flight child counts. No per-chat sort and no second filter pass.
   *
   * @type {Map<string, { best: Record<string, any> | null, bestRank: number, active: number, inFlight: number }>}
   */
  const byChat = new Map();
  const bucketFor = (id) => {
    let bucket = byChat.get(id);
    if (!bucket) {
      bucket = { best: null, bestRank: 0, active: 0, inFlight: 0 };
      byChat.set(id, bucket);
    }
    return bucket;
  };
  for (const row of listDelegationsForChatIds(ids)) {
    const controller = String(delegationController(row) || '').trim();
    const rank = rankDelegation(row);
    const child = String(row.childChatId || '').trim();
    const parent = String(row.parentChatId || '').trim();
    for (const id of [child, controller, parent]) {
      if (!id || !wantedSet.has(id)) continue;
      // A chat on two ends of one row picks the same row twice: harmless, the pick is idempotent.
      const bucket = bucketFor(id);
      if (!bucket.best || rank > bucket.bestRank || (rank === bucket.bestRank
        && String(row.createdAt || '').localeCompare(String(bucket.best.createdAt || '')) > 0)) {
        bucket.best = row;
        bucket.bestRank = rank;
      }
    }
    if (controller && wantedSet.has(controller) && isActiveDelegationStatus(row.status)) {
      const bucket = bucketFor(controller);
      bucket.active += 1;
      if (isInFlightDelegationStatus(row.status)) bucket.inFlight += 1;
    }
  }
  /** @type {Record<string, ReturnType<typeof resolveChatAgentPresence>>} */
  const out = {};
  for (const chatId of ids) {
    const chat = chatById.get(chatId);
    if (!chat) continue;
    const bucket = byChat.get(chatId);
    const run = getChatRunStateForChat(chat, '');
    const delegation = bucket?.best || null;
    let presence = resolveChatAgentPresence(run, delegation);
    if (hasBrowserConsentPending(chatId)) {
      presence = { ...presence, state: 'waiting', attention: true, inputRequested: true };
    }
    const recoveryPresence = resolveRecoveryAgentPresence(recoveryByChat[chatId]);
    if (recoveryPresence) {
      // Live/delegation work wins; the registry only fills idle chats and marks
      // an in-flight resume that the in-memory service cannot see yet.
      if (presence.state === 'idle') {
        presence = recoveryPresence.recoveryStatus === 'waiting'
          ? { ...recoveryPresence, inputRequested: true }
          : recoveryPresence;
      } else if (presence.state === 'busy' && recoveryPresence.recoveryStatus === 'resuming') {
        presence = { ...presence, recoveryStatus: 'resuming' };
      } else if (presence.state !== 'busy') {
        // Keep recovery visible next to another non-idle state (e.g. attention
        // from a completed delegation); base state and delegation fields stay.
        presence = {
          ...presence,
          recoveryStatus: recoveryPresence.recoveryStatus,
          attention: true,
          ...(recoveryPresence.recoveryStatus === 'waiting' ? { inputRequested: true } : {}),
        };
      }
    }
    if (bucket && bucket.active > 0) {
      const inFlightChildCount = bucket.inFlight;
      const waitingPresence = mergePresenceActivity({
        ...presence,
        state: presence.state === 'attention' ? 'attention' : 'waiting',
        waitingAgentCount: bucket.active,
        inFlightChildCount,
      }, getChatPresenceActivity(chatId));
      out[chatId] = waitingPresence;
      continue;
    }
    if (presence.state === 'idle') continue;
    out[chatId] = mergePresenceActivity(presence, getChatPresenceActivity(chatId));
  }
  return out;
}

/**
 * Async twin: reads the rows with one `peekChatsAsync` (read-only shared rows, no per-call copy) and summarizes.
 *
 * @param {string[]} [chatIds]
 * @returns {Promise<Record<string, ReturnType<typeof resolveChatAgentPresence>>>}
 */
export async function summarizeChatRunStatesAsync(chatIds) {
  return summarizeChatRunStates(chatIds, { chats: await peekChatsAsync() });
}
