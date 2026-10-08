import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  createChatViaApi,
  deleteChatViaApi,
  ensureAuthenticatedPage,
  ensureSidebarOpen,
} from './chat-e2e-helpers.js';

/**
 * Opt-in reproduction for "archive sidebar: freeze and missing row icons"
 * (todo 19d46be5-8442-419d-b19b-0a47880bb52f).
 *
 * Hermetic: dedicated workspace file + archived seed chats only in that workspace;
 * use CHAT_E2E_PORT=3411 (and optional CHAT_E2E_AUTH_DIR / CHAT_E2E_HOME_DIR) so
 * Playwright starts an isolated server when nothing listens on that port.
 *
 * Run:
 *   CHAT_E2E_ARCHIVE=1 CHAT_E2E_PORT=3411 \
 *   CHAT_E2E_CHROMIUM_EXECUTABLE_PATH=... PLAYWRIGHT_BROWSERS_PATH=... \
 *   npx playwright test tests/e2e/sidebar-archive-expand.spec.js --config playwright.config.js
 */

const ARCHIVE_COUNT = Number.parseInt(process.env.CHAT_E2E_ARCHIVE_COUNT || '70', 10);
const ITERATIONS = Number.parseInt(process.env.CHAT_E2E_ARCHIVE_ITERATIONS || '3', 10);
/** No CDP profile, in-page click only, minimal Playwright locator work (trace=off on CLI). */
const ARCHIVE_CONTROL = process.env.CHAT_E2E_ARCHIVE_CONTROL === '1';
const ARCHIVE_SEED_PREFIX = `archive-freeze-${Date.now()}`;
const SIDEBAR_ARCHIVE_OPEN_KEY = 'cretli-sidebar-archive-open';

test.skip(
  process.env.CHAT_E2E_ARCHIVE !== '1',
  'Set CHAT_E2E_ARCHIVE=1 to run the archive expand reproduction.',
);

/**
 * @param {string} sidebarKey
 */
/**
 * Real click in the page — avoids Playwright injected selector/snapshot work on the hot path.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} archiveHeaderSelector
 */
