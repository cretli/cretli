import { getChatHistoryRevisions, getChatAgentStates, postChatHistoryBatch } from '../../api.js';
import {
  CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
  CHAT_HISTORY_BACKGROUND_PULL_MAX_PAGES,
} from '../../config.js';
import { buildChatHistoryBatchBody } from '../../lib/chatIdsQuery.js';
import { getLastAckedSeq, ingestChatHistoryDeltaResponse } from '../../lib/sdk-chat-history-store.js';
import { isMobileLikeClient } from '../../lib/mobileClient.js';
import { getChatActivityAt } from './chatStore.js';
import { getRenderedSidebarChatIds } from '../sidebar/sidebarVisibleChats.js';
import {
  resolveBackgroundMonitorMode,
  selectBackgroundWsChatIds,
  selectMonitoredChatIds,
  selectMonitoredChatIdsAsync,
  selectHistoryHttpChatIds,
  shouldSkipBackgroundHistoryHttp,
  capHistoryHttpJobs,
  HISTORY_HTTP_MAX_POSTS_PER_POLL,
} from './chatBackgroundPolicy.js';
import {
  resolveBackgroundHttpBatchDelayMs,
  resolveBackgroundHttpBatchSize,
} from './chatWsReconnectPolicy.js';
import { getUiFreezeCounters } from '../../lib/uiFreezeCounters.js';
import {
  beginPendingRemoteHistoryBatch,
  configureChatPendingRemoteHistoryPublisher,
  endPendingRemoteHistoryBatch,
  flushPendingRemoteHistoryPublish,
  setChatPendingRemoteHistoryFlag,
} from './chatPendingRemoteHistoryFlag.js';
import {
  ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS,
  RESUME_POLL_DEFER_MOBILE_MS,
  shouldSkipActiveChatHistoryPollSync,
} from './chatResumePolicy.js';
import { notifyChatBackendReachable, notifyChatConnectionRestored } from './chatServerRecovery.js';
import {
  hasAgentPresenceSeqGap,
  shouldSkipHttpAgentStates,
} from '../../../lib/agent-presence-policy.js';
import {
  agentRunStateDedupeKey,
  applyDelta as applyPresenceDelta,
  applyHttpStates as applyPresenceHttpStates,
  applySnapshot as applyPresenceSnapshot,
} from './agentPresenceStore.js';
import {
  getViewAppliedSeq,
  resolveHistorySyncPollFollowUp,
  shouldClearPendingRemoteHistory,
} from './chatHistoryConvergence.js';
import { isBlockingPersistedLocalChatHarnessState } from './persistedLocalChatState.js';

const POLL_INTERVAL_MS = 15000;
const HISTORY_POLL_START_DELAY_MS = 1500;
const RESUME_POLL_DEFER_MS = 5000;
const BACKGROUND_HISTORY_SYNC_GAP_MS = 250;
const EMPTY_HISTORY_PULL_BACKOFF_MS = 60000;
/** @type {Map<string, number>} */
const emptyPullBackoffUntil = new Map();

const backgroundHistoryPullOptions = {
  pageLimit: CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
  maxPages: CHAT_HISTORY_BACKGROUND_PULL_MAX_PAGES,
};

/** @type {ChatHistorySyncPollDeps | null} */
let deps = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimerId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let firstPollTimerId = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let resumePollTimerId = null;
/** @type {Map<string, number>} */
const lastActiveHistorySyncAt = new Map();
/** @type {Map<string, number>} */
const gapFirstSeenAt = new Map();
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const gapRecheckTimers = new Map();
/** @type {Map<string, number>} */
const historySyncRetryAttempt = new Map();
let pollInFlight = false;
let pollQueued = false;
let lastPresenceAt = 0;
let lastPresenceSeq = 0;
/**
 * Bus process identity of the last presence frame. A change means the server restarted
 * (or the bus was re-initialized), so the local seq baseline is meaningless and a full
 * snapshot is required before deltas can be trusted again.
 * @type {string}
 */
let lastPresenceEpoch = '';
/**
 * Set when local presence is known incomplete (seq gap or epoch change). The HTTP
 * agent-states fallback must not be skipped while this is set, and a snapshot clears it.
 * @type {boolean}
 */
