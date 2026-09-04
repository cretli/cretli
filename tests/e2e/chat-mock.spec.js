import { test, expect } from '@playwright/test';
import {
  ensureAuthenticatedPage,
} from './chat-e2e-helpers.js';

test.describe.configure({ mode: 'serial' });

test('mock: opens new chat modal with all harness options', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const sidebarNewChatButton = page.locator('.sidebar-workspace-new-btn').first();
  await expect(sidebarNewChatButton).toHaveCount(1);
  await page.evaluate(() => {
    const trigger = document.querySelector('.sidebar-workspace-new-btn');
    if (!(trigger instanceof HTMLElement)) {
      throw new Error('Sidebar new chat button is missing');
    }
    trigger.click();
  });
  const modal = page.locator('#chat-new-modal');
  await expect(modal).toBeVisible();
  const harnessSelect = modal.locator('#chat-new-harness-select');
  await expect(harnessSelect).toBeVisible();
  const harnessValues = await harnessSelect.locator('option').evaluateAll((options) =>
    options.map((entry) => (entry instanceof HTMLOptionElement ? entry.value : '')),
  );
  expect(harnessValues).toContain('sdk');
  expect(harnessValues).toContain('opencode');
  expect(harnessValues).toContain('openrouter');
  expect(harnessValues).toContain('codebuddy');
  expect(harnessValues).toContain('deepseek');
  expect(harnessValues).toContain('codex');
  expect(harnessValues).toContain('qwen');
  await modal.locator('#chat-new-cancel').click();
  await expect(modal).toBeHidden();
});
