/** Delay before re-running a prompt after Cursor API auth recovery. */
export const SDK_AUTH_RECOVERY_RETRY_DELAY_MS = 4000;

/** Base delay for setup failure retries (multiplied by attempt). */
export const SDK_SETUP_RETRY_BASE_DELAY_MS = 3000;

/**
 * @param {number} retryAttempt
 * @returns {number}
 */
export function computeSetupRetryDelayMs(retryAttempt) {
  const attempt = Math.max(1, Number(retryAttempt) || 1);
  return SDK_SETUP_RETRY_BASE_DELAY_MS * attempt;
}

/**
 * @param {{ scheduleAfterMs?: number | null } | null | undefined} item
 * @param {(pending: { text: string, mode: string, clientSentAt: number | null }) => void} runPending
 */
export function schedulePendingPromptRun(item, runPending) {
  if (!item || typeof item.text !== 'string') return;
  const delayMs = Math.max(0, Number(item.scheduleAfterMs) || 0);
  const invoke = () => runPending(item);
  if (delayMs > 0) {
    setTimeout(invoke, delayMs);
    return;
  }
  queueMicrotask(invoke);
}
