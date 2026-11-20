/** Auth gate around the app boot: DOM-ready entry, login redirect and offline cold start. */
import * as api from '../../core/api/index.js';
import { readRequestedChatId } from './panelRouter.js';
import { hasLocalChatBootCacheForColdStart } from '../../features/chat/chatLocalBootSync.js';
import { seedLocalBootSyncFromIdbBootCache } from '../../features/chat/chatOfflineBootSeed.js';
import { resolveBootOnAuthStatusFailure } from '../../features/chat/chatBootDecision.js';
import { initClientInstance } from '../../lib/clientInstance.js';
import { initI18n, t } from '../../i18n/index.js';
import { applyStaticTranslations, wireStaticTranslations } from '../../i18n/applyStatic.js';
import { isEmbedModeEnabled } from './embedWidgetBridge.js';
import { startupLog } from './startup.js';

/**
 * @param {{
 *   bootApp: () => void,
 *   embedBridge: ReturnType<typeof import('./embedWidgetBridge.js').createEmbedWidgetBridge>,
 * }} deps
 * @returns {{ onDomReady: () => void }}
 */
export function createAuthBoot({ bootApp, embedBridge }) {
  function onDomReady() {
    startupLog('DOMContentLoaded');
    initClientInstance();
    // Non-English dictionaries are separate chunks, so wait for the active one
    // before any text is rendered.
    void initI18n().then(() => {
      applyStaticTranslations();
      wireStaticTranslations();
      ensureAuthenticatedThenBoot();
    });
  }

  /** Checks the session: redirects to /login when it is missing, otherwise boots the app. */
  function ensureAuthenticatedThenBoot() {
    if (isEmbedModeEnabled()) {
      embedBridge.initEmbedWidgetHostBridge();
      if (embedBridge.getWidgetConnection()) {
        bootApp();
        return;
      }
      window.addEventListener('cr-widget-connected', () => bootApp(), { once: true });
      return;
    }
    api.getAuthStatus()
      .then((data) => {
        if (data && data.ok && data.configured && data.authRequired) {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.replace(`/login?next=${next}`);
          return;
        }
        if (data && data.ok && !data.configured) {
          window.location.replace('/login');
          return;
        }
        bootApp();
      })
      .catch(() => {
        void resolveBootAfterAuthStatusFailure();
      });
  }

  /**
   * Offline cold start: the auth-status probe rejected. Boot the SPA when this client is
   * offline and has local chat data to hydrate; otherwise keep the "backend unavailable"
   * overlay. The online auth gate in `ensureAuthenticatedThenBoot().then` is unchanged.
   */
  async function resolveBootAfterAuthStatusFailure() {
    const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const storage = typeof localStorage !== 'undefined' ? localStorage : null;
    let hasLocalBootCache = hasLocalChatBootCacheForColdStart(storage);
    if (!online && !hasLocalBootCache) {
      // The full snapshot is often only in IndexedDB (localStorage sync doc missing);
      // seed the sync doc from it so the cached chat list renders on this boot.
      try {
        hasLocalBootCache = await seedLocalBootSyncFromIdbBootCache({
          storage,
          preferChatId: readRequestedChatId(),
        });
      } catch (_) {
        hasLocalBootCache = false;
      }
    }
    const decision = resolveBootOnAuthStatusFailure({ online, hasLocalBootCache });
    if (decision === 'boot') {
      bootApp();
      return;
    }
    showBackendUnavailableOverlay(() => ensureAuthenticatedThenBoot());
  }

  /** "Backend unavailable" overlay with a retry, shown instead of silently booting the SPA. */
  function showBackendUnavailableOverlay(retryFn) {
    if (document.getElementById('cr-backend-unavailable')) return;
    const overlay = document.createElement('div');
    overlay.id = 'cr-backend-unavailable';
    overlay.setAttribute('style', [
      'position:fixed', 'inset:0', 'display:flex', 'flex-direction:column',
      'align-items:center', 'justify-content:center', 'gap:1rem',
      'background:#1e1e1e', 'color:#d4d4d4', 'font:14px system-ui, sans-serif',
      'z-index:99999', 'text-align:center', 'padding:1rem',
    ].join(';'));
    const title = document.createElement('div');
    title.textContent = t('app.backendUnavailable');
    const sub = document.createElement('div');
    sub.style.opacity = '0.7';
    sub.textContent = t('app.checkingConnection');
    overlay.appendChild(title);
    overlay.appendChild(sub);
    const btn = document.createElement('button');
    btn.textContent = t('app.tryAgain');
    btn.setAttribute('style', 'padding:0.6rem 1rem;border:1px solid #444;background:#252526;color:#d4d4d4;border-radius:4px;cursor:pointer;');
    btn.addEventListener('click', () => {
      overlay.remove();
      retryFn();
    });
    overlay.appendChild(btn);
    (document.body || document.documentElement).appendChild(overlay);
    setTimeout(() => {
      if (document.getElementById('cr-backend-unavailable')) {
        overlay.remove();
        retryFn();
      }
    }, 4000);
  }

  return { onDomReady };
}
