/**
 * Pure reconnect scheduling for the chat WebSocket: exponential backoff with jitter,
 * a circuit breaker and a "stable connection" reset. No timers, no DOM — the caller
 * owns `setTimeout` and passes `now` / `random` so everything is unit-testable.
 */

export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_JITTER_RATIO = 0.25;
/** Failed attempts in a row after which the breaker opens. */
export const RECONNECT_BREAKER_ATTEMPTS = 8;
/** Pause between probes while the breaker is open. */
export const RECONNECT_BREAKER_PAUSE_MS = 120_000;
/** A connection must stay open at least this long to reset the schedule. */
export const RECONNECT_STABLE_MS = 30_000;
/** Window for the reconnects-per-minute metric. */
export const RECONNECT_RATE_WINDOW_MS = 60_000;

/**
 * @returns {{ attempts: number, openedAt: number, breakerOpen: boolean, breakerNotified: boolean, startedAt: number[] }}
 */
export function createReconnectState() {
  return { attempts: 0, openedAt: 0, breakerOpen: false, breakerNotified: false, startedAt: [] };
}

/**
 * Base delay (no jitter) for the 1-based attempt number: 1 s, 2 s, 4 s ... up to the ceiling.
 *
 * @param {number} attempt
 * @returns {number}
 */
export function baseReconnectDelayMs(attempt) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (n - 1));
}

/**
 * Applies ±25% jitter, never going below the 1 s floor.
 *
 * @param {number} baseMs
 * @param {() => number} [random] returns [0, 1)
 * @returns {number}
 */
export function applyReconnectJitter(baseMs, random = Math.random) {
  const factor = 1 + (random() * 2 - 1) * RECONNECT_JITTER_RATIO;
  return Math.max(RECONNECT_BASE_DELAY_MS, Math.round(baseMs * factor));
}

/**
 * Records a successful socket open (starts the stability clock).
 *
 * @param {ReturnType<typeof createReconnectState>} state
 * @param {number} now
 */
export function recordReconnectOpen(state, now) {
  state.openedAt = now;
}

/**
 * @param {ReturnType<typeof createReconnectState>} state
 */
export function resetReconnectState(state) {
  state.attempts = 0;
  state.openedAt = 0;
  state.breakerOpen = false;
  state.breakerNotified = false;
}

/**
 * Records a socket close. A connection that lasted >= 30 s resets the schedule first.
 * Returns the delay before the next attempt and whether the breaker just opened.
 *
 * @param {ReturnType<typeof createReconnectState>} state
 * @param {number} now
 * @param {() => number} [random]
 * @returns {{ delayMs: number, attempt: number, breakerOpen: boolean, notifyBreaker: boolean }}
 */
export function recordReconnectFailure(state, now, random = Math.random) {
  if (state.openedAt && now - state.openedAt >= RECONNECT_STABLE_MS) {
    resetReconnectState(state);
  }
  state.openedAt = 0;
  state.attempts += 1;
  if (state.attempts >= RECONNECT_BREAKER_ATTEMPTS) state.breakerOpen = true;
  const baseMs = state.breakerOpen ? RECONNECT_BREAKER_PAUSE_MS : baseReconnectDelayMs(state.attempts);
  const delayMs = applyReconnectJitter(baseMs, random);
  const notifyBreaker = state.breakerOpen && !state.breakerNotified;
  if (notifyBreaker) state.breakerNotified = true;
  return { delayMs, attempt: state.attempts, breakerOpen: state.breakerOpen, notifyBreaker };
}

function pruneReconnectWindow(state, now) {
  const cutoff = now - RECONNECT_RATE_WINDOW_MS;
  while (state.startedAt.length && state.startedAt[0] <= cutoff) state.startedAt.shift();
}

/**
 * Notes the start of a reconnect attempt for the per-minute metric.
 *
 * @param {ReturnType<typeof createReconnectState>} state
 * @param {number} now
 */
export function noteReconnectAttempt(state, now) {
  state.startedAt.push(now);
  pruneReconnectWindow(state, now);
}

/**
 * @param {ReturnType<typeof createReconnectState>} state
 * @param {number} now
 * @returns {number} reconnect attempts during the last minute
 */
export function reconnectsPerMinute(state, now) {
  pruneReconnectWindow(state, now);
  return state.startedAt.length;
}

/**
 * Advances the chat's schedule by one failed attempt and mirrors the attempt count on
 * `chat._reconnectAttempts` (which manual retry / server recovery reset to 0).
 *
 * @param {{ _reconnectSchedule?: ReturnType<typeof createReconnectState>, _reconnectAttempts?: number }} chat
 * @param {number} now
 * @returns {ReturnType<typeof recordReconnectFailure>}
 */
export function planChatReconnect(chat, now) {
  const schedule = chat._reconnectSchedule || (chat._reconnectSchedule = createReconnectState());
  if (!chat._reconnectAttempts && schedule.attempts > 0) resetReconnectState(schedule);
  const plan = recordReconnectFailure(schedule, now);
  chat._reconnectAttempts = plan.attempt;
  return plan;
}
