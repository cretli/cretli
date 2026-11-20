/** Delay before re-running a prompt after Cursor API auth recovery. */
export const SDK_AUTH_RECOVERY_RETRY_DELAY_MS = 4000;

/** Base delay before retrying after Cursor API rate-limit / resource-exhausted errors. */
export const SDK_RATE_LIMIT_RECOVERY_RETRY_DELAY_MS = 60000;

/** Base delay for setup failure retries (multiplied by attempt). */
export const SDK_SETUP_RETRY_BASE_DELAY_MS = 3000;

/** Pending prompt queue entry; only `text` is validated at runtime. */
export interface PendingPromptItem {
  text: string;
  mode: string;
  clientSentAt: number | null;
  scheduleAfterMs?: number | null;
}

/**
 * @param {number} retryAttempt
 * @returns {number}
 */
export function computeSetupRetryDelayMs(retryAttempt: number): number {
  const attempt = Math.max(1, Number(retryAttempt) || 1);
  return SDK_SETUP_RETRY_BASE_DELAY_MS * attempt;
}

/**
 * @param {number} retryAttempt
 * @returns {number}
 */
export function computeRateLimitRetryDelayMs(retryAttempt: number): number {
  const attempt = Math.max(1, Number(retryAttempt) || 1);
  return SDK_RATE_LIMIT_RECOVERY_RETRY_DELAY_MS * attempt;
}

/**
 * @param {{ scheduleAfterMs?: number | null } | null | undefined} item
 * @param {(pending: { text: string, mode: string, clientSentAt: number | null }) => void} runPending
 */
export function schedulePendingPromptRun(
  item: PendingPromptItem | null | undefined,
  runPending: (pending: { text: string; mode: string; clientSentAt: number | null }) => void
): void {
  if (!item || typeof item.text !== 'string') return;
  const delayMs = Math.max(0, Number(item.scheduleAfterMs) || 0);
  const invoke = () => runPending(item);
  if (delayMs > 0) {
    setTimeout(invoke, delayMs);
    return;
  }
  queueMicrotask(invoke);
}
