// Service worker for Cretli PWA.
// Strategies:
//   - app shell (HTML/JS/CSS): network-first with ~3s timeout, fallback to cache
//   - icons, manifest, screenshots, fonts: cache-first (stable names)
//   - navigations (document): network-first with timeout, fallback offline.html
//   - /api/* and /ws: always bypassed (live server)
// push + notificationclick: agent-finished, agent-needs-input and new-chat
// notifications.
//
// Bundles are requested with a ?v=<asset version> query. Cache fallbacks must
// therefore ignore the search part: after a version bump the exact URL is not in
// the cache, and a strict match would serve Response.error() for the app bundle,
// leaving the cached HTML shell without any JavaScript.

const CACHE_NAME = 'cretli-v29';
const OFFLINE_URL = '/offline.html';

// Pure notificationclick decision logic, shared with the unit test. Kept in a
// separate classic script because service workers here are not module workers.
// A failed load must not break install: notificationclick below falls back.
try {
  importScripts('/sw-notification-click.js');
} catch (_) {}
try {
  importScripts('/sw-push-inbox.js');
} catch (_) {}
try {
  importScripts('/sw-push-options.js');
} catch (_) {}
try {
  importScripts('/sw-in-app-signal.js');
} catch (_) {}
try {
  importScripts('/sw-quiet-hours.js');
} catch (_) {}

const PREF_DB_NAME = 'cretli-preferences';
const PREF_STORE_NAME = 'kv';
const PREF_QUIET_KEY = 'push-quiet-hours';
const PREF_MUTED_CHATS_KEY = 'push-muted-chats';

/**
 * Best-effort read of a device preference from IndexedDB (fail-open).
 *
 * @param {string} key
 * @returns {Promise<unknown>}
 */
function readDevicePreference(key) {
  if (!self.indexedDB || !key) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request;
    try {
      request = self.indexedDB.open(PREF_DB_NAME, 1);
    } catch (_) {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PREF_STORE_NAME)) {
        db.createObjectStore(PREF_STORE_NAME);
      }
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      let tx;
      try {
        tx = db.transaction(PREF_STORE_NAME, 'readonly');
      } catch (_) {
        resolve(null);
        return;
      }
      const getReq = tx.objectStore(PREF_STORE_NAME).get(key);
      getReq.onsuccess = () => {
        resolve(getReq.result === undefined ? null : getReq.result);
      };
      getReq.onerror = () => resolve(null);
    };
  });
}

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/monochrome-512.png',
  '/icons/apple-touch-180.png',
  '/harness-icons/claude.svg',
  '/harness-icons/codebuddy.svg',
  '/harness-icons/codex.svg',
  '/harness-icons/cursor.svg',
  '/harness-icons/deepseek.svg',
  '/harness-icons/opencode.svg',
  '/harness-icons/openrouter.svg',
  '/harness-icons/qwen.svg',
  '/dist/app/index.css',
  '/dist/app/login.css',
  '/dist/app/vendor.bundle.js',
  '/dist/app/vendor-login.bundle.js',
  '/dist/app/index.bundle.js',
  '/dist/app/login.bundle.js',
  '/dist/app/i18n-pl.bundle.js',
];

const CACHE_FIRST_PREFIXES = ['/icons/', '/harness-icons/', '/screenshots/', '/manifest.webmanifest', '/icon.svg'];
const NETWORK_TIMEOUT_MS = 3000;

// addAll() is atomic, so a single missing asset would leave the whole shell
// uncached; cache each entry on its own instead.
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(SHELL_ASSETS.map((asset) => cache.add(asset).catch(() => undefined)));
}

// No skipWaiting() here on purpose: the new worker stays in `waiting` until the
// user confirms the update banner. Activating mid-session would serve new assets
// to an already running old page.
self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(() =>
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: 'SW_UPDATED' });
          }
        })
      )
  );
});

