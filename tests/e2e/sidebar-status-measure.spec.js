import { test, expect } from '@playwright/test';
import {
  createChatViaApi,
  deleteChatViaApi,
  ensureAuthenticatedPage,
  ensureSidebarOpen,
} from './chat-e2e-helpers.js';

/**
 * Opt-in instrumented measurement for the sidebar live-status work. It reuses the
 * `uiFreezeDiag` trace from the baseline (sub-task 1) and reads the persisted
 * freeze log (`cretli-freeze-log-buffer`) to report the "after" numbers for the
 * client-side columns.
 *
 * Run with:
 *   CHAT_E2E_MEASURE=1 ... npx playwright test tests/e2e/sidebar-status-measure.spec.js
 *
 * It is skipped unless `CHAT_E2E_MEASURE=1`, so the normal mock suite stays fast.
 * Presence frames are synthetic (one OpenCode chat created through the UI plus
 * four through the API in the same workspace) — this is NOT the live 3–5 agent
 * scenario; it only exercises the client render/patch path under presence churn.
 */

const MEASURE_MS = Number.parseInt(process.env.CHAT_E2E_MEASURE_MS || '60000', 10);
const FRAME_INTERVAL_MS = Number.parseInt(process.env.CHAT_E2E_MEASURE_FRAME_MS || '250', 10);

test.skip(process.env.CHAT_E2E_MEASURE !== '1', 'Set CHAT_E2E_MEASURE=1 to run the sidebar trace measurement.');

function parseTraceText(text) {
  const raw = String(text || '');
  const space = raw.indexOf(' ');
  if (space < 0) return { name: raw, payload: {} };
  const name = raw.slice(0, space);
  try {
    return { name, payload: JSON.parse(raw.slice(space + 1)) };
  } catch (_) {
    return { name, payload: {} };
  }
}

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return 0;
  return Math.round(list[Math.floor((list.length - 1) / 2)]);
}

