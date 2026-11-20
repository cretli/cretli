/**
 * LAN host field on the settings screen: Save (PATCH /api/settings) and, when the URL carries a
 * session, a refresh of the terminal sync link and QR code after saving.
 */
import * as api from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';

/**
 * Wires the LAN host Save button.
 * @returns {(data: { lanHost?: string }) => void} Applies a settings snapshot to the LAN host input.
 */
export function initLanHostSettings() {
  const lanInput = /** @type {HTMLInputElement | null} */ (document.getElementById('lan-host-input'));
  const lanStatusEl = document.getElementById('lan-save-status');

  const btn = document.getElementById('lan-save-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (!lanInput) return;
      if (lanStatusEl) lanStatusEl.textContent = '';
      const lanHost = (lanInput.value || '').trim();
      api.patchSettingsLanHost(lanHost).then((data) => {
        if (!data.ok) {
          if (lanStatusEl) lanStatusEl.textContent = data.error || t('lanSettings.error');
          return;
        }
        if (lanStatusEl) lanStatusEl.textContent = t('common.saved');
        const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
        const session = params.get('session');
        if (!session) return;
        api.getLanUrl().then((d) => {
          const base = d.ok && d.url ? d.url : (typeof location !== 'undefined' ? location.origin : '');
          const pathname = typeof location !== 'undefined' ? location.pathname : '/';
          const syncUrl = base + pathname + '?session=' + session;
          const link = /** @type {HTMLAnchorElement | null} */ (document.getElementById('terminal-sync-link'));
          const qr = /** @type {HTMLImageElement | null} */ (document.getElementById('terminal-sync-qr'));
          if (link) {
            link.href = syncUrl;
            link.textContent = syncUrl;
          }
          if (qr) qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=' + encodeURIComponent(syncUrl);
        }).catch(() => {});
      }).catch(() => {
        if (lanStatusEl) lanStatusEl.textContent = t('lanSettings.saveError');
      });
    });
  }

  return function applyLanHost(data) {
    if (lanInput && typeof data.lanHost !== 'undefined') {
      lanInput.value = data.lanHost || '';
    }
  };
}
