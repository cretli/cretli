/**
 * Stage 4.2 — mounted history window eviction, parking, scroll restore contracts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

import { createChatHistoryReplayGenerationGate } from '../app_front/lib/chatHistoryReplayGenerationGate.js';
import {
  clearHistoryMountedParking,
  getHistoryOlderLocal,
  getHistoryParkedNewerLocal,
  prependHistoryOlderLocal,
  prependHistoryParkedNewerLocal,
  removeHistoryRecordFromMountedParking,
  takeHistoryParkedNewerLocal,
  takeOlderHistoryPageFromLocalCache,
} from '../app_front/features/chat/chatHistoryMountedParking.js';
import {
  countConnectedAndDetachedNodes,
  countMountedStreamCards,
  countMountedWindowExcess,
  createMountedDomNodeRegistry,
  createMountedHistoryRecordRegistry,
  createMountedViewResourceLedger,
  isMountedHistoryRecordApplied,
  isMountedViewOrderKeyApplied,
  mergeParkedHistoryRecords,
  parkMountedCardRecords,
  planMountedWindowEviction,
  releaseEvictedMountedCard,
  resolveMountedEvictionEdge,
} from '../app_front/lib/sdkHistoryMountedWindow.js';
import { UI_FREEZE_CHAT_MOUNTED_RECORD_CAP } from '../app_front/lib/uiFreezeRenderBudgets.js';
import { UI_FREEZE_DELEGATION_EXPAND_MAX_DOM_PAGES } from '../app_front/lib/delegationHistoryCardReport.js';
import { readServedModule } from './helpers/serve-ts-module.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('plan eviction respects cap and edge', () => {
  assert.equal(countMountedWindowExcess(79, 80), 0);
  assert.equal(countMountedWindowExcess(81, 80), 1);
  assert.deepEqual(
    planMountedWindowEviction({ mountedCount: 120, cap: 80, evictFrom: 'tail' }),
    { evictCount: 40, evictFrom: 'tail' },
  );
  assert.equal(resolveMountedEvictionEdge({ stickToBottom: false }), 'tail');
  assert.equal(resolveMountedEvictionEdge({ stickToBottom: true }), 'head');
  assert.equal(resolveMountedEvictionEdge({ isLoadingOlderHistory: true }), 'tail');
});

test('registry dedupe survives DOM eviction (identity not forgotten)', () => {
  const registry = createMountedHistoryRecordRegistry();
  const ledger = createMountedViewResourceLedger();
  const nodeRegistry = createMountedDomNodeRegistry();
  const record = { kind: 'sdk', historySeq: 42, event: { type: 'assistant' } };
  registry.note(record);
  const card = {
    isConnected: true,
    remove() {
      this.isConnected = false;
    },
    querySelectorAll() {
      return [];
    },
  };
  /** @type {HTMLElement} */
  const cardEl = /** @type {any} */ (card);
  cardEl.dataset = { historySeq: '42' };
  registry.markParkedRecord(record);
  releaseEvictedMountedCard(cardEl, ledger, nodeRegistry);
  assert.equal(isMountedHistoryRecordApplied(record, registry), true);
  assert.equal(isMountedViewOrderKeyApplied({ historySeq: 42 }, registry), false);
  assert.equal(card.isConnected, false);
});

test('live re-apply skips mounted keys; parked keys stay in registry until remount', () => {
  const registry = createMountedHistoryRecordRegistry();
  const incomingKey = { historySeq: 7, roomEventSeq: 0, eventStreamId: '' };
  registry.note({ historySeq: 7 });
  assert.equal(isMountedViewOrderKeyApplied(incomingKey, registry), true);
  registry.markParked('h:7');
  assert.equal(isMountedHistoryRecordApplied({ historySeq: 7 }, registry), true);
  assert.equal(isMountedViewOrderKeyApplied(incomingKey, registry), false);
});

test('removeHistoryRecordFromMountedParking drops clones by order key', () => {
  const chat = {};
  prependHistoryParkedNewerLocal(chat, [{ historySeq: 9 }, { historySeq: 10 }]);
  prependHistoryOlderLocal(chat, [{ historySeq: 1 }, { historySeq: 9 }]);
  removeHistoryRecordFromMountedParking(chat, { historySeq: 9 });
  assert.deepEqual(getHistoryParkedNewerLocal(chat).map((r) => r.historySeq), [10]);
  assert.deepEqual(getHistoryOlderLocal(chat).map((r) => r.historySeq), [1]);
});