test('measurement: sidebar status trace over 60s of presence churn', async ({ page }) => {
  test.setTimeout(MEASURE_MS + 180_000);

  /** @type {Array<{ client: any }>} */
  const sockets = [];
  await page.routeWebSocket(/\/ws-agent-sdk/, (client) => {
    const server = client.connectToServer();
    sockets.push({ client });
    // Keep the real socket flowing; the measurement pushes its own snapshots.
    server.onMessage((message) => client.send(message));
  });

  // The mock server keeps the freeze flag off, and boot reads the flag from the
  // server (overwriting localStorage) while the SPA router strips the URL query.
  // Turn the server flag on and reload so the trace stays active for the window.
  await ensureAuthenticatedPage(page);
  const authStatus = await (await page.request.get('/api/auth-status')).json().catch(() => ({}));
  const csrfToken = typeof authStatus?.csrfToken === 'string' ? authStatus.csrfToken : '';
  const settingsHeaders = csrfToken ? { 'X-Cretli-Csrf': csrfToken } : {};
  await page.request.patch('/api/settings', { headers: settingsHeaders, data: { debugUiFreeze: true } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#chat-panel')).toBeVisible({ timeout: 60_000 });

  // One chat through the UI learns the header workspace, the rest reuse it.
  await ensureSidebarOpen(page);
  await page.evaluate(() => {
    const trigger = document.querySelector('.sidebar-workspace-new-btn');
    if (!(trigger instanceof HTMLElement)) throw new Error('Sidebar new chat button is missing');
    trigger.click();
  });
  const modal = page.locator('#chat-new-modal');
  await expect(modal).toBeVisible();
  await modal.locator('#chat-new-harness-select').selectOption('opencode');
  await modal.locator('#chat-new-create').click();
  await expect(modal).toBeHidden({ timeout: 20_000 });

  let firstChatId = '';
  await expect.poll(async () => {
    firstChatId = await page.evaluate(() => {
      const row = document.querySelector('#app-sidebar .sidebar-chat-item.is-active');
      return row?.dataset?.chatId || '';
    });
    return firstChatId;
  }, { timeout: 15_000 }).not.toBe('');

  const listPayload = await (await page.request.get('/api/chats')).json().catch(() => ({}));
  const firstChat = (listPayload?.chats || []).find((row) => row.id === firstChatId) || {};
  const workspaceFile = typeof firstChat.workspaceFile === 'string' ? firstChat.workspaceFile : '';
  const workspaceFolder = typeof firstChat.workspaceFolder === 'string' ? firstChat.workspaceFolder : '';

  const chatIds = [firstChatId];
  try {
    for (let i = 0; i < 4; i += 1) {
      const chat = await createChatViaApi(page.request, {
        title: `measure-status-${i}-${Date.now()}`,
        transport: 'opencode',
        workspaceFile,
        workspaceFolder,
      });
      chatIds.push(chat.id);
    }
    await ensureSidebarOpen(page);
    await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThan(0);
    // Let the initial boot + first renders settle before the measured window.
    await page.waitForTimeout(5000);

    /**
     * The persisted freeze buffer is capped at 400 entries, so a long window is
     * collected incrementally and merged by (ts, tag, text) to avoid truncation.
     */
    const collected = new Map();
    const collectEntries = async () => {
      const raw = await page.evaluate(() => localStorage.getItem('cretli-freeze-log-buffer'));
      if (!raw) return;
      try {
        const doc = JSON.parse(raw);
        for (const entry of doc.entries || []) {
          collected.set(`${entry.ts}|${entry.tag}|${entry.text}`, entry);
        }
      } catch (_) {}
    };

    const sessionStart = Date.now();
    let seq = 2_000_000;
    const busy = new Set();
    const startedAt = Date.now();
    let frames = 0;
    let lastCollectAt = startedAt;
    while (Date.now() - startedAt < MEASURE_MS) {
      const chatId = chatIds[frames % chatIds.length];
      if (busy.has(chatId)) busy.delete(chatId);
      else busy.add(chatId);
      const states = {};
      for (const id of busy) {
        states[id] = { state: 'busy', activityKey: 'read', activityArg: `file-${seq}.js` };
      }
      const frame = JSON.stringify({ type: 'agentPresence', snapshot: true, seq: ++seq, states });
      for (const socket of sockets) {
        try {
          socket.client.send(frame);
        } catch (_) {}
      }
      frames += 1;
      await page.waitForTimeout(FRAME_INTERVAL_MS);
      if (Date.now() - lastCollectAt >= 5000) {
        lastCollectAt = Date.now();
        await collectEntries();
      }
    }

    // Let the last frame flush into the 1s trace window.
    await page.waitForTimeout(1500);
    await collectEntries();

    const diagnostics = await page.evaluate(() => ({
      search: location.search,
      storedFlag: localStorage.getItem('cretli-ui-freeze-diag'),
      freezeKeys: Object.keys(localStorage).filter((key) => key.includes('freeze')),
    }));
    const entries = [...collected.values()].filter((entry) => Number(entry.ts) >= sessionStart - 1000);

    let rebuilds = 0;
    let skips = 0;
    let patchAll = 0;
    let perDirty = 0;
    let presenceDup = 0;
    /** @type {Record<string, number>} */
    const rebuildSegments = {};
    const sigSamples = [];
    const snapshots = [];
    for (const entry of entries) {
      const { name, payload } = parseTraceText(entry.text);
      if (name === 'sidebar:render-rebuild') {
        rebuilds += 1;
        sigSamples.push(Number(payload.sigMs));
        for (const segment of payload.changedSegments || []) {
          rebuildSegments[segment] = (rebuildSegments[segment] || 0) + 1;
        }
      } else if (name === 'sidebar:render-skip') {
        skips += 1;
        sigSamples.push(Number(payload.sigMs));
      } else if (name === 'sidebar:sidebar-patch') {
        if (payload.patchAll === true) patchAll += 1;
        else perDirty += 1;
      } else if (name === 'sidebar:presence-dup') {
        presenceDup += 1;
      } else if (name === 'sidebar:snapshot') {
        snapshots.push(payload);
      }
    }
    const notifySidebarTotal = snapshots.reduce(
      (sum, snap) => sum + (Number(snap?.perSec?.notifySidebar) || 0),
      0,
    );
    const summary = {
      windowMs: Date.now() - sessionStart,
      framesSent: frames,
      presenceDup,
      renders: { rebuilds, skips },
      rebuildSegments,
      patch: { patchAll, perDirty },
      notifySidebarTotal,
      signatureMs: { median: median(sigSamples), samples: sigSamples.length },
      entries: entries.length,
      diagnostics,
    };
    console.log('SIDEBAR_MEASUREMENT ' + JSON.stringify(summary));

    // The measurement only means something if the trace and the frames actually ran.
    expect(frames).toBeGreaterThan(0);
    expect(entries).toBeGreaterThan(0);
    // Status is not part of the render signature, so presence churn must never be
    // the segment that forced a full rebuild.
    expect(rebuildSegments.status || 0).toBe(0);
  } finally {
    await page.request
      .patch('/api/settings', { headers: settingsHeaders, data: { debugUiFreeze: false } })
      .catch(() => {});
    for (const chatId of chatIds) {
      await deleteChatViaApi(page.request, chatId).catch(() => {});
    }
  }
});
