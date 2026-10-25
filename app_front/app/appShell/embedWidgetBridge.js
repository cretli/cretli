/** Embed-mode widget host bridge: postMessage protocol with the parent page. */
import * as api from '../../core/api/index.js';
import {
  createPageLinkedChat,
  getActiveChatIdValue,
  getChatsList,
  resolvePagePinStateForUrl,
  selectChatFromWidgetHost,
  setForcedEmbedChatId,
  syncEmbedChatToHostPage,
} from '../../features/chat/index.js';
import { setWidgetHostPort } from '../../embed/widgetHostScreenshot.js';
import { requestWidgetHostUrl } from '../../embed/widgetHostNavigation.js';
import { t } from '../../i18n/index.js';
import { appLogger } from '../../core/logging/logger.js';
import { parseEmbedModeQuery } from './embedMode.js';

const WIDGET_BRIDGE_LISTENERS_KEY = '__crWidgetBridgeListenersV1';

export function isEmbedModeEnabled() {
  if (typeof window === 'undefined') return false;
  return parseEmbedModeQuery(window.location.search || '', window.location.pathname || '').embedEnabled;
}

export function setFullscreenIcon(button, isExit) {
  const icon = document.createElement('span');
  icon.className = `mdi mdi-fullscreen${isExit ? '-exit' : ''}`;
  icon.setAttribute('aria-hidden', 'true');
  button.replaceChildren(icon);
}

/**
 * Widget host bridge for embed mode. The connection state lives in the factory
 * closure; the shell reads it through the returned accessors.
 *
 * @param {{ applyEmbedWorkspaceContext: (installation?: object) => void }} deps
 */