test('parking merges chronological records without duplicates', () => {
  const chat = {};
  prependHistoryOlderLocal(chat, [{ historySeq: 10 }, { historySeq: 11 }]);
  prependHistoryOlderLocal(chat, [{ historySeq: 9 }]);
  assert.deepEqual(getHistoryOlderLocal(chat).map((row) => row.historySeq), [9, 10, 11]);
  prependHistoryParkedNewerLocal(chat, [{ historySeq: 50 }, { historySeq: 51 }]);
  const restored = takeHistoryParkedNewerLocal(chat, 2);
  assert.deepEqual(restored.map((row) => row.historySeq), [50, 51]);
  assert.equal(getHistoryParkedNewerLocal(chat).length, 0);
  clearHistoryMountedParking(chat);
  assert.equal(getHistoryParkedNewerLocal(chat).length, 0);
});

test('head eviction + older-page slice matches chat.js cache semantics', () => {
  const chat = {};
  const pageSize = 3;
  prependHistoryOlderLocal(chat, [{ historySeq: 1 }, { historySeq: 2 }]);
  prependHistoryOlderLocal(chat, [{ historySeq: 3 }, { historySeq: 4 }, { historySeq: 5 }]);
  assert.deepEqual(getHistoryOlderLocal(chat).map((r) => r.historySeq), [1, 2, 3, 4, 5]);
  const first = takeOlderHistoryPageFromLocalCache(chat, pageSize);
  assert.deepEqual(first.records.map((r) => r.historySeq), [3, 4, 5]);
  assert.equal(first.hasOlder, true);
  assert.equal(first.remaining, 2);
  const second = takeOlderHistoryPageFromLocalCache(chat, pageSize);
  assert.deepEqual(second.records.map((r) => r.historySeq), [1, 2]);
  assert.equal(second.hasOlder, false);
  prependHistoryOlderLocal(chat, [{ historySeq: 1 }, { historySeq: 2 }]);
  assert.deepEqual(getHistoryOlderLocal(chat).map((r) => r.historySeq), [1, 2]);
});

test('mergeParkedHistoryRecords keeps order', () => {
  const merged = mergeParkedHistoryRecords(
    [{ historySeq: 20 }, { historySeq: 22 }],
    [{ historySeq: 21 }],
  );
  assert.deepEqual(merged.map((row) => row.historySeq), [20, 21, 22]);
});

test('generation gate coalesces frames per generation across chat switches', () => {
  const gate = createChatHistoryReplayGenerationGate();
  let frameCount = 0;
  const schedule = (cb) => {
    frameCount += 1;
    cb();
  };
  for (let gen = 1; gen <= 5; gen += 1) {
    gate.activate(gen);
    gate.scheduleMergedFrameWork(gen, () => {}, schedule);
    gate.revoke();
  }
  assert.equal(frameCount, 5);
});

test('mounted stream card count uses stream children', () => {
  const stream = { children: [{ id: 1 }, { id: 2 }] };
  assert.equal(countMountedStreamCards(stream), 2);
  assert.equal(countMountedStreamCards({ children: [] }), 0);
});

test('dom node registry counts connected and detached nodes', () => {
  const registry = createMountedDomNodeRegistry();
  const child = { isConnected: true, remove() {} };
  const connected = {
    isConnected: true,
    remove() {},
    querySelectorAll() {
      return [child];
    },
  };
  /** @type {Element} */
  const connectedEl = /** @type {any} */ (connected);
  registry.trackSubtree(connectedEl);
  let stats = registry.count();
  assert.equal(stats.connected, 2);
  assert.equal(stats.detached, 0);
  connected.isConnected = false;
  child.isConnected = false;
  connected.querySelectorAll = () => [child];
  stats = registry.count();
  assert.equal(stats.detached, 2);
  assert.equal(countConnectedAndDetachedNodes(registry), 2);
});

test('resource ledger releases listeners and loops across repeated evictions', () => {
  const ledger = createMountedViewResourceLedger();
  /** @param {number} n */
  function simulateChatSwitch(n) {
    for (let i = 0; i < n; i += 1) {
      const card = { isConnected: true, remove() {} };
      /** @type {HTMLElement} */
      const cardEl = /** @type {any} */ (card);
      const target = {
        /** @type {Map<string, Set<() => void>>} */
        map: new Map(),
        addEventListener(type, fn) {
          const set = this.map.get(type) || new Set();
          set.add(fn);
          this.map.set(type, set);
        },
        removeEventListener(type, fn) {
          this.map.get(type)?.delete(fn);
        },
      };
      const listener = () => {};
      ledger.bindCardListener(cardEl, target, 'click', listener);
      let loopActive = true;
      ledger.registerLoop(cardEl, () => {
        loopActive = false;
      });
      assert.equal(ledger.getActiveListenerCount(), 1);
      assert.equal(ledger.getActiveLoopCount(), 1);
      ledger.releaseCard(cardEl);
      assert.equal(ledger.getActiveListenerCount(), 0);
      assert.equal(ledger.getActiveLoopCount(), 0);
      assert.equal(loopActive, false);
    }
  }
  simulateChatSwitch(20);
  assert.equal(ledger.getActiveListenerCount(), 0);
  assert.equal(ledger.getActiveLoopCount(), 0);
});

