export function normalizeSdkRunStatusValue(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'finished' || normalized === 'completed' || normalized === 'success') {
    return 'completed';
  }
  if (
    normalized === 'cancelled' ||
    normalized === 'plan_guard_cancelled' ||
    normalized === 'run_setup_cancelled' ||
    normalized.includes('cancel')
  ) {
    return 'cancelled';
  }
  if (
    normalized === 'error' ||
    normalized === 'run_failed' ||
    normalized === 'run_setup_failed' ||
    normalized === 'idle_timeout' ||
    normalized.includes('fail') ||
    normalized.includes('error')
  ) {
    return 'error';
  }
  return normalized;
}

export function getSdkDiagRunStatusCandidates(diag) {
  const rawStatus =
    diag?.room && typeof diag.room === 'object' && typeof diag.room.lastRunStatus === 'string'
      ? diag.room.lastRunStatus.trim()
      : '';
  const normalizedFromRaw = normalizeSdkRunStatusValue(rawStatus);
  const normalizedFromDiag =
    diag?.room &&
    typeof diag.room === 'object' &&
    typeof diag.room.lastRunStatusNormalized === 'string'
      ? normalizeSdkRunStatusValue(diag.room.lastRunStatusNormalized)
      : '';
  return [rawStatus, normalizedFromRaw, normalizedFromDiag]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}
