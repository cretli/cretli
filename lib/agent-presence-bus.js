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
import {
  AGENT_PRESENCE_BACKPRESSURE_RETRY_MS,
  AGENT_PRESENCE_COALESCE_MS,
} from './agent-presence-policy.js';
import {
  chatListScopeKey,
  listChatListUpdateClients,
  sendChatListClientMessage,
  setChatListSubscribeHook,
} from './chat-list-updates.js';
import {
  loadWorkspaceWatcherPresence,
  workspaceWatcherPresenceKey,
} from './workspace-watcher-live.js';

/** @type {Map<string, string>} */
const fingerprints = new Map();
const pendingIds = new Set();
let pendingAll = false;
let timer = null;
let seq = 0;
let initialized = false;
/**
 * Bus process identity. A server restart starts a new epoch, so a client that kept a
 * `lastPresenceSeq` from the previous process cannot mistake the fresh low seq for an
 * in-order continuation (and thus never see the restart gap).
 * @type {string}
 */
let epoch = createEpoch();
/**
 * Sockets whose last presence frame hit backpressure. The next flush (or the short retry
 * timer below) sends them a full snapshot instead of queueing deltas — a snapshot is
 * idempotent and repairs any delta lost while the socket buffered.
 * @type {Set<import('ws').WebSocket>}
 */
const owedSnapshots = new Set();
/** @type {ReturnType<typeof setTimeout> | null} */
let debtRetryTimer = null;
/** @type {WeakSet<object>} */
const debtCloseBound = new WeakSet();
/** @type {((ids?: string[]) => Record<string, object>) | null} */
let summarizeOverride = null;
/** @type {(() => object[]) | null} */
let watcherLoaderOverride = null;
let lastWatcherKey = '';

/**
 * @returns {string}
 */
function createEpoch() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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
 * @param {{ snapshot?: boolean, states?: Record<string, object>, cleared?: string[], watchers?: object[] }} payload
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
  /** @type {Record<string, unknown>} */
  const message = {
    type: 'agentPresence',
    epoch,
    seq: seqValue,
    snapshot,
    states: filtered.states,
    cleared: snapshot ? [] : filtered.cleared,
  };
  // Watcher badges are per-workspace, so only the full session scope carries
  // them; widget scopes stay exactly as small as before.
  if (scope?.kind !== 'widget' && Array.isArray(payload.watchers)) {
    message.watchers = payload.watchers;
  }
  return JSON.stringify(message);
}

/**
 * @returns {object[]}
 */
function loadWatcherRows() {
  if (typeof watcherLoaderOverride === 'function') return watcherLoaderOverride();
  return loadWorkspaceWatcherPresence();
}

/**
 * Keep a backpressured socket in debt so the next flush sends it a snapshot, and arm a
 * short retry in case the last change was the one that got dropped (no later flush).
 *
 * @param {import('ws').WebSocket} ws
 * @returns {void}
 */
function markPresenceDebt(ws) {
  // Only a live socket can recover; a closed one is dropped by the chat-list registry.
  if (!ws || ws.readyState !== 1) return;
  owedSnapshots.add(ws);
  if (!debtCloseBound.has(ws) && typeof ws.once === 'function') {
    debtCloseBound.add(ws);
    ws.once('close', () => owedSnapshots.delete(ws));
  }
  if (debtRetryTimer != null) return;
  debtRetryTimer = setTimeout(() => {
    debtRetryTimer = null;
    flushAgentPresence();
  }, AGENT_PRESENCE_BACKPRESSURE_RETRY_MS);
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} message
 * @returns {boolean}
 */
function deliverPresenceMessage(ws, message) {
  if (sendChatListClientMessage(ws, message)) {
    owedSnapshots.delete(ws);
    return true;
  }
  markPresenceDebt(ws);
  return false;
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
  const watchers = loadWatcherRows();
  const message = encodePresenceMessage(scope, {
    snapshot: options.snapshot === true,
    states,
    cleared: [],
    watchers,
  }, seq);
  deliverPresenceMessage(ws, message);
}

/**
 * Encode (once per scope) a full snapshot for a socket that missed one or more deltas.
 *
 * @param {ChatListScope} scope
 * @param {object[]} watchers
 * @param {number} seqValue
 * @returns {string}
 */
function encodeSnapshot(scope, watchers, seqValue) {
  return encodePresenceMessage(scope, {
    snapshot: true,
    states: loadPresenceMap(),
    cleared: [],
    watchers,
  }, seqValue);
}

function flushAgentPresence() {
  const { states, cleared } = diffPresence();
  const watchers = loadWatcherRows();
  const watcherKey = workspaceWatcherPresenceKey(watchers);
  const watchersChanged = watcherKey !== lastWatcherKey;
  const changed = Object.keys(states).length > 0 || cleared.length > 0 || watchersChanged;
  let seqValue = seq;
  if (changed) {
    lastWatcherKey = watcherKey;
    seq += 1;
    seqValue = seq;
  }
  // An owed socket must be served even when this flush carries no delta (that is exactly
  // the "last frame was dropped" case), so an empty flush is only a no-op when nobody owes.
  if (!changed && owedSnapshots.size === 0) return;
  /** @type {Map<string, string>} */
  const encodedDeltas = new Map();
  /** @type {Map<string, string>} */
  const encodedSnapshots = new Map();
  for (const [ws, client] of listChatListUpdateClients()) {
    const owed = owedSnapshots.has(ws);
    const key = chatListScopeKey(client.scope);
    if (owed) {
      let snapshot = encodedSnapshots.get(key);
      if (!snapshot) {
        snapshot = encodeSnapshot(client.scope, watchers, seqValue);
        encodedSnapshots.set(key, snapshot);
      }
      deliverPresenceMessage(ws, snapshot);
      continue;
    }
    if (!changed) continue;
    let message = encodedDeltas.get(key);
    if (!message) {
      message = encodePresenceMessage(client.scope, { states, cleared, snapshot: false, watchers }, seqValue);
      encodedDeltas.set(key, message);
    }
    deliverPresenceMessage(ws, message);
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
 * Tests only. Replaces the persisted watcher rows the presence payload carries.
 * @param {(() => object[]) | null} fn
 * @returns {void}
 */
export function __setWatcherPresenceForTest(fn) {
  watcherLoaderOverride = typeof fn === 'function' ? fn : null;
}

/**
 * Tests only.
 * @returns {void}
 */
export function __resetAgentPresenceBusForTest() {
  if (timer != null) clearTimeout(timer);
  timer = null;
  if (debtRetryTimer != null) clearTimeout(debtRetryTimer);
  debtRetryTimer = null;
  pendingAll = false;
  pendingIds.clear();
  fingerprints.clear();
  owedSnapshots.clear();
  seq = 0;
  // A reset models a fresh bus process, so it must mint a new epoch too.
  epoch = createEpoch();
  summarizeOverride = null;
  watcherLoaderOverride = null;
  lastWatcherKey = '';
}

/**
 * Tests only. Pins the bus epoch so an epoch-change frame can be produced deterministically.
 * @param {string} value
 * @returns {void}
 */
export function __setPresenceEpochForTest(value) {
  epoch = String(value || '');
}
