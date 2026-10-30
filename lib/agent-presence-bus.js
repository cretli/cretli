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
/**
 * In-memory presence index: every non-idle chat's merged row, updated from the dirty ids of each
 * flush. Attach and owed-snapshot sends read this instead of summarizing all chats, so their cost
 * depends on the number of active chats, not on the number of chats in the system. It is built
 * by one full summarize on first use (and rebuilt by every unscoped refresh); Map insertion order
 * is recency order (an updated row is re-inserted last).
 * @type {Map<string, Record<string, any>>}
 */
const presenceIndex = new Map();
let presenceIndexReady = false;
/** First-packet window: this many most recently changed active chats. Older ones come on demand. */
export const PRESENCE_ATTACH_WINDOW = 200;
/** Wire version of the presence message; v2 clients announce support and understand `partial`. */
export const PRESENCE_PROTOCOL_VERSION = 2;
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
/** @type {WeakSet<Record<string, any>>} */
const debtCloseBound = new WeakSet();
/** @type {((ids?: string[]) => Record<string, Record<string, any>>) | null} */
let summarizeOverride = null;
/** @type {(() => Record<string, any>[]) | null} */
let watcherLoaderOverride = null;
let lastWatcherKey = '';
const PRESENCE_ERROR_LOG_INTERVAL_MS = 30_000;
let presenceErrorCount = 0;
let lastLoggedErrorCount = 0;
let lastPresenceErrorLogAt = 0;

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
    sendAgentPresenceToClient(ws, scope, { snapshot: true, protocol: /** @type {any} */ (ws)?._presenceProtocol });
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
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
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
  if (row.interruptCode) out.interruptCode = row.interruptCode;
  if (row.recoveryStatus) out.recoveryStatus = row.recoveryStatus;
  if (row.activityKey) {
    out.activityKey = row.activityKey;
    if (row.activityArg) out.activityArg = row.activityArg;
  }
  return out;
}

/**
 * @param {string[] | undefined} [ids]
 * @returns {Record<string, Record<string, any>>}
 */
function loadPresenceMap(ids) {
  const summarize = typeof summarizeOverride === 'function' ? summarizeOverride : summarizeChatRunStates;
  const raw = summarize(ids);
  /** @type {Record<string, Record<string, any>>} */
  const out = {};
  for (const [id, row] of Object.entries(raw || {})) {
    out[id] = mergePresenceActivity(row, getChatPresenceActivity(id));
  }
  return out;
}

/**
 * Apply one summarize result to the index. A scoped result only speaks for `ids`; an unscoped
 * one replaces the whole index.
 *
 * @param {string[] | undefined} ids
 * @param {Record<string, Record<string, any>>} nextMap
 * @returns {void}
 */
function updatePresenceIndex(ids, nextMap) {
  if (!ids) {
    presenceIndex.clear();
    for (const [id, row] of Object.entries(nextMap)) presenceIndex.set(id, row);
    presenceIndexReady = true;
    return;
  }
  if (!presenceIndexReady) return;
  for (const id of ids) {
    presenceIndex.delete(id);
    const row = nextMap[id];
    if (row && row.state && row.state !== 'idle') presenceIndex.set(id, row);
  }
}

/** @returns {void} */
function ensurePresenceIndex() {
  if (presenceIndexReady) return;
  updatePresenceIndex(undefined, loadPresenceMap());
}

/**
 * Snapshot rows for one socket. A v1 client gets every active chat (no `partial`); a v2 client
 * gets the newest `PRESENCE_ATTACH_WINDOW` and `partial: true` when more exist.
 *
 * @param {import("./chat-list-updates.js").ChatListScope} scope
 * @param {number} protocol
 * @returns {{ states: Record<string, Record<string, any>>, partial: boolean, total: number }}
 */
