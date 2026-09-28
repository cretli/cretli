/**
 * Coalesced agentPresence fan-out on chat-list WebSocket subscribers.
 */

import { summarizeChatRunStates } from './agent-run-state.js';
import {
  filterPresenceForScope,
  fingerprintAgentPresence,
  mergePresenceActivity,
} from './agent-presence-activity.js';
import {
  getChatPresenceActivity,
  setAgentPresenceDirtyHandler,
} from './agent-presence-hooks.js';
import { AGENT_PRESENCE_COALESCE_MS } from './agent-presence-policy.js';
import {
  chatListScopeKey,
  listChatListUpdateClients,
  sendChatListClientMessage,
  setChatListSubscribeHook,
} from './chat-list-updates.js';

/** @type {Map<string, string>} */
const fingerprints = new Map();
const pendingIds = new Set();
let pendingAll = false;
let timer = null;
let seq = 0;
let initialized = false;
/** @type {((ids?: string[]) => Record<string, object>) | null} */
let summarizeOverride = null;

/**
 * @returns {void}
 */
export function initAgentPresenceBus() {
  if (initialized) return;
  initialized = true;
  setAgentPresenceDirtyHandler(scheduleAgentPresenceRefresh);
  setChatListSubscribeHook((ws, scope) => {
    sendAgentPresenceToClient(ws, scope, { snapshot: true });
  });
}

/**
 * @param {string[] | undefined} chatIds
 * @returns {void}
 */
export function scheduleAgentPresenceRefresh(chatIds) {
  initAgentPresenceBus();
  if (!Array.isArray(chatIds) || chatIds.length === 0) {
    pendingAll = true;
  } else {
    for (const id of chatIds) {
      const trimmed = String(id || '').trim();
      if (trimmed) pendingIds.add(trimmed);
    }
  }
  if (timer != null) return;
  timer = setTimeout(() => {
    timer = null;
    flushAgentPresence();
  }, AGENT_PRESENCE_COALESCE_MS);
}

/**
 * @param {object} row
 * @returns {object}
 */
function compactPresenceRow(row) {
  const out = {
    state: row.state,
    runId: row.runId || '',
    delegationId: row.delegationId || '',
    delegationStatus: row.delegationStatus || '',
    attention: row.attention === true,
    waitingAgentCount: Number(row.waitingAgentCount) || 0,
  };
  if (row.activityKey) {
    out.activityKey = row.activityKey;
    if (row.activityArg) out.activityArg = row.activityArg;
  }
  return out;
}

/**
 * @param {string[] | undefined} ids
 * @returns {Record<string, object>}
 */
function loadPresenceMap(ids) {
  const summarize = typeof summarizeOverride === 'function' ? summarizeOverride : summarizeChatRunStates;
  const raw = summarize(ids);
  /** @type {Record<string, object>} */
  const out = {};
  for (const [id, row] of Object.entries(raw || {})) {
    out[id] = mergePresenceActivity(row, getChatPresenceActivity(id));
  }
  return out;
}

/**
 * @returns {{ states: Record<string, object>, cleared: string[] }}
 */
function diffPresence() {
  const ids = pendingAll ? undefined : [...pendingIds];
  pendingAll = false;
  pendingIds.clear();
  const nextMap = loadPresenceMap(ids);
  const considered = new Set([
    ...fingerprints.keys(),
    ...Object.keys(nextMap),
    ...(ids || []),
  ]);
  /** @type {Record<string, object>} */
  const states = {};
  /** @type {string[]} */
  const cleared = [];
  for (const id of considered) {
    const row = nextMap[id];
    const nextFp = fingerprintAgentPresence(row);
    const prevFp = fingerprints.get(id) || '';
    if (nextFp === prevFp) continue;
    if (!nextFp) {
      fingerprints.delete(id);
      if (prevFp) cleared.push(id);
      continue;
    }
    fingerprints.set(id, nextFp);
    states[id] = compactPresenceRow(row);
  }
  return { states, cleared };
}

/**
 * @param {object} scope
 * @param {{ snapshot?: boolean, states?: Record<string, object>, cleared?: string[] }} payload
 * @param {number} seqValue
 * @returns {string}
 */
function encodePresenceMessage(scope, payload, seqValue) {
  const snapshot = payload.snapshot === true;
  const filtered = filterPresenceForScope(
    payload.states || {},
    payload.cleared || [],
    scope
  );
  return JSON.stringify({
    type: 'agentPresence',
    seq: seqValue,
    snapshot,
    states: filtered.states,
    cleared: snapshot ? [] : filtered.cleared,
  });
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {ChatListScope} scope
 * @param {{ snapshot?: boolean }} [options]
 * @returns {void}
 */
export function sendAgentPresenceToClient(ws, scope, options = {}) {
  initAgentPresenceBus();
  const states = options.snapshot === true ? loadPresenceMap() : {};
  const message = encodePresenceMessage(scope, {
    snapshot: options.snapshot === true,
    states,
    cleared: [],
  }, seq);
  sendChatListClientMessage(ws, message);
}

function flushAgentPresence() {
  const { states, cleared } = diffPresence();
  if (Object.keys(states).length === 0 && cleared.length === 0) return;
  seq += 1;
  const seqValue = seq;
  /** @type {Map<string, string>} */
  const encodedByScope = new Map();
  for (const [ws, client] of listChatListUpdateClients()) {
    const key = chatListScopeKey(client.scope);
    let message = encodedByScope.get(key);
    if (!message) {
      message = encodePresenceMessage(client.scope, { states, cleared, snapshot: false }, seqValue);
      encodedByScope.set(key, message);
    }
    sendChatListClientMessage(ws, message);
  }
}

/**
 * @returns {void}
 */
export function flushAgentPresenceNow() {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  flushAgentPresence();
}

/**
 * Tests only.
 * @param {((ids?: string[]) => Record<string, object>) | null} fn
 * @returns {void}
 */
export function __setPresenceSummarizeForTest(fn) {
  summarizeOverride = typeof fn === 'function' ? fn : null;
}

/**
 * Tests only.
 * @returns {void}
 */
export function __resetAgentPresenceBusForTest() {
  if (timer != null) clearTimeout(timer);
  timer = null;
  pendingAll = false;
  pendingIds.clear();
  fingerprints.clear();
  seq = 0;
  summarizeOverride = null;
}
