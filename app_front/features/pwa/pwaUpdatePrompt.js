import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';

/** @type {ServiceWorker | null} */
let waitingWorker = null;
let isReloading = false;
let isUpdateRequested = false;
let hadController = false;
let bootFrontAssetVersion = '';
let hasBaselineFrontAssetVersion = false;
let frontAssetVersionSource = '';
let pollTimerId = 0;
let checkDebounceTimerId = 0;
let isUpdateBannerDismissed = false;

const ACTIVATION_TIMEOUT_MS = 2000;
const UPDATE_POLL_INTERVAL_MS = 20000;
const CHECK_DEBOUNCE_MS = 400;

/**
 * @param {string} scriptSrc
 * @returns {string}
 */
export function readScriptAssetVersion(scriptSrc) {
  const src = typeof scriptSrc === 'string' ? scriptSrc.trim() : '';
  if (!src) return '';
  try {
    const url = new URL(src, 'https://cretli.invalid/');
    return String(url.searchParams.get('v') || '').trim();
  } catch {
    return '';
  }
}

/**
 * @param {unknown} health
 * @returns {string}
 */
export function extractFrontAssetVersion(health) {
  if (!health || typeof health !== 'object') return '';
  const version = /** @type {{ frontAssetVersion?: unknown }} */ (health).frontAssetVersion;
  if (typeof version === 'string') return version.trim();
  if (typeof version === 'number' && Number.isFinite(version)) return String(Math.trunc(version));
  return '';
}

/**
 * @param {string} bootVersion
 * @param {string} currentVersion
 * @returns {boolean}
 */
export function hasNewerFrontAssetVersion(bootVersion, currentVersion) {
  if (!bootVersion || !currentVersion) return false;
  return bootVersion !== currentVersion;
}

/**
 * @param {{ get?: (name: string) => string | null } | null | undefined} headers
 * @returns {string}
 */
export function extractAssetVersionFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return '';
  const lastModified = String(headers.get('last-modified') || '').trim();
  if (lastModified) return lastModified;
  return String(headers.get('etag') || '').trim();
}

/**
 * @param {{ healthVersion?: string, headerVersion?: string }} params
 * @returns {{ source: 'health' | 'head' | '', version: string }}
 */
export function resolvePolledFrontAssetVersion({ healthVersion = '', headerVersion = '' } = {}) {
  if (healthVersion) return { source: 'health', version: healthVersion };
  if (headerVersion) return { source: 'head', version: headerVersion };
  return { source: '', version: '' };
}

/**
 * @param {ParentNode | null | undefined} root
 * @returns {string}
 */
export function readBootAssetVersionFromDocument(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return '';
  const scripts = root.querySelectorAll('script[src]');
  for (const script of scripts) {
    const src = String(script.getAttribute?.('src') || '');
    if (!src.includes('index.bundle.js')) continue;
    const version = readScriptAssetVersion(src);
    if (version) return version;
  }
  return '';
}

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
 * @param {{ isDismissed?: boolean, bannerExists?: boolean }} params
 * @returns {boolean}
 */
export function canShowPwaUpdateBanner({ isDismissed = false, bannerExists = false } = {}) {
  if (isDismissed) return false;
  if (bannerExists) return false;
  return true;
}

function removePwaUpdateBanner() {
  if (typeof document === 'undefined') return;
  document.getElementById('cr-pwa-update-banner')?.remove();
}

function dismissPwaUpdateBanner() {
  isUpdateBannerDismissed = true;
  removePwaUpdateBanner();
}

/**
 * Show a lightweight banner when a new service worker is waiting to activate
 * or when webpack has written a newer SPA bundle.
 */
