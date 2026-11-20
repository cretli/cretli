/**
 * User-visible notices when a deep-linked resource is missing or invalid.
 */

import { t } from '../../i18n/index.js';

/** @type {ReturnType<typeof setTimeout> | 0} */
let hideTimer = 0;

/**
 * @param {string} messageKey i18n key under navigation.*
 * @param {string} [detail] optional diagnostic suffix (not shown when empty)
 */
export function showNavigationResourceNotice(messageKey, detail) {
  if (typeof document === 'undefined') return;
  const key = typeof messageKey === 'string' ? messageKey.trim() : '';
  if (!key) return;
  let message = '';
  try {
    message = t(key);
  } catch {
    message = key;
  }
  const suffix = typeof detail === 'string' ? detail.trim() : '';
  const text = suffix ? `${message} (${suffix})` : message;
  document.getElementById('cr-navigation-resource-notice')?.remove();
  const banner = document.createElement('div');
  banner.id = 'cr-navigation-resource-notice';
  banner.className = 'cr-pwa-update-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <span class="cr-pwa-update-banner__text"></span>
    <button type="button" class="cr-pwa-update-banner__dismiss" aria-label="${t('common.close')}">×</button>
  `;
  const textEl = banner.querySelector('.cr-pwa-update-banner__text');
  if (textEl) textEl.textContent = text;
  banner.querySelector('.cr-pwa-update-banner__dismiss')?.addEventListener('click', () => {
    banner.remove();
  });
  document.body.appendChild(banner);
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    banner.remove();
    hideTimer = 0;
  }, 8000);
}

/**
 * Listen for lightweight toasts (e.g. PWA installed) with the same banner chrome.
 */
export function initNavigationResourceNoticeListener() {
  if (typeof window === 'undefined') return;
  window.addEventListener('cretli:toast', (event) => {
    const message = event?.detail?.message;
    if (typeof message !== 'string' || !message.trim()) return;
    document.getElementById('cr-navigation-resource-notice')?.remove();
    const banner = document.createElement('div');
    banner.id = 'cr-navigation-resource-notice';
    banner.className = 'cr-pwa-update-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
      <span class="cr-pwa-update-banner__text"></span>
      <button type="button" class="cr-pwa-update-banner__dismiss" aria-label="${t('common.close')}">×</button>
    `;
    const textEl = banner.querySelector('.cr-pwa-update-banner__text');
    if (textEl) textEl.textContent = message.trim();
    banner.querySelector('.cr-pwa-update-banner__dismiss')?.addEventListener('click', () => {
      banner.remove();
    });
    document.body.appendChild(banner);
  });
}
