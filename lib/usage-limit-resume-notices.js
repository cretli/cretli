/**
 * Transcript notices for usage-limit pauses. Chat subjects only: a delegation
 * has no transcript of its own. Every write goes through the async
 * `chat-history-service.js`; a rejection is logged and never reaches the run
 * path or the scheduler tick.
 */

import { appendChatNotice } from './persist/chat-history-service.js';
import { USAGE_LIMIT_RESUME_KIND } from './usage-limit-paused.js';

export const PAUSE_NOTICE_ACTION = 'usage_limit_resume';

const hhmm = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 16)} UTC` : 'the limit reset';
};

/**
 * @param {'armed'|'resumed'|'blocked'|'expired'} state
 * @param {{ resetAt?: string, reason?: string }} record
 * @returns {{ text: string, level: 'info'|'warning' }|null}
 */
export function buildPauseNotice(state, record = {}) {
  if (state === 'armed') {
    return { text: `Usage limit reached: this chat is paused until ${hhmm(record.resetAt)} and will resume automatically after the reset.`, level: 'info' };
  }
  if (state === 'resumed') {
    return { text: 'Resumed automatically after the usage limit reset.', level: 'info' };
  }
  if (state === 'blocked') {
    if (record.reason === 'start_uncertain') {
      return { text: 'Automatic resume may have started before the server restarted; it was not repeated. Check the chat and continue manually if needed.', level: 'warning' };
    }
    return { text: `Automatic resume was blocked (${record.reason || 'unknown'}). Continue manually.`, level: 'warning' };
  }
  if (state === 'expired') {
    return { text: 'The usage limit reset while the server was offline, so the chat was not resumed automatically. Continue manually.', level: 'warning' };
  }
  return null;
}

/**
 * Best-effort, awaited append of one pause notice. Never throws.
 *
 * @param {{ record?: Record<string, any>, state?: string }} input `state` defaults to `record.state`
 * @param {{ appendChatNotice?: Function, log?: Function }} [deps]
 * @returns {Promise<boolean>} true when a notice was written
 */
export async function appendPauseChatNotice(input, deps = {}) {
  try {
    const record = input?.record;
    if (!record || record.subjectType !== 'chat' || !record.subjectId) return false;
    const notice = buildPauseNotice(input.state || record.state, record);
    if (!notice) return false;
    const append = typeof deps.appendChatNotice === 'function' ? deps.appendChatNotice : appendChatNotice;
    const result = await append(record.subjectId, notice.text, {
      action: PAUSE_NOTICE_ACTION,
      level: notice.level,
      at: new Date().toISOString(),
    });
    return !(result && result.ok === false);
  } catch (err) {
    if (typeof deps.log === 'function') {
      deps.log('usage-limit-resume-notice-failed', { message: err instanceof Error ? err.message : String(err) });
    }
    return false;
  }
}

/**
 * Scheduler hooks for the `usage_limit_resume` kind. A disabled feature
 * announces and publishes nothing, whatever rows are still in the store.
 *
 * @param {{
 *   readSettings: () => { enabled: boolean },
 *   publish: (payload: Record<string, any>) => Promise<unknown>,
 *   appendNotice?: Function,
 *   log?: Function,
 * }} deps
 * @returns {{ notify: Function, announceChat: Function }}
 */
export function createResumeAnnouncers(deps) {
  const enabled = () => deps.readSettings().enabled === true;
  const isOurs = (payload) => payload?.record?.kind === USAGE_LIMIT_RESUME_KIND;
  return {
    notify: async (payload) => {
      if (!isOurs(payload) || !enabled()) return;
      await deps.publish(payload);
    },
    announceChat: async (payload) => {
      if (!isOurs(payload) || !enabled()) return;
      await appendPauseChatNotice(payload, { appendChatNotice: deps.appendNotice, log: deps.log });
    },
  };
}
