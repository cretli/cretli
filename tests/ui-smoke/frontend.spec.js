import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage, ensureSidebarOpen, createChatViaApi, selectChatInSidebar } from '../e2e/chat-e2e-helpers.js';
import { ensureScopedRouteContext } from '../e2e/spa-route-helpers.js';
import { fileURLToPath } from 'node:url';

test('built frontend: Chat, Terminal, Todo and Settings', async ({ page }, testInfo) => {
  const errors = [];
  const terminalSockets = new Map();
  const sockets = [];
  page.on('websocket', (socket) => {
    sockets.push(socket.url());
    if (new URL(socket.url()).pathname !== '/ws') return;
    terminalSockets.set(socket, '');
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.type === 'output') terminalSockets.set(socket, terminalSockets.get(socket) + String(frame.data));
      } catch { /* Ignore non-JSON frames. */ }
    });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || /unhandled|TypeError|missing[ _-]?key/i.test(message.text())) errors.push(message.text());
  });
  try {
    await ensureAuthenticatedPage(page);
    const scope = await ensureScopedRouteContext(page.request);
    // Seed a dormant chat: rendering must not require provider credentials or a model run.
    const chat = await createChatViaApi(page.request, {
      title: 'UI smoke', transport: 'sdk', workspaceFolder: fileURLToPath(new URL('../..', import.meta.url)),
    });
    await page.goto(`/chat?${new URLSearchParams({ ws: scope.workspaceKey, folder: scope.folderKey })}`);
    expect(await ensureSidebarOpen(page)).toBe(true);
    await expect(page.locator('#app-sidebar')).toBeVisible();
    await selectChatInSidebar(page, chat.id);
    const modeBar = page.locator('cr-sdk-mode-bar').first();
    await expect(modeBar).toBeVisible();
    // An undefined custom element can exist in the DOM; require its rendered controls.
    await expect(modeBar.locator('button.mode')).toBeVisible();
    await page.locator('#sidebar-close-btn').click();
    await expect(page.locator('#app-sidebar')).toBeHidden();

    await page.locator('.tab[data-panel="terminal"]').click();
    await expect(page.locator('#terminal-panel')).toBeVisible();
    await expect(page.locator('#terminal-main .xterm').first()).toBeVisible();
    const terminalInput = page.locator('#terminal-main .xterm-helper-textarea').first();
    await terminalInput.pressSequentially("printf 'UI_%s_DONE\\n' smoke");
    await terminalInput.press('Enter');
    // The result is absent from the command text, so local echo cannot satisfy this check.
    await expect.poll(() => [...terminalSockets].some(([socket, output]) => !socket.isClosed()
      && new URL(socket.url()).searchParams.get('scoped') === '1' && output.includes('UI_smoke_DONE'))).toBeTruthy();

    await page.locator('.tab[data-panel="todo"]').click();
    await expect(page.locator('#todo-panel')).toBeVisible();
    for (const tab of ['watcher', 'list']) {
      await page.locator(`#todo-tabs [data-tab="${tab}"]`).click();
      await expect(page.locator(`#todo-tabs [data-tab="${tab}"]`)).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(`[data-todo-tab-panel="${tab}"]`)).toBeVisible();
    }
    await page.locator('#header-settings-btn').click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    await expect(page.locator('#settings-tabs')).toBeVisible();
    await page.locator('#settings-back-btn').click();
    await page.locator('.tab[data-panel="chat"]').click();
    await expect(modeBar.locator('button.mode')).toBeVisible();
    expect(errors, 'Frontend console errors').toEqual([]);
  } finally {
    await testInfo.attach('console-errors', { body: JSON.stringify(errors, null, 2), contentType: 'application/json' });
    await testInfo.attach('terminal-sockets', { body: JSON.stringify({ sockets, output: [...terminalSockets.values()] }, null, 2), contentType: 'application/json' });
  }
});
