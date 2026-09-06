import { test, expect } from '@playwright/test';
import {
  ensureAuthenticatedPage,
  ensureSidebarOpen,
  setActiveModeInPane,
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

async function locateModeBar(page) {
  return page.locator('.chat-fullscreen-bar cr-sdk-mode-bar, cr-sdk-mode-bar').first();
}

async function openModeMenu(page) {
  const modeBar = await locateModeBar(page);
  await expect(modeBar).toBeVisible();
  await modeBar.evaluate((el) => {
    const root = el?.shadowRoot;
    const trigger = root?.querySelector('.mode');
    if (!(trigger instanceof HTMLButtonElement)) throw new Error('Mode trigger is missing');
    trigger.click();
  });
  const menu = page.locator('#cr-sdk-mode-menu');
  await expect(menu).toBeVisible();
  return { modeBar, menu };
}

async function readModeTriggerText(page) {
  const modeBar = await locateModeBar(page);
  return modeBar.evaluate((el) => {
    const trigger = el?.shadowRoot?.querySelector('.mode');
    return String(trigger?.textContent || '').replace('▾', '').trim();
  });
}

async function readModeTriggerAria(page) {
  const modeBar = await locateModeBar(page);
  return modeBar.evaluate((el) => {
    const trigger = el?.shadowRoot?.querySelector('.mode');
    return String(trigger?.getAttribute('aria-label') || '');
  });
}

async function isBuildPlanVisible(page) {
  const modeBar = await locateModeBar(page);
  return modeBar.evaluate((el) => Boolean(el?.shadowRoot?.querySelector('.build')));
}

async function dismissFirstRunIfPresent(page) {
  const setup = page.locator('cr-first-run-setup');
  for (let i = 0; i < 4; i += 1) {
    if (!(await setup.count())) return;
    const skip = setup.locator('cr-bar-button').filter({ hasText: /Skip/i }).first();
    if (!(await skip.count())) return;
    await skip.click();
    await expect(setup).toBeHidden({ timeout: 5_000 }).catch(() => {});
  }
}

async function createOpenCodeChatFromSidebar(page) {
  await ensureSidebarOpen(page);
  await expect(page.locator('.sidebar-workspace-new-btn').first()).toBeVisible();
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
  await harnessSelect.selectOption('opencode');
  await modal.locator('#chat-new-create').click();
  await expect(modal).toBeHidden({ timeout: 20_000 });
}

test('mock: Plan / Agent / Ask dropdown selection, keyboard, persist, and viewports', async ({ page }, testInfo) => {
  await ensureAuthenticatedPage(page);
  await dismissFirstRunIfPresent(page);
  await createOpenCodeChatFromSidebar(page);
  const modeBar = page.locator('.chat-fullscreen-bar cr-sdk-mode-bar, cr-sdk-mode-bar').first();
  await expect(modeBar).toBeVisible();
  await expect.poll(() => readModeTriggerText(page)).toBe('Agent');
  expect(await isBuildPlanVisible(page)).toBe(false);

  const { menu } = await openModeMenu(page);
  const items = menu.locator('[role="menuitemradio"]');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute('data-mode', 'plan');
  await expect(items.nth(1)).toHaveAttribute('data-mode', 'agent');
  await expect(items.nth(2)).toHaveAttribute('data-mode', 'ask');
  await expect(menu.locator('[data-mode="agent"]')).toHaveAttribute('aria-checked', 'true');
  await expect(menu.locator('[data-mode="plan"]')).toHaveAttribute('aria-checked', 'false');
  await expect(menu.locator('[data-mode="ask"]')).toHaveAttribute('aria-checked', 'false');
  await testInfo.attach('mode-dropdown-desktop', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });

  await menu.locator('[data-mode="plan"]').click();
  await expect.poll(() => readModeTriggerText(page)).toBe('Plan');
  expect(await isBuildPlanVisible(page)).toBe(true);

  await setActiveModeInPane(page, 'ask');
  await expect.poll(() => readModeTriggerText(page)).toBe('Ask');
  expect(await isBuildPlanVisible(page)).toBe(false);
  const afterAsk = await openModeMenu(page);
  await expect(afterAsk.menu.locator('[data-mode="ask"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(afterAsk.menu).toBeHidden();
  await expect.poll(() => readModeTriggerText(page)).toBe('Ask');

  await openModeMenu(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#cr-sdk-mode-menu')).toBeHidden();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureAuthenticatedPage(page);
  await dismissFirstRunIfPresent(page);
  await expect.poll(() => readModeTriggerText(page)).toBe('Ask');

  await page.evaluate(() => {
    localStorage.setItem('cretli-lang', 'pl');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureAuthenticatedPage(page);
  await dismissFirstRunIfPresent(page);
  await expect.poll(() => readModeTriggerText(page)).toBe('Ask');
  await expect.poll(() => readModeTriggerAria(page)).toBe('Tryb czatu');
  await page.evaluate(() => {
    localStorage.setItem('cretli-lang', 'en');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureAuthenticatedPage(page);
  await dismissFirstRunIfPresent(page);
  await expect.poll(() => readModeTriggerAria(page)).toBe('Chat mode');

  const fullscreenBtn = page.locator('#chat-fullscreen-btn');
  if (await fullscreenBtn.isVisible()) {
    await fullscreenBtn.click();
    const { menu: fullscreenMenu } = await openModeMenu(page);
    await expect(fullscreenMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await fullscreenBtn.click();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await openModeMenu(page);
  await expect(page.locator('#cr-sdk-mode-menu [data-mode="ask"]')).toBeVisible();
  await testInfo.attach('mode-dropdown-mobile', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await page.keyboard.press('Escape');
});
