/** Header chrome: fullscreen/settings buttons, account logout and notification deep links. */
import * as api from '../../core/api/index.js';
import { openChatFromNotification } from '../../features/chat/index.js';
import { initAppUpdateSettings } from '../../features/settings/appUpdateSettings.js';
import { clearPushInboxCache } from '../../features/pwa/pushInbox.js';
import { resolveNotificationActionUrl } from '../../features/notifications/notificationStore.js';
import { t } from '../../i18n/index.js';
import { setFullscreenIcon } from './embedWidgetBridge.js';
import { getLastMainPanel } from './panelRegistry.js';
import { parseNotificationActionRoute } from './spaNavigation.js';
import { getSharedSpaNavigation } from './spaNavigationBridge.js';

/**
 * Navigate to a notification's `actionUrl` inside the SPA. The URL is validated
 * again here (defence in depth): only same-origin relative paths are followed.
 *
 * @param {string} url
 */
export function openNotificationActionUrl(url) {
  const safe = resolveNotificationActionUrl(url);
  if (!safe || typeof window === 'undefined') return;
  if (document.body?.classList.contains('chat-fullscreen-active')) {
    document.body.classList.remove('chat-fullscreen-active');
  }
  const route = parseNotificationActionRoute(safe, window.location.origin);
  const nav = getSharedSpaNavigation();
  if (route && nav) {
    void nav.navigate({
      panel: route.panel,
      settingsTab: route.settingsTab,
      subview: route.subview,
      context: route.context,
      scope: route.scope,
      query: route.query,
      resource: route.resource,
    }, { explicit: true });
    return;
  }
  const chatOnly = parseNotificationActionRoute(`/?${safe.startsWith('?') ? safe.slice(1) : safe}`, window.location.origin);
  if (chatOnly?.query?.chat) {
    openChatFromNotification({ chatId: chatOnly.query.chat });
    return;
  }
  try {
    const parsed = new URL(safe, window.location.origin);
    window.location.assign(`${parsed.pathname || '/'}${parsed.search || ''}`);
  } catch {
    // ignore unsafe navigation
  }
}

/**
 * @param {{ embedBridge: ReturnType<typeof import('./embedWidgetBridge.js').createEmbedWidgetBridge> }} deps
 */
export function createHeaderChrome({ embedBridge }) {
  function initHeaderSettings() {
    const resetChatFullscreenMode = () => {
      if (!document.body.classList.contains('chat-fullscreen-active')) return;
      document.body.classList.remove('chat-fullscreen-active');
      const fullscreenBtn = document.getElementById('chat-fullscreen-btn');
      if (!fullscreenBtn) return;
      fullscreenBtn.setAttribute('data-fullscreen', 'off');
      fullscreenBtn.setAttribute('title', t('common.fullscreen'));
      fullscreenBtn.setAttribute('aria-label', t('common.fullscreen'));
      setFullscreenIcon(fullscreenBtn, false);
    };

    const appFullscreenBtn = document.getElementById('header-app-fullscreen-btn');
    if (appFullscreenBtn) {
      const isEmbedMode = typeof document !== 'undefined' && document.body?.classList.contains('embed-mode');
      const updateAppFullscreenButton = () => {
        if (isEmbedMode) {
          embedBridge.updateEmbedFullscreenButton();
          return;
        }
        const fullscreenOn = isEmbedMode ? embedBridge.isEmbedModalOn() : !!document.fullscreenElement;
        appFullscreenBtn.dataset.fullscreen = fullscreenOn ? 'on' : 'off';
        appFullscreenBtn.title = isEmbedMode
          ? (fullscreenOn ? t('app.closeModal') : t('app.openModal'))
          : (fullscreenOn ? t('app.closeFullscreen') : t('app.openFullscreen'));
        appFullscreenBtn.setAttribute('aria-label', appFullscreenBtn.title);
        setFullscreenIcon(appFullscreenBtn, fullscreenOn);
      };
      appFullscreenBtn.addEventListener('click', async () => {
        try {
          if (isEmbedMode) {
            // In embed mode we toggle the parent-controlled modal state (widget.js), not browser fullscreen.
            if (window.parent && window.parent !== window && embedBridge.getWidgetConnection()?.parentOrigin) {
              window.parent.postMessage(
                { type: 'cretli-widget-modal', action: 'toggle' },
                embedBridge.getWidgetConnection().parentOrigin,
              );
            } else {
              embedBridge.setEmbedModalOn(!embedBridge.isEmbedModalOn());
            }
            return;
          }
          if (document.fullscreenElement) {
            await document.exitFullscreen();
            return;
          }
          const root = document.documentElement;
          if (!root || typeof root.requestFullscreen !== 'function') return;
          await root.requestFullscreen();
        } catch (_) {
        } finally {
          updateAppFullscreenButton();
        }
      });
      if (isEmbedMode) {
        embedBridge.initEmbedWidgetHostBridge();
      } else {
        document.addEventListener('fullscreenchange', updateAppFullscreenButton);
      }
      updateAppFullscreenButton();
    }
    const leaveSettings = () => {
      resetChatFullscreenMode();
      void getSharedSpaNavigation()?.navigate({ panel: getLastMainPanel() }, { explicit: true });
    };
    const settingsBtn = document.getElementById('header-settings-btn');
    if (settingsBtn) {
      settingsBtn.addEventListener('click', () => {
        const settingsOpen = document.getElementById('settings-panel')?.classList.contains('active');
        if (settingsOpen) {
          leaveSettings();
          return;
        }
        resetChatFullscreenMode();
        void getSharedSpaNavigation()?.navigate({ panel: 'settings' }, { explicit: true });
      });
    }
    const backBtn = document.getElementById('settings-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', leaveSettings);
    }
    initAccountLogout();
    initAppUpdateSettings();
  }

  function initAccountLogout() {
    const section = document.getElementById('settings-account-section');
    const btn = document.getElementById('account-logout-btn');
    const status = document.getElementById('account-logout-status');
    if (!section || !btn) return;

    api.getAuthStatus()
      .then((data) => {
        if (data && data.ok && data.configured) {
          section.dataset.accountEnabled = 'true';
          const activeTab = document.getElementById('settings-panel')?.dataset?.activeSettingsTab
            || document.querySelector('#settings-tabs .settings-tab.active')?.dataset.settingsTab;
          if (activeTab === 'account') section.hidden = false;
        }
      })
      .catch(() => {});

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      if (status) status.textContent = t('app.logoutProgress');
      try {
        await api.logout();
        await clearPushInboxCache();
        if (typeof window !== 'undefined') window.location.assign('/login');
      } catch (err) {
        if (status) status.textContent = t('app.logoutError', { detail: err?.message || t('app.logoutErrorUnknown') });
        btn.disabled = false;
      }
    });
  }

  return { initHeaderSettings };
}
