/**
 * PWA install prompt (beforeinstallprompt / appinstalled).
 * Shows the #header-pwa-install-btn button when Chrome offers installation.
 */
import { t } from '../../i18n/index.js';

let deferredPrompt = null;

function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.navigator.standalone === true
  );
}

function setButtonVisible(btn, visible) {
  if (!btn) return;
  if (visible) {
    btn.hidden = false;
    btn.style.display = '';
  } else {
    btn.hidden = true;
    btn.style.display = 'none';
  }
}

export function initInstallPrompt() {
  if (typeof window === 'undefined') return;
  if (window.parent !== window || window.matchMedia?.('(display-mode: standalone)')?.matches) return;
  const btn = document.getElementById('header-pwa-install-btn');
  if (!btn) return;

  setButtonVisible(btn, false);

  // Already installed as PWA — no install button needed.
  if (isStandalone()) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    setButtonVisible(btn, true);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    setButtonVisible(btn, false);
    // Lightweight toast via appLogger if present (no hard dep).
    try {
      const evt = new CustomEvent('cretli:toast', {
        detail: { message: t('pwa.installed') },
      });
      window.dispatchEvent(evt);
    } catch (_) {}
  });

  btn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    try {
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        // nothing — appinstalled handler hides the button
      }
    } catch (_) {
    } finally {
      deferredPrompt = null;
      setButtonVisible(btn, false);
    }
  });
}

export function getDeferredInstallPrompt() {
  return deferredPrompt;
}
