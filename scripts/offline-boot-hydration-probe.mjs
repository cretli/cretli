/**
 * Repeatable offline cold-start hydration probe (todo 1a336b36).
 *
 * Scenario:
 *   1. online: open ?chat=<id> twice, wait until the requested chat hydrates (cards > 0);
 *   2. snapshot SW / CacheStorage / IndexedDB / localStorage state;
 *   3. context.setOffline(true) and reload the same URL;
 *   4. collect requests, console/pageerror, cards timeline, FCP and the time from
 *      navigation start to cards > 0;
 *   5. write raw JSON + a readable log, exit non-zero when the chat did not hydrate.
 *
 * Usage:
 *   node scripts/offline-boot-hydration-probe.mjs [chatId] [outBase]
 * Env:
 *   CRETLI_BASE_URL           default https://127.0.0.1:3011
 *   CRETLI_COOKIE_FILE        default .tmp/ui-freeze-52/cookie.txt
 *   CRETLI_CHAT_ID            overrides argv[2]
 *   CRETLI_OFFLINE_TIMEOUT_MS default 25000
 *   CRETLI_ONLINE_TIMEOUT_MS  default 30000
 *   CRETLI_SAMPLE_INTERVAL_MS default 250
 *   CRETLI_SETTLE_MS          default 3000
 *   CRETLI_CLEAR_SYNC_BEFORE_OFFLINE=1  drop the localStorage sync doc before the offline
 *                                       reload to exercise the IDB -> sync seed fallback
 *   CRETLI_PROBE_NON_ACTIVE=1           exercise a requested chat that is NOT the active one:
 *                                       warm `?chat=<id>`, then open a different chat so the
 *                                       snapshot's activeChatId differs, then reload offline on
 *                                       `?chat=<id>`. Combine with CLEAR_SYNC to force the
 *                                       IDB seed + `preferChatId` path.
 *
 * Read-only against the running server: it uses an existing session cookie and never
 * mutates data/ directly. It does require a running Cretli server and the session cookie.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.CRETLI_BASE_URL || 'https://127.0.0.1:3011').replace(/\/$/, '');
const CHAT = process.env.CRETLI_CHAT_ID || process.argv[2] || 'c84b5a31-2091-4061-ae3f-2f59cec4703f';
const COOKIE_FILE = process.env.CRETLI_COOKIE_FILE || '.tmp/ui-freeze-52/cookie.txt';
const OUT_BASE = process.argv[3] || '.tmp/offline-hydration/offline-boot-hydration';
const ONLINE_TIMEOUT_MS = Number(process.env.CRETLI_ONLINE_TIMEOUT_MS || 30000);
const OFFLINE_TIMEOUT_MS = Number(process.env.CRETLI_OFFLINE_TIMEOUT_MS || 25000);
const SAMPLE_INTERVAL_MS = Number(process.env.CRETLI_SAMPLE_INTERVAL_MS || 250);
const SETTLE_MS = Number(process.env.CRETLI_SETTLE_MS || 3000);
const CLEAR_SYNC_BEFORE_OFFLINE = process.env.CRETLI_CLEAR_SYNC_BEFORE_OFFLINE === '1';
const PROBE_NON_ACTIVE = process.env.CRETLI_PROBE_NON_ACTIVE === '1';

const JSON_OUT = `${OUT_BASE}.json`;
const LOG_OUT = `${OUT_BASE}.log`;
const CHAT_URL = `${BASE}/chat?chat=${encodeURIComponent(CHAT)}`;

const runStart = Date.now();
const logLines = [];
function log(line) {
  const stamped = `[${((Date.now() - runStart) / 1000).toFixed(2)}s] ${line}`;
  logLines.push(stamped);
  console.log(stamped);
}

const result = {
  chat: CHAT,
  url: CHAT_URL,
  base: BASE,
  cookieFile: COOKIE_FILE,
  startedAt: new Date().toISOString(),
  steps: [],
  online: { samples: [], requests: [], errors: [], console: [] },
  offline: { samples: [], requests: [], errors: [], console: [] },
  storageOnline: null,
  storageOffline: null,
  syncClearedBeforeOffline: 0,
  nonActiveProbe: PROBE_NON_ACTIVE,
  nonActiveOther: null,
  nonActiveActiveChat: null,
  requestedDiffersFromActiveOnline: null,
  requestedOutsideSyncWindow: null,
  onlineSidebarItems: null,
  hydration: null,
  finalDom: null,
  fcpMs: null,
  navigatorOnLineOnline: null,
  navigatorOnLineOffline: null,
  verdict: 'FAIL',
  failReason: null,
};

/** Phase switch for the shared page listeners. */
let phase = 'online';
const sink = () => result[phase];