let presenceFallbackRequired = false;
/**
 * When the current uncertainty started. An HTTP response is only allowed to clear
 * `presenceFallbackRequired` when it was requested after this instant; a gap that lands
 * while the request is in flight stays pending for the next poll.
 * @type {number}
 */
let presenceUncertaintyAt = 0;

/**
 * @typedef {object} ChatHistorySyncPollDeps
 * @property {() => object[]} getChats
 * @property {() => string | null} getActiveChatId
 * @property {(chat: object, context?: object) => Promise<{ status?: string } | void>} syncSdkHistoryOnResume
 * @property {{ log: (tag: string, message: string, payload?: object) => void }} appLogger
 * @property {(changedChats: object[], meta?: { ids?: string[], addedIds?: string[], removedIds?: string[] }) => void} [onPendingHistoryChange]
 * @property {(ids?: string[]) => void} [onAgentStatesChange]
 * @property {(ids?: string[]) => void} [onAgentPresenceChange]
 * @property {() => 'local' | 'redis' | string} [getSdkRoomBusMode]
 * @property {() => boolean} [hasOpenHarnessWs]
 */

/**
 * @returns {boolean}
 */
export function isChatHistoryRevisionPollInFlight() {
  return pollInFlight;
}

/**
 * Interval + gap-recheck share one cycle. A signal during the run queues one more pass.
 *
 * @returns {boolean} true when this caller owns the cycle
 */
export function tryEnterChatHistoryRevisionPoll() {
  if (pollInFlight) {
    pollQueued = true;
    return false;
  }
  pollInFlight = true;
  return true;
}

/**
 * @returns {boolean} true when another pass was requested while in flight
 */
export function leaveChatHistoryRevisionPoll() {
  const again = pollQueued;
  pollQueued = false;
  pollInFlight = false;
  return again;
}

function clearGapRecheck(chatId) {
  const timer = gapRecheckTimers.get(chatId);
  if (timer != null) {
    clearTimeout(timer);
    gapRecheckTimers.delete(chatId);
  }
  gapFirstSeenAt.delete(chatId);
}

function scheduleGapRecheck(chatId, delayMs, options = {}) {
  if (gapRecheckTimers.has(chatId)) {
    if (options.replace !== true) return;
    clearTimeout(gapRecheckTimers.get(chatId));
    gapRecheckTimers.delete(chatId);
  }
  gapRecheckTimers.set(
    chatId,
    setTimeout(() => {
      gapRecheckTimers.delete(chatId);
      void pollChatHistoryRevisions();
    }, Math.max(0, delayMs))
  );
}

/**
 * Store ACK is not the view. Keep the badge until viewAppliedSeq catches headSeq.
 *
 * @param {{ headSeq?: number, viewAppliedSeq?: number, incomplete?: boolean }} input
 * @returns {boolean}
 */
export function canClearPendingRemoteHistoryAfterStoreAck(input) {
  if (input?.incomplete === true) return false;
  return shouldClearPendingRemoteHistory({
    status: 'success',
    headSeq: input?.headSeq,
    viewAppliedSeq: input?.viewAppliedSeq,
  });
}

/**
 * Apply a compact agent-states map. Missing keys are idle (clears a previous busy row).
 *
 * A response is authoritative even when a chat's state did not change, so every
 * chat is stamped with the server watermark `_serverRunStateAt`. That watermark
 * blocks an older push-inbox record from resurrecting a superseded state.
 *
 * The full map also goes into `agentPresenceStore` first, so an id the list does not
 * contain yet keeps its row and its watermark until the chat object exists.
 *
 * @param {object[]} chats
 * @param {Record<string, object> | null | undefined} statesById
 * @param {{ requestedAt?: number }} [options] HTTP request start time. Rows already newer
 *   than the request (a WS frame that landed while it was in flight) are left untouched,
 *   so a late HTTP response can never roll back a newer push.
 * @returns {{ changed: boolean, dirtyIds: string[] }} `dirtyIds` are the chats whose
 *   rendered state changed (a new state or a missing one cleared to idle). Callers must
 *   read `.changed`, never the object as a boolean (an object is always truthy).
 */
