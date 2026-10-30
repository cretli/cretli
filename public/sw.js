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

const CACHE_NAME = 'cretli-v31';
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

// Durable seen-occurrence store. It is deliberately independent of displayed
// notifications: a user who dismissed the first notification must not be alerted
// again when the server retries a push whose per-channel progress write failed.
const PUSH_SEEN_DB_NAME = 'cretli-push-seen';
const PUSH_SEEN_STORE_NAME = 'kv';
const PUSH_SEEN_KEY = 'received-event-ids';

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

/**
 * Opens the durable seen-push-occurrence database.
 *
 * @returns {Promise<IDBDatabase>}
 */
function openPushSeenDb() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) {
      reject(new Error('push-seen-no-indexeddb'));
      return;
    }
    let request;
    try {
      request = self.indexedDB.open(PUSH_SEEN_DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PUSH_SEEN_STORE_NAME)) {
        db.createObjectStore(PUSH_SEEN_STORE_NAME);
      }
    };
    request.onerror = () => reject(request.error || new Error('push-seen-open-failed'));
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Atomically claims an occurrence id in the durable seen-push store.
 *
 * The read, duplicate check, prune and replacement write all run inside ONE
 * `readwrite` transaction on the seen store, and the claim (including the
 * duplicate decision) resolves only on `transaction.oncomplete`. A separate
 * read transaction and write transaction would let two overlapping push
 * handlers both observe an empty list: the same occurrence could be claimed
 * twice, or two different ids could overwrite each other and lose one, making a
 * later retry of the dismissed one alert again.
 *
 * IndexedDB serializes overlapping `readwrite` transactions on the same object
 * store, so a concurrent handler must observe the claim committed by the
 * earlier transaction. Any read/write/abort error rejects the claim; the caller
 * fails open and still shows the notification.
 *
 * @param {string} eventId
 * @param {number} now epoch ms
 * @param {{
 *   prunePushEventIds: Function,
 *   recordPushEventId: Function,
 *   isDuplicatePushEventId: Function,
 *   PUSH_EVENT_ID_MAX_ENTRIES?: number,
 *   PUSH_EVENT_ID_TTL_MS?: number,
 * }} policy
 * @returns {Promise<{ duplicate: boolean, tracked: boolean }>}
 */
function claimStoredPushEventId(eventId, now, policy) {
  return openPushSeenDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(PUSH_SEEN_STORE_NAME, 'readwrite');
        } catch (error) {
          db.close();
          reject(error);
          return;
        }
        let settled = false;
        let claim = { duplicate: false, tracked: false };
        const settle = (finish, value) => {
          if (settled) return;
          settled = true;
          db.close();
          finish(value);
        };
        const abortOnError = (error) => {
          try {
            tx.abort();
          } catch (_) {}
          settle(reject, error);
        };
        tx.oncomplete = () => settle(resolve, claim);
        tx.onerror = () => settle(reject, tx.error || new Error('push-seen-claim-failed'));
        tx.onabort = () => settle(reject, tx.error || new Error('push-seen-claim-aborted'));
        const bounds = {
          maxEntries: policy.PUSH_EVENT_ID_MAX_ENTRIES,
          ttlMs: policy.PUSH_EVENT_ID_TTL_MS,
        };
        try {
          const store = tx.objectStore(PUSH_SEEN_STORE_NAME);
          const getReq = store.get(PUSH_SEEN_KEY);
          getReq.onsuccess = () => {
            try {
              const entries = policy.prunePushEventIds(
                Array.isArray(getReq.result) ? getReq.result : [],
                now,
                bounds,
              );
              if (policy.isDuplicatePushEventId(entries, eventId)) {
                claim = { duplicate: true, tracked: true };
                return;
              }
              tx.objectStore(PUSH_SEEN_STORE_NAME).put(
                policy.recordPushEventId(entries, eventId, now, bounds),
                PUSH_SEEN_KEY,
              );
              claim = { duplicate: false, tracked: true };
            } catch (error) {
              abortOnError(error);
            }
          };
          getReq.onerror = () =>
            abortOnError(getReq.error || new Error('push-seen-claim-read-failed'));
        } catch (error) {
          abortOnError(error);
        }
      }),
  );
}

// Injectable for the unit test; production falls back to IndexedDB. An injected
// store must expose an atomic `claim(eventId, now, policy)`; a read/write pair
// is not enough because overlapping handlers could duplicate a claim or lose a
// recorded occurrence id.
const pushSeenStore =
  self.cretliPushSeenStore && typeof self.cretliPushSeenStore.claim === 'function'
    ? self.cretliPushSeenStore
    : { claim: claimStoredPushEventId };

/**
 * Claims an occurrence id before the notification is shown. The id is recorded
 * durably first, so a crash right after the show (or a failed server-side
 * progress write) cannot make the next retry alert again. A missing id is never
 * claimed and a broken store fails open, so a real notification is not lost.
 *
 * @param {unknown} eventId
 * @returns {Promise<{ duplicate: boolean, tracked: boolean }>}
 */
async function claimPushEventId(eventId) {
  const policy = self.cretliPushOptions;
  const id = typeof eventId === 'string' ? eventId.trim() : '';
  if (
    !id ||
    !policy ||
    typeof policy.prunePushEventIds !== 'function' ||
    typeof policy.recordPushEventId !== 'function' ||
    typeof policy.isDuplicatePushEventId !== 'function'
  ) {
    return { duplicate: false, tracked: false };
  }
  try {
    const result = await pushSeenStore.claim(id, Date.now(), policy);
    return {
      duplicate: !!(result && result.duplicate),
      tracked: !(result && result.tracked === false),
    };
  } catch (_) {
    return { duplicate: false, tracked: false };
  }
}

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/login.html',
  '/offline.html',
  '/sw-routes.js',
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
  '/harness-icons/mistral.svg',
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

// Keep in sync with lib/spa-routes.js (the shared server/client route contract).
// The list lives in its own classic script so the offline shell and the server
// cannot drift; tests/spa-route-shell-contract.test.js compares both sides.
try {
  importScripts('/sw-routes.js');
} catch (_) {}

const SW_ROUTES = self.cretliSwRoutes || null;

function isSpaViewPath(pathname) {
  if (SW_ROUTES) return SW_ROUTES.isSpaViewPath(pathname);
  // Route script unavailable (partial install): only the bare shell is trusted.
  return pathname === '/' || pathname === '/index.html';
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
    // Renotify only when `data.eventId` is new. Without an eventId keep the
    // historical always-renotify behaviour.
    let renotify = true;
    if (optionsPolicy && optionsPolicy.hasPushEventId(payload)) {
      // Durable dedupe comes first: the server may retry a push whose delivery
      // progress write failed, and the notification the user already saw (or
      // dismissed) must not alert again. A different crossing has a different
      // eventId and still alerts.
      const claim = await claimPushEventId(optionsPolicy.readPushEventId(payload));
      if (claim.duplicate) return;
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
  // Decision-card Yes/No buttons: resolve with the single-use token carried in the encrypted payload.
  // A body tap, an unsupported action (iOS) or a failed request falls through to opening the card.
  if ((event.action === 'yes' || event.action === 'no') && data.decisionToken) {
    event.waitUntil((async () => {
      let resolved = false;
      try {
        const sub = await self.registration.pushManager.getSubscription();
        const res = await fetch('/api/decisions/resolve-by-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token: data.decisionToken, choice: event.action, endpoint: sub ? sub.endpoint : '' }),
        });
        resolved = res.ok;
      } catch (_) {}
      if (!resolved && self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })());
    return;
  }
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
