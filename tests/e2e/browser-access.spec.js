import { test, expect } from '@playwright/test';
import { ensureMockNewChatEnvironment } from './chat-e2e-helpers.js';

for (const width of [390, 1440]) {
  test(`global browser approval outside the requesting chat (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let prompts = [];
    let fail = true;
    const answers = [];
    await page.route('**/api/browser/requests', (route) => route.fulfill({ json: { ok: true, prompts } }));
    await page.route('**/api/browser/access/chrome-1', (route) => {
      if (fail) return route.fulfill({ status: 500, json: { ok: false, code: 'temporary' } });
      answers.push(route.request().postDataJSON());
      prompts = prompts.filter((prompt) => prompt.id !== 'chrome-1');
      return route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/browser/consent/nav-1', (route) => {
      answers.push(route.request().postDataJSON());
      prompts = [];
      return route.fulfill({ json: { ok: true } });
    });
    await ensureMockNewChatEnvironment(page);
    await page.locator('#header-settings-btn').click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    prompts = [
      { id: 'chrome-1', chatId: 'background-chat', chatTitle: 'Checkout preview', kind: 'chrome' },
      { id: 'nav-1', chatId: 'other-chat', chatTitle: 'Docs preview', kind: 'navigation', origin: 'https://example.com' },
    ];
    // No consent event: the global fallback must work without that chat's socket.
    const panel = page.locator('cr-browser-access-dialog cr-dialog');
    const dialog = panel.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 12_000 });
    await expect(panel).toContainText('Checkout preview');
    await expect(panel).toContainText('Claude in Chrome');
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    const allow = panel.getByRole('button', { name: /Allow for this run|Zezwól na to uruchomienie/ });
    await allow.click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel).toContainText('Checkout preview');
    fail = false;
    await page.screenshot({ path: `test-results/browser-access-${width}.png` });
    await allow.click();
    await expect(panel).toContainText('Docs preview');
    await expect(panel).toContainText('https://example.com');
    await panel.getByRole('button', { name: /^(Deny|Odmów)$/ }).click();
    await expect(panel).toHaveCount(0);
    expect(answers).toEqual([
      { chatId: 'background-chat', decision: 'allow' },
      { chatId: 'other-chat', decision: 'deny' },
    ]);
    await expect(page.locator('#settings-panel')).toBeVisible();
  });
}
