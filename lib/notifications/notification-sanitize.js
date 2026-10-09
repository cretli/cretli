/**
 * Sanitise notification title/body before persistence (no secrets or host paths).
 */

import { redactText } from '../browser/redaction.js';

const HOME_PATH_RE = /(?:^|[\s"'`(])\/(?:home|Users)\/[^\s"'`,)]+/gi;
const ABSOLUTE_URL_RE = /\bhttps?:\/\/[^\s"'`,)]+/gi;

/**
 * @param {unknown} value
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeNotificationText(value, maxLen = 2000) {
  let text = redactText(String(value || ''));
  text = text.replace(HOME_PATH_RE, (match) => match.replace(/\/(?:home|Users)\/[^\s"'`,)]+/, '/[path]'));
  text = text.replace(ABSOLUTE_URL_RE, '[url]');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) {
    return `${text.slice(0, Math.max(1, maxLen - 1))}…`;
  }
  return text;
}
