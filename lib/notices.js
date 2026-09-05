/** Localized Cursor setup-cancel messages (CLI may emit PL or EN). */
export const USER_CANCELLED_SETUP_RE = /anulowano przez użytkownika|cancelled by (the )?user/i;

/**
 * @param {string} message
 * @returns {boolean}
 */
export function isUserCancelledSetupMessage(message) {
  return USER_CANCELLED_SETUP_RE.test(String(message || ''));
}

const HARNESS_TAG = String.raw`\[(?:SDK|OpenCode|OpenRouter|Qwen|Codex|CodeBuddy|DeepSeek)\]`;

export const TIMEOUT_PROGRESS_STARTED_RE = new RegExp(
  `^${HARNESS_TAG}\\s+(?:Wysłano prompt\\.?\\s+Czekam na pierwszą odpowiedź agenta|Prompt sent\\.?\\s+Waiting for the agent's first response)`,
  'i',
);

export const TIMEOUT_PROGRESS_PATTERNS = [
  new RegExp(
    `^${HARNESS_TAG}\\s+(?:Nadal czekam na pierwsze zdarzenie|Still waiting for the first event)\\s+\\((\\d+)s\\)\\.(?:\\s+(?:Timeout za ok\\.|Warning threshold in about)\\s+(\\d+)s\\.)?\\s*$`,
    'i',
  ),
  new RegExp(
    `^${HARNESS_TAG}\\s+(?:Brak nowych zdarzeń od|No new events for)\\s+\\(?(\\d+)s\\)?\\.(?:\\s+(?:Timeout za ok\\.|Warning threshold in about)\\s+(\\d+)s\\.)?\\s*$`,
    'i',
  ),
];

export const SUMMARY_FORK_META_LINE_PATTERNS = [
  /^\[SDK\]\s+(?:No new events|Brak nowych zdarzeń)/i,
  /^(?:Creating context summary|Tworzę podsumowanie kontekstu)/i,
  /^Auto-(?:compression|kompresja)/i,
  /^(?:Chat unblocked after|Odblokowano czat po problemie)/i,
  /^(?:Context summary error|Błąd podsumowania kontekstu)/i,
  /^Run (?:ended with error|was cancelled|exceeded the idle budget)/i,
];

/**
 * @param {string} text
 * @returns {{ idleSeconds: number, remainingSeconds: number, isStarted?: boolean } | null}
 */
export function parseTimeoutProgressNotice(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (TIMEOUT_PROGRESS_STARTED_RE.test(raw)) {
    return { idleSeconds: 0, remainingSeconds: 0, isStarted: true };
  }
  for (const pattern of TIMEOUT_PROGRESS_PATTERNS) {
    const match = raw.match(pattern);
    if (!match) continue;
    const idleSeconds = Number(match[1]);
    const remainingSeconds = Number(match[2] || 0);
    if (!Number.isFinite(idleSeconds) || !Number.isFinite(remainingSeconds)) return null;
    if (idleSeconds < 0 || remainingSeconds < 0) return null;
    return { idleSeconds, remainingSeconds };
  }
  return null;
}