// On-demand update from the UI (both message names are accepted so an older
// cached frontend can still trigger the activation).
self.addEventListener('message', (event) => {
  const type = event?.data?.type;
  if (type === 'SKIP_WAITING' || type === 'skipWaiting') {
    self.skipWaiting();
  }
});

function isCacheFirst(url) {
  // Font files are content-hashed, so they cannot be precached by name; without
  // this the icon font is missing offline and the UI renders empty boxes.
  if (/\.(woff2?|ttf|eot)$/i.test(url.pathname)) return true;
  return CACHE_FIRST_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p));
}

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw-timeout')), ms);
    fetch(req)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// Keeps a single cached copy per bundle path, so ?v= bumps do not pile up
// multi-megabyte duplicates of the same asset.
async function dropOtherVersions(cache, req) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/dist/')) return;
  const keys = await cache.keys(req, { ignoreSearch: true });
  await Promise.all(
    keys.filter((key) => key.url !== req.url).map((key) => cache.delete(key))
  );
}

function putInCache(req, res) {
  if (!res || res.status !== 200) return;
  const copy = res.clone();
  caches
    .open(CACHE_NAME)
    .then(async (cache) => {
      await cache.put(req, copy);
      await dropOtherVersions(cache, req);
    })
    .catch(() => {});
}

// Versioned assets never match the cached URL exactly after a version bump, so
// fall back to the same path with any ?v=.
async function matchCached(req) {
  const exact = await caches.match(req);
  if (exact) return exact;
  return caches.match(req, { ignoreSearch: true });
}

async function cacheFirst(req) {
  const cached = await matchCached(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    putInCache(req, res);
    return res;
  } catch (_) {
    return cached || Response.error();
  }
}

// Keep in sync with lib/spa-routes.js SPA_PANELS.
// `widget` is a legacy alias for /settings/widgets (SW cannot import lib/).
const SPA_VIEW_PANELS = new Set([
  'chat',
  'terminal',
  'tasks',
  'agents',
  'todo',
  'browser',
  'files',
  'git',
  'github',
  'logs',
  'instances',
  'tests',
  'widget',
  'settings',
]);

function isSpaViewPath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return true;
  const parts = String(pathname || '').replace(/\/$/, '').split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return false;
  if (!SPA_VIEW_PANELS.has(parts[0])) return false;
  return parts.length === 1 || parts[0] === 'settings';
}

async function networkFirstNavigation(req, url) {
  try {
    const res = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
    putInCache(req, res);
    return res;
  } catch (_) {
    const cached = await matchCached(req);
    if (cached) return cached;
    if (url.pathname === '/login' || url.pathname.startsWith('/login')) {
      const login = await caches.match('/login.html');
      if (login) return login;
    }
    if (isSpaViewPath(url.pathname)) {
      const index = await caches.match('/index.html');
      if (index) return index;
    }
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    const index = await caches.match('/index.html');
    return index || Response.error();
  }
}

async function networkFirstAsset(req) {
  try {
    const res = await fetch(req);
    putInCache(req, res);
    return res;
  } catch (_) {
    const cached = await matchCached(req);
    return cached || Response.error();
  }
}

function isWidgetNavigation(url) {
  if (url.pathname.startsWith('/widget-authorize/')) return true;
  if (/^\/embed\/[^/]+$/.test(url.pathname)) return true;
  if (url.pathname === '/login' && url.searchParams.get('widgetAuth') === '1') return true;
  return false;
}