function selectSnapshotRows(scope, protocol) {
  ensurePresenceIndex();
  /** @type {Record<string, Record<string, any>>} */
  const states = {};
  const withActivity = (id, row) => mergePresenceActivity(row, getChatPresenceActivity(id));
  if (scope?.kind === 'widget') {
    // Bounded by the widget allowlist, never by the index size.
    for (const id of scope.chatIds || []) {
      const row = presenceIndex.get(id);
      if (row) states[id] = withActivity(id, row);
    }
    return { states, partial: false, total: Object.keys(states).length };
  }
  const total = presenceIndex.size;
  if (protocol < PRESENCE_PROTOCOL_VERSION || total <= PRESENCE_ATTACH_WINDOW) {
    for (const [id, row] of presenceIndex) states[id] = withActivity(id, row);
    return { states, partial: false, total };
  }
  const ids = [...presenceIndex.keys()].slice(-PRESENCE_ATTACH_WINDOW);
  for (const id of ids) states[id] = withActivity(id, presenceIndex.get(id));
  return { states, partial: true, total };
}

/**
 * @returns {{ states: Record<string, Record<string, any>>, cleared: string[] }}
 */
function diffPresence() {
  const ids = pendingAll ? undefined : [...pendingIds];
  pendingAll = false;
  pendingIds.clear();
  const nextMap = loadPresenceMap(ids);
  updatePresenceIndex(ids, nextMap);
  // A scoped refresh only summarized `ids`, so `nextMap` says nothing about any other chat.
  // Walking every known fingerprint here would read that silence as "idle" and clear each
  // unrelated busy chat on every tool event of another one.
  const considered = new Set(ids
    ? [...Object.keys(nextMap), ...ids]
    : [...fingerprints.keys(), ...Object.keys(nextMap)]);
  /** @type {Record<string, Record<string, any>>} */
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
 * @param {Record<string, any>} scope
 * @param {{ snapshot?: boolean, states?: Record<string, Record<string, any>>, cleared?: string[], watchers?: Record<string, any>[], degraded?: boolean, partial?: boolean, total?: number, version?: number }} payload
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
  // Versioned fields are only sent to clients that announced support (v1 never sees them).
  if (payload.version === PRESENCE_PROTOCOL_VERSION) {
    message.version = PRESENCE_PROTOCOL_VERSION;
    if (snapshot) {
      message.partial = payload.partial === true;
      message.total = Number(payload.total) || 0;
    }
  }
  // Tells the client the presence map is partial/empty because computing it failed.
  if (payload.degraded === true) message.degraded = true;
  // Watcher badges are per-workspace, so only the full session scope carries
  // them; widget scopes stay exactly as small as before.
  if (scope?.kind !== 'widget' && Array.isArray(payload.watchers)) {
    message.watchers = payload.watchers;
  }
  return JSON.stringify(message);
}

/**
 * @returns {Record<string, any>[]}
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
 * @param {import("./chat-list-updates.js").ChatListScope} scope
 * @param {{ snapshot?: boolean, protocol?: number }} [options]
 * @returns {void}
 */
export function sendAgentPresenceToClient(ws, scope, options = {}) {
  initAgentPresenceBus();
  try {
    const protocol = Number(options.protocol) || 1;
    const picked = options.snapshot === true
      ? selectSnapshotRows(scope, protocol)
      : { states: {}, partial: false, total: 0 };
    const watchers = loadWatcherRows();
    const message = encodePresenceMessage(scope, {
      snapshot: options.snapshot === true,
      states: picked.states,
      partial: picked.partial,
      total: picked.total,
      version: protocol,
      cleared: [],
      watchers,
    }, seq);
    deliverPresenceMessage(ws, message);
  } catch (err) {
    reportPresenceFailure('attach', err);
    sendDegradedPresence(ws, scope);
  }
}

/**
 * Count a presence failure and log it without flooding: the first failure of a burst is
 * logged, later ones only bump the counter until the quiet window has passed.
 *
 * @param {string} where
 * @param {unknown} err
 * @returns {void}
 */
function reportPresenceFailure(where, err) {
  presenceErrorCount += 1;
  const now = Date.now();
  if (now - lastPresenceErrorLogAt < PRESENCE_ERROR_LOG_INTERVAL_MS) return;
  const suppressed = presenceErrorCount - 1 - lastLoggedErrorCount;
  lastPresenceErrorLogAt = now;
  lastLoggedErrorCount = presenceErrorCount;
  console.error(`[agent-presence] ${where} failed (total=${presenceErrorCount}, suppressed=${suppressed}):`,
    err instanceof Error ? err.message : err);
}

