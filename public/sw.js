// Service worker for Cretli PWA.
// Strategies:
//   - app shell (HTML/JS/CSS): network-first with ~3s timeout, fallback to cache
//   - icons, manifest, screenshots, fonts: cache-first (stable names)
//   - navigations (document): network-first with timeout, fallback offline.html
//   - /api/* and /ws: always bypassed (live server)
// push + notificationclick: agent-finished notifications.
//
// Bundles are requested with a ?v=<asset version> query. Cache fallbacks must
// therefore ignore the search part: after a version bump the exact URL is not in
// the cache, and a strict match would serve Response.error() for the app bundle,
// leaving the cached HTML shell without any JavaScript.

const CACHE_NAME = 'cretli-v21';
const OFFLINE_URL = '/offline.html';

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
  '/dist/app/index.css',
  '/dist/app/login.css',
  '/dist/app/vendor.bundle.js',
  '/dist/app/vendor-login.bundle.js',
  '/dist/app/index.bundle.js',
  '/dist/app/login.bundle.js',
  '/dist/app/i18n-pl.bundle.js',
];

const CACHE_FIRST_PREFIXES = ['/icons/', '/screenshots/', '/manifest.webmanifest', '/icon.svg'];
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

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
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
  const options = {
    body: String(payload.body || ''),
    icon: '/icons/icon-192.png',
    badge: '/icons/monochrome-512.png',
    tag: String(payload.tag || 'cretli'),
    renotify: true,
    data: payload.data || {},
    vibrate: [80, 40, 80],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.url || '/';
  const focusOrOpen = async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    for (const client of allClients) {
      if ('focus' in client) {
        if (data.url && 'navigate' in client) {
          try {
            await client.navigate(targetUrl);
          } catch (_) {}
        }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    return null;
  };
  event.waitUntil(focusOrOpen());
});