test('resource ledger resetAll removes every active listener and loop', () => {
  const ledger = createMountedViewResourceLedger();
  const target = {
    /** @type {Map<string, Set<() => void>>} */
    map: new Map(),
    addEventListener(type, fn) {
      const set = this.map.get(type) || new Set();
      set.add(fn);
      this.map.set(type, set);
    },
    removeEventListener(type, fn) {
      this.map.get(type)?.delete(fn);
    },
  };
  const card = { isConnected: true, remove() {} };
  /** @type {HTMLElement} */
  const cardEl = /** @type {any} */ (card);
  const listener = () => {};
  ledger.bindCardListener(cardEl, target, 'click', listener);
  ledger.registerLoop(cardEl, () => {});
  assert.equal(ledger.getActiveListenerCount(), 1);
  assert.equal(ledger.getActiveLoopCount(), 1);
  ledger.resetAll();
  assert.equal(ledger.getActiveListenerCount(), 0);
  assert.equal(ledger.getActiveLoopCount(), 0);
  assert.equal(target.map.get('click')?.size ?? 0, 0);
});

test('delegation expand enforces max DOM pages behaviorally (Chromium)', { timeout: 120_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const reportUrl = `${baseUrl}/app_front/lib/delegationHistoryCardReport.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const pageCount = await page.evaluate(async ({ reportUrl, maxPages }) => {
      const mod = await import(reportUrl);
      mod.resetHistoryCardReportRuntimeForTests();
      const line = `${'paragraph '.repeat(120)}\n\n`;
      let body = '';
      while (mod.measureUtf8ByteLength(body) < 900 * 1024) body += line;
      const root = document.createElement('div');
      document.body.appendChild(root);
      root.innerHTML = mod.buildHistoryCardReportHostHtml(body, {
        escapeHtml: (v) => String(v ?? ''),
        t: (k) => k,
        renderMarkdown: (src) => `<div class="sdk-md"><pre>${src.length}</pre></div>`,
      });
      mod.wireHistoryCardReportControls(root, {
        t: (k) => k,
        renderMarkdown: (src) => `<div class="sdk-md"><pre>${src.length}</pre></div>`,
        writeTextToClipboard: () => {},
        decorateCodeForCopy: () => {},
        expandMaxDomPages: maxPages,
      });
      const btn = root.querySelector('[data-report-action="expand"]');
      if (!(btn instanceof HTMLElement)) throw new Error('missing expand');
      for (let i = 0; i < maxPages + 2; i += 1) btn.click();
      return root.querySelectorAll('.sdk-rich-delegation-report-page').length;
    }, { reportUrl, maxPages: UI_FREEZE_DELEGATION_EXPAND_MAX_DOM_PAGES });
    assert.equal(pageCount, UI_FREEZE_DELEGATION_EXPAND_MAX_DOM_PAGES);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

test('a throwing apply settles the replay outcome as error (Chromium)', { timeout: 120_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ viewUrl }) => {
      const viewMod = await import(viewUrl);
      const mount = document.getElementById('mount');
      if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
      const chat = { id: 'replay-error-test' };
      const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
      // Non-enumerable getter survives structuredClone/JSON clone but throws when
      // applySdkEvent reads event.type, so the apply loop rejects deterministically.
      const badEvent = {};
      Object.defineProperty(badEvent, 'type', {
        enumerable: false,
        configurable: true,
        get() {
          throw new Error('boom apply');
        },
      });
      const records = [
        {
          kind: 'sdk',
          historySeq: 1,
          event: badEvent,
          createdAt: new Date().toISOString(),
        },
      ];
      const settled = await Promise.race([
        rich.replayHistoryRecords(records, { instant: true, source: 'test' }),
        new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 5000)),
      ]);
      rich.destroy();
      return settled;
    }, { viewUrl });
    assert.notEqual(result, 'TIMEOUT', 'replay outcome must settle when apply throws');
    assert.equal(result.reason, 'error');
    assert.equal(result.cancelled, false);
    assert.equal(result.total, 1);
    assert.equal(result.applied, 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

/**
 * @param {string} root
 * @returns {Promise<{ server: import('node:http').Server, baseUrl: string }>}
 */
function startStaticModuleServer(root) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const rel = decodeURIComponent(url.pathname).replace(/^\//, '');
        const filePath = path.resolve(root, rel);
        if (!filePath.startsWith(`${path.resolve(root)}${path.sep}`) && filePath !== path.resolve(root)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        const { type, body: data } = readServedModule(filePath);
        res.writeHead(200, {
          'Content-Type': type,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      } catch (err) {
        res.writeHead(404);
        res.end(String(err instanceof Error ? err.message : err));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('static server bind failed'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function resolveChromiumExecutable() {
  const fromEnv = String(process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  return candidates.find((file) => existsSync(file));
}

test('production sdk-rich-view eviction, restore, live tail (Chromium)', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const parkingUrl = `${baseUrl}/app_front/features/chat/chatHistoryMountedParking.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(
      async ({ viewUrl, parkingUrl, mountedCap }) => {
        const viewMod = await import(viewUrl);
        const parking = await import(parkingUrl);
        const mount = document.getElementById('mount');
        if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
        /** @param {number} seq */
        function noticeRecord(seq) {
          return {
            kind: 'meta',
            variant: 'notice',
            historySeq: seq,
            payload: `notice ${seq}`,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
          };
        }
        const chat = { id: 'mounted-window-test' };
        const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
        const harness = rich.mountedWindowHarness;
        if (!harness) throw new Error('missing mountedWindowHarness');
        const records = [];
        for (let seq = 1; seq <= mountedCap + 4; seq += 1) records.push(noticeRecord(seq));
        await rich.replayHistoryRecords(records, { instant: true, source: 'test' });
        harness.enforceMountedHistoryWindowBudget();
        const stream = harness.getRealStream();
        const mountEl = harness.getMountEl();
        const mountedAfterCap = harness.countMountedStreamCards();
        const headEvictedSeq = 1;
        const headMissingAfterEvict =
          stream.querySelector(`[data-history-seq="${headEvictedSeq}"]`) == null;
        const olderBefore = parking.getHistoryOlderLocal(chat).map((r) => r.historySeq);
        mountEl.scrollTop = 0;
        harness.setStickToBottom(false);
        harness.applyHistoryRecord(noticeRecord(mountedCap + 5));
        harness.applyHistoryRecord(noticeRecord(mountedCap + 6));
        harness.enforceMountedHistoryWindowBudgetFromEdge('tail');
        const tailEvictedSeq = mountedCap + 6;
        const tailMissingAfterEvict =
          stream.querySelector(`[data-history-seq="${tailEvictedSeq}"]`) == null;
        const parkedNewerBeforeLive = parking.getHistoryParkedNewerLocal(chat).map((r) => r.historySeq);
        const scrollBeforeLive = mountEl.scrollTop;
        const heightBeforeLive = mountEl.scrollHeight;
        rich.applyEvent(
          { type: 'text-delta', delta: 'live tail update' },
          { historySeq: tailEvictedSeq, roomEventSeq: tailEvictedSeq, eventStreamId: 'room-test' },
        );
        mountEl.scrollTop = scrollBeforeLive + (mountEl.scrollHeight - heightBeforeLive);
        const tailCountAfterLive = stream.querySelectorAll(`[data-history-seq="${tailEvictedSeq}"]`).length;
        const parkedNewerAfterLive = parking.getHistoryParkedNewerLocal(chat).map((r) => r.historySeq);
        harness.setStickToBottom(true);
        await harness.restoreParkedNewerTailIfNeeded();
        const tailCountAfterRestore = stream.querySelectorAll(`[data-history-seq="${tailEvictedSeq}"]`).length;
        const page = parking.takeOlderHistoryPageFromLocalCache(chat, 2);
        await rich.prependHistoryRecords(page.records);
        const ids = [...stream.querySelectorAll('[data-history-seq]')].map(
          (el) => el.getAttribute('data-history-seq'),
        );
        const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
        const ledger = harness.getMountedViewResourceLedger();
        const nodeStats = harness.getMountedDomNodeRegistry().count();
        rich.destroy();
        return {
          pageErrors: [],
          mountedAfterCap,
          headMissingAfterEvict,
          olderBefore,
          loadedOlder: page.records.map((r) => r.historySeq),
          tailEvictedSeq,
          tailMissingAfterEvict,
          parkedNewerBeforeLive,
          tailCountAfterLive,
          parkedNewerAfterLive,
          tailCountAfterRestore,
          duplicateIds: dupes,
          activeListeners: ledger.getActiveListenerCount(),
          activeLoops: ledger.getActiveLoopCount(),
          connectedNodes: nodeStats.connected,
          detachedNodes: nodeStats.detached,
        };
      },
      { viewUrl, parkingUrl, mountedCap: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP },
    );
    assert.equal(result.mountedAfterCap, UI_FREEZE_CHAT_MOUNTED_RECORD_CAP);
    assert.equal(result.headMissingAfterEvict, true);
    assert.ok(result.olderBefore.includes(1));
    assert.equal(result.tailMissingAfterEvict, true);
    assert.ok(result.parkedNewerBeforeLive.includes(result.tailEvictedSeq));
    assert.equal(result.tailCountAfterLive, 1);
    assert.equal(result.parkedNewerAfterLive.includes(result.tailEvictedSeq), false);
    assert.equal(result.tailCountAfterRestore, 1);
    assert.deepEqual(result.duplicateIds, []);
    assert.equal(result.activeListeners, 0);
    assert.equal(result.activeLoops, 0);
    assert.ok(result.connectedNodes >= 0);
    assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

test('deferred burst keeps every live-remounted tail record protected (Chromium)', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(
      async ({ viewUrl, mountedCap }) => {
        const viewMod = await import(viewUrl);
        const mount = document.getElementById('mount');
        const noticeRecord = (seq) => ({
          kind: 'meta',
          variant: 'notice',
          historySeq: seq,
          payload: `notice ${seq}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
        });
        const chat = { id: 'burst-protect-test' };
        const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
        const harness = rich.mountedWindowHarness;
        const records = [];
        for (let seq = 1; seq <= mountedCap + 4; seq += 1) records.push(noticeRecord(seq));
        await rich.replayHistoryRecords(records, { instant: true, source: 'test' });
        harness.enforceMountedHistoryWindowBudget();
        harness.setStickToBottom(false);
        // Park the two newest tail records.
        const seqA = mountedCap + 5;
        const seqB = mountedCap + 6;
        harness.applyHistoryRecord(noticeRecord(seqA));
        harness.applyHistoryRecord(noticeRecord(seqB));
        harness.enforceMountedHistoryWindowBudgetFromEdge('tail');
        harness.enforceMountedHistoryWindowBudgetFromEdge('tail');
        // One synchronous burst: enough events to defer the scans, then two remounts.
        const live = (seq) => rich.applyEvent(
          { type: 'text-delta', delta: `live ${seq}` },
          { historySeq: seq, roomEventSeq: seq, eventStreamId: 'room-test' },
        );
        // Fillers push the burst past the synchronous limit, so both remounts are deferred.
        for (let i = 0; i < 8; i += 1) live(mountedCap + 4);
        live(seqA);
        live(seqB);
        await Promise.resolve();
        await Promise.resolve();
        const stream = harness.getRealStream();
        const count = (seq) => stream.querySelectorAll(`[data-history-seq="${seq}"]`).length;
        const out = { a: count(seqA), b: count(seqB) };
        rich.destroy();
        return out;
      },
      { viewUrl, mountedCap: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP },
    );
    assert.equal(result.a, 1, 'first remounted record must stay mounted');
    assert.equal(result.b, 1, 'second remounted record must stay mounted');
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

test('repeated sdk-rich-view destroy clears listeners and node registry (Chromium)', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ viewUrl }) => {
      const viewMod = await import(viewUrl);
      const mount = document.getElementById('mount');
      if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
      let maxListeners = 0;
      let maxLoops = 0;
      let maxNodes = 0;
      for (let round = 0; round < 8; round += 1) {
        const chat = { id: `chat-${round}` };
        const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
        const harness = rich.mountedWindowHarness;
        await rich.replayHistoryRecords(
          [
            {
              kind: 'meta',
              variant: 'notice',
              historySeq: round + 1,
              payload: `round ${round}`,
            },
          ],
          { instant: true, source: 'test' },
        );
        harness.enforceMountedHistoryWindowBudget();
        const ledger = harness.getMountedViewResourceLedger();
        const nodes = harness.getMountedDomNodeRegistry().count().total;
        maxListeners = Math.max(maxListeners, ledger.getActiveListenerCount());
        maxLoops = Math.max(maxLoops, ledger.getActiveLoopCount());
        maxNodes = Math.max(maxNodes, nodes);
        rich.destroy();
        const afterNodes = harness.getMountedDomNodeRegistry().count().total;
        maxNodes = Math.max(maxNodes, afterNodes);
        if (ledger.getActiveListenerCount() > 0 || ledger.getActiveLoopCount() > 0) {
          throw new Error('ledger not cleared on destroy');
        }
      }
      return { maxListeners, maxLoops, maxNodes, mountChildCount: mount.childElementCount };
    }, { viewUrl });
    assert.equal(result.maxListeners, 0);
    assert.equal(result.maxLoops, 0);
    assert.equal(result.mountChildCount, 0);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

console.log('chat-history-mounted-window.test.js OK');

test('paging older history to the start keeps the oldest page and re-arms after tail restore (Chromium)', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ viewUrl }) => {
      const viewMod = await import(viewUrl);
      const mount = document.getElementById('mount');
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const record = (seq) => ({
        kind: 'meta',
        variant: 'notice',
        historySeq: seq,
        payload: `notice ${seq}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
      });
      const all = Array.from({ length: 500 }, (_, i) => record(i + 1));
      let older = all.slice(0, 420);
      const chat = { id: 'older-paging-test' };
      const hooks = {
        appendPlain() {},
        loadOlderHistory: async () => {
          const cut = Math.max(0, older.length - 80);
          const records = older.slice(cut);
          older = older.slice(0, cut);
          return { records, hasOlder: cut > 0 };
        },
      };
      const rich = viewMod.createSdkRichView(chat, mount, hooks);
      await rich.replayHistoryRecords(all.slice(420), { instant: true, source: 'test' });
      rich.scrollToBottom();
      await sleep(300);
      rich.setOlderHistoryAvailable(true);
      for (let i = 0; i < 40; i += 1) {
        mount.scrollTop = 0;
        await sleep(150);
      }
      const seqs = () =>
        [...mount.querySelectorAll('[data-history-seq]')].map((el) => Number(el.dataset.historySeq));
      const atTop = seqs();
      // The parked tail comes back one step per arrival at the bottom of what is mounted.
      for (let i = 0; i < 20; i += 1) {
        mount.scrollTop = mount.scrollHeight;
        await sleep(150);
      }
      const atBottom = seqs();
      const sentinelState = mount.querySelector('.sdk-rich-history-top')?.dataset.state;
      rich.destroy();
      return { atTop, atBottom, sentinelState };
    }, { viewUrl });
    assert.equal(result.atTop[0], 1, 'oldest page must stay mounted at the top');
    assert.equal(result.atTop[result.atTop.length - 1], 80, 'no gap between pages');
    assert.equal(result.atBottom[result.atBottom.length - 1], 500);
    assert.equal(result.sentinelState, 'idle', 'older paging must be re-armed after tail restore');
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

test('parking an evicted card parks every record merged into it', () => {
  const registry = createMountedHistoryRecordRegistry();
  const running = { kind: 'sdk', historySeq: 10, event: { type: 'tool_call', status: 'running' } };
  const completed = { kind: 'sdk', historySeq: 11, event: { type: 'tool_call', status: 'completed' } };
  const next = { kind: 'sdk', historySeq: 12, event: { type: 'tool_call', status: 'running' } };
  for (const record of [running, completed, next]) registry.note(record);
  // The tray and the hidden full block share the running record's identity.
  const parked = parkMountedCardRecords([['h:12'], ['h:10', 'h:11'], ['h:10']], registry);
  assert.deepEqual(parked.map((r) => r.historySeq), [10, 11, 12]);
  assert.equal(registry.isMounted('h:11'), false);
  assert.deepEqual(parkMountedCardRecords([['h:10', 'h:11']], registry), []);
});

test('evicted tool cards come back finished, not spinning (Chromium)', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const parkingUrl = `${baseUrl}/app_front/features/chat/chatHistoryMountedParking.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(
      async ({ viewUrl, parkingUrl, toolCount }) => {
        const viewMod = await import(viewUrl);
        const parking = await import(parkingUrl);
        const mount = document.getElementById('mount');
        if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
        const chat = { id: 'mounted-window-tools' };
        const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
        const harness = rich.mountedWindowHarness;
        /** @type {unknown[]} */
        const records = [];
        let seq = 0;
        for (let index = 0; index < toolCount; index += 1) {
          for (const status of ['running', 'completed']) {
            seq += 1;
            records.push({
              kind: 'sdk',
              historySeq: seq,
              eventStreamId: 'room-tools',
              roomEventSeq: seq,
              createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
              event: {
                type: 'tool_call',
                name: 'Bash',
                status,
                call_id: `toolu_${index}`,
                args: { command: `ssh host-${index} && ls` },
              },
            });
          }
        }
        await rich.replayHistoryRecords(records, { instant: true, source: 'test' });
        harness.setStickToBottom(true);
        harness.enforceMountedHistoryWindowBudget();
        const stream = harness.getRealStream();
        const spinning = () => stream.querySelectorAll('.sdk-tool-tile__status-icon.mdi-spin').length;
        const spinningAfterEvict = spinning();
        const olderLocal = parking.getHistoryOlderLocal(chat).length;
        const older = parking.takeOlderHistoryPageFromLocalCache(chat, olderLocal);
        // The user scrolled up to read: paging older history trims the tail instead.
        harness.setStickToBottom(false);
        await rich.prependHistoryRecords(older.records);
        const spinningAfterPrepend = spinning();
        const callIds = [...stream.querySelectorAll('.sdk-tool-tile')].map((tile) => tile.dataset.callId);
        rich.destroy();
        return { spinningAfterEvict, olderLocal, spinningAfterPrepend, tiles: callIds.length };
      },
      { viewUrl, parkingUrl, toolCount: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP + 20 },
    );
    assert.equal(result.spinningAfterEvict, 0);
    assert.ok(result.olderLocal > 0, 'head eviction must park records');
    assert.equal(result.spinningAfterPrepend, 0, 'restored tool tiles must not spin');
    assert.ok(result.tiles > 0);
    assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

test('tools after an answer open a new Activity card below it, not in the earlier thinking tray (Chromium)', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ viewUrl }) => {
      const viewMod = await import(viewUrl);
      const mount = document.getElementById('mount');
      if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
      const chat = { id: 'activity-turn-boundary' };
      const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
      let seq = 0;
      /** @param {Record<string, unknown>} event */
      const record = (event) => {
        seq += 1;
        return {
          kind: 'sdk',
          historySeq: seq,
          eventStreamId: 'room-boundary',
          roomEventSeq: seq,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
          event,
        };
      };
      /** @param {string} id @param {string} status */
      const tool = (id, status) => record({
        type: 'tool_call', name: 'Bash', status, call_id: id, args: { command: `echo ${id}` },
      });
      const answer = (text) => record({
        type: 'assistant', streamTextMode: 'snapshot',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
      await rich.replayHistoryRecords([
        record({ type: 'thinking', text: 'Checking the export.', streamTextMode: 'snapshot' }),
        tool('before', 'running'),
        tool('before', 'completed'),
        answer('Both models are ready.'),
        tool('after', 'running'),
        tool('after', 'completed'),
      ], { instant: true, source: 'test' });
      const stream = rich.mountedWindowHarness.getRealStream();
      const cards = [...stream.children].filter((el) => !el.classList.contains('sdk-full-tool-block'));
      const indexOfTile = (id) => cards.findIndex((el) => el.querySelector(`.sdk-tool-tile[data-call-id="${id}"]`));
      const answerIndex = cards.findIndex((el) => el.querySelector('.sdk-rich-assistant-md'));
      const out = { before: indexOfTile('before'), answer: answerIndex, after: indexOfTile('after') };
      rich.destroy();
      return out;
    }, { viewUrl });
    assert.ok(result.before >= 0 && result.answer >= 0 && result.after >= 0, JSON.stringify(result));
    assert.ok(result.before < result.answer, JSON.stringify(result));
    assert.ok(result.after > result.answer, `tool after the answer must render below it: ${JSON.stringify(result)}`);
    assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

test('a finished AskUserQuestion closes its question card on replay (Chromium)', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ viewUrl }) => {
      const viewMod = await import(viewUrl);
      const mount = document.getElementById('mount');
      if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
      const rich = viewMod.createSdkRichView({ id: 'question-resolve' }, mount, { appendPlain() {} });
      const questions = [{ question: 'Which file?', header: 'File', options: [{ label: 'A' }, { label: 'B' }] }];
      let seq = 0;
      /** @param {Record<string, unknown>} event */
      const record = (event) => {
        seq += 1;
        return { kind: 'sdk', historySeq: seq, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), event };
      };
      const ask = (status, result) => record({
        type: 'tool_call', name: 'AskUserQuestion', status, call_id: 'toolu_ask', args: { questions }, result,
      });
      // No questionResolved meta record: older chats never persisted one.
      await rich.replayHistoryRecords([
        ask('running'),
        record({ type: 'opencode_question', requestId: 'req-1', questions }),
        ask('completed', 'Your questions have been answered: "Which file?"="B". You can now continue.'),
      ], { instant: true, source: 'test' });
      const card = mount.querySelector('.sdk-rich-opencode-question');
      const out = {
        found: !!card,
        resolved: !!card?.classList.contains('sdk-rich-opencode-question--resolved'),
        enabledButtons: card ? [...card.querySelectorAll('button')].filter((b) => !b.disabled).length : -1,
        inputs: card ? card.querySelectorAll('input, .sdk-rich-opencode-question-actions').length : -1,
        answer: card?.querySelector('.sdk-rich-opencode-question-answer')?.textContent || '',
        selected: card ? [...card.querySelectorAll('.is-selected')].map((el) => el.textContent) : [],
      };
      // A saved questionResolved record carries the answers as a JSON string.
      const rich2Mount = document.createElement('div');
      document.body.appendChild(rich2Mount);
      const rich2 = viewMod.createSdkRichView({ id: 'question-resolve-meta' }, rich2Mount, { appendPlain() {} });
      await rich2.replayHistoryRecords([
        { kind: 'sdk', historySeq: 1, event: { type: 'opencode_question', requestId: 'req-2', questions } },
        {
          kind: 'meta', variant: 'questionResolved', historySeq: 2,
          payload: JSON.stringify({ requestId: 'req-2', status: 'answered', answers: [['A']] }),
        },
      ], { instant: true, source: 'test' });
      out.metaAnswer = rich2Mount.querySelector('.sdk-rich-opencode-question-answer')?.textContent || '';
      rich2.destroy();
      rich.destroy();
      return out;
    }, { viewUrl });
    assert.equal(result.found, true);
    assert.equal(result.resolved, true, JSON.stringify(result));
    assert.equal(result.enabledButtons, 0, JSON.stringify(result));
    assert.equal(result.inputs, 0, 'a resolved card drops its input and actions');
    assert.match(result.answer, /B/);
    assert.deepEqual(result.selected, ['B']);
    assert.match(result.metaAnswer, /A/);
    assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

test('replayed partial thinking snapshots update the saved Thinking block instead of stacking new ones (Chromium)', { timeout: 180_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/chat-history-mounted-window-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ viewUrl }) => {
      const viewMod = await import(viewUrl);
      const mount = document.getElementById('mount');
      if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
      const rich = viewMod.createSdkRichView({ id: 'thinking-replay' }, mount, { appendPlain() {} });
      const stream = 'room-thinking';
      const full = 'The cause is neckV = 1.001, which the shop rejects.';
      /** @param {number} seq @param {number} room @param {Record<string, unknown>} event */
      const record = (seq, room, event) => ({
        kind: 'sdk', historySeq: seq, roomEventSeq: room, eventStreamId: stream,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), event,
      });
      // History keeps one record per thinking segment, under the segment's first room seq.
      await rich.replayHistoryRecords([
        record(1, 474, { type: 'thinking', text: full, streamTextMode: 'snapshot' }),
        record(2, 505, { type: 'tool_call', name: 'Bash', status: 'running', call_id: 't1', args: { command: 'grep x' } }),
        record(3, 506, { type: 'tool_call', name: 'Bash', status: 'completed', call_id: 't1', args: { command: 'grep x' } }),
        record(4, 507, {
          type: 'assistant', streamTextMode: 'snapshot',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }] },
        }),
      ], { instant: true, source: 'test' });
      const count = () => mount.querySelectorAll('.sdk-rich-thinking-pre').length;
      const before = count();
      // A reconnect replays the partial snapshots that history folded into room seq 474.
      for (let room = 475; room <= 480; room += 1) {
        rich.applyEvent(
          { type: 'thinking', text: full.slice(0, (room - 474) * 8), streamTextMode: 'snapshot' },
          { roomEventSeq: room, eventStreamId: stream },
        );
      }
      const out = {
        before,
        after: count(),
        text: mount.querySelector('.sdk-rich-thinking-pre')?.textContent || '',
      };
      rich.destroy();
      return out;
    }, { viewUrl });
    assert.equal(result.before, 1);
    assert.equal(result.after, 1, `replayed snapshots must not stack Thinking blocks: ${JSON.stringify(result)}`);
    assert.match(result.text, /which the shop rejects/);
    assert.equal(pageErrors.length, 0, pageErrors.join('; '));
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});
