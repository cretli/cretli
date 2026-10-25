export const AGENT_PRESENCE_TTL_MS = 10000;
export const AGENT_PRESENCE_COALESCE_MS = 80;
/**
 * How long an owed snapshot waits before the bus retries a backpressured socket.
 * Kept well under the 1 s sidebar-latency budget so a busy→idle frame dropped by
 * `bufferedAmount` still lands without waiting for the 15 s poll.
 */
export const AGENT_PRESENCE_BACKPRESSURE_RETRY_MS = 250;

/**
 * Skip GET /api/chats/agent-states only when local WS presence is trustworthy.
 *
 * `presenceUncertain` is set by the client after a detected seq gap or a bus epoch
 * change: local state is known incomplete, so the HTTP snapshot must not be skipped
 * just because a frame arrived recently.
 *
 * @param {{
 *   redisBus?: boolean,
 *   hasOpenHarnessWs?: boolean,
 *   lastPresenceAt?: number,
 *   now?: number,
 *   hidden?: boolean,
 *   presenceUncertain?: boolean,
 * }} [input]
 * @returns {boolean}
 */
export function shouldSkipHttpAgentStates(input = {}) {
  if (input.redisBus === true) return false;
  if (input.hidden === true) return false;
  if (input.presenceUncertain === true) return false;
  if (input.hasOpenHarnessWs !== true) return false;
  const last = Number(input.lastPresenceAt) || 0;
  if (last <= 0) return false;
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  return now - last < AGENT_PRESENCE_TTL_MS;
}

/**
 * @param {number | null | undefined} lastSeq
 * @param {number | null | undefined} nextSeq
 * @param {boolean} [snapshot]
 * @returns {boolean}
 */
export function hasAgentPresenceSeqGap(lastSeq, nextSeq, snapshot = false) {
  if (snapshot === true) return false;
  const next = Number(nextSeq);
  if (!Number.isSafeInteger(next) || next < 1) return true;
  const prev = Number(lastSeq);
  if (!Number.isSafeInteger(prev) || prev < 1) return false;
  return next > prev + 1;
}