// Browser preview frames must never enter the offline cache: a screencast blob
// or a fallback screenshot is the live content of somebody's browsing session,
// and an exact URL is not even stable (the live channel is /ws-browser, the pull
// frames are per-session files under /api/browser/). Named explicitly so a future
// widening of the generic `/api/` and `/ws` bypass below cannot silently start
// caching page content.
function isBrowserFramePath(pathname) {
  const text = String(pathname || '');
  if (text === '/ws-browser' || text.startsWith('/ws-browser/')) return true;
  return text.startsWith('/api/browser/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isBrowserFramePath(url.pathname)) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  // HMR EventSource and hot-update chunks must not go through cache/timeout —
  // a PWA worker would otherwise swallow webpack rebuilds.
  if (url.pathname === '/__webpack_hmr' || url.pathname.startsWith('/__webpack_hmr')) return;
  if (url.pathname.includes('.hot-update.')) return;
  if (isWidgetNavigation(url)) return;

  if (isCacheFirst(url)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirstNavigation(req, url));
    return;
  }
  event.respondWith(networkFirstAsset(req));
});

// Ask a visible page to handle the in-app signal and reply whether it actually
// did. Only a `handled: true` reply may suppress the notification vibration; a
// timeout or a page that stayed silent keeps the normal OS vibration.
function requestClientSignalHandled(client, message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 400);
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (reply) => {
        clearTimeout(timer);
        finish(!!(reply && reply.data && reply.data.handled === true));
      };
      client.postMessage(message, [channel.port2]);
    } catch (_) {
      clearTimeout(timer);
      finish(false);
    }
  });
}

// --- Push notifications ---
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    try {
      payload = { body: event.data ? event.data.text() : '' };
    } catch (_) {
      payload = {};
    }
  }
  const title = String(payload.title || 'Cretli');
  const tag = String(payload.tag || 'cretli');
  const optionsPolicy = self.cretliPushOptions;
  const persistInbox = (async () => {
    if (!self.cretliPushInbox) return;
    // A fire-test notification is not a real event and must not touch the inbox.
    if (optionsPolicy && !optionsPolicy.shouldPersistPushPayload(payload)) return;
    // Persist unconditionally: the write is cheap and the app-side freshness
    // watermark (never the SW) decides whether the record is still relevant.
    await self.cretliPushInbox.persistPushPayload(payload).catch(() => undefined);
  })();
  // When a Cretli window is visible it plays the in-app signal itself, so the
  // SW delegates the event and suppresses the OS notification vibration. This
  // keeps a single event from producing two vibrations (app + notification).
  const delegateToVisibleClient = (async () => {
    const signalPolicy = self.cretliInAppSignal;
    if (!signalPolicy || !self.clients) return null;
    try {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const decision = signalPolicy.resolveClientSignal({
        payload,
        clients: windows.map((client) => ({
          url: client.url,
          visibilityState: client.visibilityState,
          focused: client.focused,
        })),
      });
      if (!decision.post) return decision;
      const client = windows[decision.clientIndex];
      if (!client || typeof client.postMessage !== 'function') {
        return { ...decision, post: false, suppressVibrate: false, reason: 'no-postable-client' };
      }
      const handled = await requestClientSignalHandled(
        client,
        signalPolicy.buildClientMessage(payload)
      );
      // Keep the OS vibration unless the page confirmed it played the signal.
      return { ...decision, suppressVibrate: !!handled, handled: !!handled };
    } catch (_) {
      return null;
    }
  })();
  const showNotification = (async () => {
    const quietPolicy = self.cretliQuietHours;
    let suppressDeviceVibrate = false;
    if (quietPolicy) {
      try {
        const quietRaw = await readDevicePreference(PREF_QUIET_KEY);
        const muteRaw = await readDevicePreference(PREF_MUTED_CHATS_KEY);
        const quietActive = quietPolicy.isQuietHoursActive(new Date(), quietRaw);
        const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : {};
        const pushChatId = typeof data.chatId === 'string' ? data.chatId.trim() : '';
        const chatMuted = pushChatId && quietPolicy.isChatMuted(muteRaw, pushChatId);
        suppressDeviceVibrate = !!(quietActive || chatMuted);
      } catch (_) {
        suppressDeviceVibrate = false;
      }
    }
    // renotify only when `data.eventId` is new. Without an eventId keep the
    // historical always-renotify behaviour.
    let renotify = true;
    if (optionsPolicy && optionsPolicy.hasPushEventId(payload)) {
      try {
        const existing = await self.registration.getNotifications({ tag });
        renotify = optionsPolicy.resolvePushRenotify(payload, existing);
      } catch (_) {
        renotify = true;
      }
    }
    const options = {
      body: String(payload.body || ''),
      icon: '/icons/icon-192.png',
      badge: '/icons/monochrome-512.png',
      tag,
      renotify,
      data: payload.data || {},
    };
    if (optionsPolicy) {
      const clientSignal = await delegateToVisibleClient;
      if (clientSignal && clientSignal.suppressVibrate) {
        // The visible page will signal; keep the notification silent.
        options.silent = true;
      } else if (optionsPolicy.resolvePushSilent(payload)) {
        // silent: true => no vibration at all.
        options.silent = true;
      } else if (suppressDeviceVibrate) {
        // Device quiet hours / muted chat: the notification stays visible (we
        // still call showNotification), but both vibration and the OS sound are
        // suppressed. `silent` is a NotificationOption here, not an invisible
        // push.
        options.silent = true;
      } else {
        const vibrate = optionsPolicy.resolvePushVibrate(payload);
        // An empty pattern (explicit `vibrate: []`) means "do not vibrate".
        if (Array.isArray(vibrate) && vibrate.length > 0) options.vibrate = vibrate;
      }
    } else {
      // Helper script failed to load. Keep the historical pattern unless the
      // device is in quiet hours / the chat is muted, in which case stay visible
      // but silent.
      if (suppressDeviceVibrate) options.silent = true;
      else options.vibrate = [80, 40, 80];
    }
    await self.registration.showNotification(title, options);
  })();
  event.waitUntil(Promise.all([showNotification, persistInbox]));
});

