// Service-worker side of the in-app signal coordination.
//
// push events normally vibrate/show an OS notification. When a Cretli window
// is visible, the page itself plays the in-app signal (see
// app_front/features/pwa/inAppSignals.js), so the SW delegates the event with a
// `cretli-in-app-signal` postMessage and suppresses the notification vibration.
// That way a single event never produces both an OS vibration and an in-app one.
//
// Pure decision logic (no registration/clients access) so tests can load this
// classic script with node:vm, mirroring public/sw-push-options.js.
(function () {
  'use strict';

  var SIGNAL_MESSAGE = 'cretli-in-app-signal';

  function readData(payload) {
    return payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
      ? payload.data
      : {};
  }

  /**
   * @param {unknown} payload
   * @returns {string}
   */
  function readSignalEventId(payload) {
    var data = readData(payload);
    return typeof data.eventId === 'string' ? data.eventId.trim() : '';
  }

  /**
   * @param {unknown} payload
   * @returns {'' | 'finished' | 'question' | 'permission' | 'newChat'}
   */
  function resolveSignalEventType(payload) {
    var data = readData(payload);
    var type = typeof data.type === 'string' ? data.type.trim() : '';
    if (type === 'agent-finished' || type === 'finished') return 'finished';
    if (type === 'agent-needs-input') {
      var kind = typeof data.kind === 'string' ? data.kind.trim() : '';
      return kind === 'permission' ? 'permission' : 'question';
    }
    if (type === 'opencode_permission' || type === 'permission') return 'permission';
    if (type === 'opencode_question' || type === 'question') return 'question';
    if (type === 'chat-created') return 'newChat';
    return '';
  }

  /**
   * Only real SPA windows run `initInAppSignals`. A visible login/offline page
   * must not suppress the notification vibration.
   *
   * @param {unknown} url
   * @returns {boolean}
   */
  function isAppClientUrl(url) {
    if (typeof url !== 'string' || !url) return true;
    try {
      var pathname = new URL(url).pathname;
      if (pathname === '/offline.html') return false;
      if (pathname === '/login' || pathname.indexOf('/login/') === 0) return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  /**
   * @param {unknown} client
   * @returns {boolean}
   */
  function isVisibleClient(client) {
    if (!client || typeof client !== 'object') return false;
    if (client.visibilityState === 'visible') return true;
    return client.focused === true;
  }

  /**
   * Decide whether the SW should delegate the signal to a visible page. The
   * caller still has to confirm the page actually handled it before suppressing
   * the notification vibration.
   *
   * @param {{ payload?: unknown, clients?: Array<unknown> }} [input]
   * @returns {{ post: boolean, suppressVibrate: boolean, clientIndex: number, eventId: string, eventType: string, reason: string }}
   */
  function resolveClientSignal(input) {
    var payload = input && input.payload;
    var clients = input && Array.isArray(input.clients) ? input.clients : [];
    var eventId = readSignalEventId(payload);
    var eventType = resolveSignalEventType(payload);
    if (!eventId || !eventType) {
      return {
        post: false,
        suppressVibrate: false,
        clientIndex: -1,
        eventId: eventId,
        eventType: eventType,
        reason: 'no-signal-event',
      };
    }
    for (var i = 0; i < clients.length; i += 1) {
      if (isVisibleClient(clients[i]) && isAppClientUrl(clients[i] && clients[i].url)) {
        return {
          post: true,
          suppressVibrate: false,
          clientIndex: i,
          eventId: eventId,
          eventType: eventType,
          reason: 'visible-client',
        };
      }
    }
    return {
      post: false,
      suppressVibrate: false,
      clientIndex: -1,
      eventId: eventId,
      eventType: eventType,
      reason: 'no-visible-client',
    };
  }

  /**
   * @param {unknown} payload
   * @returns {{ type: string, eventId: string, eventType: string, chatId: string, notificationScope?: string }}
   */
  function buildClientMessage(payload) {
    var data = readData(payload);
    return {
      type: SIGNAL_MESSAGE,
      eventId: readSignalEventId(payload),
      eventType: resolveSignalEventType(payload),
      chatId: typeof data.chatId === 'string' ? data.chatId : '',
      ...(data.notificationScope ? { notificationScope: data.notificationScope } : {}),
    };
  }

  self.cretliInAppSignal = {
    SIGNAL_MESSAGE: SIGNAL_MESSAGE,
    readSignalEventId: readSignalEventId,
    resolveSignalEventType: resolveSignalEventType,
    isVisibleClient: isVisibleClient,
    isAppClientUrl: isAppClientUrl,
    resolveClientSignal: resolveClientSignal,
    buildClientMessage: buildClientMessage,
  };
})();