export function applyAgentStatesToChats(chats, statesById, options = {}) {
  if (!statesById || typeof statesById !== 'object') return { changed: false, dirtyIds: [] };
  let changed = false;
  /** @type {string[]} */
  const dirtyIds = [];
  const touchedAt = Date.now();
  const requestedAt = Number(options?.requestedAt);
  const watermark = Number.isFinite(requestedAt) && requestedAt > 0 ? requestedAt : touchedAt;
  applyPresenceHttpStates(statesById, touchedAt, { ifRowAtOrBefore: watermark });
  const list = Array.isArray(chats) ? chats : [];
  for (const chat of list) {
    const prevAt = Number(chat._serverRunStateAt) || 0;
    if (prevAt > watermark) continue;
    const next = statesById[chat.id] || null;
    const prev = chat._serverRunState || null;
    chat._serverRunStateAt = touchedAt;
    if (agentRunStateDedupeKey(prev) === agentRunStateDedupeKey(next)) continue;
    chat._serverRunState = next;
    changed = true;
    if (chat?.id) dirtyIds.push(chat.id);
  }
  // A full HTTP map is authoritative for the uncertainty it was requested after. A gap or
  // epoch change that landed while the request was in flight stays pending for the next pass.
  if (!(Number.isFinite(requestedAt) && requestedAt > 0) || presenceUncertaintyAt <= requestedAt) {
    presenceFallbackRequired = false;
  }
  return { changed, dirtyIds };
}

// The presence identity lives in the store, which is the only module that has to compare a
// remembered row against a chat object. Re-exported so `pushInbox.js` keeps one definition.
export { agentRunStateDedupeKey };

/**
 * Patch presence from a WS frame. Snapshot treats missing ids as idle.
 *
 * Every chat mentioned by the frame gets `_serverRunStateAt = Date.now()`, even
 * when its state is unchanged and even in a snapshot. The watermark is the
 * authoritative server clock that push-inbox patches are compared against, so it
 * must advance on every server message, not only on a state-key change.
 *
 * The frame is recorded in `agentPresenceStore` before any chat object is touched, so a
 * snapshot that arrives while the list is still loading — or a delta naming a delegation
 * sub-chat the client has never seen — is not lost: `chatController` hydrates the row when
 * the chat object appears.
 *
 * @param {object[]} chats
 * @param {{ states?: Record<string, object>, cleared?: string[], snapshot?: boolean } | null | undefined} message
 * @returns {{ changed: boolean, dirtyIds: string[] }}
 */
export function applyAgentPresenceToChats(chats, message) {
  if (!message || typeof message !== 'object') return { changed: false, dirtyIds: [] };
  const list = Array.isArray(chats) ? chats : [];
  const touchedAt = Date.now();
  if (message.snapshot === true) {
    const states = message.states && typeof message.states === 'object' ? message.states : {};
    applyPresenceSnapshot(states, touchedAt);
    const dirtyIds = [];
    for (const chat of list) {
      const next = states[chat.id] || null;
      chat._serverRunStateAt = touchedAt;
      if (agentRunStateDedupeKey(chat._serverRunState) === agentRunStateDedupeKey(next)) continue;
      chat._serverRunState = next;
      dirtyIds.push(chat.id);
    }
    return { changed: dirtyIds.length > 0, dirtyIds };
  }
  const states = message.states && typeof message.states === 'object' ? message.states : {};
  applyPresenceDelta(states, message.cleared, touchedAt);
  const byId = new Map(list.map((chat) => [chat.id, chat]));
  const dirtyIds = [];
  for (const [id, next] of Object.entries(states)) {
    const chat = byId.get(id);
    if (!chat) continue;
    chat._serverRunStateAt = touchedAt;
    if (agentRunStateDedupeKey(chat._serverRunState) === agentRunStateDedupeKey(next)) continue;
    chat._serverRunState = next;
    dirtyIds.push(id);
  }
  for (const rawId of Array.isArray(message.cleared) ? message.cleared : []) {
    const id = String(rawId || '').trim();
    const chat = byId.get(id);
    if (!chat) continue;
    chat._serverRunStateAt = touchedAt;
    if (!chat._serverRunState) continue;
    chat._serverRunState = null;
    dirtyIds.push(id);
  }
  return { changed: dirtyIds.length > 0, dirtyIds };
}