function step(name, extra = {}) {
  const entry = { name, atMs: Date.now() - runStart, ...extra };
  result.steps.push(entry);
  log(`STEP ${name}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}`);
  return entry;
}

function readCookie() {
  if (!fs.existsSync(COOKIE_FILE)) throw new Error(`missing session cookie file: ${COOKIE_FILE}`);
  const raw = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new Error(`malformed cookie file: ${COOKIE_FILE}`);
  const host = new URL(BASE).hostname;
  return {
    name: raw.slice(0, eq).trim(),
    value: raw.slice(eq + 1).trim(),
    domain: host,
    path: '/',
    secure: BASE.startsWith('https'),
    httpOnly: true,
    sameSite: 'Lax',
  };
}

async function dom(page) {
  return page
    .evaluate(() => {
      const stream = document.querySelector('.sdk-rich-stream');
      const active = document.querySelector('#app-sidebar .sidebar-chat-item.is-active');
      return {
        url: location.href,
        title: document.title,
        cards: stream ? stream.children.length : 0,
        activeChat: active?.getAttribute('data-chat-id') || null,
        hasChatPanel: !!document.getElementById('chat-panel'),
        overlayVisible: !!document.getElementById('cr-backend-unavailable'),
        bodyTextLen: (document.body?.innerText || '').length,
        sidebarItems: document.querySelectorAll('#app-sidebar .sidebar-chat-item').length,
        navigatorOnLine: typeof navigator !== 'undefined' ? navigator.onLine : null,
        paints: performance
          .getEntriesByType('paint')
          .map((p) => ({ name: p.name, t: Math.round(p.startTime) })),
      };
    })
    .catch((e) => ({ error: String(e).slice(0, 200) }));
}