export function createEmbedWidgetBridge({ applyEmbedWorkspaceContext }) {
  let widgetConnection = null;
  let embedModalOn = false;
  let embedWidgetBridgeInitialized = false;
  /** @type {Map<string, Promise<{ ok: boolean, chat?: object, reused?: boolean, error?: string }>>} */
  const widgetCreatePageChatInFlight = new Map();

  function updateEmbedFullscreenButton() {
    const button = document.getElementById('header-app-fullscreen-btn');
    if (!button) return;
    button.dataset.fullscreen = embedModalOn ? 'on' : 'off';
    button.title = embedModalOn ? t('app.closeModal') : t('app.openModal');
    button.setAttribute('aria-label', button.title);
    setFullscreenIcon(button, embedModalOn);
  }

  function notifyWidgetEmbedReady() {
    if (!widgetConnection?.parentOrigin) return;
    window.parent.postMessage(
      { type: 'cretli-widget-embed-ready' },
      widgetConnection.parentOrigin,
    );
  }

  function notifyWidgetSelectChatApplied(chatId) {
    if (!widgetConnection?.parentOrigin) return;
    const normalizedId = String(chatId || '').trim();
    if (!normalizedId) return;
    window.parent.postMessage(
      { type: 'cretli-widget-select-chat-applied', chatId: normalizedId },
      widgetConnection.parentOrigin,
    );
  }

  /**
   * @param {string} requestedPageUrl
   * @returns {Promise<string>}
   */
  async function resolveWidgetCreatePageUrl(requestedPageUrl) {
    const normalizedRequestedPageUrl = String(requestedPageUrl || '').trim();
    if (normalizedRequestedPageUrl) return normalizedRequestedPageUrl;
    try {
      const current = await requestWidgetHostUrl();
      const hostPageUrl = typeof current?.url === 'string' ? current.url.trim() : '';
      return hostPageUrl || '';
    } catch {
      return '';
    }
  }

  /**
   * @param {{ pageSessionId: string, pageUrl: string, pageTitle: string, harness?: string, forceNew?: boolean }} params
   * @returns {Promise<{ ok: boolean, chat?: object, reused?: boolean, error?: string }>}
   */
  function createWidgetPageChatWithDedupe(params) {
    const pageSessionId = String(params.pageSessionId || '').trim();
    const pageUrl = String(params.pageUrl || '').trim();
    const pageTitle = String(params.pageTitle || '').trim();
    const harness = String(params.harness || '').trim().toLowerCase();
    const forceNew = params.forceNew !== false;
    const dedupeKey = `${pageSessionId}|${pageUrl}|${pageTitle}|${harness}|${forceNew ? 'new' : 'reuse'}`;
    const pending = widgetCreatePageChatInFlight.get(dedupeKey);
    if (pending) return pending;
    const promise = createPageLinkedChat({
      pageUrl,
      pageTitle,
      harness,
      forceNew,
    }).finally(() => {
      widgetCreatePageChatInFlight.delete(dedupeKey);
    });
    widgetCreatePageChatInFlight.set(dedupeKey, promise);
    return promise;
  }

  async function broadcastPagePinStateToParent() {
    if (!widgetConnection?.parentOrigin) return;
    let pageUrl = '';
    try {
      const current = await requestWidgetHostUrl();
      pageUrl = typeof current?.url === 'string' ? current.url.trim() : '';
    } catch {
      return;
    }
    if (!pageUrl) return;
    const linked = await resolvePagePinStateForUrl(pageUrl);
    window.parent.postMessage({
      type: 'cretli-widget-page-pin-state',
      linkedChatId: linked?.id || '',
      linkedChatTitle: linked?.title || '',
    }, widgetConnection.parentOrigin);
  }

  function initEmbedWidgetHostBridge() {
    if (!isEmbedModeEnabled() || embedWidgetBridgeInitialized) return;
    embedWidgetBridgeInitialized = true;
    const previousListeners = window[WIDGET_BRIDGE_LISTENERS_KEY];
    if (previousListeners?.messageHandler) {
      window.removeEventListener('message', previousListeners.messageHandler);
    }
    if (previousListeners?.bindChatHandler) {
      window.removeEventListener('cr-widget-bind-chat-request', previousListeners.bindChatHandler);
    }
    const messageHandler = (event) => {
      const data = event?.data;
      if (!data || typeof data !== 'object' || event.source !== window.parent) return;

      if (data.type === 'cretli-widget-connect') {
        if (widgetConnection) return;
        const installationId = window.location.pathname.split('/').filter(Boolean)[1] || '';
        const installation = data.installation;
        if (!installationId || installation?.id !== installationId) return;
        if (!Array.isArray(installation.allowedOrigins)
          || !installation.allowedOrigins.includes(event.origin)) return;
        const port = event.ports?.[0];
        if (!port) return;

        widgetConnection = {
          installation,
          pageSessionId: data.pageSessionId,
          parentOrigin: event.origin,
          port,
        };
        setWidgetHostPort(port);
        api.setWidgetAccessToken(data.accessToken);
        applyEmbedWorkspaceContext(installation);
        port.start();
        window.dispatchEvent(new CustomEvent('cr-widget-connected', {
          detail: {
            installation,
            pageSessionId: data.pageSessionId,
          },
        }));
        void broadcastPagePinStateToParent();
        const activeChat = getChatsList().find((chat) => chat.id === getActiveChatIdValue());
        if (activeChat?.cursorSessionId) {
          port.postMessage({
            type: 'cretli-widget-bind-chat',
            chatSessionKey: activeChat.cursorSessionId,
          });
        }
        return;
      }

      if (data.type === 'cretli-widget-select-chat') {
        if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
        const chatId = typeof data.chatId === 'string' ? data.chatId.trim() : '';
        if (!chatId) return;
        appLogger.log('widget-plus', 'select-chat from host', { chatId: chatId.slice(0, 8) });
        setForcedEmbedChatId(chatId);
        void selectChatFromWidgetHost(chatId).then(() => {
          const chat = getChatsList().find((entry) => entry.id === chatId);
          appLogger.log('widget-plus', 'select-chat done', {
            chatId: chatId.slice(0, 8),
            hasPane: !!chat?.pane,
            hasRichView: !!chat?._sdkRichView,
          });
          if (chat?.pane && chat?._sdkRichView) notifyWidgetSelectChatApplied(chatId);
        });
        return;
      }

      if (data.type === 'cretli-widget-create-page-chat') {
        if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
        const requestId = typeof data.id === 'string' ? data.id : '';
        const requestedPageUrl = typeof data.pageUrl === 'string' ? data.pageUrl.trim() : '';
        const pageTitle = typeof data.pageTitle === 'string' ? data.pageTitle.trim() : '';
        const harness = typeof data.harness === 'string' ? data.harness.trim() : '';
        const forceNew = data.forceNew !== false;
        appLogger.log('widget-plus', 'create-page-chat from host', { requestId, requestedPageUrl, pageTitle });
        void resolveWidgetCreatePageUrl(requestedPageUrl)
          .then((resolvedPageUrl) => {
            appLogger.log('widget-plus', 'create-page-chat resolved-url', {
              requestId,
              requestedPageUrl,
              resolvedPageUrl,
              pageTitle,
            });
            return createWidgetPageChatWithDedupe({
              pageSessionId: widgetConnection.pageSessionId,
              pageUrl: resolvedPageUrl,
              pageTitle,
              harness,
              forceNew,
            });
          })
          .then((result) => {
            appLogger.log('widget-plus', 'create-page-chat result', {
              requestId,
              ok: result.ok === true,
              chatId: result.chat?.id ? String(result.chat.id).slice(0, 8) : null,
              reused: result.reused === true,
              error: result.error || null,
            });
            const createdChatId = typeof result?.chat?.id === 'string' ? result.chat.id.trim() : '';
            if (!result.ok || !createdChatId) {
              window.parent.postMessage({
                type: 'cretli-widget-create-page-chat-result',
                id: requestId,
                ok: false,
                chat: null,
                reused: result.reused === true,
                error: result.error || '',
              }, widgetConnection.parentOrigin);
              return;
            }
            setForcedEmbedChatId(createdChatId);
            return selectChatFromWidgetHost(createdChatId)
              .catch(() => null)
              .then(() => {
                window.parent.postMessage({
                  type: 'cretli-widget-create-page-chat-result',
                  id: requestId,
                  ok: true,
                  chat: result.chat || null,
                  reused: result.reused === true,
                  error: '',
                }, widgetConnection.parentOrigin);
                void broadcastPagePinStateToParent();
              });
          });
        return;
      }

      if (data.type === 'cretli-widget-request-page-pin-state') {
        if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
        const requestId = typeof data.id === 'string' ? data.id : '';
        const pageUrl = typeof data.pageUrl === 'string' ? data.pageUrl.trim() : '';
        void resolvePagePinStateForUrl(pageUrl).then((linked) => {
          window.parent.postMessage({
            type: 'cretli-widget-page-pin-state-result',
            id: requestId,
            linkedChat: linked,
          }, widgetConnection.parentOrigin);
        });
        return;
      }

      if (data.type === 'cretli-widget-sync-embed-chat') {
        if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
        void syncEmbedChatToHostPage();
        return;
      }

      if (data.type !== 'cretli-widget-modal-state') return;
      if (!widgetConnection || event.origin !== widgetConnection.parentOrigin) return;
      embedModalOn = !!data.expanded;
      updateEmbedFullscreenButton();
    };

    const bindChatHandler = (event) => {
      const chatSessionKey = event?.detail?.chatSessionKey;
      if (!widgetConnection?.port || typeof chatSessionKey !== 'string' || !chatSessionKey.trim()) return;
      widgetConnection.port.postMessage({
        type: 'cretli-widget-bind-chat',
        chatSessionKey: chatSessionKey.trim(),
      });
    };
    window.addEventListener('message', messageHandler);
    window.addEventListener('cr-widget-bind-chat-request', bindChatHandler);
    window[WIDGET_BRIDGE_LISTENERS_KEY] = {
      messageHandler,
      bindChatHandler,
    };
  }

  return {
    initEmbedWidgetHostBridge,
    updateEmbedFullscreenButton,
    notifyWidgetEmbedReady,
    getWidgetConnection: () => widgetConnection,
    isEmbedModalOn: () => embedModalOn,
    setEmbedModalOn: (value) => {
      embedModalOn = !!value;
    },
  };
}
