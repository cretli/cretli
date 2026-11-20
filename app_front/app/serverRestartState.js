export const ACTIVE_SERVER_RESTART_PHASES = new Set(['requesting', 'waiting', 'recovering']);

export function isServerRestartPhaseActive(phase) {
  return ACTIVE_SERVER_RESTART_PHASES.has(phase);
}

export function canStartServerRestart(phase) {
  return !isServerRestartPhaseActive(phase);
}

export function isServerRestartTimedOut({ startedAt, now = Date.now(), timeoutMs }) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || !Number.isFinite(timeoutMs)) return false;
  return now - startedAt > timeoutMs;
}

export function shouldSuppressDisconnectUi({
  phase,
  suppressUntil = 0,
  now = Date.now(),
}) {
  return isServerRestartPhaseActive(phase) || now < suppressUntil;
}

export function evaluateRestartHealth({
  health,
  previousToken,
  stableToken = '',
  stableProbeCount = 0,
  requiredStableProbes = 2,
}) {
  const token = typeof health?.serverInstanceToken === 'string'
    ? health.serverInstanceToken.trim()
    : '';
  if (!health?.ok || !token || token === previousToken) {
    return { status: 'waiting', stableToken: '', stableProbeCount: 0 };
  }
  if (token !== stableToken) {
    return { status: 'stabilizing', stableToken: token, stableProbeCount: 1 };
  }
  const nextProbeCount = stableProbeCount + 1;
  return {
    status: nextProbeCount >= requiredStableProbes ? 'ready' : 'stabilizing',
    stableToken: token,
    stableProbeCount: nextProbeCount,
  };
}