/**
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Chats the revision poll may touch. A persisted local chat whose plugin is missing,
 * disabled, not chat-capable, or host-incompatible has no SDK runtime, so it must never
 * trigger an agent-state/history-revision HTTP request or an active resume sync. Every
 * other row (including `not_loaded`, no-state, and legacy rows) is preserved unchanged.
 *
 * @param {object[] | null | undefined} chats
 * @returns {object[]}
 */
export function selectPersistedLocalChatHistoryPollChats(chats) {
  return (Array.isArray(chats) ? chats : []).filter(
    (chat) => chat?.id && chat?.cursorSessionId && !isBlockingPersistedLocalChatHarnessState(chat)
  );
}

/**
 * @param {Array<{ chat: object, revision: object }>} jobs
 */
async function pullBackgroundHistoryQueue(jobs) {
  if (!deps || jobs.length === 0) return;
  const chunkSize = Math.max(1, resolveBackgroundHttpBatchSize());
  const delayMs = resolveBackgroundHttpBatchDelayMs();
  const cappedJobs = capHistoryHttpJobs(jobs, {
    chunkSize,
    maxPosts: HISTORY_HTTP_MAX_POSTS_PER_POLL,
  });
  for (let offset = 0; offset < cappedJobs.length; offset += chunkSize) {
    if (offset > 0) await waitMs(delayMs);
    // A background chat can turn blocking while the poll is in flight. Drop it before
    // the fetch, and re-check again before ingest because the POST itself is async.
    const slice = cappedJobs
      .slice(offset, offset + chunkSize)
      .filter(({ chat }) => !isBlockingPersistedLocalChatHarnessState(chat));
    if (slice.length === 0) continue;
    const body = buildChatHistoryBatchBody(
      slice.map(({ chat }) => ({
        id: chat.id,
        since: getLastAckedSeq(chat.id),
        limit: CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
      }))
    );
    if (!body) continue;
    let response = null;
    try {
      response = await postChatHistoryBatch(body.chats);
    } catch (err) {
      deps.appLogger.log('chat-history-poll', 'background history batch failed', {
        error: String(err?.message || err),
        chatIds: slice.map(({ chat }) => chat.id),
      });
      continue;
    }
    if (!response?.ok || !response.histories || typeof response.histories !== 'object') continue;
    for (const { chat, revision } of slice) {
      // The response is async: a chat may have flipped to blocking while the batch was
      // in flight. It must never ingest history or be pulled any further.
      if (isBlockingPersistedLocalChatHarnessState(chat)) continue;
      const page = response.histories[chat.id];
      if (!page) continue;
      const sinceBeforePull = getLastAckedSeq(chat.id);
      const synced = await ingestChatHistoryDeltaResponse(
        chat.id,
        chat.cursorSessionId || '',
        page,
        sinceBeforePull
      );
      if (!synced) {
        emptyPullBackoffUntil.set(chat.id, Date.now() + EMPTY_HISTORY_PULL_BACKOFF_MS);
        continue;
      }
      if (!synced.applied) {
        emptyPullBackoffUntil.set(chat.id, Date.now() + EMPTY_HISTORY_PULL_BACKOFF_MS);
      } else {
        emptyPullBackoffUntil.delete(chat.id);
      }
      if (synced.incomplete === true) {
        deps.appLogger.log('chat-history-poll', 'background history partial', {
          chatId: chat.id,
          applied: synced.applied,
          headSeq: synced.headSeq,
          ackSeq: synced.ackSeq,
        });
        continue;
      }
      if (
        !canClearPendingRemoteHistoryAfterStoreAck({
          headSeq: revision.headSeq,
          viewAppliedSeq: getViewAppliedSeq(chat.id, chat),
          incomplete: synced.incomplete,
        })
      ) {
        continue;
      }
      setChatPendingRemoteHistoryFlag(chat, false);
      clearGapRecheck(chat.id);
      deps.appLogger.log('chat-history-poll', 'background history synced', {
        chatId: chat.id,
        applied: synced.applied,
        headSeq: synced.headSeq,
        ackSeq: synced.ackSeq,
        pageLimit: CHAT_HISTORY_BACKGROUND_PULL_LIMIT,
      });
    }
    flushPendingRemoteHistoryPublish();
    if (isMobileLikeClient()) await waitMs(BACKGROUND_HISTORY_SYNC_GAP_MS);
  }
}