/**
 * Empty snapshot flagged `degraded` so the client keeps its socket and shows partial state.
 *
 * @param {import('ws').WebSocket} ws
 * @param {import("./chat-list-updates.js").ChatListScope} scope
 * @returns {void}
 */
function sendDegradedPresence(ws, scope) {
  try {
    deliverPresenceMessage(ws, encodePresenceMessage(scope, {
      snapshot: true, states: {}, cleared: [], watchers: [], degraded: true,
    }, seq));
  } catch (err) {
    reportPresenceFailure('degraded-send', err);
  }
}

/** @returns {number} Tests only. */
export function getAgentPresenceErrorCount() {
  return presenceErrorCount;
}

/**
 * Encode (once per scope and protocol) a snapshot for a socket that missed one or more deltas.
 * Rows come from the presence index, so no summarize runs here.
 *
 * @param {import("./chat-list-updates.js").ChatListScope} scope
 * @param {number} protocol
 * @param {Record<string, any>[]} watchers
 * @param {number} seqValue
 * @returns {string}
 */
function encodeSnapshot(scope, protocol, watchers, seqValue) {
  const picked = selectSnapshotRows(scope, protocol);
  return encodePresenceMessage(scope, {
    snapshot: true,
    states: picked.states,
    partial: picked.partial,
    total: picked.total,
    version: protocol,
    cleared: [],
    watchers,
  }, seqValue);
}

// A memo of summarizeChatRunStates across flushes was deliberately NOT added: presence also
// depends on in-memory run state and activity hooks that change without any file write or
// dirty event we could key on, so a cached value could hide a busy -> idle transition.
// Instead dirty ids are re-summarized per flush and folded into `presenceIndex`.
function flushAgentPresence() {
  try {
    flushAgentPresenceUnsafe();
  } catch (err) {
    // A failed flush must not escape a timer callback; clients get one degraded frame.
    reportPresenceFailure('flush', err);
    for (const [ws, client] of listChatListUpdateClients()) sendDegradedPresence(ws, client.scope);
  }
}

function flushAgentPresenceUnsafe() {
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
    const protocol = Number(/** @type {any} */ (ws)?._presenceProtocol) || 1;
    const key = `${chatListScopeKey(client.scope)}|v${protocol}`;
    if (owed) {
      let snapshot = encodedSnapshots.get(key);
      if (!snapshot) {
        snapshot = encodeSnapshot(client.scope, protocol, watchers, seqValue);
        encodedSnapshots.set(key, snapshot);
      }
      deliverPresenceMessage(ws, snapshot);
      continue;
    }
    if (!changed) continue;
    let message = encodedDeltas.get(key);
    if (!message) {
      message = encodePresenceMessage(client.scope, {
        states, cleared, snapshot: false, watchers, version: protocol,
      }, seqValue);
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
 * @param {((ids?: string[]) => Record<string, Record<string, any>>) | null} fn
 * @returns {void}
 */
export function __setPresenceSummarizeForTest(fn) {
  summarizeOverride = typeof fn === 'function' ? fn : null;
}

/**
 * Tests only. Replaces the persisted watcher rows the presence payload carries.
 * @param {(() => Record<string, any>[]) | null} fn
 * @returns {void}
 */
export function __setWatcherPresenceForTest(fn) {
  watcherLoaderOverride = typeof fn === 'function' ? fn : null;
}

/**
 * Tests only. Copy of the presence index (builds it when cold).
 * @returns {Record<string, Record<string, any>>}
 */
export function __getPresenceIndexForTest() {
  ensurePresenceIndex();
  return Object.fromEntries(presenceIndex);
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
  presenceIndex.clear();
  presenceIndexReady = false;
  presenceErrorCount = 0;
  lastLoggedErrorCount = 0;
  lastPresenceErrorLogAt = 0;
}

/**
 * Tests only. Pins the bus epoch so an epoch-change frame can be produced deterministically.
 * @param {string} value
 * @returns {void}
 */
export function __setPresenceEpochForTest(value) {
  epoch = String(value || '');
}
