/**
 * Pure notificationclick decision logic for public/sw.js.
 *
 * Classic script on purpose: service workers are registered without `type:
 * 'module'`, so sw.js loads this with importScripts(). The unit test loads the
 * same file through node:vm, so this file must not use import/export or Node
 * globals. It exposes `cretliNotificationClickPolicy` on the global object.
 */
(function attachNotificationClickPolicy(root) {
  'use strict';

  // Pages that are served by the shell but cannot handle the SPA message.
  var NON_APP_PATH_PREFIXES = ['/login', '/login.html', '/offline', '/offline.html'];

  /**
   * A window client can switch chats in place when it is same-origin and is not
   * one of the non-app pages.
   *
   * @param {string} clientUrl
   * @param {string} targetOrigin
   * @returns {boolean}
   */
  function canHandleOpenChatMessage(clientUrl, targetOrigin) {
    if (typeof clientUrl !== 'string' || !clientUrl) return false;
    var parsed;
    try {
      parsed = new URL(clientUrl);
    } catch (_) {
      return false;
    }
    if (targetOrigin && parsed.origin !== targetOrigin) return false;
    for (var i = 0; i < NON_APP_PATH_PREFIXES.length; i += 1) {
      var prefix = NON_APP_PATH_PREFIXES[i];
      if (parsed.pathname === prefix || parsed.pathname.indexOf(prefix + '/') === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * @param {{
   *   clients?: Array<{
   *     url?: string,
   *     canFocus?: boolean,
   *     canPostMessage?: boolean,
   *     canNavigate?: boolean,
   *   }>,
   *   targetUrl?: string,
   *   chatId?: string,
   *   origin?: string,
   * }} input
   * @returns {{
   *   action: 'postMessage' | 'navigate' | 'openWindow',
   *   clientIndex: number,
   *   url: string,
   *   chatId: string,
   *   reason: string,
   * }}
   */
  function resolveNotificationClickAction(input) {
    var clients = Array.isArray(input && input.clients) ? input.clients : [];
    var targetUrl =
      typeof (input && input.targetUrl) === 'string' && input.targetUrl ? input.targetUrl : '/';
    var chatId = String((input && input.chatId) || '').trim();
    var origin = String((input && input.origin) || '').trim();
    var firstSameOriginIndex = -1;
    for (var index = 0; index < clients.length; index += 1) {
      var client = clients[index] || {};
      var sameOrigin =
        !origin || (typeof client.url === 'string' && client.url.indexOf(origin) === 0);
      if (canHandleOpenChatMessage(client.url, origin) && client.canPostMessage !== false) {
        return {
          action: 'postMessage',
          clientIndex: index,
          url: targetUrl,
          chatId: chatId,
          reason: 'app-client',
        };
      }
      if (sameOrigin && firstSameOriginIndex < 0) {
        firstSameOriginIndex = index;
      }
    }
    if (firstSameOriginIndex >= 0) {
      return {
        action: 'navigate',
        clientIndex: firstSameOriginIndex,
        url: targetUrl,
        chatId: chatId,
        reason: 'non-app-client',
      };
    }
    return {
      action: 'openWindow',
      clientIndex: -1,
      url: targetUrl,
      chatId: chatId,
      reason: 'no-client',
    };
  }

  /**
   * Older/agent-finished pushes only carry `url`; the chat id is a query param.
   *
   * @param {string} url
   * @param {string} [baseUrl]
   * @returns {string}
   */
  function readChatIdFromUrl(url, baseUrl) {
    if (typeof url !== 'string' || !url) return '';
    try {
      var parsed = new URL(url, baseUrl || undefined);
      return String(parsed.searchParams.get('chat') || '').trim();
    } catch (_) {
      return '';
    }
  }

  root.cretliNotificationClickPolicy = {
    canHandleOpenChatMessage: canHandleOpenChatMessage,
    readChatIdFromUrl: readChatIdFromUrl,
    resolveNotificationClickAction: resolveNotificationClickAction,
  };
})(typeof self !== 'undefined' ? self : globalThis);