export function ingestAgentPresenceMessage(chats, message) {
  if (!message || typeof message !== 'object') {
    return { changed: false, dirtyIds: [], seqGap: false };
  }
  const seq = Number(message.seq);
  const snapshot = message.snapshot === true;
  const epoch = typeof message.epoch === 'string' ? message.epoch : '';
  const epochChanged = epoch !== '' && lastPresenceEpoch !== '' && epoch !== lastPresenceEpoch;
  if (epoch !== '') lastPresenceEpoch = epoch;

  if (epochChanged) {
    // The previous process's seq baseline is gone. Reset it before deciding anything.
    lastPresenceSeq = 0;
    presenceFallbackRequired = true;
    presenceUncertaintyAt = Date.now();
  }

  if (snapshot) {
    // A snapshot is self-contained and always wins, even when its seq is lower than the
    // one we last applied (server restart). Reset downward, never keep the stale high seq.
    if (Number.isSafeInteger(seq)) lastPresenceSeq = seq;
    lastPresenceAt = Date.now();
    const applied = applyAgentPresenceToChats(chats, message);
    presenceFallbackRequired = false;
    return { ...applied, seqGap: false };
  }

  if (epochChanged) {
    // A delta from a new epoch cannot be trusted as a continuation. Apply its content (it
    // is newer than the snapshot we no longer have) and require a snapshot for the rest.
    if (Number.isSafeInteger(seq) && seq > 0) lastPresenceSeq = seq;
    lastPresenceAt = 0;
    presenceFallbackRequired = true;
    presenceUncertaintyAt = Date.now();
    const applied = applyAgentPresenceToChats(chats, message);
    return { ...applied, seqGap: true };
  }

  if (Number.isSafeInteger(seq) && seq > 0 && seq <= lastPresenceSeq) {
    // Duplicate or out-of-order (epoch, seq): each chat socket re-delivers the shared bus
    // frame, so this is the common path. Drop it before any apply work.
    return { changed: false, dirtyIds: [], seqGap: false, duplicate: true };
  }

  if (hasAgentPresenceSeqGap(lastPresenceSeq, seq, snapshot)) {
    // Apply the frame: it is a valid newer delta. The missing middle is filled by the
    // HTTP agent-states snapshot the caller triggers on `seqGap`.
    lastPresenceAt = 0;
    presenceFallbackRequired = true;
    presenceUncertaintyAt = Date.now();
    if (Number.isSafeInteger(seq) && seq > 0) lastPresenceSeq = seq;
    const applied = applyAgentPresenceToChats(chats, message);
    return { ...applied, seqGap: true };
  }

  if (Number.isSafeInteger(seq) && seq > 0) lastPresenceSeq = seq;
  lastPresenceAt = Date.now();
  const applied = applyAgentPresenceToChats(chats, message);
  return { ...applied, seqGap: false };
}

export function invalidateAgentPresenceTrust() {
  lastPresenceAt = 0;
}

function shouldSkipAgentStatesHttp() {
  return shouldSkipHttpAgentStates({
    redisBus: deps?.getSdkRoomBusMode?.() === 'redis',
    hasOpenHarnessWs: deps?.hasOpenHarnessWs?.() === true,
    lastPresenceAt,
    hidden: typeof document !== 'undefined' && document.hidden === true,
    presenceUncertain: presenceFallbackRequired,
  });
}

/**
 * Tests only. Reads the module-local presence sync state.
 * @returns {{ lastPresenceSeq: number, lastPresenceEpoch: string, lastPresenceAt: number, presenceFallbackRequired: boolean, presenceUncertaintyAt: number }}
 */