function showPwaUpdateBanner() {
  if (typeof document === 'undefined') return;
  const bannerExists = !!document.getElementById('cr-pwa-update-banner');
  if (!canShowPwaUpdateBanner({ isDismissed: isUpdateBannerDismissed, bannerExists })) return;
  const banner = document.createElement('div');
  banner.id = 'cr-pwa-update-banner';
  banner.className = 'cr-pwa-update-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <span class="cr-pwa-update-banner__text">${t('pwa.updateAvailable')}</span>
    <button type="button" class="cr-pwa-update-banner__action">${t('pwa.reloadApp')}</button>
    <button type="button" class="cr-pwa-update-banner__dismiss" aria-label="${t('pwa.dismissUpdate')}">×</button>
  `;
  const action = banner.querySelector('.cr-pwa-update-banner__action');
  const dismiss = banner.querySelector('.cr-pwa-update-banner__dismiss');
  action?.addEventListener('click', applyPwaUpdate);
  dismiss?.addEventListener('click', dismissPwaUpdateBanner);
  document.body.appendChild(banner);
}

function rememberFrontAssetVersion(version, source = '') {
  if (!version) return;
  if (source && frontAssetVersionSource && source !== frontAssetVersionSource) {
    bootFrontAssetVersion = version;
    frontAssetVersionSource = source;
    hasBaselineFrontAssetVersion = true;
    return;
  }
  if (hasBaselineFrontAssetVersion) return;
  bootFrontAssetVersion = version;
  frontAssetVersionSource = source;
  hasBaselineFrontAssetVersion = true;
}

async function fetchHealthFrontAssetVersion() {
  const res = await cretliApiFetch('/api/health', { cache: 'no-store' });
  if (!res.ok) return '';
  return extractFrontAssetVersion(await res.json());
}

async function fetchBundleHeadVersion() {
  const res = await fetch('/dist/app/index.bundle.js', { method: 'HEAD', cache: 'no-store' });
  if (!res.ok) return '';
  return extractAssetVersionFromHeaders(res.headers);
}

async function fetchFrontAssetVersion() {
  let healthVersion = '';
  try {
    healthVersion = await fetchHealthFrontAssetVersion();
  } catch {
    healthVersion = '';
  }
  if (healthVersion) return resolvePolledFrontAssetVersion({ healthVersion });
  try {
    const headerVersion = await fetchBundleHeadVersion();
    return resolvePolledFrontAssetVersion({ headerVersion });
  } catch {
    return resolvePolledFrontAssetVersion({});
  }
}

async function checkFrontAssetVersion() {
  const { source, version } = await fetchFrontAssetVersion();
  if (!version) return;
  rememberFrontAssetVersion(version, source);
  if (!hasNewerFrontAssetVersion(bootFrontAssetVersion, version)) return;
  showPwaUpdateBanner();
}

function requestServiceWorkerUpdate() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((registration) => {
    if (!registration || typeof registration.update !== 'function') return;
    return registration.update();
  }).catch(() => {});
}

function runFrontUpdateCheck() {
  void checkFrontAssetVersion();
  requestServiceWorkerUpdate();
}

function scheduleFrontUpdateCheck() {
  if (checkDebounceTimerId) clearTimeout(checkDebounceTimerId);
  checkDebounceTimerId = window.setTimeout(() => {
    checkDebounceTimerId = 0;
    runFrontUpdateCheck();
  }, CHECK_DEBOUNCE_MS);
}

function isPageVisible() {
  if (typeof document === 'undefined') return false;
  return document.visibilityState !== 'hidden';
}

function startFrontUpdatePolling() {
  if (pollTimerId) return;
  pollTimerId = window.setInterval(() => {
    if (!isPageVisible()) return;
    runFrontUpdateCheck();
  }, UPDATE_POLL_INTERVAL_MS);
}

function bindFrontUpdateResumeListeners() {
  document.addEventListener('visibilitychange', () => {
    if (!isPageVisible()) return;
    scheduleFrontUpdateCheck();
  });
  window.addEventListener('pageshow', () => {
    scheduleFrontUpdateCheck();
  });
  window.addEventListener('focus', () => {
    scheduleFrontUpdateCheck();
  });
}

function bindServiceWorkerUpdateListeners() {
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

/**
 * Register service-worker update listeners and poll `/api/health` for a newer
 * webpack bundle. Standalone PWAs cannot pull-to-refresh (`overflow: hidden`
 * on `body`), so this banner is the reload path after a front rebuild.
 */
export function initPwaUpdatePrompt() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.parent !== window) return;
  rememberFrontAssetVersion(readBootAssetVersionFromDocument(document), 'health');
  bindServiceWorkerUpdateListeners();
  bindFrontUpdateResumeListeners();
  startFrontUpdatePolling();
  scheduleFrontUpdateCheck();
}