// A notification click must not reload an already-open PWA: postMessage lets the
// app switch chats through its SPA router and resume the socket in place. Only
// non-app windows (login/offline) or a missing window fall back to navigate/open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.url || '/';
  const policy = self.cretliNotificationClickPolicy;
  const dataChatId = typeof data.chatId === 'string' ? data.chatId.trim() : '';
  // Agent-finished pushes carry only a url with the chat id as a query param.
  const chatId = dataChatId || (policy ? policy.readChatIdFromUrl(targetUrl, self.location.origin) : '');
  const focusOrOpen = async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    const clientInfos = allClients.map((client) => ({
      url: client.url,
      canFocus: 'focus' in client,
      canPostMessage: typeof client.postMessage === 'function',
      canNavigate: 'navigate' in client,
    }));
    const decision = policy
      ? policy.resolveNotificationClickAction({
          clients: clientInfos,
          targetUrl,
          chatId,
          origin: self.location.origin,
        })
      : (() => {
          // Policy script unavailable: keep the old focus/navigate behaviour.
          const sameOriginIndex = allClients.findIndex(
            (client) =>
              typeof client.url === 'string' && client.url.startsWith(self.location.origin)
          );
          return sameOriginIndex >= 0
            ? { action: 'navigate', clientIndex: sameOriginIndex, url: targetUrl }
            : { action: 'openWindow', clientIndex: -1, url: targetUrl };
        })();
    if (decision.action === 'postMessage') {
      const client = allClients[decision.clientIndex];
      if (client) {
        try {
          client.postMessage({ type: 'open-chat', chatId, url: targetUrl });
        } catch (_) {}
        if ('focus' in client) return client.focus();
        return null;
      }
    }
    if (decision.action === 'navigate') {
      const client = allClients[decision.clientIndex];
      if (client) {
        if ('navigate' in client) {
          try {
            await client.navigate(targetUrl);
          } catch (_) {}
        }
        if ('focus' in client) return client.focus();
        return null;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    return null;
  };
  event.waitUntil(focusOrOpen());
});