export function __getAgentPresenceSyncStateForTest() {
  return {
    lastPresenceSeq,
    lastPresenceEpoch,
    lastPresenceAt,
    presenceFallbackRequired,
    presenceUncertaintyAt,
  };
}

/**
 * Tests only. Resets the module-local presence sync state.
 * @returns {void}
 */
export function __resetAgentPresenceSyncForTest() {
  lastPresenceAt = 0;
  lastPresenceSeq = 0;
  lastPresenceEpoch = '';
  presenceFallbackRequired = false;
  presenceUncertaintyAt = 0;
}

/**
 * Wrapper around one revision-poll pass. Pending UI publishes are batched only
 * around synchronous flag updates inside the pass (not across awaits). With the
 * freeze diagnostics flag off the counter calls are no-ops.
 *
 * @returns {Promise<void>}
 */
export async function runChatHistoryRevisionPoll() {
  const counters = getUiFreezeCounters();
  if (counters) counters.beginPendingBatch();
  try {
    await runChatHistoryRevisionPollPass();
  } finally {
    if (counters) counters.endPendingBatch();
  }
}

/**
 * One revision-poll pass. Runs through `runChatHistoryRevisionPoll`; kept as a
 * separate function so the batch wrapper can measure the whole pass.
 *
 * @returns {Promise<void>}
 */
