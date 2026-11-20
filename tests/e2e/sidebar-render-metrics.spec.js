import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  createChatViaApi,
  deleteChatViaApi,
  ensureAuthenticatedPage,
  ensureSidebarOpen,
} from './chat-e2e-helpers.js';
import { classifyRowCap, RENDERED_ROW_CAP } from '../../scripts/architecture-sidebar-row-cap.mjs';

/**
 * Opt-in `sidebarRenderMetrics` scenario (baseline section 6.2 / 6.6): DOM size, rendered rows,
 * long tasks and search latency of the real sidebar with N seeded chats. Runs on the project's
 * Playwright config; desktop is the default viewport, mobile-edge is `CHAT_E2E_MOBILE=1`
 * (390x844 emulation, NOT a real device).
 *
 *   CHAT_E2E_MEASURE=1 npx playwright test -c playwright.config.js tests/e2e/sidebar-render-metrics.spec.js
 *   CHAT_E2E_MEASURE=1 CHAT_E2E_MOBILE=1 npx playwright test -c playwright.config.js tests/e2e/sidebar-render-metrics.spec.js
 *
 * Needs a built front (`npm run build:front`) because the config starts the real server.
 * Frozen budgets (docs/architecture-baseline.md section 5) are reported as pass/fail fields, not
 * asserted, so a measurement run always produces numbers. Knobs: CHAT_E2E_MEASURE_CHATS (60),
 * CHAT_E2E_MEASURE_REPEATS (50 search keystroke samples, the plan asks for >= 50; P99 is
 * labelled `exploratory` below 1000 samples and `stable` from 1000).
 */

const CHAT_COUNT = Number.parseInt(process.env.CHAT_E2E_MEASURE_CHATS || '60', 10);
const REPEATS = Number.parseInt(process.env.CHAT_E2E_MEASURE_REPEATS || '50', 10);
// `sdk` with a dummy CURSOR_API_KEY creates chats without an external harness;
// `opencode` stays the default so the committed scenario is unchanged.
const TRANSPORT = process.env.CHAT_E2E_MEASURE_TRANSPORT || 'opencode';
const DOM_NODE_CAP = 5000;

test.skip(process.env.CHAT_E2E_MEASURE !== '1', 'Set CHAT_E2E_MEASURE=1 to run the sidebar render measurement.');

// This scenario measures the sidebar renderer, not the PWA. A controlled reload
// runs through public/sw.js network-first handling, whose 3 s timeout turns a
// slow test-server response into ERR_FAILED instead of a page, and the
// registration itself is irrelevant to DOM/latency numbers.
test.use({ serviceWorkers: 'block' });

/**
 * The fresh e2e data directory has no workspace, so the app shows its blocking
 * first-run dialog and never renders sidebar rows. Register one small folder,
 * then wait for the dialog to go away.
 *
 * @param {import('@playwright/test').Page} page
 */
async function ensureFirstRunWorkspace(page) {
  // `maybeShowFirstRunSetup` runs after the first boot render, so absence right
  // after login is not proof that the dialog will not appear; wait for it.
  const setup = page.locator('cr-first-run-setup');
  try {
    await setup.waitFor({ state: 'attached', timeout: 8_000 });
  } catch {
    return;
  }
  const dialog = setup.locator('cr-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const folderInput = setup.locator('#cr-first-run-folder input');
  if (!(await folderInput.count())) {
    await setup.locator('cr-dialog cr-bar-button').first().click();
    return;
  }
  const workspaceDir = path.resolve(process.env.CHAT_E2E_DATA_DIR || '.tmp/e2e-data', 'workspaces');
  fs.mkdirSync(workspaceDir, { recursive: true });
  await folderInput.fill(workspaceDir);
  await setup.locator('cr-dialog cr-bar-button[variant="primary"]').click();
  await expect(setup).toHaveCount(0, { timeout: 20_000 });
}

function percentile(values, q) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  return Math.round(list[Math.min(list.length - 1, Math.ceil(q * list.length) - 1)] * 100) / 100;
}

