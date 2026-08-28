import { t } from '../../i18n/index.js';

/** @type {ServiceWorker | null} */
let waitingWorker = null;
let isReloading = false;
let isUpdateRequested = false;
let hadController = false;
const ACTIVATION_TIMEOUT_MS = 2000;

function reloadOnce() {
  if (isReloading) return;
  isReloading = true;
  window.location.reload();
}

/**
 * Activate the pending service worker (if any) and reload the page.
 */
function applyPwaUpdate() {
  isUpdateRequested = true;
  const worker = waitingWorker;
  // No worker is waiting — it already took over (or never existed), so a plain
  // reload is enough to pick up the new assets.
  if (!worker || worker.state !== 'installed') {
    reloadOnce();
    return;
  }
  worker.addEventListener('statechange', () => {
    if (worker.state === 'activated' || worker.state === 'redundant') reloadOnce();
  });
  worker.postMessage({ type: 'SKIP_WAITING' });
  // Safety net: activation events are unreliable on mobile (backgrounded tab,
  // iOS standalone), so never leave the button doing nothing.
  setTimeout(reloadOnce, ACTIVATION_TIMEOUT_MS);
}

/**
 * Show a lightweight banner when a new service worker is waiting to activate.
 */
function showPwaUpdateBanner() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('cr-pwa-update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'cr-pwa-update-banner';
  banner.className = 'cr-pwa-update-banner';
  banner.innerHTML = `
    <span class="cr-pwa-update-banner__text">${t('pwa.updateAvailable')}</span>
    <button type="button" class="cr-pwa-update-banner__action">${t('pwa.reloadApp')}</button>
  `;
  const action = banner.querySelector('.cr-pwa-update-banner__action');
  action?.addEventListener('click', applyPwaUpdate);
  document.body.appendChild(banner);
}

/**
 * Register service-worker update listeners (prod/PWA shell only).
 */
export function initPwaUpdatePrompt() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event?.data?.type !== 'SW_UPDATED') return;
    // On a first install the worker claims an uncontrolled page — that is not
    // an update, so do not offer a reload.
    if (!hadController) return;
    showPwaUpdateBanner();
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (isUpdateRequested) reloadOnce();
  });
  navigator.serviceWorker.ready.then((registration) => {
    if (registration.waiting) {
      waitingWorker = registration.waiting;
      showPwaUpdateBanner();
    }
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state !== 'installed') return;
        if (!navigator.serviceWorker.controller) return;
        waitingWorker = registration.waiting || installing;
        showPwaUpdateBanner();
      });
    });
  }).catch(() => {});
}