async function runChatHistoryRevisionPollPass() {
  if (!deps || typeof document === 'undefined' || document.hidden) return;
  // Blocked persisted local chats are dropped before any agent-state/history HTTP so a
  // missing/disabled plugin can never drive SDK sync for that chat.
  const chats = selectPersistedLocalChatHistoryPollChats(deps.getChats());
  if (chats.length === 0) return;
  const now = Date.now();
  if (!shouldSkipAgentStatesHttp()) {
    try {
      // Remember when the request left: a WS frame that lands while it is in flight must
      // win over this response, which cannot contain it.
      const requestedAt = Date.now();
      const stateResponse = await getChatAgentStates();
      if (stateResponse?.ok) {
        const applied = applyAgentStatesToChats(chats, stateResponse.states, { requestedAt });
        if (applied.changed && typeof deps.onAgentStatesChange === 'function') {
          deps.onAgentStatesChange(applied.dirtyIds);
        }
      }
    } catch (err) {
      deps.appLogger.log('chat-history-poll', 'agent-state poll failed', {
        error: String(err?.message || err),
      });
    }
  }
  // A chat can turn blocking while the agent-state request was in flight: re-check the
  // live state before deciding which chats may be history-polled or resume-synced.
  const eligibleChats = chats.filter(
    (chat) => !isBlockingPersistedLocalChatHarnessState(chat)
  );
  if (eligibleChats.length === 0) return;
  const activeChatId = deps.getActiveChatId();
  // Task 0.1/3.1: while diagnostics are on, report the raw candidate reasons
  // ("before") and the archive-gated result ("after") per chat, split by
  // archivedAt. Production keeps the exact previous call.
  const pollCounters = getUiFreezeCounters();
  const classifiedOptions = pollCounters
    ? {
      onClassified: (chat, info) => {
        for (const reason of info.candidateReasons) {
          pollCounters.recordMonitoringCandidate({ reason, archived: info.archived });
        }
        for (const reason of info.reasons) {
          pollCounters.recordMonitoringQualification({ reason, archived: info.archived });
        }
      },
    }
    : {};
  const monitoredSet = await selectMonitoredChatIdsAsync(
    eligibleChats,
    deps.getActiveChatId,
    getChatActivityAt,
    Date.now(),
    classifiedOptions,
  );
  const monitoredChatIds = selectHistoryHttpChatIds(
    monitoredSet,
    eligibleChats,
    {
      activeChatId,
      visibleChatIds: getRenderedSidebarChatIds(),
    },
  );
  const wsChatIds = selectBackgroundWsChatIds(eligibleChats, deps.getActiveChatId, getChatActivityAt, now);
  const monitoredChats = eligibleChats.filter((chat) => monitoredChatIds.has(chat.id));
  if (pollCounters) {
    pollCounters.bump('poll.passes');
    pollCounters.bump('poll.eligibleChats', eligibleChats.length);
    pollCounters.bump('poll.monitoredChats', monitoredChats.length);
    pollCounters.bump('poll.visibleChats', getRenderedSidebarChatIds().size);
  }
  if (monitoredChats.length === 0) return;
  try {
    const response = await getChatHistoryRevisions(monitoredChats.map((chat) => chat.id));
    if (!response?.ok) return;
    const revisions = response.revisions && typeof response.revisions === 'object' ? response.revisions : {};
    /** @type {Array<{ chat: object, revision: object }>} */
    const backgroundHttpJobs = [];
    beginPendingRemoteHistoryBatch();
    try {
    for (const chat of monitoredChats) {
      // Re-check the live state after the revision request and immediately before any
      // active resume sync or background fetch/ingest: a chat that flipped to blocking
      // in flight must not drive SDK history.
      if (isBlockingPersistedLocalChatHarnessState(chat)) continue;
      const revision = revisions[chat.id];
      if (!revision || typeof revision.headSeq !== 'number') {
        setChatPendingRemoteHistoryFlag(chat, false);
        clearGapRecheck(chat.id);
        continue;
      }
      const localAck = getLastAckedSeq(chat.id);
      const viewAppliedSeq = getViewAppliedSeq(chat.id, chat);
      const storeLag = revision.headSeq > localAck;
      const viewLag = revision.headSeq > viewAppliedSeq;
      if (!storeLag && !viewLag) {
        setChatPendingRemoteHistoryFlag(chat, false);
        clearGapRecheck(chat.id);
        continue;
      }
      setChatPendingRemoteHistoryFlag(chat, true);
      if (!gapFirstSeenAt.has(chat.id)) gapFirstSeenAt.set(chat.id, now);
      const isActive = chat.id === activeChatId;
      const monitorMode = resolveBackgroundMonitorMode(
        chat,
        wsChatIds,
        monitoredChatIds,
        activeChatId
      );
      const hasPendingDelegation = revision.hasPendingDelegation === true;
      if (
        !isActive &&
        shouldSkipBackgroundHistoryHttp({
          monitorMode,
          hasPendingDelegation,
        })
      ) {
        if (!viewLag) {
          setChatPendingRemoteHistoryFlag(chat, false);
          clearGapRecheck(chat.id);
        }
        continue;
      }
      if (isActive) {
        const wsOpen = chat.ws?.readyState === WebSocket.OPEN;
        const gapObservedAt = gapFirstSeenAt.get(chat.id) || now;
        if (
          shouldSkipActiveChatHistoryPollSync({
            headSeq: revision.headSeq,
            localAck,
            viewAppliedSeq,
            wsOpen,
            hydrating: chat._sdkHistoryHydrating === true,
            lastSyncAt: lastActiveHistorySyncAt.get(chat.id),
            now,
            gapObservedAt,
            hasPendingDelegation,
          })
        ) {
          if (!viewLag) {
            setChatPendingRemoteHistoryFlag(chat, false);
            clearGapRecheck(chat.id);
          } else {
            const graceLeft = ACTIVE_CHAT_HISTORY_POLL_WS_GRACE_MS - (now - gapObservedAt);
            if (wsOpen && graceLeft > 0) {
              scheduleGapRecheck(chat.id, graceLeft);
            }
          }
          continue;
        }
        // Close the sync batch and publish before the long resume fetch.
        endPendingRemoteHistoryBatch();
        const result = await deps.syncSdkHistoryOnResume(chat, { reason: 'cross_device_poll' });
        const viewSeqAfter = getViewAppliedSeq(chat.id, chat);
        const followUp = resolveHistorySyncPollFollowUp({
          status: result?.status,
          headSeq: revision.headSeq,
          viewAppliedSeq: viewSeqAfter,
          wsOpen: chat.ws?.readyState === WebSocket.OPEN,
          retryAttempt: historySyncRetryAttempt.get(chat.id) || 0,
        });
        if (followUp.canClearPending) {
          lastActiveHistorySyncAt.set(chat.id, Date.now());
          setChatPendingRemoteHistoryFlag(chat, false);
          clearGapRecheck(chat.id);
          historySyncRetryAttempt.delete(chat.id);
        } else if (followUp.retryDelayMs > 0) {
          historySyncRetryAttempt.set(
            chat.id,
            (historySyncRetryAttempt.get(chat.id) || 0) + 1
          );
          scheduleGapRecheck(chat.id, followUp.retryDelayMs, { replace: true });
        } else {
          historySyncRetryAttempt.delete(chat.id);
        }
        if (followUp.notifyRestored) {
          notifyChatConnectionRestored(chat);
        } else if (followUp.notifyReachable) {
          notifyChatBackendReachable(chat);
        }
        flushPendingRemoteHistoryPublish();
        beginPendingRemoteHistoryBatch();
        continue;
      }
      const backoffUntil = emptyPullBackoffUntil.get(chat.id) || 0;
      if (backoffUntil > now) continue;
      backgroundHttpJobs.push({ chat, revision });
    }
    } finally {
      endPendingRemoteHistoryBatch();
    }
    // Flush before the background batch HTTP: a long pull must not hold back
    // the badges for the chats already marked in this pass.
    flushPendingRemoteHistoryPublish();
    await pullBackgroundHistoryQueue(backgroundHttpJobs);
  } catch (err) {
    deps.appLogger.log('chat-history-poll', 'revision poll failed', {
      error: String(err?.message || err),
    });
  }
}