async function clickArchiveHeaderInPage(page, archiveHeaderSelector) {
  await page.evaluate((headerSel) => {
    const el = document.querySelector(headerSel);
    if (!(el instanceof HTMLElement)) {
      throw new Error(`archive header not found: ${headerSel}`);
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    el.click();
  }, archiveHeaderSelector);
}

/**
 * @param {string} sidebarKey
 */
function archiveGroupSelector(sidebarKey) {
  const normalized = String(sidebarKey || '').replace(/\\/g, '/').replace(/\/$/, '').trim();
  return `.sidebar-archive-group[data-sidebar-key="${normalized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

/**
 * Scroll the archive virtual list until a seeded chat row is mounted.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} archiveGroupSel
 * @param {string} seedTitlePrefix
 * @param {string} seedChatId
 */
async function scrollArchiveUntilSeedMounted(page, archiveGroupSel, seedTitlePrefix, seedChatId) {
  return page.evaluate(async ({ groupSel, titlePrefix, chatId }) => {
    const group = document.querySelector(groupSel);
    const list = group?.querySelector('.sidebar-archive-list');
    const scrollContainer = list?.closest('.sidebar-body') || list?.parentElement;
    if (!list || !(scrollContainer instanceof Element)) return false;
    const findSeedRow = () => {
      const byId = list.querySelector(`cr-sidebar-chat-row[chat-id="${chatId}"]`);
      if (byId) return byId;
      return Array.from(list.querySelectorAll('cr-sidebar-chat-row')).find((host) => {
        const title = host.querySelector('.sidebar-chat-item-title')?.textContent || '';
        return title.includes(titlePrefix);
      }) || null;
    };
    if (findSeedRow()) return true;
    const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    for (let step = 0; step <= 24; step += 1) {
      scrollContainer.scrollTop = Math.round((maxScroll * step) / 24);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const early = findSeedRow();
      if (early instanceof Element) {
        early.scrollIntoView({ block: 'center', inline: 'nearest' });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      }
    }
    scrollContainer.scrollTop = maxScroll;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const row = findSeedRow();
    if (row instanceof Element) {
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    }
    return false;
  }, { groupSel: archiveGroupSel, titlePrefix: seedTitlePrefix, chatId: seedChatId });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} archiveGroupSel
 * @param {string} seedChatId
 */
async function alignArchiveSeedIntoViewport(page, archiveGroupSel, seedChatId) {
  await page.evaluate(async ({ groupSel, chatId }) => {
    const group = document.querySelector(groupSel);
    const list = group?.querySelector('.sidebar-archive-list');
    const scrollContainer = list?.closest('.sidebar-body')
      || group?.closest('.sidebar-workspace')?.querySelector('.sidebar-body');
    const row = group?.querySelector(`cr-sidebar-chat-row[chat-id="${chatId}"]`);
    const li = row?.querySelector('.sidebar-chat-item');
    const logicalIndex = Number.parseInt(li?.getAttribute('data-archive-logical-index') || '0', 10);
    if (!(scrollContainer instanceof Element) || !list || !Number.isFinite(logicalIndex)) return;
    let listTop = 0;
    let node = list;
    while (node && node !== scrollContainer) {
      listTop += node.offsetTop;
      const parent = node.offsetParent;
      if (!(parent instanceof Element) || !scrollContainer.contains(parent)) break;
      node = parent;
    }
    const rowHeight = 32;
    const scrollTopPx = Math.max(0, logicalIndex * rowHeight - Math.round(scrollContainer.clientHeight / 2));
    scrollContainer.scrollTop = Math.max(0, listTop + scrollTopPx);
    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { groupSel: archiveGroupSel, chatId: seedChatId });
}

/**
 * Install in-page observers (MutationObserver + rAF + EventTiming + longtask)
 * before a real Playwright click.
 *
 * `first-visible-reaction` is measured inside the page: a Playwright poll
 * (`expect.poll` + locator round-trips) adds main-thread work of its own and
 * inflates the very window it measures. Marks are therefore written by an
 * in-page rAF loop and a MutationObserver on the archive group, never by a
 * Playwright poll.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} archiveHeaderSelector
 */
async function installArchiveMeasurement(page, archiveHeaderSelector) {
  await page.evaluate((headerSel) => {
    const state = {
      eventEntries: [],
      longtasks: [],
      longtaskObserverActive: false,
      longtaskObserverError: null,
      eventObserverActive: false,
      eventObserverError: null,
      mutationObserverActive: false,
      mutationObserverError: null,
      mutationCount: 0,
      rafActive: false,
      rafFrames: 0,
      marksSet: {
        clickHandled: false,
        listVisible: false,
        firstVisibleReaction: false,
        firstRow: false,
        lastRow: false,
      },
      lastRowStableFrames: 0,
    };
    window.__cretliArchiveMeasure = state;
    state.archiveGroupSel = headerSel.replace(/\.sidebar-archive-header$/, '');

    // `fromMutation` marks a probe driven by the MutationObserver. Only the rAF
    // loop may advance `lastRowStableFrames`, so `lastRow` is guaranteed to
    // mean >= settleFrames real animation frames with a stable mounted-row
    // count even when many attribute/class mutation batches fire in between.
    state.probe = ({ fromMutation = false } = {}) => {
      const group = document.querySelector(state.archiveGroupSel);
      const header = group?.querySelector('.sidebar-archive-header');
      const list = group?.querySelector('.sidebar-archive-list');
      if (!header || !list) return;

      if (!state.marksSet.clickHandled && header.getAttribute('aria-expanded') === 'true') {
        performance.mark('cretli-archive-click-handled');
        state.marksSet.clickHandled = true;
      }

      const listVisible = list.hidden === false
        && header.getAttribute('aria-expanded') === 'true';
      if (!state.marksSet.listVisible && listVisible) {
        performance.mark('cretli-archive-list-visible');
        state.marksSet.listVisible = true;
      }

      if (!state.marksSet.firstVisibleReaction && listVisible) {
        const rect = list.getBoundingClientRect();
        if (rect.height > 0 || list.querySelector('cr-sidebar-chat-row')) {
          performance.mark('cretli-archive-first-visible-reaction');
          state.marksSet.firstVisibleReaction = true;
        }
      }

      const rows = list.querySelectorAll('cr-sidebar-chat-row');
      if (!state.marksSet.firstRow && rows.length > 0) {
        performance.mark('cretli-archive-first-row');
        state.marksSet.firstRow = true;
      }
      const rowCount = rows.length;
      const settleFrames = 5;
      if (rowCount === 0) {
        state.lastMountedRowCount = 0;
        state.lastRowStableFrames = 0;
        if (state.marksSet.lastRow) {
          state.marksSet.lastRow = false;
          performance.clearMarks('cretli-archive-last-row');
        }
        return;
      }
      if (state.lastMountedRowCount !== rowCount) {
        // A real added/removed row restarts the settle whatever the driver.
        state.lastMountedRowCount = rowCount;
        state.lastRowStableFrames = 0;
        state.marksSet.lastRow = false;
        performance.clearMarks('cretli-archive-last-row');
        return;
      }
      // Mutation callbacks may fire several times per frame; they must not
      // inflate the settle window or `lastRow` could be marked after ~1-3 real
      // frames instead of settleFrames. Only the rAF loop advances the counter.
      if (fromMutation) return;
      state.lastRowStableFrames += 1;
      if (!state.marksSet.lastRow && state.lastRowStableFrames >= settleFrames) {
        performance.mark('cretli-archive-last-row');
        state.marksSet.lastRow = true;
      }
    };

    // In-page frame loop: keeps `last-row` tracking the settled window until
    // finalize() cancels it. Bounded so it can never run away.
    const rafLoop = () => {
      if (!state.rafActive) return;
      state.probe();
      state.rafFrames += 1;
      if (state.rafFrames >= 3600) {
        state.rafActive = false;
        state.rafId = null;
        return;
      }
      state.rafId = requestAnimationFrame(rafLoop);
    };
    state.rafFrames = 0;
    state.rafActive = true;
    state.rafId = requestAnimationFrame(rafLoop);

    if (typeof MutationObserver !== 'undefined') {
      try {
        state.mutationObserver = new MutationObserver(() => {
          state.mutationCount += 1;
          state.probe({ fromMutation: true });
        });
        state.mutationObserver.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-expanded', 'hidden', 'class'],
        });
        state.mutationObserverActive = true;
      } catch (err) {
        state.mutationObserverError = String(err);
      }
    }

    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const ltObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.longtasks.push({
              startMs: Math.round(entry.startTime * 10) / 10,
              durationMs: Math.round(entry.duration * 10) / 10,
            });
          }
        });
        ltObs.observe({ entryTypes: ['longtask'] });
        state.longtaskObserver = ltObs;
        state.longtaskObserverActive = true;
      } catch (err) {
        state.longtaskObserverError = String(err);
      }

      try {
        const evObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const name = entry.name || '';
            if (name === 'click' || name === 'pointerdown' || name === 'pointerup') {
              state.eventEntries.push({
                name,
                startTime: Math.round(entry.startTime * 10) / 10,
                duration: Math.round(entry.duration * 10) / 10,
                processingStart: typeof entry.processingStart === 'number'
                  ? Math.round(entry.processingStart * 10) / 10
                  : null,
                interactionId: entry.interactionId || 0,
              });
            }
          }
        });
        evObs.observe({
          type: 'event',
          durationThreshold: 16,
          buffered: true,
        });
        state.eventObserver = evObs;
        state.eventObserverActive = true;
      } catch (err) {
        state.eventObserverError = String(err);
      }
    }
  }, archiveHeaderSelector);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function finalizeArchiveMeasurement(page) {
  return page.evaluate(() => {
    const state = window.__cretliArchiveMeasure || {};
    if (state.rafId) {
      window.cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.rafActive = false;
    if (state.mutationObserver) {
      try {
        state.mutationObserver.takeRecords?.();
        state.mutationObserver.disconnect();
      } catch (_) {}
    }

    if (state.longtaskObserver) {
      try {
        const pending = state.longtaskObserver.takeRecords?.() || [];
        for (const entry of pending) {
          state.longtasks.push({
            startMs: Math.round(entry.startTime * 10) / 10,
            durationMs: Math.round(entry.duration * 10) / 10,
          });
        }
        state.longtaskObserver.disconnect();
      } catch (_) {}
    }
    if (state.eventObserver) {
      try {
        const pending = state.eventObserver.takeRecords?.() || [];
        for (const entry of pending) {
          const name = entry.name || '';
          if (name === 'click' || name === 'pointerdown' || name === 'pointerup') {
            state.eventEntries.push({
              name,
              startTime: Math.round(entry.startTime * 10) / 10,
              duration: Math.round(entry.duration * 10) / 10,
              processingStart: typeof entry.processingStart === 'number'
                ? Math.round(entry.processingStart * 10) / 10
                : null,
              interactionId: entry.interactionId || 0,
            });
          }
        }
        state.eventObserver.disconnect();
      } catch (_) {}
    }

    /** @param {string} name */
    const markTime = (name) => performance.getEntriesByName(name, 'mark')[0]?.startTime ?? null;
    const beforeClickMs = markTime('cretli-archive-before-click');
    const clickEntry = (state.eventEntries || []).find((entry) => entry.name === 'click')
      || (state.eventEntries || []).find((entry) => entry.name === 'pointerup');
    // Real input timestamp when available; the before-click mark is only a fallback.
    const clickStartMs = clickEntry ? clickEntry.startTime : beforeClickMs;

    /** @param {number | null} fromMs @param {string} endMark */
    const delta = (fromMs, endMark) => {
      const end = markTime(endMark);
      if (fromMs == null || end == null) return null;
      return Math.round((end - fromMs) * 10) / 10;
    };

    const groupSel = state.archiveGroupSel || '.sidebar-archive-group';
    const group = document.querySelector(groupSel);
    const list = group?.querySelector('.sidebar-archive-list');
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const clipRect = list?.closest('.sidebar-body')?.getBoundingClientRect()
      || { top: 0, bottom: viewport.height, left: 0, right: viewport.width };

    const rowInfoList = () => Array.from(list?.querySelectorAll('cr-sidebar-chat-row') || []).map((host) => {
      const li = host.querySelector('.sidebar-chat-item');
      const harness = host.querySelector('.sidebar-chat-item-harness');
      const img = harness?.querySelector('img') || null;
      const rect = li ? li.getBoundingClientRect() : null;
      const imgStyle = img ? getComputedStyle(img) : null;
      const bbox = rect
        ? {
          top: Math.round(rect.top),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
        }
        : null;
      const isVisible = bbox
        && bbox.width > 0
        && bbox.height > 0
        && bbox.top + bbox.height > clipRect.top
        && bbox.top < clipRect.bottom;
      return {
        chatId: host.getAttribute('chat-id') || '',
        logicalIndex: li?.getAttribute('data-archive-logical-index') || '',
        title: (li?.querySelector('.sidebar-chat-item-title')?.textContent || '').trim().slice(0, 80),
        hasImg: img instanceof HTMLImageElement,
        src: img?.getAttribute('src') || '',
        complete: img ? img.complete === true : false,
        naturalWidth: img ? img.naturalWidth : 0,
        imgDisplay: imgStyle?.display || '',
        imgVisibility: imgStyle?.visibility || '',
        isVisible: isVisible === true,
        harnessBbox: harness
          ? {
            width: Math.round(harness.getBoundingClientRect().width),
            height: Math.round(harness.getBoundingClientRect().height),
          }
          : null,
        bbox,
      };
    });

    const rows = rowInfoList();
    const visibleRows = rows.filter((row) => row.isVisible);
    const longtasks = (state.longtasks || []).map((task) => ({
      ...task,
      sinceBeforeClickMs: beforeClickMs == null
        ? null
        : Math.round((task.startMs - beforeClickMs) * 10) / 10,
    }));

    return {
      viewport,
      sidebarClip: {
        top: Math.round(clipRect.top),
        bottom: Math.round(clipRect.bottom),
      },
      rows,
      mountedRows: rows.length,
      visibleRows: visibleRows.length,
      firstRow: rows[0] || null,
      lastRow: rows.length > 0 ? rows[rows.length - 1] : null,
      eventEntries: state.eventEntries || [],
      longtasks,
      longtaskObserverActive: state.longtaskObserverActive === true,
      longtaskObserverError: state.longtaskObserverError || null,
      mutationObserverActive: state.mutationObserverActive === true,
      mutationObserverError: state.mutationObserverError || null,
      mutationCount: state.mutationCount || 0,
      eventObserverActive: state.eventObserverActive === true,
      eventObserverError: state.eventObserverError || null,
      markDeltas: {
        beforeToClickHandled: delta(beforeClickMs, 'cretli-archive-click-handled'),
        beforeToListVisible: delta(beforeClickMs, 'cretli-archive-list-visible'),
        beforeToApiResponse: delta(beforeClickMs, 'cretli-archive-api-response'),
        beforeToFirstVisibleReaction: delta(beforeClickMs, 'cretli-archive-first-visible-reaction'),
        beforeToFirstRow: delta(beforeClickMs, 'cretli-archive-first-row'),
        beforeToLastRow: delta(beforeClickMs, 'cretli-archive-last-row'),
      },
      clickMarkDeltas: {
        clickStartMs,
        source: clickEntry ? clickEntry.name : 'before-click-fallback',
        clickToClickHandled: delta(clickStartMs, 'cretli-archive-click-handled'),
        clickToListVisible: delta(clickStartMs, 'cretli-archive-list-visible'),
        clickToFirstVisibleReaction: delta(clickStartMs, 'cretli-archive-first-visible-reaction'),
        clickToFirstRow: delta(clickStartMs, 'cretli-archive-first-row'),
        clickToLastRow: delta(clickStartMs, 'cretli-archive-last-row'),
      },
      marksPresent: {
        beforeClick: performance.getEntriesByName('cretli-archive-before-click', 'mark').length > 0,
        clickHandled: performance.getEntriesByName('cretli-archive-click-handled', 'mark').length > 0,
        listVisible: performance.getEntriesByName('cretli-archive-list-visible', 'mark').length > 0,
        apiResponse: performance.getEntriesByName('cretli-archive-api-response', 'mark').length > 0,
        firstVisibleReaction: performance.getEntriesByName('cretli-archive-first-visible-reaction', 'mark').length > 0,
        firstRow: performance.getEntriesByName('cretli-archive-first-row', 'mark').length > 0,
        lastRow: performance.getEntriesByName('cretli-archive-last-row', 'mark').length > 0,
      },
    };
  });
}

test('archive expand: EventTiming, marks, longtasks and row harness icons', async ({ page, context }, testInfo) => {
  test.setTimeout(360_000);

  const hermetic = {
    port: process.env.CHAT_E2E_PORT || '3311',
    authDir: process.env.CHAT_E2E_AUTH_DIR || path.resolve('.tmp/e2e-auth'),
    homeDir: process.env.CHAT_E2E_HOME_DIR || path.resolve('.tmp/e2e-home'),
    browserContextFresh: true,
    iconCacheNote: 'First navigation in this Playwright context; harness SVG cache cold until first load.',
    dataIsolationNote: 'CURSOR_REMOTE_TEST_DATA_DIR isolates auth; chat catalog may still include pre-existing archived rows from data/.',
  };

  await ensureAuthenticatedPage(page);

  await page.addInitScript((key) => {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
  }, SIDEBAR_ARCHIVE_OPEN_KEY);

  const authStatus = await (await page.request.get('/api/auth-status')).json().catch(() => ({}));
  const csrfToken = typeof authStatus?.csrfToken === 'string' ? authStatus.csrfToken : '';
  const csrfHeaders = csrfToken ? { 'X-Cretli-Csrf': csrfToken } : {};

  /** @type {Array<{ url: string, status: number }>} */
  const harnessIconResponses = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/harness-icons/')) {
      harnessIconResponses.push({
        url: url.replace(/^https?:\/\/[^/]+/, ''),
        status: response.status(),
      });
    }
  });

  /** @type {string[]} */
  const createdChatIds = [];
  /** @type {Array<Record<string, unknown>>} */
  const iterationReports = [];

  try {
    let seedWorkspaceFile = '';
    for (let i = 0; i < ARCHIVE_COUNT; i += 1) {
      const chat = await createChatViaApi(page.request, {
        title: `${ARCHIVE_SEED_PREFIX}-${String(i).padStart(3, '0')}`,
        transport: 'opencode',
      });
      if (!seedWorkspaceFile && typeof chat.workspaceFile === 'string') {
        seedWorkspaceFile = chat.workspaceFile.replace(/\\/g, '/').replace(/\/$/, '').trim();
      }
      createdChatIds.push(chat.id);
      let archived = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const response = await page.request.patch(`/api/chats/${encodeURIComponent(chat.id)}`, {
          headers: csrfHeaders,
          data: { archived: true },
        });
        if (response.ok()) {
          archived = true;
          break;
        }
        if (response.status() === 404 && attempt < 2) {
          console.warn(`ARCHIVE_SEED_RETRY chat=${chat.id} status=404 attempt=${attempt}`);
          await page.waitForTimeout(150);
          continue;
        }
        throw new Error(`Failed to archive ${chat.id}: ${response.status()}`);
      }
      if (!archived) {
        throw new Error(`Failed to archive ${chat.id}: exhausted retries`);
      }
    }

    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      harnessIconResponses.length = 0;

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('#chat-panel')).toBeVisible({ timeout: 60_000 });
      await ensureSidebarOpen(page);

      await page.evaluate(() => {
        document
          .querySelectorAll('#app-sidebar .sidebar-workspace.is-collapsed .sidebar-workspace-header')
          .forEach((header) => {
            if (header instanceof HTMLElement) header.click();
          });
      });

      const sidebarKey = seedWorkspaceFile.replace(/\\/g, '/').replace(/\/$/, '').trim();
      expect(sidebarKey, `iter ${iteration}: brak workspaceFile z seedów`).toBeTruthy();
      const archiveGroupSel = archiveGroupSelector(sidebarKey);
      const archiveHeaderSel = `${archiveGroupSel} .sidebar-archive-header`;

      const archiveHeader = page.locator(archiveHeaderSel);
      await expect(archiveHeader, `iter ${iteration}: archive header for seed workspace`).toBeVisible({ timeout: 30_000 });

      const isOpen = await page.evaluate((sel) => {
        const list = document.querySelector(`${sel} .sidebar-archive-list`);
        return list ? list.hidden === false : null;
      }, archiveGroupSel);
      if (isOpen === true) {
        await archiveHeader.click();
        await expect
          .poll(async () => page.evaluate((sel) => {
            const list = document.querySelector(`${sel} .sidebar-archive-list`);
            return list ? list.hidden === false : null;
          }, archiveGroupSel), { timeout: 10_000 })
          .toBe(false);
      }

      await installArchiveMeasurement(page, archiveHeaderSel);

      const archiveResponsePromise = page
        .waitForResponse(
          (response) => response.url().includes('/api/chats') && response.url().includes('includeArchived=1'),
          { timeout: 30_000 },
        );

      /** @type {Record<string, unknown> | null} */
      let profile = null;
      /** @type {Awaited<ReturnType<import('@playwright/test').BrowserContext['newCDPSession']>> | null} */
      let cdp = null;
      if (!ARCHIVE_CONTROL) {
        cdp = await context.newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }

      await page.evaluate(() => {
        performance.clearMarks();
        performance.mark('cretli-archive-before-click');
      });

      if (ARCHIVE_CONTROL) {
        await clickArchiveHeaderInPage(page, archiveHeaderSel);
      } else {
        await archiveHeader.scrollIntoViewIfNeeded();
        await archiveHeader.click();
      }

      const archiveResponse = await archiveResponsePromise;
      await page.evaluate(() => {
        performance.mark('cretli-archive-api-response');
      });

      // Wait for the in-page observer to record the first row; no Playwright
      // locator polling (which would add injected selector work to the window).
      await page.waitForFunction(
        () => window.__cretliArchiveMeasure?.marksSet?.firstRow === true,
        undefined,
        { timeout: 20_000 },
      );

      // Hold the longtask observer open until the last row has mounted, so the
      // reported "0 long tasks" window spans first-row → last-row (the mount/
      // layout tail), not only the phase up to the first row. Finalizing before
      // this mark disconnected the observer at first-row and under-counted.
      await page.waitForFunction(
        () => window.__cretliArchiveMeasure?.marksSet?.lastRow === true
          && performance.getEntriesByName('cretli-archive-last-row', 'mark').length > 0,
        undefined,
        { timeout: 20_000 },
      );

      const seedChatId = createdChatIds[createdChatIds.length - 1] || '';
      if (!ARCHIVE_CONTROL) {
        const seedScrolled = await scrollArchiveUntilSeedMounted(
          page,
          archiveGroupSel,
          ARCHIVE_SEED_PREFIX,
          seedChatId,
        );
        expect(seedScrolled, `iter ${iteration}: nie znaleziono seeda w wirtualnej liście archiwum`).toBe(true);
        await alignArchiveSeedIntoViewport(page, archiveGroupSel, seedChatId);
        await page.waitForTimeout(250);
        if (cdp) {
          const stopped = await cdp.send('Profiler.stop');
          profile = stopped.profile;
          await cdp.detach();
        }
      }

      const probe = await finalizeArchiveMeasurement(page);

      /** @type {Record<string, unknown>} */
      const api = {
        present: archiveResponse != null,
        status: archiveResponse.status(),
        records: 0,
        bodyOk: false,
        decodedBytes: 0,
        encodedBytes: 0,
        contentEncoding: '',
        responseHeaders: archiveResponse.headers(),
      };
      api.encodedBytes = Number(archiveResponse.headers()['content-length'] || 0);
      api.contentEncoding = archiveResponse.headers()['content-encoding'] || '';
      try {
        const buffer = await archiveResponse.body();
        api.decodedBytes = buffer.length;
        const payload = JSON.parse(buffer.toString('utf8'));
        api.bodyOk = payload?.ok === true;
        api.records = Array.isArray(payload?.chats) ? payload.chats.length : 0;
      } catch (_) {
        api.bodyOk = false;
      }

      const visibleRows = Array.isArray(probe.rows)
        ? probe.rows.filter((row) => row.isVisible === true)
        : [];

      const seededRows = (probe.rows || []).filter((row) => createdChatIds.includes(row.chatId)
        || row.title.includes(ARCHIVE_SEED_PREFIX));
      const seededVisible = seededRows.filter((row) => visibleRows.some((v) => v.chatId === row.chatId));
      const seededWithOpencodeIcon = seededRows.filter((row) => row.src === '/harness-icons/opencode.svg'
        && row.hasImg
        && row.complete
        && row.naturalWidth > 0);

      const visibleWithoutImg = visibleRows.filter((row) => !row.hasImg);
      const visibleBrokenImg = visibleRows.filter((row) => row.hasImg
        && (!(row.complete && row.naturalWidth > 0) || row.imgDisplay === 'none' || row.imgVisibility === 'hidden'));
      const mountedWithoutImg = (probe.rows || []).filter((row) => !row.hasImg);
      const uniqueVisibleSrcs = [...new Set(visibleRows.map((row) => row.src).filter(Boolean))];

      /** @type {Record<string, number>} */
      const iconAssetStatuses = {};
      for (const src of uniqueVisibleSrcs) {
        const response = await page.request.get(src).catch(() => null);
        iconAssetStatuses[src] = response ? response.status() : 0;
      }

      const maxLongtaskMs = (probe.longtasks || []).reduce(
        (max, task) => Math.max(max, Number(task.durationMs) || 0),
        0,
      );

      const goal100Ms = probe.markDeltas.beforeToFirstVisibleReaction;
      const clickToFirstRowMs = probe.markDeltas.beforeToFirstRow;
      const clickMarkDeltas = probe.clickMarkDeltas || {};

      const clickHandledMs = clickMarkDeltas.clickToClickHandled;
      const clickWindowEndMs = Math.max(
        clickHandledMs ?? 0,
        clickMarkDeltas.clickToListVisible ?? 0,
        clickMarkDeltas.clickToFirstRow ?? 0,
      );
      // `clickWindowEndMs` is a delta from `clickStartMs`; the click window in page
      // time is [clickStartMs, clickStartMs + clickWindowEndMs]. Take every long task
      // whose interval OVERLAPS that window, so a task that began just before the
      // click but still ran into the window is not silently dropped (the old
      // `startMs - clickStartMs >= 0` filter only caught tasks starting after the click).
      const longtasksInClickWindow = (probe.longtasks || []).filter((task) => {
        if (clickMarkDeltas.clickStartMs == null) return false;
        if (!Number.isFinite(task.startMs) || !Number.isFinite(task.durationMs)) return false;
        const windowEndMs = clickMarkDeltas.clickStartMs + clickWindowEndMs;
        const taskEndMs = task.startMs + task.durationMs;
        return taskEndMs > clickMarkDeltas.clickStartMs && task.startMs <= windowEndMs;
      });

      const report = {
        iteration,
        controlRun: ARCHIVE_CONTROL,
        hermetic,
        viewport: probe.viewport,
        seededArchived: createdChatIds.length,
        sidebarKey,
        seedWorkspaceFile,
        api,
        mountedRows: probe.mountedRows,
        visibleRows: visibleRows.length,
        seededRowsMounted: seededRows.length,
        seededRowsVisible: seededVisible.length,
        seededWithOpencodeIcon: seededWithOpencodeIcon.length,
        firstRow: probe.firstRow,
        lastRow: probe.lastRow,
        markDeltas: probe.markDeltas,
        clickMarkDeltas,
        clickWindows: {
          source: clickMarkDeltas.source,
          clickHandledMs,
          clickToClickHandledMs: clickMarkDeltas.clickToClickHandled,
          clickToListVisibleMs: clickMarkDeltas.clickToListVisible,
          clickToFirstVisibleReactionMs: clickMarkDeltas.clickToFirstVisibleReaction,
          clickToFirstRowMs: clickMarkDeltas.clickToFirstRow,
          clickToLastRowMs: clickMarkDeltas.clickToLastRow,
          clickWindowEndMs,
          longtasksInClickWindow,
        },
        marksPresent: probe.marksPresent,
        eventTiming: probe.eventEntries,
        goal100Ms: {
          metric: 'before-click → first-visible-reaction (painted row/box)',
          ms: goal100Ms,
          pass: typeof goal100Ms === 'number' && goal100Ms <= 100,
        },
        clickToFirstRowMs: {
          metric: 'before-click → first-row (includes API round-trip)',
          ms: clickToFirstRowMs,
        },
        longtaskMeasured: probe.longtaskObserverActive && !probe.longtaskObserverError,
        longtaskCount: (probe.longtasks || []).length,
        maxLongtaskMs,
        longtasks: probe.longtasks,
        longtaskObserverActive: probe.longtaskObserverActive,
        longtaskObserverError: probe.longtaskObserverError,
        mutationObserverActive: probe.mutationObserverActive,
        mutationObserverError: probe.mutationObserverError,
        mutationCount: probe.mutationCount,
        eventObserverActive: probe.eventObserverActive,
        eventObserverError: probe.eventObserverError,
        visibleWithoutImg: visibleWithoutImg.map((row) => ({ chatId: row.chatId, title: row.title })),
        visibleBrokenImg: visibleBrokenImg.map((row) => ({ chatId: row.chatId, src: row.src })),
        mountedWithoutImgCount: mountedWithoutImg.length,
        iconAssetStatuses,
        harnessIconResponses: [...harnessIconResponses],
        rows: probe.rows,
      };
      iterationReports.push(report);

      const reportJson = JSON.stringify(report, null, 2);
      if (ARCHIVE_CONTROL) {
        console.log(`ARCHIVE_CONTROL_ITERATION ${JSON.stringify({
          iteration,
          clickHandledMs,
          clickToListVisibleMs: clickMarkDeltas.clickToListVisible,
          clickToFirstRowMs: clickMarkDeltas.clickToFirstRow,
          longtasksInClickWindow,
          longtasks: probe.longtasks,
        })}`);
      }
      console.log(`ARCHIVE_EXPAND_ITERATION ${JSON.stringify(report)}`);
      await fs.mkdir(testInfo.outputDir, { recursive: true });
      const reportPath = path.join(testInfo.outputDir, `archive-expand-iteration-${iteration}.json`);
      await fs.writeFile(reportPath, reportJson, 'utf8');
      await testInfo.attach(`archive-expand-iteration-${iteration}.json`, {
        path: reportPath,
        contentType: 'application/json',
      });

      if (profile) {
        const cpuProfilePath = path.join(
          testInfo.outputDir,
          `archive-expand-iteration-${iteration}.cpuprofile`,
        );
        await fs.writeFile(cpuProfilePath, JSON.stringify(profile), 'utf8');
        await testInfo.attach(`archive-expand-iteration-${iteration}.cpuprofile`, {
          path: cpuProfilePath,
          contentType: 'application/json',
        });
      }

      if (!ARCHIVE_CONTROL) {
        await page.screenshot({
          path: path.join(testInfo.outputDir, `archive-expand-iteration-${iteration}.png`),
          fullPage: false,
        });
        await testInfo.attach(`archive-expand-iteration-${iteration}.png`, {
          path: path.join(testInfo.outputDir, `archive-expand-iteration-${iteration}.png`),
          contentType: 'image/png',
        });
      }

      expect(probe.eventObserverActive, `iter ${iteration}: EventTiming observer`).toBe(true);
      expect(
        (probe.eventEntries || []).some((e) => e.name === 'click' || e.name === 'pointerdown' || e.name === 'pointerup'),
        `iter ${iteration}: brak wpisu EventTiming click/pointer*`,
      ).toBe(true);

      expect(probe.longtaskObserverActive, `iter ${iteration}: longtask observer nieaktywny`).toBe(true);
      expect(report.longtaskMeasured, `iter ${iteration}: longtask observer error: ${probe.longtaskObserverError}`).toBe(true);
      expect(probe.mutationObserverActive, `iter ${iteration}: MutationObserver nieaktywny`).toBe(true);
      for (const task of probe.longtasks || []) {
        expect(Number.isFinite(task.durationMs), `iter ${iteration}: longtask bez durationMs`).toBe(true);
        expect(Number.isFinite(task.startMs), `iter ${iteration}: longtask bez startMs`).toBe(true);
      }

      expect(probe.marksPresent.beforeClick, `iter ${iteration}: brak mark before-click`).toBe(true);
      expect(probe.marksPresent.clickHandled, `iter ${iteration}: brak mark click-handled`).toBe(true);
      expect(probe.marksPresent.listVisible, `iter ${iteration}: brak mark list-visible`).toBe(true);
      expect(probe.marksPresent.apiResponse, `iter ${iteration}: brak mark api-response`).toBe(true);
      expect(probe.marksPresent.firstVisibleReaction, `iter ${iteration}: brak mark first-visible-reaction`).toBe(true);
      expect(probe.marksPresent.firstRow, `iter ${iteration}: brak mark first-row`).toBe(true);
      expect(probe.marksPresent.lastRow, `iter ${iteration}: brak mark last-row`).toBe(true);

      expect(probe.mountedRows, `iter ${iteration}: brak zamontowanych wierszy`).toBeGreaterThan(0);
      expect(seededRows.length, `iter ${iteration}: brak zamontowanych seedów`).toBeGreaterThan(0);
      expect(seededWithOpencodeIcon.length, `iter ${iteration}: brak seeda z opencode.svg`).toBeGreaterThan(0);
      if (!ARCHIVE_CONTROL) {
        expect(
          seededVisible.length,
          `iter ${iteration}: seed nie w viewporcie po scrollIntoView (zamontowane=${seededRows.length})`,
        ).toBeGreaterThan(0);
      }
      expect(visibleRows.length, `iter ${iteration}: brak wierszy w viewporcie`).toBeGreaterThan(0);

      expect(api.present, `iter ${iteration}: brak GET includeArchived=1`).toBe(true);
      expect(api.status, `iter ${iteration}: status API`).toBe(200);
      expect(api.bodyOk, `iter ${iteration}: API ok=false`).toBe(true);
      expect(api.records, `iter ${iteration}: rekordy archiwum`).toBeGreaterThanOrEqual(ARCHIVE_COUNT);
      const seededInApi = await page.evaluate(async ({ ids }) => {
        const res = await fetch('/api/chats?includeArchived=1');
        const payload = await res.json().catch(() => ({}));
        const chats = Array.isArray(payload?.chats) ? payload.chats : [];
        const idSet = new Set(ids);
        return chats.filter((chat) => idSet.has(chat.id)).length;
      }, { ids: createdChatIds });
      expect(seededInApi, `iter ${iteration}: seedów w API`).toBeGreaterThanOrEqual(ARCHIVE_COUNT);
      report.apiSeededCount = seededInApi;
      report.hermeticSharedCatalog = api.records > ARCHIVE_COUNT;

      expect(mountedWithoutImg.length, `iter ${iteration}: zamontowane wiersze bez img`).toBe(0);
      expect(visibleWithoutImg.map((row) => row.chatId), `iter ${iteration}: widoczne bez img`).toEqual([]);
      expect(visibleBrokenImg.map((row) => row.chatId), `iter ${iteration}: widoczne ze złą ikoną`).toEqual([]);

      for (const row of visibleRows) {
        expect(row.src, `iter ${iteration}: ${row.chatId} src`).toMatch(/^\/harness-icons\/[a-z0-9-]+\.svg$/);
        expect(iconAssetStatuses[row.src], `iter ${iteration}: ${row.src} HTTP`).toBe(200);
      }
    }

    const summary = {
      seeded: createdChatIds.length,
      seedWorkspaceFile: iterationReports[0]?.seedWorkspaceFile || seedWorkspaceFile,
      hermetic,
      iterations: iterationReports.map((r) => ({
        iteration: r.iteration,
        markDeltas: r.markDeltas,
        clickWindows: r.clickWindows,
        goal100Ms: r.goal100Ms,
        clickToFirstRowMs: r.clickToFirstRowMs,
        eventTimingCount: (r.eventTiming || []).length,
        longtaskMeasured: r.longtaskMeasured,
        longtaskCount: r.longtaskCount,
        maxLongtaskMs: r.maxLongtaskMs,
        longtasks: r.longtasks,
        mutationObserverActive: r.mutationObserverActive,
        mutationCount: r.mutationCount,
        mountedRows: r.mountedRows,
        visibleRows: r.visibleRows,
        seededWithOpencodeIcon: r.seededWithOpencodeIcon,
        apiRecords: r.api.records,
      })),
    };
    console.log(`ARCHIVE_EXPAND_REPORT ${JSON.stringify(summary)}`);
    const summaryPath = path.join(testInfo.outputDir, 'archive-expand-summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    await testInfo.attach('archive-expand-summary.json', {
      path: summaryPath,
      contentType: 'application/json',
    });
  } finally {
    for (const chatId of createdChatIds) {
      await deleteChatViaApi(page.request, chatId).catch(() => {});
    }
  }
});