test('measurement: sidebar DOM size, rows, long tasks and search latency', async ({ page }, testInfo) => {
  test.setTimeout(240_000 + CHAT_COUNT * 500);
  await ensureAuthenticatedPage(page);
  await ensureFirstRunWorkspace(page);
  const created = [];
  try {
    for (let i = 0; i < CHAT_COUNT; i += 1) {
      const chat = await createChatViaApi(page.request, { title: `metrics-${i}-${Date.now()}`, transport: TRANSPORT });
      created.push(chat.id);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#chat-panel')).toBeVisible({ timeout: 60_000 });
    const sidebarOpened = await ensureSidebarOpen(page);
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
        }).observe({ entryTypes: ['longtask'] });
      } catch (_) {}
    });
    const measureDom = () => page.evaluate(() => {
      // The frozen cap is on real DOM nodes, so count open shadow roots too:
      // `querySelectorAll('*')` on the document misses everything inside them.
      const countDeep = (root) => {
        let count = 0;
        const stack = [root];
        while (stack.length > 0) {
          const scope = stack.pop();
          for (const el of scope.querySelectorAll('*')) {
            count += 1;
            if (el.shadowRoot) stack.push(el.shadowRoot);
          }
        }
        return count;
      };
      const sidebar = document.querySelector('#app-sidebar');
      // The default renderer is still the legacy list of `.sidebar-chat-item`
      // rows; the Lit `cr-sidebar-chat-row` hosts only appear behind the shadow
      // entity-store flag. Report both and cap on whichever actually rendered.
      const litRows = [...document.querySelectorAll('#app-sidebar cr-sidebar-chat-row')];
      const legacyRows = [...document.querySelectorAll('#app-sidebar .sidebar-chat-item')];
      const visibleLegacyRows = legacyRows.filter((row) => {
        if (row.classList.contains('is-subchat-hidden')) return false;
        const rect = row.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const activeRows = [...document.querySelectorAll('#app-sidebar .sidebar-chat-item.is-active')];
      // Classify every row the frozen cap may legitimately except. The cap names
      // focus, drag and the active row only; the active row's ancestor chain is
      // still an open human decision, so it is reported separately and never
      // counted as an allowed exception.
      const rowsById = new Map();
      for (const row of legacyRows) {
        const id = String(row.dataset.chatId || '');
        if (id) rowsById.set(id, row);
      }
      const ancestorIds = new Set();
      for (const row of activeRows) {
        let parentId = String(row.dataset.parentId || '');
        let guard = 0;
        while (parentId && rowsById.has(parentId) && guard < 200) {
          ancestorIds.add(parentId);
          parentId = String(rowsById.get(parentId).dataset.parentId || '');
          guard += 1;
        }
      }
      const focusRows = legacyRows.filter((row) => row === document.activeElement || row.contains(document.activeElement));
      const dragRows = legacyRows.filter((row) => row.classList.contains('is-dragging'));
      const allowedExceptionIds = new Set([...activeRows, ...focusRows, ...dragRows]
        .map((row) => String(row.dataset.chatId || ''))
        .filter(Boolean));
      const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : null;
      return {
        nodes: document.querySelectorAll('*').length,
        deepNodes: countDeep(document),
        sidebarNodes: sidebar ? sidebar.querySelectorAll('*').length : 0,
        sidebarDeepNodes: sidebar ? countDeep(sidebar) : 0,
        sidebarOpen: sidebarRect ? sidebarRect.width > 0 : false,
        litRows: litRows.length,
        legacyRows: legacyRows.length,
        visibleLegacyRows: visibleLegacyRows.length,
        renderedRows: Math.max(litRows.length, visibleLegacyRows.length, legacyRows.length),
        activeRows: activeRows.length,
        focusRows: focusRows.length,
        dragRows: dragRows.length,
        ancestorRows: ancestorIds.size,
        allowedExceptionRows: allowedExceptionIds.size,
      };
    });
    const dom = await measureDom();
    // `showAll`/search lifts the per-group cap of 40 but not the rendered-row cap
    // of 300. A search that matches every seeded chat is the reproducible way to
    // exercise the cap in a real page. The frozen exception list names focus,
    // drag and the active row; the active row's ancestors remain an open human
    // decision and are reported separately.
    // `#sidebar-search` is a `cr-bar-input` host (shadow DOM), so drive its
    // public value/input contract instead of Playwright `fill` on the host.
    const setSearch = (value) => page.evaluate((next) => {
      const el = document.getElementById('sidebar-search');
      if (!el) throw new Error('sidebar search input is missing');
      el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await setSearch('metrics-');
    await page.waitForTimeout(1200);
    const domSearch = await measureDom();
    await setSearch('');
    await page.waitForTimeout(500);
    const searchLatencyMs = [];
    for (let i = 0; i < REPEATS; i += 1) {
      const term = i % 2 === 0 ? 'metrics-1' : '';
      const ms = await page.evaluate(async (value) => {
        const el = document.getElementById('sidebar-search');
        const started = performance.now();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return performance.now() - started;
      }, term);
      searchLatencyMs.push(ms);
    }
    await setSearch('');
    const longTasks = await page.evaluate(() => window.__longTasks || []);
    const viewport = page.viewportSize();
    const mobile = viewport ? viewport.width < 600 : false;
    // Classify each state separately. The exceptions of one state must never
    // explain rows that only the other state rendered: `renderedRows` is a max,
    // so the exceptions have to come from the same state as that max.
    const idleRows = {
      renderedRows: dom.renderedRows,
      activeRows: dom.activeRows,
      focusRows: dom.focusRows,
      dragRows: dom.dragRows,
      ancestorRows: dom.ancestorRows,
      allowedExceptionRows: dom.allowedExceptionRows,
    };
    const searchRows = {
      renderedRows: domSearch.renderedRows,
      activeRows: domSearch.activeRows,
      focusRows: domSearch.focusRows,
      dragRows: domSearch.dragRows,
      ancestorRows: domSearch.ancestorRows,
      allowedExceptionRows: domSearch.allowedExceptionRows,
    };
    const idleCap = classifyRowCap({
      renderedRows: idleRows.renderedRows,
      allowedExceptions: idleRows.allowedExceptionRows,
      ancestorRows: idleRows.ancestorRows,
    });
    const searchCap = classifyRowCap({
      renderedRows: searchRows.renderedRows,
      allowedExceptions: searchRows.allowedExceptionRows,
      ancestorRows: searchRows.ancestorRows,
    });
    // Both states must satisfy the cap; a compliant idle state cannot excuse a
    // search state that renders too many rows, and vice versa.
    const rowCapOk = idleCap.rowCapOk && searchCap.rowCapOk;
    const worstState = idleCap.rowsOverCap >= searchCap.rowsOverCap ? 'idle' : 'search';
    const worstRows = worstState === 'idle' ? idleRows : searchRows;
    const worstCap = worstState === 'idle' ? idleCap : searchCap;
    const capExceptions = {
      active: worstRows.activeRows,
      focus: worstRows.focusRows,
      drag: worstRows.dragRows,
      ancestor: worstRows.ancestorRows,
    };
    const rowCapStates = {
      idle: {
        ...idleCap,
        activeRows: idleRows.activeRows,
        focusRows: idleRows.focusRows,
        dragRows: idleRows.dragRows,
      },
      search: {
        ...searchCap,
        activeRows: searchRows.activeRows,
        focusRows: searchRows.focusRows,
        dragRows: searchRows.dragRows,
      },
    };
    const report = {
      profile: mobile ? 'mobile-edge-emulated' : 'desktop',
      viewport,
      chats: CHAT_COUNT,
      transport: TRANSPORT,
      sidebarOpened,
      dom,
      domSearch,
      domCapOk: Math.max(dom.deepNodes, domSearch.deepNodes) <= DOM_NODE_CAP,
      rowCapOk,
      rowCap: {
        cap: RENDERED_ROW_CAP,
        renderedRows: Math.max(idleCap.renderedRows, searchCap.renderedRows),
        worstState,
        rowsOverCap: worstCap.rowsOverCap,
        exceptions: capExceptions,
        allowedExceptions: worstCap.allowedExceptions,
        unclassifiedRows: worstCap.unclassifiedRows,
        ancestorDecisionOpen: worstCap.ancestorDecisionOpen,
        states: rowCapStates,
      },
      search: {
        n: searchLatencyMs.length,
        p50: percentile(searchLatencyMs, 0.5),
        p95: percentile(searchLatencyMs, 0.95),
        p99: percentile(searchLatencyMs, 0.99),
        // A P99 from fewer than 1000 samples is directional only.
        p99Label: searchLatencyMs.length >= 1000 ? 'stable' : 'exploratory',
        max: percentile(searchLatencyMs, 1),
        budgetP95Ms: mobile ? 200 : 100,
      },
      longTasks: { count: longTasks.length, over100: longTasks.filter((d) => d > 100).length, max: Math.round(Math.max(0, ...longTasks)) },
      note: 'emulated viewport only; deepNodes includes open shadow roots; real-device runs are separate (docs/architecture-frontend-baseline.md)',
    };
    console.log(`SIDEBAR_RENDER_METRICS ${JSON.stringify(report)}`);
    await testInfo.attach('sidebar-render-metrics.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    const outFile = process.env.CHAT_E2E_MEASURE_OUT;
    if (outFile) {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    for (const id of created) await deleteChatViaApi(page.request, id).catch(() => {});
  }
});
