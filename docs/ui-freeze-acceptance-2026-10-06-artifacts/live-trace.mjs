/**
 * Real Chromium performance trace for the UI-freeze acceptance (leaf 5.2).
 *
 * Drives the live Cretli UI on https://127.0.0.1:3011 with a session cookie and
 * records a CDP Performance trace (DevTools timeline + V8 CPU profile + input
 * latency + JS stacks) for a scripted scenario. Raw trace and a sidecar JSON
 * with sampled metrics are written to the paths given on the command line.
 *
 * Usage:
 *   node .tmp/ui-freeze-52/live-trace.mjs <scenario> <outTrace.json> <outSidecar.json>
 *   scenario: desktop | mobile | offline
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://127.0.0.1:3011';
const HEAVY = 'f9f6294e-5491-474b-9f07-518ce257cf80';       // 509 records, max event 22 KB
const REPORT = '95deac11-2e52-4eaa-8049-e83fa0efe522';      // 2000 records incl. ~880 KB report
const LONGTURN = 'b6c301d6-6c2e-4924-a86b-8d9323186841';    // 2000 records in one run, max event ~1 MB

const scenario = process.argv[2] || 'desktop';
const outTrace = process.argv[3] || path.resolve('.tmp/ui-freeze-52/trace.json');
const outSidecar = process.argv[4] || path.resolve('.tmp/ui-freeze-52/trace-sidecar.json');

const CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-devtools.timeline.inputs',
  'devtools.timeline.frame',
  'blink.user_timing',
  'latencyInfo',
  'v8',
  'disabled-by-default-v8.cpu_profiler',
  'benchmark',
];

const cookieRaw = fs.readFileSync(path.resolve('.tmp/ui-freeze-52/cookie.txt'), 'utf8').trim();
const eq = cookieRaw.indexOf('=');
const cookie = {
  name: cookieRaw.slice(0, eq),
  value: cookieRaw.slice(eq + 1),
  domain: '127.0.0.1',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
};

const sidecar = {
  scenario,
  baseUrl: BASE,
  startedAt: new Date().toISOString(),
  viewport: null,
  steps: [],
  samples: [],
  longTasks: [],
  errors: [],
  marks: [],
};
const t0 = Date.now();
const rel = () => Math.round(Date.now() - t0);

function logStep(name, extra = {}) {
  const entry = { name, atMs: rel(), ...extra };
  sidecar.steps.push(entry);
  console.log(`[${(rel() / 1000).toFixed(2)}s] ${name}`, JSON.stringify(extra));
}

const viewport = scenario === 'mobile'
  ? { width: 390, height: 844 }
  : { width: 1920, height: 525 };

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors'],
});
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport,
  deviceScaleFactor: scenario === 'mobile' ? 2 : 1,
  isMobile: scenario === 'mobile',
  hasTouch: scenario === 'mobile',
});
sidecar.viewport = viewport;
await context.addCookies([cookie]);
const page = await context.newPage();
page.on('pageerror', (e) => sidecar.errors.push({ kind: 'pageerror', text: String(e).slice(0, 240), atMs: rel() }));
page.on('console', (m) => {
  if (m.type() === 'error') sidecar.errors.push({ kind: 'console', text: m.text().slice(0, 240), atMs: rel() });
});
await page.addInitScript(() => {
  try { localStorage.setItem('cretli-ui-freeze-diag', '1'); } catch (_) {}
  window.__lt = [];
  window.__marks = {};
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__lt.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (_) {}
});

const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');

async function cdpMetrics() {
  try {
    const m = await cdp.send('Performance.getMetrics');
    const get = (n) => (m.metrics.find((x) => x.name === n) || {}).value;
    return {
      Nodes: get('Nodes'),
      Documents: get('Documents'),
      JSEventListeners: get('JSEventListeners'),
      LayoutObjects: get('LayoutObjects'),
      JSHeapUsedSize: get('JSHeapUsedSize'),
      LayoutCount: get('LayoutCount'),
      RecalcStyleCount: get('RecalcStyleCount'),
      LayoutDuration: get('LayoutDuration'),
      RecalcStyleDuration: get('RecalcStyleDuration'),
      ScriptDuration: get('ScriptDuration'),
      TaskDuration: get('TaskDuration'),
    };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

async function domSnapshot() {
  return page.evaluate(() => {
    const stream = document.querySelector('.sdk-rich-stream');
    const active = document.querySelector('#app-sidebar .sidebar-chat-item.is-active');
    const mount = document.querySelector('.sdk-rich-chat-mount');
    const counters = (() => { try { return window.__crUiFreeze?.counters?.() || null; } catch (_) { return null; } })();
    return {
      activeChat: active?.getAttribute('data-chat-id') || null,
      cards: stream ? stream.children.length : 0,
      elements: document.getElementsByTagName('*').length,
      mountScrollHeight: mount ? mount.scrollHeight : 0,
      mountClientHeight: mount ? mount.clientHeight : 0,
      sidebarVisible: (() => { const e = document.getElementById('app-sidebar'); return e ? getComputedStyle(e).display !== 'none' : false; })(),
      archiveRows: document.querySelectorAll('.sidebar-archive-list cr-sidebar-chat-row, .sidebar-archive-list .sidebar-chat-item').length,
      archiveHeaders: document.querySelectorAll('.sidebar-archive-header').length,
      archiveListHeight: Math.round(document.querySelector('.sidebar-archive-list')?.getBoundingClientRect().height || 0),
      archiveExpanded: document.querySelector('.sidebar-archive-header')?.getAttribute('aria-expanded') || null,
      counters,
    };
  });
}

async function sample(label) {
  const [metrics, dom] = await Promise.all([cdpMetrics(), domSnapshot()]);
  const row = { label, atMs: rel(), metrics, cards: dom.cards, elements: dom.elements, activeChat: dom.activeChat, sidebarVisible: dom.sidebarVisible, archiveRows: dom.archiveRows, archiveHeaders: dom.archiveHeaders, counters: dom.counters };
  sidecar.samples.push(row);
  console.log(`[${(rel() / 1000).toFixed(2)}s] sample ${label}`, JSON.stringify({ Nodes: metrics.Nodes, listeners: metrics.JSEventListeners, cards: dom.cards, elements: dom.elements, active: dom.activeChat, archiveRows: dom.archiveRows }));
  return row;
}

async function mark(name) {
  sidecar.marks.push({ name, atMs: rel() });
  await page.evaluate((n) => performance.mark(n), name).catch(() => {});
}

async function gotoChat(chatId) {
  await page.goto(`${BASE}/chat?chat=${encodeURIComponent(chatId)}&uiFreezeDiag=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
}

async function openSidebar() {
  const visible = await page.evaluate(() => {
    const e = document.getElementById('app-sidebar');
    return e ? getComputedStyle(e).display !== 'none' : false;
  });
  if (visible) return;
  await page.locator('#header-menu-btn').first().click({ timeout: 8000 });
  await page.waitForTimeout(800);
}

async function cssFlush(ms) { await page.waitForTimeout(ms); }

async function runDesktop() {
  await mark('start');
  logStep('trace-start');
  await cdp.send('Tracing.start', { categories: CATEGORIES.join(','), transferMode: 'ReturnAsStream' });

  // A: heavy chat local+HTTP, input during replay
  await mark('A-heavy-open');
  logStep('A-heavy-open', { chat: HEAVY });
  const gotoPromise = gotoChat(HEAVY);
  await page.waitForTimeout(1300);
  const input = page.locator('#chat-panel .send-keys-input').first();
  try {
    await input.click({ timeout: 4000 });
    await input.type('trace input during replay', { delay: 35 });
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, -300);
  } catch (e) {
    sidecar.errors.push({ kind: 'input', text: String(e).slice(0, 200), atMs: rel() });
  }
  await gotoPromise;
  await cssFlush(6500);
  await sample('A-after-heavy');
  await mark('A-heavy-done');

  // B: history scroll up (older prepend) — scroller is .sdk-rich-chat-mount
  await mark('B-scroll');
  logStep('B-scroll-top');
  await page.evaluate(() => { const m = document.querySelector('.sdk-rich-chat-mount'); if (m) m.scrollTop = 0; });
  await cssFlush(1600);
  await page.evaluate(() => { const m = document.querySelector('.sdk-rich-chat-mount'); if (m) m.scrollTop = m.scrollHeight; });
  await cssFlush(1400);
  await sample('B-after-scroll');
  await mark('B-done');

  // C: sidebar open + pin
  await mark('C-sidebar');
  logStep('C-sidebar-open');
  await openSidebar();
  await cssFlush(900);
  await page.locator('#sidebar-pin-btn').first().click({ timeout: 8000 }).catch((e) => sidecar.errors.push({ kind: 'pin', text: String(e).slice(0, 160), atMs: rel() }));
  await cssFlush(1200);
  await sample('C-after-sidebar-pin');
  await mark('C-done');

  // D: rapid chat switch A -> B -> A
  await mark('D-switch');
  logStep('D-rapid-switch');
  let other = null;
  for (const item of await page.locator('#app-sidebar .sidebar-chat-item[data-chat-id]').all()) {
    const id = await item.getAttribute('data-chat-id');
    if (id && id !== HEAVY && await item.isVisible().catch(() => false)) { other = id; break; }
  }
  logStep('D-other-chat', { other });
  if (other) {
    await page.locator(`#app-sidebar .sidebar-chat-item[data-chat-id="${other}"]`).first().click({ timeout: 6000 }).catch((e) => sidecar.errors.push({ kind: 'switch', text: String(e).slice(0, 160), atMs: rel() }));
    await page.waitForTimeout(400);
  }
  await page.locator(`#app-sidebar .sidebar-chat-item[data-chat-id="${HEAVY}"]`).first().click({ timeout: 6000 }).catch((e) => sidecar.errors.push({ kind: 'switch-back', text: String(e).slice(0, 160), atMs: rel() }));
  await cssFlush(2600);
  await sample('D-after-switch');
  await mark('D-done');

  // E: panel switch chat -> terminal -> chat
  await mark('E-panel');
  logStep('E-panel-switch');
  await page.locator('.tab[data-panel="terminal"]').click({ timeout: 6000 }).catch((e) => sidecar.errors.push({ kind: 'panel', text: String(e).slice(0, 160), atMs: rel() }));
  await cssFlush(1400);
  await page.locator('.tab[data-panel="chat"]').click({ timeout: 6000 }).catch((e) => sidecar.errors.push({ kind: 'panel-back', text: String(e).slice(0, 160), atMs: rel() }));
  await cssFlush(1600);
  await sample('E-after-panel');
  await mark('E-done');

  // F: 800 KB report chat in delegation/mailbox
  await mark('F-report');
  logStep('F-report-open', { chat: REPORT });
  await gotoChat(REPORT);
  await cssFlush(5200);
  await page.locator('cr-delegation-card, .delegation-card, [data-delegation-id]').first().scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  await cssFlush(1200);
  await sample('F-after-report');
  await mark('F-done');

  // G: long single turn
  await mark('G-longturn');
  logStep('G-longturn-open', { chat: LONGTURN });
  await gotoChat(LONGTURN);
  await cssFlush(7500);
  await sample('G-after-longturn');
  await mark('G-done');

  // H: archive section open
  await mark('H-archive');
  logStep('H-archive-open');
  await openSidebar();
  await cssFlush(600);
  const arch = page.locator('.sidebar-archive-header').first();
  if (await arch.count()) {
    await arch.scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
    await arch.click({ timeout: 6000 }).catch((e) => sidecar.errors.push({ kind: 'archive', text: String(e).slice(0, 160), atMs: rel() }));
  } else {
    sidecar.errors.push({ kind: 'archive', text: 'no .sidebar-archive-header', atMs: rel() });
  }
  await cssFlush(2600);
  await sample('H-after-archive');
  await mark('H-done');

  await cssFlush(600);
}

async function runMobile() {
  await mark('start');
  logStep('trace-start');
  await cdp.send('Tracing.start', { categories: CATEGORIES.join(','), transferMode: 'ReturnAsStream' });

  await mark('A-heavy-open');
  logStep('A-heavy-open', { chat: HEAVY });
  const gotoPromise = gotoChat(HEAVY);
  await page.waitForTimeout(1300);
  try {
    const input = page.locator('#chat-panel .send-keys-input').first();
    await input.click({ timeout: 4000 });
    await input.type('mobile trace input', { delay: 35 });
  } catch (e) {
    sidecar.errors.push({ kind: 'input', text: String(e).slice(0, 200), atMs: rel() });
  }
  await gotoPromise;
  await cssFlush(6000);
  await sample('A-after-heavy');
  await mark('A-done');

  await mark('C-sidebar');
  logStep('C-sidebar-open');
  await openSidebar();
  await cssFlush(900);
  await page.locator('#sidebar-pin-btn').first().click({ timeout: 8000 }).catch((e) => sidecar.errors.push({ kind: 'pin', text: String(e).slice(0, 160), atMs: rel() }));
  await cssFlush(1200);
  await sample('C-after-sidebar-pin');
  await mark('C-done');

  await mark('E-panel');
  logStep('E-panel-switch');
  await page.locator('.tab[data-panel="terminal"]').click({ timeout: 6000 }).catch((e) => sidecar.errors.push({ kind: 'panel', text: String(e).slice(0, 160), atMs: rel() }));
  await cssFlush(1400);
  await page.locator('.tab[data-panel="chat"]').click({ timeout: 6000 }).catch((e) => sidecar.errors.push({ kind: 'panel-back', text: String(e).slice(0, 160), atMs: rel() }));
  await cssFlush(1600);
  await sample('E-after-panel');
  await mark('E-done');

  await mark('F-report');
  logStep('F-report-open', { chat: REPORT });
  await gotoChat(REPORT);
  await cssFlush(5200);
  await sample('F-after-report');
  await mark('F-done');

  await cssFlush(600);
}

async function runOffline() {
  // Warm caches online first.
  logStep('warm-online');
  await gotoChat(HEAVY);
  await cssFlush(7000);
  const sw = await page.evaluate(async () => {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    return { count: regs.length, controller: !!navigator.serviceWorker?.controller };
  });
  logStep('service-worker', sw);
  await mark('start');
  logStep('trace-start-offline');
  await cdp.send('Tracing.start', { categories: CATEGORIES.join(','), transferMode: 'ReturnAsStream' });
  await context.setOffline(true);
  await mark('offline-reload');
  logStep('offline-reload', { chat: HEAVY });
  await gotoChat(HEAVY).catch((e) => sidecar.errors.push({ kind: 'offline-goto', text: String(e).slice(0, 200), atMs: rel() }));
  await cssFlush(9000);
  const offlineInfo = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    hasChatPanel: !!document.getElementById('chat-panel'),
    hasAppSidebar: !!document.getElementById('app-sidebar'),
    bodyTextLen: (document.body?.innerText || '').length,
    paints: performance.getEntriesByType('paint').map((p) => ({ name: p.name, startTime: Math.round(p.startTime) })),
    navType: performance.getEntriesByType('navigation').map((n) => n.type),
    resources: performance.getEntriesByType('resource').length,
  })).catch((e) => ({ error: String(e).slice(0, 200) }));
  logStep('offline-info', offlineInfo);
  await sample('offline-after-reload');
  await mark('offline-done');
  await context.setOffline(false);
}

async function runArchive() {
  await mark('start');
  logStep('trace-start');
  logStep('archive-base-open');
  await page.goto(`${BASE}/chat?uiFreezeDiag=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await cssFlush(4000);
  await openSidebar();
  await cssFlush(800);
  const before = await page.evaluate(() => {
    const h = document.querySelector('.sidebar-archive-header');
    const grp = document.querySelector('.sidebar-archive-group');
    return {
      header: h ? (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null,
      sidebarKey: grp ? grp.getAttribute('data-sidebar-key') : null,
      archiveRows: document.querySelectorAll('.sidebar-archive-list cr-sidebar-chat-row, .sidebar-archive-list .sidebar-chat-item').length,
      openSections: (() => { try { return localStorage.getItem('cretli-sidebar-archive-open'); } catch (_) { return null; } })(),
    };
  });
  logStep('archive-before', before);
  await cdp.send('Tracing.start', { categories: CATEGORIES.join(','), transferMode: 'ReturnAsStream' });
  await mark('archive-open-click');
  await page.locator('.sidebar-archive-header').first().scrollIntoViewIfNeeded({ timeout: 6000 }).catch(() => {});
  await page.locator('.sidebar-archive-header').first().click({ timeout: 6000 }).catch((e) => sidecar.errors.push({ kind: 'archive', text: String(e).slice(0, 160), atMs: rel() }));
  await cssFlush(2600);
  await sample('archive-after-open');
  const after = await page.evaluate(() => ({
    archiveRows: document.querySelectorAll('.sidebar-archive-list cr-sidebar-chat-row, .sidebar-archive-list .sidebar-chat-item').length,
    listHeight: document.querySelector('.sidebar-archive-list')?.getBoundingClientRect().height || 0,
    openSections: (() => { try { return localStorage.getItem('cretli-sidebar-archive-open'); } catch (_) { return null; } })(),
    virtualSpacers: document.querySelectorAll('.sidebar-archive-virtual-spacer').length,
  }));
  logStep('archive-after', after);
  if (after.archiveRows === 0) {
    await page.locator('.sidebar-archive-header').first().click({ timeout: 6000 }).catch(() => {});
    await cssFlush(2600);
    await sample('archive-after-reclick');
    const after2 = await page.evaluate(() => ({
      archiveRows: document.querySelectorAll('.sidebar-archive-list cr-sidebar-chat-row, .sidebar-archive-list .sidebar-chat-item').length,
      openSections: (() => { try { return localStorage.getItem('cretli-sidebar-archive-open'); } catch (_) { return null; } })(),
    }));
    logStep('archive-after-reclick', after2);
  }
  await mark('archive-done');
}

if (scenario === 'desktop') await runDesktop();
else if (scenario === 'mobile') await runMobile();
else if (scenario === 'offline') await runOffline();
else if (scenario === 'archive') await runArchive();
else throw new Error('unknown scenario ' + scenario);

logStep('trace-stop');
let streamHandle = null;
const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
await cdp.send('Tracing.end');
const done = await complete;
streamHandle = done.stream || null;

sidecar.longTasks = await page.evaluate(() => window.__lt || []).catch(() => []);
sidecar.endMarkMs = rel();
sidecar.offline = await page.evaluate(() => (typeof navigator !== 'undefined' && navigator.onLine === false)).catch(() => null);

if (streamHandle) {
  const chunks = [];
  for (;;) {
    const r = await cdp.send('IO.read', { handle: streamHandle, size: 16 * 1024 * 1024 });
    chunks.push(r.data);
    if (r.eof) break;
  }
  await cdp.send('IO.close', { handle: streamHandle }).catch(() => {});
  fs.writeFileSync(outTrace, chunks.join(''));
} else {
  sidecar.errors.push({ kind: 'trace', text: 'no stream handle from Tracing.tracingComplete', atMs: rel() });
}

fs.writeFileSync(outSidecar, JSON.stringify(sidecar, null, 1));
console.log('TRACE', outTrace, 'bytes', fs.existsSync(outTrace) ? fs.statSync(outTrace).size : 0);
console.log('SIDECAR', outSidecar);
await browser.close();
