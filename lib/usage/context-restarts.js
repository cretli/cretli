/**
 * In-memory ledger of harness session restarts.
 *
 * A restart rebuilds the context prefix, so a provider prompt cache is cold
 * from the first changed token onward. Recording these events makes the cost
 * visible (counts per chat and per harness+reason) without persisting them.
 *
 * Bounded by design: per-chat history is capped, the number of tracked chats
 * is capped (oldest first-seen entries are evicted), and the summary is derived
 * on demand. The ledger stores no prompts, tokens or other secrets.
 */

export const CONTEXT_RESTART_REASON = Object.freeze({
  /** The MCP document revision changed, so the tool prefix changes. */
  MCP_REVISION: 'mcp_revision',
  /** MCP content/order changed without a revision bump. */
  MCP_CONTENT_CHANGE: 'mcp_content_change',
  /** The harness system prompt changed (e.g. a Plan/Ask mode switch). */
  SYSTEM_PROMPT_CHANGE: 'system_prompt_change',
  /** The model changed and a live runtime had to be replaced. */
  MODEL_CHANGE: 'model_change',
  /** The Plan/Agent/Ask mode changed and a live runtime had to be replaced. */
  MODE_CHANGE: 'mode_change',
  /** A live session was dropped for a non-prefix reason (cwd, read-only). */
  SESSION_DROP: 'session_drop',
  /** The harness process/runtime was rebuilt for another reason. */
  PROCESS_RECREATED: 'process_recreated',
});

export const CONTEXT_RESTART_LIMITS = Object.freeze({
  maxEventsPerChat: 25,
  maxTrackedChats: 500,
});

const REASONS = new Set(Object.values(CONTEXT_RESTART_REASON));
const UNKNOWN_REASON = 'unknown';

/**
 * @typedef {{ chatId: string, harness: string, reason: string, at: number }} ContextRestartEvent
 */

/** @type {Map<string, { chatId: string, harness: string, count: number, byReason: Map<string, number>, events: ContextRestartEvent[], lastAt: number }>} */
const chats = new Map();

/** @type {Map<string, number>} */
const harnessReasonCounts = new Map();

/**
 * Listeners notified after a context-invalidating event (a recorded restart or
 * a compaction epoch bump). Kept as a registry so a consumer such as the
 * per-chat cache state can react without this module importing it and creating
 * a cycle. Listeners are best-effort: a throwing listener never affects the
 * restart bookkeeping.
 *
 * @type {Set<(event: { chatId: string, harness: string, reason: string, at: number }) => void>}
 */
const invalidationListeners = new Set();

let total = 0;

/**
 * Subscribe to context-invalidating events. Returns an unsubscribe function.
 *
 * @param {(event: { chatId: string, harness: string, reason: string, at: number }) => void} listener
 * @returns {() => void}
 */
