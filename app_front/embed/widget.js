import { buildEmbedQueryString } from '../app/appShell/embedMode.js';
import { copyTextToClipboard, createPageBridge, isAllowedNavigation } from './pageBridge.js';
import {
  clearWidgetAuth,
  consumeWidgetOpenOnLoad,
  getOrCreatePageSessionId,
  loadStoredWidgetAuth,
  markWidgetOpenOnLoad,
  saveWidgetAuth,
} from './widgetSession.js';
import { findChatPinnedToPageUrl, isSamePageUrl } from './pageUrlCompare.js';
import { readStorageValueWithAlias } from '../lib/storageKeyAlias.js';

const WIDGET_DEBUG_LS_KEY = 'cretli-debug-widget';

/**
 * @param {string} step
 * @param {Record<string, unknown>} [data]
 */
function widgetDebugLog(step, data = {}) {
  try {
    const verbose = readStorageValueWithAlias(localStorage, WIDGET_DEBUG_LS_KEY, '');
    const forceVerbose = verbose === '1' || verbose === 'true';
    const isPlusFlow = step.startsWith('plus.') || step.startsWith('create.');
    if (!forceVerbose && !isPlusFlow) return;
  } catch {
    // Always log plus/create steps when localStorage is unavailable.
  }
  console.log(`[cretli-widget] ${step}`, data);
}

function createStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .cr-widget-root {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
    }
    .cr-widget-launcher-dock {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: stretch;
      gap: 8px;
      pointer-events: auto !important;
    }
    .cr-widget-launcher {
      border: 0;
      border-radius: 999px;
      padding: 10px 14px;
      background: #2563eb;
      color: #fff;
      font: 600 13px/1.1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
      pointer-events: auto !important;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 40px;
    }
    .cr-widget-launcher--linked {
      background: #1d4ed8;
    }
    .cr-widget-launcher-inner {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .cr-widget-launcher-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .cr-widget-launcher-plus {
      border: 0;
      border-radius: 999px;
      width: 40px;
      min-width: 40px;
      padding: 0;
      background: #1e40af;
      color: #fff;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
      pointer-events: auto !important;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .cr-widget-launcher-plus:hover {
      background: #1d4ed8;
    }
    .cr-widget-launcher-plus:disabled {
      opacity: 0.65;
      cursor: wait;
    }
    .cr-widget-launcher-plus[hidden] {
      display: none !important;
    }
    .cr-widget-panel {
      position: fixed;
      right: 16px;
      bottom: 64px;
      width: min(420px, calc(100vw - 24px));
      height: min(640px, calc(100vh - 92px));
      z-index: 2147483647;
      border: 1px solid #d1d5db;
      border-radius: 12px;
      overflow: hidden;
      background: #fff;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
      display: none;
      pointer-events: auto !important;
    }
    .cr-widget-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.42);
      z-index: 2147483646;
      display: none;
      pointer-events: auto !important;
    }
    .cr-widget-panel.is-open {
      display: block;
    }
    .cr-widget-panel.is-open.is-modal {
      right: auto;
      bottom: auto;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(1040px, calc(100vw - 48px));
      height: min(86vh, 860px);
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
      z-index: 2147483647;
    }
    .cr-widget-backdrop.is-open {
      display: block;
    }
    .cr-widget-frame,
    .cr-widget-auth-frame {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      pointer-events: auto !important;
    }
    .cr-widget-panel.is-authorizing .cr-widget-frame {
      display: none;
    }
    .cr-widget-auth-hint {
      position: absolute;
      inset: auto 12px 12px 12px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(17, 24, 39, 0.92);
      color: #f9fafb;
      font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      pointer-events: none;
    }
  `;
  return style;
}

const widgetScriptElement = typeof document !== 'undefined' ? document.currentScript : null;

const LINK_ICON_SVG = '<svg class="cr-widget-launcher-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10.59 13.41c.41.39.41 1.03 0 1.42-.39.39-1.03.39-1.42 0a5.003 5.003 0 0 1 0-7.07l3.54-3.54a5.003 5.003 0 0 1 7.07 0 5.003 5.003 0 0 1 0 7.07l-1.49 1.49c.01-.82-.12-1.64-.4-2.43l.47-.48a2.982 2.982 0 0 0 0-4.24 2.982 2.982 0 0 0-4.24 0l-3.53 3.53a2.982 2.982 0 0 0 0 4.24m2.82-4.24c.39-.39 1.03-.39 1.42 0a5.003 5.003 0 0 1 0 7.07l-3.54 3.54a5.003 5.003 0 0 1-7.07 0 5.003 5.003 0 0 1 0-7.07l1.49-1.49c-.01.82.12 1.64.4 2.43l-.47.48a2.982 2.982 0 0 0 0 4.24 2.982 2.982 0 0 0 4.24 0l3.53-3.53a2.982 2.982 0 0 0 0-4.24"/></svg>';
const PLUS_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';

function resolveWidgetScriptElement() {
  if (widgetScriptElement) return widgetScriptElement;
  return document.querySelector('script[data-installation-id], script[src*="embed-widget.bundle.js"]');
}

function initCretliWidget() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const scriptEl = resolveWidgetScriptElement();
  const scriptUrl = scriptEl && scriptEl.src ? new URL(scriptEl.src, window.location.href) : null;
  const config = window.CretliWidgetConfig || window.CursorRemoteWidgetConfig || {};
  const baseUrl = String(config.baseUrl || (scriptUrl && scriptUrl.origin) || window.location.origin || '').replace(/\/$/, '');
  if (!baseUrl) return;
  const scriptWorkspaceFile = scriptEl?.dataset?.workspaceFile || '';
  const scriptWorkspaceFolder = scriptEl?.dataset?.workspaceFolder || '';
  const scriptModel = scriptEl?.dataset?.model || '';
  const scriptHarness = scriptEl?.dataset?.harness || '';
  const scriptPanel = scriptEl?.dataset?.panel || '';
  const scriptInstallationId = scriptEl?.dataset?.installationId || '';
  const runtimeConfig = {
    ...config,
    installationId: config.installationId || scriptInstallationId,
    workspaceFile: config.workspaceFile || scriptWorkspaceFile,
    workspaceFolder: config.workspaceFolder || scriptWorkspaceFolder,
    model: config.model || scriptModel,
    harness: config.harness || scriptHarness,
    panel: config.panel || scriptPanel,
  };

  const root = document.createElement('div');
  root.className = 'cr-widget-root';
  root.setAttribute('data-cr-widget', '');

  const launcherDock = document.createElement('div');
  launcherDock.className = 'cr-widget-launcher-dock';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'cr-widget-launcher';
  openBtn.textContent = runtimeConfig.buttonLabel || 'Chat';
  openBtn.setAttribute('aria-label', 'Open chat panel');
  openBtn.title = 'Open chat panel';

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'cr-widget-launcher-plus';
  plusBtn.innerHTML = PLUS_ICON_SVG;
  plusBtn.setAttribute('aria-label', 'New chat for this page');
  plusBtn.title = 'New chat for this page';

  const panel = document.createElement('div');
  panel.className = 'cr-widget-panel';
  const backdrop = document.createElement('div');
  backdrop.className = 'cr-widget-backdrop';

  const hostOrigin = window.location.origin;
  let isOpen = consumeWidgetOpenOnLoad(runtimeConfig.installationId, hostOrigin);
  let isModal = false;
  let iframeLoaded = false;
  let iframeRef = null;
  let iframeOrigin = null;
  let authFrame = null;
  let authorization = null;
  let pageBridge = null;
  let authorizationPromise = null;
  let pagePinRefreshPromise = null;
  let pendingSelectChatId = null;
  let pendingPlusCreate = false;
  let pendingCreatePageChatRequest = null;
  const pendingHostRequests = new Map();
  let lastTrackedHostPageUrl = '';
  let pageChatCreateInProgress = false;
  let pagePinState = { linkedChatId: null, linkedChatTitle: null };
  let embedIframeReady = false;
  /** @type {Array<(ready: boolean) => void>} */
  let embedIframeReadyWaiters = [];
  const pageSessionId = runtimeConfig.installationId
    ? getOrCreatePageSessionId(runtimeConfig.installationId, hostOrigin)
    : globalThis.crypto?.randomUUID?.()
      || `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cursorRemoteOrigin = new URL(baseUrl).origin;

  async function copyTextOnHostPage(text) {
    await copyTextToClipboard(text);
  }

  function buildAuthorizeUrl() {
    const authorizeUrl = new URL(
      `/widget-authorize/${encodeURIComponent(runtimeConfig.installationId)}`,
      baseUrl,
    );
    authorizeUrl.searchParams.set('origin', window.location.origin);
    authorizeUrl.searchParams.set('pageSessionId', pageSessionId);
    authorizeUrl.searchParams.set('widgetAuth', '1');
    return authorizeUrl;
  }

  function removeAuthFrame() {
    if (!authFrame) return;
    authFrame.remove();
    authFrame = null;
    panel.classList.remove('is-authorizing');
    clearAuthHint();
  }

  function ensureAuthFrame() {
    if (!runtimeConfig.installationId || authorization || authFrame) return;
    authFrame = document.createElement('iframe');
    authFrame.className = 'cr-widget-auth-frame';
    authFrame.title = 'Cretli authorization';
    authFrame.src = buildAuthorizeUrl().toString();
    authFrame.addEventListener('error', () => {
      showAuthHint(`Could not connect to ${baseUrl}. Open that address in this browser, accept the HTTPS certificate, then try again.`);
    });
    panel.classList.add('is-authorizing');
    panel.appendChild(authFrame);
    showAuthHint(`Signing in to Cretli… If you see a blank screen, open ${baseUrl} and accept the certificate.`);
  }

  function openAuthorizeWindow() {
    if (!runtimeConfig.installationId || authorization) return false;
    try {
      const popup = window.open(buildAuthorizeUrl().toString(), '_blank');
      if (!popup) return false;
      showAuthHint('Finish signing in on the new Cretli tab, then come back to this page.');
      return true;
    } catch {
      return false;
    }
  }

  function showAuthHint(message) {
    if (!message) return;
    let hint = panel.querySelector('.cr-widget-auth-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'cr-widget-auth-hint';
      panel.appendChild(hint);
    }
    hint.textContent = message;
  }

  function clearAuthHint() {
    panel.querySelector('.cr-widget-auth-hint')?.remove();
  }

  function authorizeWidget({ visible = true } = {}) {
    if (!runtimeConfig.installationId || authorization) return Promise.resolve(true);
    if (visible) {
      const openedInNewTab = openAuthorizeWindow();
      if (!openedInNewTab) {
        ensureAuthFrame();
      }
      return Promise.resolve(false);
    }
    return authorizeWidgetSilently();
  }

  function authorizeWidgetSilently() {
    if (!runtimeConfig.installationId || authorization) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, 10_000);
      const iframe = document.createElement('iframe');
      iframe.className = 'cr-widget-auth-frame';
      iframe.setAttribute('aria-hidden', 'true');
      iframe.tabIndex = -1;
      Object.assign(iframe.style, {
        position: 'absolute',
        width: '0',
        height: '0',
        border: '0',
        opacity: '0',
        pointerEvents: 'none',
      });
      iframe.src = buildAuthorizeUrl().toString();

      const onMessage = (event) => {
        const data = event?.data;
        if (!data || typeof data !== 'object') return;
        if (event.origin !== cursorRemoteOrigin) return;
        if (data.type !== 'cretli-widget-authorized') return;
        if (data.pageSessionId !== pageSessionId) return;
        if (data.installation?.id !== runtimeConfig.installationId) return;
        cleanup();
        handleAuthorized(data);
        resolve(true);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        iframe.remove();
      };

      window.addEventListener('message', onMessage);
      panel.appendChild(iframe);
    });
  }

  /**
   * @param {{ allowVisible?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function validateStoredAuthorization(storedAuth) {
    if (!storedAuth?.accessToken) return false;
    try {
      const response = await fetch(`${baseUrl}/api/chats`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${storedAuth.accessToken}`,
          Accept: 'application/json',
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  function ensureAuthorization(options = {}) {
    const allowVisible = options.allowVisible !== false;
    if (authorization) return Promise.resolve(true);
    if (authorizationPromise) return authorizationPromise;

    const stored = runtimeConfig.installationId
      ? loadStoredWidgetAuth(runtimeConfig.installationId, hostOrigin, pageSessionId)
      : null;
    authorizationPromise = (async () => {
      if (stored) {
        const storedAuthValid = await validateStoredAuthorization(stored);
        widgetDebugLog('auth.stored.probe', { valid: storedAuthValid });
        if (storedAuthValid) {
          handleAuthorized(stored);
          return true;
        }
        if (runtimeConfig.installationId) {
          clearWidgetAuth(runtimeConfig.installationId, hostOrigin);
        }
      }
      const ok = await authorizeWidgetSilently();
      if (ok) return true;
      if (allowVisible) authorizeWidget({ visible: true });
      return false;
    })().finally(() => {
      authorizationPromise = null;
    });
    return authorizationPromise;
  }

  /**
   * Loads pin state for the current host URL without opening the panel.
   * Uses stored/silent widget auth + host-origin API (CORS).
   */
  function bootstrapPagePinState() {
    return ensureAuthorization({ allowVisible: false }).then((ok) => {
      if (!ok) return null;
      return refreshPagePinState();
    }).catch(() => null);
  }

  function widgetApiFetch(path, init = {}) {
    if (!authorization?.accessToken) {
      return Promise.reject(new Error('Widget is not authorized'));
    }
    const headers = {
      Authorization: `Bearer ${authorization.accessToken}`,
      Accept: 'application/json',
      ...(init.headers || {}),
    };
    if (init.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const timeoutMs = Number.isFinite(init.timeoutMs) ? init.timeoutMs : 12_000;
    const { timeoutMs: _timeoutMs, ...fetchInit } = init;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    return fetch(`${baseUrl}${path}`, {
      ...fetchInit,
      headers,
      signal: controller?.signal,
    }).then((response) => response.json()).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  }

  function findLinkedChatForCurrentPage(chats) {
    if (!Array.isArray(chats)) return null;
    return findChatPinnedToPageUrl(chats, location.href);
  }

  function applyLinkedChatState(linked) {
    pagePinState = linked?.id
      ? {
        linkedChatId: linked.id,
        linkedChatTitle: typeof linked.title === 'string' ? linked.title.trim() : '',
      }
      : { linkedChatId: null, linkedChatTitle: null };
    updateLauncherPinUi();
    return linked || null;
  }

  function showPlusActionHint(message) {
    if (!message) return;
    plusBtn.title = message;
    plusBtn.setAttribute('aria-label', message);
  }

  function clearPlusActionHint() {
    plusBtn.title = 'New chat for this page';
    plusBtn.setAttribute('aria-label', 'New chat for this page');
  }

  function resolveHostRequest(id, value) {
    const entry = pendingHostRequests.get(id);
    if (!entry) return;
    pendingHostRequests.delete(id);
    clearTimeout(entry.timeoutId);
    entry.resolve(value);
  }

  function requestIframePagePinState() {
    if (!iframeRef?.contentWindow || !iframeOrigin) return Promise.resolve(null);
    const id = `pin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingHostRequests.delete(id);
        reject(new Error('Timed out waiting for the page pin state'));
      }, 15_000);
      pendingHostRequests.set(id, { resolve, reject, timeoutId });
      iframeRef.contentWindow.postMessage({
        type: 'cretli-widget-request-page-pin-state',
        id,
        pageUrl: location.href,
      }, iframeOrigin);
    });
  }

  function requestIframeCreatePageChat() {
    const harness = String(runtimeConfig.harness || '').trim().toLowerCase();
    const payload = {
      pageUrl: location.href,
      pageTitle: (document.title || '').trim() || location.pathname || 'Page chat',
      ...(harness ? { harness } : {}),
    };
    if (!iframeRef?.contentWindow || !iframeOrigin) {
      pendingCreatePageChatRequest = true;
      return Promise.resolve(null);
    }
    const id = `create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingHostRequests.delete(id);
        reject(new Error('Timed out waiting for the page chat to be created'));
      }, 30_000);
      pendingHostRequests.set(id, { resolve, reject, timeoutId });
      widgetDebugLog('create.iframe.post', { requestId: id, ...payload });
      iframeRef.contentWindow.postMessage({
        type: 'cretli-widget-create-page-chat',
        id,
        ...payload,
      }, iframeOrigin);
    });
  }

  function flushPendingCreatePageChatRequest() {
    if (!pendingCreatePageChatRequest || !iframeRef?.contentWindow || !iframeOrigin) return;
    if (plusBtn.disabled || pageChatCreateInProgress) return;
    pendingCreatePageChatRequest = null;
    void createAndLinkPageChat();
  }

  function refreshPagePinStateFromHostApi() {
    const pinnedQuery = encodeURIComponent(location.href);
    return widgetApiFetch(`/api/chats?pinnedTo=${pinnedQuery}`)
      .then((data) => {
        if (!data?.ok) {
          throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to read the page pins');
        }
        const linkedFromApi = data?.linkedChat?.id
          ? {
            id: data.linkedChat.id,
            title: typeof data.linkedChat.title === 'string' ? data.linkedChat.title.trim() : '',
          }
          : findLinkedChatForCurrentPage(Array.isArray(data.chats) ? data.chats : []);
        return applyLinkedChatState(linkedFromApi);
      });
  }

  function refreshPagePinState() {
    if (!authorization?.accessToken) {
      applyLinkedChatState(null);
      return Promise.resolve(null);
    }
    if (pagePinRefreshPromise) return pagePinRefreshPromise;

    pagePinRefreshPromise = (async () => {
      try {
        return await refreshPagePinStateFromHostApi();
      } catch {
        if (!iframeRef?.contentWindow || !iframeOrigin) {
          applyLinkedChatState(null);
          return null;
        }
        try {
          const linked = await requestIframePagePinState();
          return applyLinkedChatState(linked);
        } catch {
          applyLinkedChatState(null);
          return null;
        }
      }
    })().finally(() => {
      pagePinRefreshPromise = null;
    });
    return pagePinRefreshPromise;
  }

  function updateLauncherPinUi() {
    const label = isOpen
      ? (runtimeConfig.closeLabel || 'Close')
      : (runtimeConfig.buttonLabel || 'Chat');
    const linked = !!pagePinState.linkedChatId;
    const chatTitle = pagePinState.linkedChatTitle;

    openBtn.classList.toggle('cr-widget-launcher--linked', linked);
    // One chat per URL — hide "+" whenever this page already has a pinned chat.
    plusBtn.hidden = linked;
    plusBtn.setAttribute('aria-hidden', linked ? 'true' : 'false');

    if (linked) {
      openBtn.innerHTML = `<span class="cr-widget-launcher-inner">${LINK_ICON_SVG}<span class="cr-widget-launcher-label">${label}</span></span>`;
      openBtn.title = isOpen
        ? (chatTitle ? `Close chat: ${chatTitle}` : 'Close the chat pinned to this page')
        : (chatTitle ? `Open chat: ${chatTitle}` : 'Open the chat pinned to this page');
    } else {
      openBtn.textContent = label;
      openBtn.title = isOpen ? 'Close chat panel' : 'Open chat panel';
    }
    openBtn.setAttribute('aria-label', openBtn.title);
  }

  function clearPendingSelectChatId(chatId) {
    const normalizedId = String(chatId || '').trim();
    if (!normalizedId || pendingSelectChatId !== normalizedId) return;
    pendingSelectChatId = null;
  }

  function requestIframeSelectChat(chatId) {
    const normalizedId = String(chatId || '').trim();
    if (!normalizedId) return false;
    pendingSelectChatId = normalizedId;
    if (!iframeRef?.contentWindow || !iframeOrigin) {
      widgetDebugLog('create.select-chat-deferred', {
        chatId: normalizedId.slice(0, 8),
        iframeReady: embedIframeReady,
      });
      return false;
    }
    widgetDebugLog('create.select-chat-post', { chatId: normalizedId.slice(0, 8) });
    iframeRef.contentWindow.postMessage(
      { type: 'cretli-widget-select-chat', chatId: normalizedId },
      iframeOrigin,
    );
    return true;
  }

  function flushPendingSelectChatId() {
    if (!pendingSelectChatId) return;
    requestIframeSelectChat(pendingSelectChatId);
  }

  /**
   * Creates a chat for the current host page (title + pin) via host API.
   * Falls back to the embed iframe when host API is unavailable.
   * @returns {Promise<{ id: string, title?: string }>}
   */
  async function createLinkedChatViaHostApi() {
    const pageUrl = location.href;
    const pageTitle = (document.title || '').trim() || location.pathname || 'Page chat';
    const harness = String(runtimeConfig.harness || '').trim().toLowerCase();
    widgetDebugLog('create.host-api.start', { pageUrl, pageTitle });
    const existing = await refreshPagePinStateFromHostApi().catch(() => null);
    if (existing?.id) {
      widgetDebugLog('create.host-api.reused-existing', { chatId: existing.id.slice(0, 8) });
      return existing;
    }
    const createData = await widgetApiFetch('/api/chats', {
      method: 'POST',
      body: JSON.stringify({
        title: pageTitle,
        widgetPinnedUrl: pageUrl,
        ...(harness ? { agentTransport: harness } : {}),
      }),
    });
    widgetDebugLog('create.host-api.response', {
      ok: createData?.ok === true,
      chatId: createData?.chat?.id ? String(createData.chat.id).slice(0, 8) : null,
      error: createData?.error || null,
    });
    if (!createData?.ok || !createData.chat?.id) {
      throw new Error(createData?.error || 'Failed to create the chat');
    }
    const chat = createData.chat;
    const title = typeof chat.title === 'string' && chat.title.trim()
      ? chat.title.trim()
      : pageTitle;
    applyLinkedChatState({ id: chat.id, title });
    return { id: chat.id, title };
  }

  function markEmbedIframeReady() {
    embedIframeReady = true;
    const waiters = embedIframeReadyWaiters.splice(0);
    waiters.forEach((notify) => notify());
  }

  function waitForEmbedIframeReady(timeoutMs = 20_000) {
    if (embedIframeReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready) => {
        if (settled) return;
        settled = true;
        resolve(ready);
      };
      const timeoutId = setTimeout(() => finish(false), timeoutMs);
      embedIframeReadyWaiters.push(() => {
        clearTimeout(timeoutId);
        finish(true);
      });
    });
  }

  async function createPageChatViaIframe() {
    widgetDebugLog('create.iframe.start', {
      pageUrl: location.href,
      iframeReady: embedIframeReady,
      iframeLoaded,
    });
    ensureIframeLoaded({ forPageChatCreate: true });
    if (!iframeRef?.contentWindow || !iframeOrigin) {
      widgetDebugLog('create.iframe.no-window', { iframeLoaded });
      return null;
    }
    const ready = await waitForEmbedIframeReady();
    widgetDebugLog('create.iframe.ready', { ready, embedIframeReady });
    if (!ready) {
      throw new Error('The chat panel did not start in time. Please try again.');
    }
    const result = await requestIframeCreatePageChat();
    widgetDebugLog('create.iframe.result', {
      hasResult: !!result,
      ok: result?.ok === true,
      chatId: result?.chat?.id ? String(result.chat.id).slice(0, 8) : null,
      reused: result?.reused === true,
      error: result?.error || null,
    });
    if (!result) return null;
    if (!result.ok || !result.chat?.id) {
      throw new Error(result.error || 'Failed to create the page chat');
    }
    const title = typeof result.chat.title === 'string' ? result.chat.title.trim() : '';
    applyLinkedChatState({ id: result.chat.id, title });
    return { id: result.chat.id, title };
  }

  async function createAndLinkPageChat() {
    if (plusBtn.disabled) return;
    widgetDebugLog('plus.click', {
      pageUrl: location.href,
      linkedChatId: pagePinState.linkedChatId ? pagePinState.linkedChatId.slice(0, 8) : null,
      isOpen,
      iframeReady: embedIframeReady,
    });
    plusBtn.disabled = true;
    pageChatCreateInProgress = true;
    clearPlusActionHint();
    try {
      if (!isOpen) {
        isOpen = true;
        applyWidgetUiState();
      }
      const authorized = await ensureAuthorization({ allowVisible: true });
      widgetDebugLog('plus.auth', { authorized });
      if (!authorized) {
        pendingPlusCreate = true;
        showPlusActionHint('Sign in on the panel to create a page chat.');
        return;
      }

      let chat = null;
      try {
        chat = await createPageChatViaIframe();
        if (!chat) {
          widgetDebugLog('plus.deferred', { reason: 'iframe-not-ready' });
          pendingCreatePageChatRequest = true;
          return;
        }
        widgetDebugLog('plus.done-iframe', { chatId: chat.id.slice(0, 8), title: chat.title || '' });
      } catch (iframeError) {
        widgetDebugLog('plus.iframe-failed', { error: iframeError instanceof Error ? iframeError.message : String(iframeError) });
        console.warn('[cretli-widget] iframe create failed, trying host API', iframeError);
        try {
          chat = await createLinkedChatViaHostApi();
        } catch (hostError) {
          throw new Error(hostError?.message || iframeError?.message || 'Failed to create the page chat');
        }
        widgetDebugLog('plus.done-host-api', { chatId: chat.id.slice(0, 8), title: chat.title || '' });
        ensureIframeLoaded({ forPageChatCreate: true });
        requestIframeSelectChat(chat.id);
        const retryDelaysMs = [150, 400, 900, 1800];
        retryDelaysMs.forEach((delayMs) => {
          window.setTimeout(() => {
            if (pendingSelectChatId !== chat.id) return;
            if (pagePinState.linkedChatId !== chat.id) return;
            requestIframeSelectChat(chat.id);
          }, delayMs);
        });
      }
    } catch (error) {
      widgetDebugLog('plus.failed', { error: error instanceof Error ? error.message : String(error) });
      console.error('[cretli-widget] create page chat failed', error);
      showPlusActionHint(error instanceof Error ? error.message : 'Failed to create the page chat');
    } finally {
      pageChatCreateInProgress = false;
      plusBtn.disabled = false;
      flushPendingCreatePageChatRequest();
    }
  }

  function requestIframeSyncEmbedChat() {
    if (!iframeRef?.contentWindow || !iframeOrigin) return false;
    iframeRef.contentWindow.postMessage(
      { type: 'cretli-widget-sync-embed-chat' },
      iframeOrigin,
    );
    return true;
  }

  function handleHostPageUrlChange(nextUrl) {
    if (pageChatCreateInProgress) return;
    const normalized = String(nextUrl || '').trim();
    if (!normalized || isSamePageUrl(lastTrackedHostPageUrl, normalized)) return;
    lastTrackedHostPageUrl = normalized;
    // Always refresh launcher pin state on navigation — no need to open the panel.
    void bootstrapPagePinState().then(() => {
      if (isOpen) requestIframeSyncEmbedChat();
    });
  }

  function startPageBridge() {
    if (!authorization || pageBridge) return;
    pageBridge = createPageBridge({
      serverUrl: baseUrl,
      accessToken: authorization.accessToken,
      pageSessionId,
      installation: authorization.installation,
      onState: (state) => {
        const url = typeof state?.url === 'string' ? state.url.trim() : '';
        if (url) handleHostPageUrlChange(url);
      },
    });
    handleHostPageUrlChange(location.href);
  }

  function sendBridgePort(iframe) {
    if (!authorization || !iframe.contentWindow || typeof MessageChannel === 'undefined') return;
    const channel = new MessageChannel();
    channel.port1.onmessage = async (event) => {
      const data = event?.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'cretli-widget-bind-chat' && pageBridge) {
        pageBridge.bindChat(data.chatSessionKey);
        return;
      }
      if (data.type === 'cretli-widget-copy-text') {
        const requestId = typeof data.id === 'string' ? data.id : '';
        const reply = {
          type: 'cretli-widget-copy-text-result',
          id: requestId,
          ok: false,
        };
        try {
          await copyTextOnHostPage(data.text);
          channel.port1.postMessage({
            ...reply,
            ok: true,
          });
        } catch (error) {
          channel.port1.postMessage({
            ...reply,
            error: error instanceof Error ? error.message : String(error || 'Copy failed'),
          });
        }
        return;
      }
      if (data.type === 'cretli-widget-get-url') {
        const requestId = typeof data.id === 'string' ? data.id : '';
        const state = pageBridge?.getState?.();
        channel.port1.postMessage({
          type: 'cretli-widget-get-url-result',
          id: requestId,
          ok: true,
          url: state?.url || location.href,
        });
        return;
      }
      if (data.type === 'cretli-widget-navigate') {
        const requestId = typeof data.id === 'string' ? data.id : '';
        const reply = {
          type: 'cretli-widget-navigate-result',
          id: requestId,
          ok: false,
        };
        try {
          const target = String(data.url || '').trim();
          if (!target) {
            throw new Error('Missing URL');
          }
          const allowedOrigins = authorization?.installation?.allowedOrigins || [];
          if (!isAllowedNavigation(target, allowedOrigins, location.href)) {
            throw new Error('This URL is not allowed for this widget installation');
          }
          const nextUrl = new URL(target, location.href).href;
          if (location.href === nextUrl || isSamePageUrl(location.href, nextUrl)) {
            channel.port1.postMessage({
              ...reply,
              ok: true,
              url: nextUrl,
              skipped: true,
            });
            return;
          }
          markWidgetOpenOnLoad(runtimeConfig.installationId, hostOrigin);
          channel.port1.postMessage({
            ...reply,
            ok: true,
            url: nextUrl,
          });
          location.assign(nextUrl);
        } catch (error) {
          channel.port1.postMessage({
            ...reply,
            error: error instanceof Error ? error.message : String(error || 'Navigation failed'),
          });
        }
        return;
      }
      if (data.type === 'cretli-widget-screenshot' && pageBridge) {
        const requestId = typeof data.id === 'string' ? data.id : '';
        const reply = {
          type: 'cretli-widget-screenshot-result',
          id: requestId,
          ok: false,
        };
        const captureMode = data.mode === 'dom' ? 'dom' : 'display';
        const hideUi = () => {
          launcherDock.style.visibility = 'hidden';
          panel.style.visibility = 'hidden';
          backdrop.style.visibility = 'hidden';
        };
        const restoreUi = () => {
          launcherDock.style.visibility = '';
          panel.style.visibility = '';
          backdrop.style.visibility = '';
        };
        hideUi();
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        try {
          const result = await pageBridge.takeScreenshot({ mode: captureMode });
          channel.port1.postMessage({
            ...reply,
            ok: true,
            dataUrl: result.dataUrl,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
          });
        } catch (error) {
          channel.port1.postMessage({
            ...reply,
            error: error instanceof Error ? error.message : String(error || 'Screenshot failed'),
          });
        } finally {
          restoreUi();
        }
        return;
      }
      if (data.type === 'cretli-widget-pick-element' && pageBridge) {
        const pickRequestId = typeof data.id === 'string' ? data.id : '';
        const pickReply = {
          type: 'cretli-widget-pick-element-result',
          id: pickRequestId,
          ok: false,
        };
        const hidePickUi = () => {
          launcherDock.style.visibility = 'hidden';
          panel.style.visibility = 'hidden';
          backdrop.style.visibility = 'hidden';
        };
        const restorePickUi = () => {
          launcherDock.style.visibility = '';
          panel.style.visibility = '';
          backdrop.style.visibility = '';
        };
        hidePickUi();
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        try {
          const context = await pageBridge.pickElementWithContext();
          channel.port1.postMessage({
            ...pickReply,
            ok: true,
            context,
          });
        } catch (error) {
          channel.port1.postMessage({
            ...pickReply,
            error: error instanceof Error ? error.message : String(error || 'Pick failed'),
          });
        } finally {
          restorePickUi();
        }
      }
    };
    channel.port1.start();
    iframe.contentWindow.postMessage({
      type: 'cretli-widget-connect',
      pageSessionId,
      installation: authorization.installation,
      accessToken: authorization.accessToken,
    }, iframeOrigin, [channel.port2]);
  }

  function ensureIframeLoaded(options = {}) {
    const forPageChatCreate = options.forPageChatCreate === true;
    if (iframeLoaded) return;
    if (runtimeConfig.installationId && !authorization) {
      void ensureAuthorization().then((ok) => {
        if (ok) ensureIframeLoaded(options);
      });
      return;
    }
    removeAuthFrame();
    const iframe = document.createElement('iframe');
    iframe.className = 'cr-widget-frame';
    iframe.title = 'Cretli Widget';
    iframe.loading = 'lazy';
    const pageChatCreateQuery = forPageChatCreate ? '?widgetCreatePageChat=1' : '';
    iframe.src = runtimeConfig.installationId
      ? `${baseUrl}/embed/${encodeURIComponent(runtimeConfig.installationId)}${pageChatCreateQuery}`
      : `${baseUrl}/${buildEmbedQueryString(runtimeConfig)}`;
    iframe.addEventListener('error', () => {
      showAuthHint('Failed to load Cretli. Check the HTTPS certificate at the widget server address.');
    });
    panel.appendChild(iframe);
    iframeRef = iframe;
    try {
      iframeOrigin = new URL(iframe.src).origin;
    } catch (_) {
      return;
    }
    iframe.addEventListener('load', () => {
      sendBridgePort(iframe);
      flushPendingSelectChatId();
      flushPendingCreatePageChatRequest();
    });
    iframeLoaded = true;
  }

  function notifyIframeModalState() {
    if (!iframeRef || !iframeRef.contentWindow) return;
    iframeRef.contentWindow.postMessage(
      { type: 'cretli-widget-modal-state', expanded: !!isModal },
      iframeOrigin
    );
  }

  function applyWidgetUiState() {
    panel.classList.toggle('is-open', isOpen);
    panel.classList.toggle('is-modal', isOpen && isModal);
    backdrop.classList.toggle('is-open', isOpen && isModal);
    updateLauncherPinUi();
    notifyIframeModalState();
  }

  function toggleModalState(forceValue) {
    isModal = typeof forceValue === 'boolean' ? forceValue : !isModal;
    if (!isOpen) {
      isOpen = true;
      ensureIframeLoaded();
    }
    applyWidgetUiState();
  }

  function handleAuthorized(data) {
    if (data.pageSessionId !== pageSessionId) return;
    if (data.installation?.id !== runtimeConfig.installationId) return;
    authorization = data;
    saveWidgetAuth(runtimeConfig.installationId, hostOrigin, data);
    removeAuthFrame();
    startPageBridge();
    void refreshPagePinState();
    if (isOpen && !iframeLoaded) ensureIframeLoaded();
    applyWidgetUiState();
    if (pendingPlusCreate) {
      pendingPlusCreate = false;
      void createAndLinkPageChat();
    }
  }

  launcherDock.appendChild(openBtn);
  launcherDock.appendChild(plusBtn);
  root.appendChild(launcherDock);
  root.appendChild(backdrop);
  root.appendChild(panel);

  openBtn.addEventListener('click', () => {
    isOpen = !isOpen;
    if (isOpen) ensureIframeLoaded();
    if (!isOpen) isModal = false;
    applyWidgetUiState();
    if (!isOpen) return;
    void refreshPagePinState()
      .catch(() => null)
      .then((linked) => {
        if (!isOpen) return;
        const linkedId = linked?.id || pagePinState.linkedChatId;
        if (linkedId) {
          requestIframeSelectChat(linkedId);
          return;
        }
        requestIframeSyncEmbedChat();
      });
  });
  plusBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    void createAndLinkPageChat();
  });
  backdrop.addEventListener('click', () => {
    if (!isOpen) return;
    isModal = false;
    applyWidgetUiState();
  });
  window.addEventListener('message', (event) => {
    const data = event?.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'cretli-widget-authorized') {
      if (event.origin !== cursorRemoteOrigin) return;
      handleAuthorized(data);
      return;
    }
    if (data.type === 'cretli-widget-embed-ready') {
      if (event.origin !== iframeOrigin || event.source !== iframeRef?.contentWindow) return;
      widgetDebugLog('create.embed-ready', { pendingSelect: pendingSelectChatId?.slice(0, 8) || null });
      markEmbedIframeReady();
      flushPendingSelectChatId();
      flushPendingCreatePageChatRequest();
      return;
    }
    if (data.type === 'cretli-widget-select-chat-applied') {
      if (event.origin !== iframeOrigin || event.source !== iframeRef?.contentWindow) return;
      widgetDebugLog('create.select-chat-applied', { chatId: String(data.chatId || '').slice(0, 8) });
      clearPendingSelectChatId(data.chatId);
      return;
    }
    if (data.type === 'cretli-widget-page-pin-changed') {
      if (event.origin !== iframeOrigin || event.source !== iframeRef?.contentWindow) return;
      void refreshPagePinState();
      return;
    }
    if (data.type === 'cretli-widget-page-pin-state') {
      if (event.origin !== iframeOrigin || event.source !== iframeRef?.contentWindow) return;
      const linkedChatId = typeof data.linkedChatId === 'string' ? data.linkedChatId.trim() : '';
      applyLinkedChatState(linkedChatId
        ? {
          id: linkedChatId,
          title: typeof data.linkedChatTitle === 'string' ? data.linkedChatTitle.trim() : '',
        }
        : null);
      return;
    }
    if (data.type === 'cretli-widget-page-pin-state-result') {
      if (event.origin !== iframeOrigin || event.source !== iframeRef?.contentWindow) return;
      const requestId = typeof data.id === 'string' ? data.id : '';
      const linked = data.linkedChat?.id
        ? {
          id: data.linkedChat.id,
          title: typeof data.linkedChat.title === 'string' ? data.linkedChat.title.trim() : '',
        }
        : null;
      resolveHostRequest(requestId, linked);
      return;
    }
    if (data.type === 'cretli-widget-create-page-chat-result') {
      if (event.origin !== iframeOrigin || event.source !== iframeRef?.contentWindow) return;
      const requestId = typeof data.id === 'string' ? data.id : '';
      widgetDebugLog('create.iframe.result-msg', {
        requestId,
        ok: data.ok === true,
        chatId: data.chat?.id ? String(data.chat.id).slice(0, 8) : null,
        reused: data.reused === true,
        error: data.error || null,
      });
      resolveHostRequest(requestId, {
        ok: data.ok === true,
        chat: data.chat || null,
        reused: data.reused === true,
        error: typeof data.error === 'string' ? data.error : '',
      });
      return;
    }
    if (data.type !== 'cretli-widget-modal') return;
    if (event.origin !== iframeOrigin || event.source !== iframeRef?.contentWindow) return;
    toggleModalState(data.action === 'open' ? true : (data.action === 'close' ? false : undefined));
  });
  window.addEventListener('popstate', () => {
    handleHostPageUrlChange(location.href);
  });
  window.addEventListener('hashchange', () => {
    handleHostPageUrlChange(location.href);
  });
  window.addEventListener('beforeunload', () => pageBridge?.destroy?.(), { once: true });

  document.head.appendChild(createStyles());
  document.body.appendChild(root);
  updateLauncherPinUi();

  // Pin/link icon on the launcher must work before the panel is opened.
  void bootstrapPagePinState();

  if (isOpen) {
    applyWidgetUiState();
    void ensureAuthorization({ allowVisible: true }).then((ok) => {
      if (!ok) return;
      ensureIframeLoaded();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCretliWidget);
} else {
  initCretliWidget();
}
