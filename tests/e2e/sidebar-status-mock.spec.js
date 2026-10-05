import { test, expect } from '@playwright/test';
import {
  deleteChatViaApi,
  ensureAuthenticatedPage,
  ensureSidebarOpen,
} from './chat-e2e-helpers.js';

/**
 * Focused, mock-data regression spec for the sidebar live-status work:
 *
 *  1. A presence change paints only the affected row in place — the `<li>` node
 *     identity survives idle -> working -> idle — and the working status is still
 *     there after a reload even when the HTTP agent-states poll is blocked (the
 *     WS presence snapshot, backed by the per-chat presence store, carries it).
 *  2. On a mobile viewport the first real tap still closes the drawer right after
 *     an interrupted swipe (the synthetic-click swallow must self-expire).
 *
 * No live harness is started: presence frames are injected onto the routed agent
 * socket while the real server connection is kept for everything else.
 */

function chatRow(page, chatId) {
  return page.locator(`#app-sidebar .sidebar-chat-item[data-chat-id="${chatId}"]`).first();
}

/** Reads the status tone currently rendered on the row's chip. */
function rowTone(rowOrHandle) {
  return rowOrHandle.evaluate((el) => {
    const chip = el.querySelector('.sidebar-chat-item-awaiting');
    return chip ? chip.getAttribute('data-status-tone') || '' : '';
  });
}

/**
 * Creates an OpenCode chat through the sidebar so it lands in the workspace the
 * header currently shows (a chat created through the API without a workspace is
 * not grouped into any sidebar workspace and never renders).
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} the new chat id
 */
async function createOpenCodeChatFromSidebar(page) {
  await ensureSidebarOpen(page);
  await expect(page.locator('.sidebar-workspace-new-btn').first()).toBeVisible();
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
  let chatId = '';
  await expect.poll(async () => {
    chatId = await page.evaluate(() => {
      const row = document.querySelector('#app-sidebar .sidebar-chat-item.is-active')
        || document.querySelector('#app-sidebar .sidebar-chat-item[aria-selected="true"]');
      return row?.dataset?.chatId || '';
    });
    return chatId;
  }, { timeout: 15_000 }).not.toBe('');
  return chatId;
}