async function pollChatHistoryRevisions() {
  if (!tryEnterChatHistoryRevisionPoll()) return;
  try {
    do {
      pollQueued = false;
      await runChatHistoryRevisionPoll();
    } while (pollQueued);
  } finally {
    leaveChatHistoryRevisionPoll();
  }
}

function startPolling() {
  if (pollTimerId != null || typeof window === 'undefined') return;
  pollTimerId = setInterval(() => {
    void pollChatHistoryRevisions();
  }, POLL_INTERVAL_MS);
  if (firstPollTimerId != null) clearTimeout(firstPollTimerId);
  firstPollTimerId = setTimeout(() => {
    firstPollTimerId = null;
    void pollChatHistoryRevisions();
  }, HISTORY_POLL_START_DELAY_MS);
}

function stopPolling() {
  if (firstPollTimerId != null) {
    clearTimeout(firstPollTimerId);
    firstPollTimerId = null;
  }
  if (pollTimerId == null) return;
  clearInterval(pollTimerId);
  pollTimerId = null;
}

function bindVisibilitySync() {
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      invalidateAgentPresenceTrust();
      if (resumePollTimerId != null) {
        clearTimeout(resumePollTimerId);
        resumePollTimerId = null;
      }
      return;
    }
    if (resumePollTimerId != null) clearTimeout(resumePollTimerId);
    const deferMs = isMobileLikeClient() ? RESUME_POLL_DEFER_MOBILE_MS : RESUME_POLL_DEFER_MS;
    resumePollTimerId = setTimeout(() => {
      resumePollTimerId = null;
      void pollChatHistoryRevisions();
    }, deferMs);
  });
}

/**
 * @param {ChatHistorySyncPollDeps} dependencies
 */
export function initChatHistorySyncPoll(dependencies) {
  deps = dependencies;
  // All three pending writers (poll, push inbox, convergence run) publish UI
  // changes through this single callback so one synchronous batch = one render.
  configureChatPendingRemoteHistoryPublisher(deps?.onPendingHistoryChange);
  bindVisibilitySync();
  startPolling();
}

export function stopChatHistorySyncPoll() {
  stopPolling();
  deps = null;
  configureChatPendingRemoteHistoryPublisher(null);
  pollInFlight = false;
  pollQueued = false;
  lastActiveHistorySyncAt.clear();
  historySyncRetryAttempt.clear();
  lastPresenceAt = 0;
  lastPresenceSeq = 0;
  lastPresenceEpoch = '';
  presenceFallbackRequired = false;
  presenceUncertaintyAt = 0;
  for (const timer of gapRecheckTimers.values()) clearTimeout(timer);
  gapRecheckTimers.clear();
  gapFirstSeenAt.clear();
}
