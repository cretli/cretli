import { t } from '../../i18n/index.js';

/**
 * Machine-readable codes the panel can receive from `/api/browser/*`: the
 * `BrowserError` set plus the route/guard rejections that are not errors of the
 * driver itself. Each one has a `browser.error.<code>` entry in both
 * dictionaries, because the raw Chromium/Playwright sentence is not something a
 * user can act on.
 */
export const BROWSER_ERROR_CODES = Object.freeze(new Set([
  'auth-required',
  'browser-error',
  'browser-unavailable',
  'external-browser-consent-required',
  'chat-bind-conflict',
  'confirmation-required',
  'dialog-action-invalid',
  'dialog-failed',
  'dialog-not-found',
  'dom-failed',
  'drag-target-required',
  'elements-failed',
  'elements-unavailable',
  'explicit-target-required',
  'external-session-busy',
  'forbidden-chat',
  'forbidden-owner',
  'forbidden-workspace',
  'input-rate-limited',
  'invalid-argument',
  'invalid-chat',
  'invalid-owner',
  'invalid-url',
  'invalid-wait-until',
  'locator-failed',
  'locator-index-invalid',
  'locator-required',
  'mode-required',
  'navigation-blocked',
  'navigation-failed',
  'no-workspace',
  'not-external',
  'not-found',
  'page-closed',
  'plan-mode-readonly',
  'rate-limited',
  'review-mode-readonly',
  'screenshot-busy',
  'screenshot-failed',
  'screenshot-too-large',
  'select-option-invalid',
  'select-option-required',
  'session-limit',
  'tab-limit',
  'tab-not-found',
  'unknown-action',
  'unsupported-input',
  'upload-file-limit',
  'upload-files-required',
  'upload-path-forbidden',
  'upload-path-not-found',
  'wait-loadstate-invalid',
  'wait-state-invalid',
  'wait-target-required',
  'widget-auth-forbidden',
]));

/**
 * @param {string} holder holder category from the server
 * @returns {string}
 */
export function externalHolderText(holder) {
  const known = ['agent', 'other-login', 'other-workspace', 'pending', 'self'];
  return t(`browser.externalHolder.${known.includes(holder) ? holder : 'pending'}`);
}

/**
 * Turns an API failure into user-facing text. A known code becomes its
 * translation; anything else keeps the server message (already redacted
 * route-side), so an unmapped code never degrades into a bare code string.
 * @param {unknown} err
 * @returns {string}
 */
export function errorText(err) {
  const message = String(/** @type {{ message?: unknown }} */ (err)?.message || err || 'error');
  const code = String(/** @type {{ code?: unknown }} */ (err)?.code || '');
  const holder = String(/** @type {{ holder?: unknown }} */ (err)?.holder || '');
  const detail = code === 'external-session-busy' && holder ? externalHolderText(holder) : message;
  const text = BROWSER_ERROR_CODES.has(code) ? t(`browser.error.${code}`, { detail }) : message;
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