test('mock: sidebar chat status patches its row in place and survives reload', async ({ page }) => {
  /** @type {Array<{ client: any, server: any }>} */
  const sockets = [];
  /** Presence the spec wants every server snapshot to carry (survives reload). */
  let injectedPresence = null;
  let presenceSeq = 1_000_000;

  await page.routeWebSocket(/\/ws-agent-sdk/, (client) => {
    const server = client.connectToServer();
    const entry = { client, server };
    sockets.push(entry);
    // Server -> page frames are intercepted so the injected presence can be merged
    // into the authoritative snapshot. Without manual forwarding the route would
    // stop auto-forwarding, so every message is sent through explicitly.
    server.onMessage((message) => {
      let outbound = message;
      try {
        const text = typeof message === 'string' ? message : message.toString('utf8');
        const parsed = JSON.parse(text);
        if (parsed?.type === 'agentPresence' && injectedPresence) {
          outbound = JSON.stringify({
            ...parsed,
            snapshot: true,
            states: { ...(parsed.states || {}), ...injectedPresence },
            cleared: [],
          });
        }
      } catch (_) {
        // Non-JSON frames are forwarded untouched.
      }
      client.send(outbound);
    });
  });

  await ensureAuthenticatedPage(page);
  const chatId = await createOpenCodeChatFromSidebar(page);
  // Creating a chat closes the drawer; reopen it before asserting on the row.
  await ensureSidebarOpen(page);

  try {
    const row = chatRow(page, chatId);
    await expect(row).toBeVisible();
    await expect.poll(() => rowTone(row)).toBe('idle');

    // The presence frame travels on the chat's own agent socket, so wait until it
    // is connected before pushing anything.
    await expect.poll(() => sockets.length).toBeGreaterThan(0);

    const rowHandle = await row.elementHandle();
    expect(rowHandle).not.toBeNull();
    const sameRowNode = () => page.evaluate((el) => {
      const current = document.querySelector(
        `#app-sidebar .sidebar-chat-item[data-chat-id="${el?.dataset?.chatId || ''}"]`,
      );
      return current === el;
    }, rowHandle);

    const busyState = { state: 'busy', activityKey: 'read', activityArg: 'src/main.js' };

    // idle -> working.
    injectedPresence = { [chatId]: busyState };
    const busyFrame = JSON.stringify({
      type: 'agentPresence',
      snapshot: true,
      seq: ++presenceSeq,
      states: { [chatId]: busyState },
    });
    for (const socket of sockets) socket.client.send(busyFrame);

    await expect.poll(() => rowTone(rowHandle)).toBe('active');
    expect(await sameRowNode()).toBe(true);

    // working -> idle.
    injectedPresence = null;
    const idleFrame = JSON.stringify({ type: 'agentPresence', snapshot: true, seq: ++presenceSeq, states: {} });
    for (const socket of sockets) socket.client.send(idleFrame);

    await expect.poll(() => rowTone(rowHandle)).toBe('idle');
    expect(await sameRowNode()).toBe(true);

    // Reload with the chat busy again. The agent-states poll is blocked, so only
    // the WS snapshot + presence store can produce the status on the reloaded page.
    injectedPresence = { [chatId]: { state: 'busy', activityKey: 'edit', activityArg: 'a.js' } };
    await page.route('**/api/chats/agent-states*', (route) => route.abort());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ensureAuthenticatedPage(page);
    await ensureSidebarOpen(page);

    const reloadedRow = chatRow(page, chatId);
    await expect(reloadedRow).toBeVisible();
    await expect.poll(() => rowTone(reloadedRow), { timeout: 10_000 }).toBe('active');
  } finally {
    await deleteChatViaApi(page.request, chatId).catch(() => {});
  }
});

/**
 * Opens the drawer and keeps trying until it survives the boot-time resume cleanup,
 * which force-closes an unpinned drawer on mobile shortly after `pageshow`.
 * @param {import('@playwright/test').Page} page
 */
async function openSidebarStable(page) {
  const sidebar = page.locator('#app-sidebar');
  const menu = page.locator('#header-menu-btn').first();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await sidebar.isVisible()) {
      await page.waitForTimeout(400);
      if (await sidebar.isVisible()) return;
    }
    await menu.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }
  throw new Error('Sidebar did not stay open');
}

async function dispatchInterruptedSwipe(page) {
  await page.evaluate(() => {
    const sidebar = document.getElementById('app-sidebar');
    if (!(sidebar instanceof HTMLElement)) throw new Error('Sidebar is missing');
    const rect = sidebar.getBoundingClientRect();
    const pointerId = 4242;
    const startX = Math.round(rect.left + rect.width - 24);
    const y = Math.round(rect.top + 140);
    const pointerType = 'touch';
    sidebar.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType,
      isPrimary: true,
      buttons: 1,
      clientX: startX,
      clientY: y,
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType,
      isPrimary: true,
      buttons: 1,
      clientX: startX - 40,
      clientY: y,
    }));
  });
  // A slow release keeps the velocity at zero so the swipe settles back instead of
  // committing to close, which is what arms the synthetic-click window.
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      cancelable: true,
      pointerId: 4242,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 0,
      clientY: 0,
    }));
  });
  // Let the snap-back transition finish and arm the suppression window.
  await page.waitForTimeout(320);
}

test('mock: first tap closes the sidebar after an interrupted swipe (mobile)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ensureAuthenticatedPage(page);
  await openSidebarStable(page);

  const sidebar = page.locator('#app-sidebar');
  await expect(sidebar).toBeVisible();

  await dispatchInterruptedSwipe(page);
  await expect(sidebar).toBeVisible();

  // The first real click after the gesture must still close the drawer: the
  // pointerdown resets the synthetic-click window instead of eating this tap.
  await page.locator('#sidebar-close-btn').click();
  await expect(sidebar).toBeHidden();
});