export function onContextInvalidation(listener) {
  if (typeof listener !== 'function') return () => {};
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

/**
 * @param {{ chatId: string, harness: string, reason: string, at: number }} event
 * @returns {void}
 */
function notifyContextInvalidation(event) {
  for (const listener of invalidationListeners) {
    try {
      listener(event);
    } catch {
      // A cache-state consumer must never break the prompt/restart path.
    }
  }
}

/**
 * Keep only reasons from the stable enum so counters stay groupable.
 *
 * @param {unknown} reason
 * @returns {string}
 */
function normalizeReason(reason) {
  const value = String(reason || '').trim();
  return REASONS.has(value) ? value : UNKNOWN_REASON;
}

/**
 * @param {unknown} harness
 * @param {unknown} reason
 * @returns {string}
 */
function harnessReasonKey(harness, reason) {
  return `${harness}\u0000${reason}`;
}

/**
 * One compact console line, mirroring the delegation log style. Suppressed in
 * isolated test runs so suites stay quiet.
 *
 * @param {ContextRestartEvent} event
 * @returns {void}
 */
function logContextRestart(event) {
  if (process.env.CRETLI_TEST_DATA_DIR) return;
  console.info('[context-restart]', JSON.stringify(event));
}

/**
 * Record one cache-invalidating restart. Cheap: a few map operations and one
 * bounded array push. Safe to call from hot prompt paths.
 *
 * @param {{ chatId?: unknown, harness?: unknown, reason?: unknown, at?: unknown }} [input]
 * @returns {ContextRestartEvent}
 */
export function recordContextRestart(input = {}) {
  const chatId = String(input.chatId || '').trim() || 'unknown';
  const harness = String(input.harness || '').trim() || 'unknown';
  const reason = normalizeReason(input.reason);
  const at = Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now();
  let entry = chats.get(chatId);
  if (!entry) {
    entry = { chatId, harness, count: 0, byReason: new Map(), events: [], lastAt: at };
    chats.set(chatId, entry);
    if (chats.size > CONTEXT_RESTART_LIMITS.maxTrackedChats) {
      const oldest = chats.keys().next().value;
      if (oldest !== undefined) chats.delete(oldest);
    }
  }
  entry.harness = harness || entry.harness;
  entry.count += 1;
  entry.byReason.set(reason, (entry.byReason.get(reason) || 0) + 1);
  entry.lastAt = at;
  const event = { chatId, harness, reason, at };
  entry.events.push(event);
  if (entry.events.length > CONTEXT_RESTART_LIMITS.maxEventsPerChat) {
    entry.events.shift();
  }
  total += 1;
  const key = harnessReasonKey(harness, reason);
  harnessReasonCounts.set(key, (harnessReasonCounts.get(key) || 0) + 1);
  logContextRestart(event);
  notifyContextInvalidation(event);
  return event;
}

/**
 * Advances the logical context epoch for a room.
 *
 * A compaction rewrites the prompt prefix, so the provider prompt cache is
 * destroyed and the next request starts cold. The usage layer must therefore
 * not subtract a snapshot baseline from the previous epoch; bumping the epoch
 * gives every following measurement a new identity. Monotonic and cheap.
 *
 * @param {{ _contextEpoch?: unknown }} [room]
 * @param {string} [reason]
 * @returns {number|null} The new epoch, or null for a non-object room.
 */
export function advanceRoomContextEpoch(room, reason = '') {
  if (!room || typeof room !== 'object') return null;
  const current = Number.isFinite(Number(room._contextEpoch))
    ? Math.max(0, Math.floor(Number(room._contextEpoch)))
    : 0;
  const next = current + 1;
  room._contextEpoch = next;
  room._contextEpochReason = String(reason || '').trim() || 'context_reset';
  room._contextEpochAt = Date.now();
  // A compaction rewrites the prefix without going through `recordContextRestart`,
  // so tell cache-state consumers here as well; otherwise an advanced epoch would
  // only be visible to an estimator that explicitly passes it.
  notifyContextInvalidation({
    chatId: String(room.chatId || '').trim() || 'unknown',
    harness: String(room.transport || '').trim() || 'unknown',
    reason: room._contextEpochReason,
    at: room._contextEpochAt,
  });
  return next;
}

/**
 * @param {unknown} chatId
 * @returns {{ chatId: string, harness: string, count: number, lastAt: number, byReason: Record<string, number>, events: ContextRestartEvent[] } | null}
 */
export function getContextRestartForChat(chatId) {
  const id = String(chatId || '').trim();
  const entry = chats.get(id);
  if (!entry) return null;
  return {
    chatId: entry.chatId,
    harness: entry.harness,
    count: entry.count,
    lastAt: entry.lastAt,
    byReason: Object.fromEntries(entry.byReason),
    events: entry.events.map((event) => ({ ...event })),
  };
}

/**
 * Bounded snapshot: per-chat counts and per harness+reason totals.
 *
 * @returns {{
 *   total: number,
 *   chats: Array<{ chatId: string, harness: string, count: number, lastAt: number, byReason: Record<string, number>, events: ContextRestartEvent[] }>,
 *   byHarnessReason: Array<{ harness: string, reason: string, count: number }>,
 * }}
 */
export function getContextRestartSummary() {
  const chatRows = [];
  for (const entry of chats.values()) {
    chatRows.push({
      chatId: entry.chatId,
      harness: entry.harness,
      count: entry.count,
      lastAt: entry.lastAt,
      byReason: Object.fromEntries(entry.byReason),
      events: entry.events.map((event) => ({ ...event })),
    });
  }
  const byHarnessReason = [];
  for (const [key, count] of harnessReasonCounts) {
    const separator = key.indexOf('\u0000');
    byHarnessReason.push({
      harness: key.slice(0, separator),
      reason: key.slice(separator + 1),
      count,
    });
  }
  return { total, chats: chatRows, byHarnessReason };
}

/**
 * Test-only reset. Never called from production paths.
 *
 * @returns {void}
 */
export function resetContextRestartsForTests() {
  chats.clear();
  harnessReasonCounts.clear();
  total = 0;
}