async function storageState(page) {
  return page
    .evaluate(async (requestedChatId) => {
      const out = { sw: null, caches: null, idb: null, lsKeys: null, bootSync: null };
      try {
        const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
        out.sw = {
          count: regs.length,
          controller: !!navigator.serviceWorker?.controller,
          scopes: regs.map((r) => r.scope),
        };
      } catch (e) {
        out.sw = { error: String(e).slice(0, 120) };
      }
      try {
        const names = await caches.keys();
        const detail = {};
        let total = 0;
        for (const n of names) {
          const c = await caches.open(n);
          const keys = await c.keys();
          total += keys.length;
          detail[n] = { count: keys.length, urls: keys.map((r) => r.url).slice(0, 60) };
        }
        out.caches = { names, totalEntries: total, detail };
      } catch (e) {
        out.caches = { error: String(e).slice(0, 120) };
      }
      try {
        if (indexedDB.databases) out.idb = (await indexedDB.databases()).map((d) => d.name);
      } catch (e) {
        out.idb = { error: String(e).slice(0, 120) };
      }
      try {
        out.lsKeys = Object.keys(localStorage).filter((k) => k.startsWith('cretli'));
        const boot = localStorage.getItem('cretli-chat-boot-sync-v1');
        if (boot) {
          let parsed = null;
          try {
            parsed = JSON.parse(boot);
          } catch (_) {}
          const chats = Array.isArray(parsed?.chats) ? parsed.chats : [];
          out.bootSync = {
            rawLength: boot.length,
            activeChatId: parsed?.activeChatId ?? null,
            chatCount: chats.length,
            chatIds: chats.map((row) => row?.id).filter(Boolean).slice(0, 80),
            hasRequestedChat: chats.some((row) => row?.id === requestedChatId),
          };
        }
      } catch (e) {
        out.lsKeys = { error: String(e).slice(0, 120) };
      }
      try {
        const dbs = indexedDB.databases ? await indexedDB.databases() : [];
        if (dbs.some((d) => d.name === 'cretli-chat-metadata')) {
          const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('cretli-chat-metadata');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const row = await new Promise((resolve, reject) => {
            const req = db.transaction('meta', 'readonly').objectStore('meta').get('cretli-chat-boot-cache-v1');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          db.close();
          const raw = row && typeof row.value === 'string' ? row.value : '';
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch (_) {}
          const chats = Array.isArray(parsed?.chats) ? parsed.chats : [];
          out.idbBootCache = {
            rawLength: raw.length,
            activeChatId: parsed?.activeChatId ?? null,
            chatCount: chats.length,
            chatIds: chats.map((r) => r?.id).filter(Boolean).slice(0, 80),
            hasRequestedChat: chats.some((r) => r?.id === requestedChatId),
          };
        }
      } catch (e) {
        out.idbBootCache = { error: String(e).slice(0, 120) };
      }
      return out;
    }, CHAT)
    .catch((e) => ({ error: String(e).slice(0, 200) }));
}

function attachListeners(page) {
  page.on('request', (req) => {
    sink().requests.push({
      event: 'request',
      atMs: Date.now() - runStart,
      method: req.method(),
      url: req.url().slice(0, 300),
      resourceType: req.resourceType(),
    });
  });
  page.on('response', (res) => {
    sink().requests.push({
      event: 'response',
      atMs: Date.now() - runStart,
      status: res.status(),
      url: res.url().slice(0, 300),
    });
  });
  page.on('requestfailed', (req) => {
    sink().requests.push({
      event: 'requestfailed',
      atMs: Date.now() - runStart,
      method: req.method(),
      url: req.url().slice(0, 300),
      errorText: req.failure()?.errorText || null,
    });
  });
  page.on('pageerror', (e) => {
    sink().errors.push({
      kind: 'pageerror',
      atMs: Date.now() - runStart,
      text: String(e).slice(0, 400),
      stack: String(e?.stack || '').split('\n').slice(0, 6).join(' | ').slice(0, 600),
    });
  });
  page.on('console', (m) => {
    const entry = { atMs: Date.now() - runStart, type: m.type(), text: m.text().slice(0, 400) };
    sink().console.push(entry);
    if (m.type() === 'error') sink().errors.push({ kind: 'console', ...entry });
  });
}

function assertIdbSnapshotDidNotShrink(onlineStorage, offlineStorage) {
  const online = onlineStorage?.idbBootCache;
  const offline = offlineStorage?.idbBootCache;
  if (!online || online.error || !offline || offline.error) {
    return 'missing idbBootCache snapshot in online or offline storage probe';
  }
  if (offline.chatCount < online.chatCount) {
    return `IDB boot snapshot shrank: online chatCount=${online.chatCount} offline=${offline.chatCount}`;
  }
  if (offline.rawLength < online.rawLength) {
    return `IDB boot snapshot shrank: online rawLength=${online.rawLength} offline=${offline.rawLength}`;
  }
  return null;
}

function summarizeRequests(requests) {
  const response = requests.filter((r) => r.event === 'response');
  const failed = requests.filter((r) => r.event === 'requestfailed');
  const apiFailed = failed.filter((r) => /\/api\//.test(r.url));
  return {
    total: requests.length,
    responses: response.length,
    failures: failed.length,
    apiFailures: apiFailed.length,
    failedDetail: failed.map((r) => ({ url: r.url, errorText: r.errorText })),
    responseStatuses: response.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {}),
  };
}

async function waitForHydration(page, timeoutMs, samples, label, startedAt = Date.now(), targetId = CHAT) {
  const deadline = startedAt + timeoutMs;
  let hydrated = null;
  while (Date.now() < deadline) {
    const d = await dom(page);
    samples.push({ atMs: Date.now() - runStart, sinceNavMs: Date.now() - startedAt, ...d });
    if (d.cards > 0 && !hydrated) {
      hydrated = { sinceNavMs: Date.now() - startedAt, cards: d.cards, activeChat: d.activeChat, overlayVisible: d.overlayVisible };
      if (d.activeChat === targetId) break;
    }
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }
  log(`${label} hydration=${JSON.stringify(hydrated)}`);
  return hydrated;
}

// ---------------------------------------------------------------------------

let browser;
try {
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  const cookie = readCookie();

  browser = await chromium.launch({
    executablePath: process.env.CRETLI_CHROMIUM || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  await context.addCookies([cookie]);
  const page = await context.newPage();
  attachListeners(page);

  // 1. Warm the cache online, twice: the second load is SW-controlled and lets the
  //    chat list reconcile so the boot snapshot + IndexedDB are authoritative.
  step('warm-online-start', { url: CHAT_URL });
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const warm1 = await waitForHydration(page, ONLINE_TIMEOUT_MS, result.online.samples, 'warm-online-1');
  if (!warm1) throw new Error('online warm-up did not hydrate the requested chat (cards=0)');

  step('warm-online-reload');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  const warm2 = await waitForHydration(page, ONLINE_TIMEOUT_MS, result.online.samples, 'warm-online-2');
  if (!warm2) throw new Error('online warm reload did not hydrate the requested chat (cards=0)');

  // 1b. Non-active probe: make the requested chat differ from the snapshot's activeChatId.
  //     Warm `?chat=<requested>`, then open a *different* chat so the persisted snapshot's
  //     activeChatId is the other one; the offline reload below returns to `?chat=<requested>`.
  if (PROBE_NON_ACTIVE) {
    const preState = await storageState(page);
    // Prefer the synchronous window (recent, live rows) over the durable snapshot, which may
    // still hold stale ids; both are checked so a run with a single chat still works.
    const candidates = [
      ...(Array.isArray(preState.bootSync?.chatIds) ? preState.bootSync.chatIds : []),
      ...(Array.isArray(preState.idbBootCache?.chatIds) ? preState.idbBootCache.chatIds : []),
    ];
    const other = candidates.find((id) => typeof id === 'string' && id && id !== CHAT);
    if (!other) {
      throw new Error(`CRETLI_PROBE_NON_ACTIVE=1 but the local snapshot has no chat id other than ${CHAT}`);
    }
    result.nonActiveOther = other;
    const otherUrl = `${BASE}/chat?chat=${encodeURIComponent(other)}`;
    step('non-active-warm-other-start', { url: otherUrl });
    await page.goto(otherUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const otherWarm = await waitForHydration(
      page,
      ONLINE_TIMEOUT_MS,
      result.online.samples,
      'non-active-other',
      Date.now(),
      other,
    );
    if (!otherWarm) throw new Error(`non-active warm-up did not hydrate the other chat ${other} (cards=0)`);
    result.nonActiveActiveChat = otherWarm.activeChat;
    step('non-active-other-active', { other, activeChat: otherWarm.activeChat });
  }

  result.navigatorOnLineOnline = (await dom(page)).navigatorOnLine;
  await page.waitForTimeout(SETTLE_MS); // let the boot snapshot / IDB writes settle

  result.storageOnline = await storageState(page);
  step('storage-online', {
    sw: result.storageOnline.sw,
    caches: result.storageOnline.caches?.names,
    cacheEntries: result.storageOnline.caches?.totalEntries,
    idb: result.storageOnline.idb,
    lsKeyCount: Array.isArray(result.storageOnline.lsKeys) ? result.storageOnline.lsKeys.length : result.storageOnline.lsKeys,
    bootSync: result.storageOnline.bootSync,
    idbBootCache: result.storageOnline.idbBootCache,
  });

  if (!result.storageOnline.sw?.controller) {
    throw new Error('service worker is not controlling the page after two online loads; an offline reload would not be served');
  }
  if (!result.storageOnline.caches?.names?.length) {
    throw new Error('no CacheStorage buckets after online warm-up; nothing to serve the offline shell from');
  }
  const syncCount = result.storageOnline.bootSync?.chatCount || 0;
  const idbCount = result.storageOnline.idbBootCache?.chatCount || 0;
  const hasRequested = result.storageOnline.bootSync?.hasRequestedChat === true
    || result.storageOnline.idbBootCache?.hasRequestedChat === true;
  if (syncCount <= 0 && idbCount <= 0) {
    throw new Error('no local chat snapshot after online warm-up (localStorage sync and IDB both empty); offline hydration has no source');
  }
  if (!hasRequested) {
    throw new Error(`local chat snapshot does not contain the requested chat ${CHAT}; choose another chat`);
  }

  const activeOnline = result.storageOnline.bootSync?.activeChatId
    || result.storageOnline.idbBootCache?.activeChatId
    || null;
  result.requestedDiffersFromActiveOnline = Boolean(activeOnline && activeOnline !== CHAT);
  // Informational: is the requested chat outside the 40-row synchronous window?
  result.requestedOutsideSyncWindow = result.storageOnline.bootSync?.hasRequestedChat === false;
  if (PROBE_NON_ACTIVE) {
    if (!activeOnline) throw new Error('CRETLI_PROBE_NON_ACTIVE=1 but no activeChatId in local snapshot');
    if (activeOnline === CHAT) {
      throw new Error(
        `CRETLI_PROBE_NON_ACTIVE=1 could not make ${CHAT} non-active (snapshot activeChatId=${activeOnline})`,
      );
    }
    if (result.nonActiveOther && activeOnline !== result.nonActiveOther) {
      throw new Error(
        `CRETLI_PROBE_NON_ACTIVE=1 expected activeChatId=${result.nonActiveOther} after opening it, got ${activeOnline}`,
      );
    }
    step('non-active-chat-probe', {
      activeOnline,
      requestedChat: CHAT,
      requestedOutsideSyncWindow: result.requestedOutsideSyncWindow,
    });
  }

  const onlineDom = await dom(page);
  result.onlineSidebarItems = onlineDom.sidebarItems;
  step('online-sidebar', { sidebarItems: onlineDom.sidebarItems, activeChat: onlineDom.activeChat });
  await page.waitForTimeout(SETTLE_MS); // F6: settle durable writes before the offline reload

  // 2. Go offline and reload the same URL.
  if (CLEAR_SYNC_BEFORE_OFFLINE) {
    // Exercise the IDB -> localStorage sync seed fallback (pre-fix / IDB-only clients).
    const cleared = await page.evaluate(() => {
      const keys = ['cretli-chat-boot-sync-v1', 'cursor-remote-chat-boot-sync-v1'];
      let removed = 0;
      for (const key of keys) {
        if (localStorage.getItem(key) != null) {
          localStorage.removeItem(key);
          removed += 1;
        }
      }
      return removed;
    });
    result.syncClearedBeforeOffline = cleared;
    step('sync-cleared-before-offline', { removed: cleared });
  }
  step('offline-set');
  await context.setOffline(true);
  phase = 'offline';
  result.navigatorOnLineOffline = await page.evaluate(() => (typeof navigator !== 'undefined' ? navigator.onLine : null));
  step('navigator-online-offline', { onLine: result.navigatorOnLineOffline });

  const navStart = Date.now();
  step('offline-reload', { url: CHAT_URL });
  await page
    .goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
    .catch((e) => result.offline.errors.push({ kind: 'offline-goto', atMs: Date.now() - runStart, text: String(e).slice(0, 300) }));

  const hydration = await waitForHydration(page, OFFLINE_TIMEOUT_MS, result.offline.samples, 'offline', navStart);
  result.hydration = hydration;

  const finalDom = await dom(page);
  result.finalDom = finalDom;
  const fcp = (finalDom.paints || []).find((p) => p.name === 'first-contentful-paint');
  result.fcpMs = fcp ? fcp.t : null;
  result.offline.networkSummary = summarizeRequests(result.offline.requests);
  await page.waitForTimeout(SETTLE_MS); // F6: let the offline boot's durable writes settle
  result.storageOffline = await storageState(page);

  step('offline-done', {
    hydration,
    cards: finalDom.cards,
    activeChat: finalDom.activeChat,
    overlayVisible: finalDom.overlayVisible,
    sidebarItems: finalDom.sidebarItems,
    fcpMs: result.fcpMs,
    networkSummary: result.offline.networkSummary,
    errors: result.offline.errors.length,
  });

  // 3. Verdict.
  if (!hydration) {
    result.failReason = `requested chat did not hydrate offline (cards=0 after ${OFFLINE_TIMEOUT_MS}ms)`;
  } else if (finalDom.activeChat !== CHAT) {
    result.failReason = `chat hydrated (cards=${finalDom.cards}) but activeChat=${finalDom.activeChat} !== ${CHAT}`;
  } else if (finalDom.overlayVisible) {
    result.failReason = 'backend unavailable overlay is visible after offline boot';
  } else if (result.onlineSidebarItems > 0 && (finalDom.sidebarItems || 0) === 0) {
    result.failReason = `offline sidebar is empty although online had ${result.onlineSidebarItems} rows`;
  } else {
    const shrinkReason = assertIdbSnapshotDidNotShrink(result.storageOnline, result.storageOffline);
    if (shrinkReason) {
      result.failReason = shrinkReason;
    } else if (!result.storageOffline.bootSync?.hasRequestedChat && !result.storageOffline.idbBootCache?.hasRequestedChat) {
      result.failReason = `requested chat ${CHAT} missing from offline local snapshots after reload`;
    } else {
      result.verdict = 'PASS';
    }
  }

  await context.setOffline(false);
} catch (err) {
  result.failReason = result.failReason || String(err?.message || err);
  log(`ERROR ${result.failReason}`);
} finally {
  if (browser) await browser.close().catch(() => {});
}

result.finishedAt = new Date().toISOString();
result.durationMs = Date.now() - runStart;
fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
fs.writeFileSync(LOG_OUT, `${logLines.join('\n')}\n`);

console.log(`\nRESULT ${result.verdict}${result.failReason ? ` (${result.failReason})` : ''}`);
console.log(`raw JSON: ${JSON_OUT}`);
console.log(`log:      ${LOG_OUT}`);
process.exit(result.verdict === 'PASS' ? 0 : 2);
