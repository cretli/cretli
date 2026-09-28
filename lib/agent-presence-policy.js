export const AGENT_PRESENCE_TTL_MS = 10000;
export const AGENT_PRESENCE_COALESCE_MS = 80;

/**
 * Skip GET /api/chats/agent-states only when local WS presence is trustworthy.
 *
 * @param {{
 *   redisBus?: boolean,
 *   hasOpenHarnessWs?: boolean,
 *   lastPresenceAt?: number,
 *   now?: number,
 *   hidden?: boolean,
 * }} [input]
 * @returns {boolean}
 */
export function shouldSkipHttpAgentStates(input = {}) {
  if (input.redisBus === true) return false;
  if (input.hidden === true) return false;
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
