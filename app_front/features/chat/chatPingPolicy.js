/** Stale-pong limit measured from the first unacked ping, not the latest ping. */
export const CHAT_STALE_PONG_MS = 150000;

/** Resume probe: close an apparently-open socket if the control ping gets no pong. */
export const CHAT_RESUME_PROBE_PONG_MS = 20000;

/**
 * @param {{
 *   unackedPingAt?: number,
 *   lastPingAt?: number,
 *   lastPongAt?: number,
 * }} input
 * @returns {number} epoch ms of the first unacked ping, or 0
 */
export function resolveUnackedPingAt(input) {
  const lastPingAt = Number(input?.lastPingAt) || 0;
  const lastPongAt = Number(input?.lastPongAt) || 0;
  if (lastPingAt <= 0 || lastPingAt <= lastPongAt) return 0;
  const existing = Number(input?.unackedPingAt) || 0;
  if (existing > 0 && existing <= lastPingAt) return existing;
  return lastPingAt;
}

/**
 * Later pings must not move the stale deadline. Measure from the first unacked ping.
 *
 * @param {{
 *   unackedPingAt?: number,
 *   lastPingAt?: number,
 *   lastPongAt?: number,
 *   now?: number,
 *   staleMs?: number,
 * }} input
 * @returns {boolean}
 */
export function shouldCloseSocketForStalePong(input) {
  const now = Number.isFinite(Number(input?.now)) ? Number(input.now) : Date.now();
  const staleMs = Number.isFinite(Number(input?.staleMs))
    ? Number(input.staleMs)
    : CHAT_STALE_PONG_MS;
  const unackedPingAt = resolveUnackedPingAt(input);
  if (unackedPingAt <= 0) return false;
  return now - unackedPingAt > staleMs;
}

/**
 * @param {{
 *   awaitingResumeProbePong?: boolean,
 *   resumeProbeAt?: number,
 *   now?: number,
 *   probeTimeoutMs?: number,
 *   socketGeneration?: number,
 *   probeGeneration?: number,
 * }} input
 * @returns {boolean}
 */
export function shouldCloseSocketForResumeProbeTimeout(input) {
  if (input?.awaitingResumeProbePong !== true) return false;
  const socketGeneration = Number(input?.socketGeneration) || 0;
  const probeGeneration = Number(input?.probeGeneration) || 0;
  if (socketGeneration > 0 && probeGeneration > 0 && socketGeneration !== probeGeneration) {
    return false;
  }
  const resumeProbeAt = Number(input?.resumeProbeAt) || 0;
  if (resumeProbeAt <= 0) return false;
  const now = Number.isFinite(Number(input?.now)) ? Number(input.now) : Date.now();
  const probeTimeoutMs = Number.isFinite(Number(input?.probeTimeoutMs))
    ? Number(input.probeTimeoutMs)
    : CHAT_RESUME_PROBE_PONG_MS;
  return now - resumeProbeAt > probeTimeoutMs;
}

/**
 * An open socket on resume is not healthy until the server answers a control ping.
 *
 * @param {{ awaitingResumeProbePong?: boolean }} input
 * @returns {boolean}
 */
export function shouldMarkResumeSocketHealthy(input) {
  return input?.awaitingResumeProbePong !== true;
}

/**
 * @param {{ unackedPingAt?: number, lastPingAt?: number, lastPongAt?: number, sentAt: number }} input
 * @returns {{ unackedPingAt: number, lastPingAt: number }}
 */
export function recordPingSent(input) {
  const sentAt = Number(input?.sentAt) || 0;
  const unackedPingAt = resolveUnackedPingAt(input);
  return {
    lastPingAt: sentAt,
    unackedPingAt: unackedPingAt > 0 ? unackedPingAt : sentAt,
  };
}

/**
 * @param {number} receivedAt
 * @returns {{ lastPongAt: number, unackedPingAt: number, awaitingResumeProbePong: boolean }}
 */
export function recordPongReceived(receivedAt) {
  return {
    lastPongAt: Number(receivedAt) || 0,
    unackedPingAt: 0,
    awaitingResumeProbePong: false,
  };
}
