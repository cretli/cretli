/**
 * Lightweight per-chat agent presence for the sidebar (no WebSocket required).
 */

import { loadChats } from './persist/chats-persist.js';
import { listDelegationsForChatIds } from './persist/delegations-persist.js';
import { getChatRunStateForChat } from './chat-run-service.js';
import {
  isActiveDelegationStatus,
  isInFlightDelegationStatus,
  normalizeDelegationStatus,
} from './delegation-status.js';
import { getChatPresenceActivity } from './agent-presence-hooks.js';
import { mergePresenceActivity } from './agent-presence-activity.js';

const TERMINAL_ATTENTION = new Set(['completed', 'failed', 'interrupted']);

/**
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isDelegationAcknowledged(row) {
  return Boolean(String(row?.acknowledgedAt || '').trim());
}

/**
 * Attention survives reloads until the user opens a waiting executor
 * or explicitly reviews a finished job.
 *
 * @param {object | null | undefined} row
 * @returns {boolean}
 */
export function isDelegationAttention(row) {
  if (!row || isDelegationAcknowledged(row)) return false;
  const status = normalizeDelegationStatus(row.status);
  if (status === 'waiting_for_input') return true;
  return TERMINAL_ATTENTION.has(status);
}

/**
 * @param {object | null | undefined} row
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
 * @param {object[]} rows
 * @returns {object | null}
 */
function pickDelegation(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return [...rows].sort((left, right) => {
    const byRank = rankDelegation(right) - rankDelegation(left);
    if (byRank !== 0) return byRank;
    return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
  })[0] || null;
}

/**
 * @param {object | null} run
 * @param {object | null} delegation
 * @returns {{
 *   state: 'busy' | 'waiting' | 'attention' | 'idle',
 *   runId: string,
 *   delegationId: string,
 *   delegationStatus: string,
 *   attention: boolean,
 *   waitingAgentCount: number,
 *   inFlightChildCount: number,
 * }}
 */
export function resolveChatAgentPresence(run, delegation) {
  const runId = String(run?.runId || delegation?.runId || '');
  const delegationId = String(delegation?.id || '');
  const delegationStatus = normalizeDelegationStatus(delegation?.status);
  const waitingFromDelegation = delegationStatus === 'waiting_for_input' && !isDelegationAcknowledged(delegation);
  const waitingFromRun = run?.waitingForInput === true && !delegation;
  if (waitingFromDelegation || waitingFromRun) {
    return {
      state: 'waiting',
      runId,
      delegationId,
      delegationStatus,
      attention: true,
      waitingAgentCount: 0,
      inFlightChildCount: 0,
    };
  }
  const busy = run?.busy === true
    || (isActiveDelegationStatus(delegationStatus) && delegationStatus !== 'waiting_for_input');
  if (busy) {
    return {
      state: 'busy',
      runId,
      delegationId,
      delegationStatus,
      attention: false,
      waitingAgentCount: 0,
      inFlightChildCount: 0,
    };
  }
  if (isDelegationAttention(delegation) && TERMINAL_ATTENTION.has(delegationStatus)) {
    return {
      state: 'attention',
      runId,
      delegationId,
      delegationStatus,
      attention: true,
      waitingAgentCount: 0,
      inFlightChildCount: 0,
    };
  }
  return {
    state: 'idle',
    runId,
    delegationId,
    delegationStatus,
    attention: false,
    waitingAgentCount: 0,
    inFlightChildCount: 0,
  };
}

/**
 * Compact presence map: only busy | waiting | attention.
 * Idle chats are omitted; a missing id means idle.
 *
 * @param {string[]} [chatIds]
 * @returns {Record<string, ReturnType<typeof resolveChatAgentPresence>>}
 */
export function summarizeChatRunStates(chatIds) {
  const wanted = Array.isArray(chatIds)
    ? [...new Set(chatIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  const chats = loadChats();
  const chatById = new Map(chats.map((row) => [row.id, row]));
  const ids = wanted.length > 0 ? wanted : chats.map((row) => row.id);
  const delegations = listDelegationsForChatIds(ids);
  /** @type {Map<string, object[]>} */
  const byChat = new Map();
  for (const row of delegations) {
    for (const chatId of [row.childChatId, row.parentChatId]) {
      const id = String(chatId || '').trim();
      if (!id) continue;
      const list = byChat.get(id) || [];
      list.push(row);
      byChat.set(id, list);
    }
  }
  /** @type {Record<string, ReturnType<typeof resolveChatAgentPresence>>} */
  const out = {};
  for (const chatId of ids) {
    const chat = chatById.get(chatId);
    if (!chat) continue;
    const run = getChatRunStateForChat(chat, '');
    const delegation = pickDelegation(byChat.get(chatId) || []);
    const presence = resolveChatAgentPresence(run, delegation);
    const childJobs = (byChat.get(chatId) || []).filter((row) => (
      String(row.parentChatId || '') === chatId && isActiveDelegationStatus(row.status)
    ));
    if (childJobs.length > 0) {
      const inFlightChildCount = childJobs.filter((row) => (
        isInFlightDelegationStatus(row.status)
      )).length;
      const waitingPresence = mergePresenceActivity({
        ...presence,
        state: presence.state === 'attention' ? 'attention' : 'waiting',
        waitingAgentCount: childJobs.length,
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
