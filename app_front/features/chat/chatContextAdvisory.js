import {
  getContextMeterFillPercent,
  getContextPressureLevel,
  isContextAdvisoryEnabled,
  normalizeContextAdvisoryWarnPercent,
  shouldSuggestContextMaintenance,
} from '../../../lib/sdk/sdk-context-advisory.js';

/**
 * @param {object | null | undefined} chat
 * @param {number | null | undefined} fillPercent
 * @param {boolean} [likelyPressure]
 * @returns {boolean}
 */
export function shouldShowContextAdvisory(chat, fillPercent, likelyPressure = false) {
  if (!chat || chat.agentTransport !== 'sdk') return false;
  if (!isContextAdvisoryEnabled(chat)) return false;
  if (chat._contextAdvisoryDismissed === true) return false;
  if (shouldSuggestContextMaintenance(fillPercent, chat.contextAdvisoryWarnPercent)) return true;
  if (likelyPressure !== true) return false;
  const numeric = Number(fillPercent);
  return Number.isFinite(numeric) && numeric >= 65;
}

/**
 * @param {object | null | undefined} chat
 * @param {number | null | undefined} fillPercent
 */
export function maybeClearContextAdvisoryDismiss(chat, fillPercent) {
  if (!chat) return;
  if (chat._contextAdvisoryDismissed !== true) return;
  const warnAt = normalizeContextAdvisoryWarnPercent(chat.contextAdvisoryWarnPercent);
  const numeric = Number(fillPercent);
  if (!Number.isFinite(numeric)) return;
  if (numeric < Math.max(50, warnAt - 5)) {
    chat._contextAdvisoryDismissed = false;
  }
}

/**
 * @param {object | null | undefined} chat
 */
export function dismissContextAdvisory(chat) {
  if (!chat) return;
  chat._contextAdvisoryDismissed = true;
}

/**
 * @param {{
 *   chat?: object | null,
 *   fillPercent?: number | null,
 *   label?: string,
 *   likelyPressure?: boolean,
 *   richView?: { updateContextAdvisory?: (opts: Record<string, unknown>) => void } | null,
 *   t: (key: string, params?: Record<string, unknown>) => string,
 *   onSummarize?: () => void,
 *   onDismiss?: () => void,
 * }} input
 */
export function updateChatContextAdvisoryUi(input) {
  const richView = input.richView;
  if (!richView || typeof richView.updateContextAdvisory !== 'function') return;
  const chat = input.chat;
  const fillPercent = Number(input.fillPercent);
  const level = getContextPressureLevel(fillPercent);
  maybeClearContextAdvisoryDismiss(chat, fillPercent);
  const visible = shouldShowContextAdvisory(chat, fillPercent, input.likelyPressure === true);
  if (!visible) {
    richView.updateContextAdvisory({ visible: false });
    return;
  }
  const messageKey =
    level === 'critical'
      ? 'chat.contextAdvisoryCritical'
      : level === 'danger'
        ? 'chat.contextAdvisoryDanger'
        : 'chat.contextAdvisoryWarn';
  richView.updateContextAdvisory({
    visible: true,
    level,
    message: input.t(messageKey, {
      percent: Number.isFinite(fillPercent) ? fillPercent.toFixed(1) : '—',
      label: input.label || '',
    }),
    actionLabel: input.t('chat.contextAdvisoryAction'),
    dismissLabel: input.t('chat.contextAdvisoryDismiss'),
    onSummarize: input.onSummarize,
    onDismiss: () => {
      dismissContextAdvisory(chat);
      if (typeof input.onDismiss === 'function') input.onDismiss();
    },
  });
}

/**
 * @param {number | null | undefined} fillPercent
 * @returns {{ fillWidth: number, level: string, isOverLimit: boolean }}
 */
export function getContextMeterVisualState(fillPercent) {
  const numeric = Number(fillPercent);
  const level = getContextPressureLevel(fillPercent);
  return {
    fillWidth: getContextMeterFillPercent(fillPercent),
    level,
    isOverLimit: Number.isFinite(numeric) && numeric >= 100,
  };
}
