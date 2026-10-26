import { test, expect } from '@playwright/test';
import { ensureMockNewChatEnvironment, ensureSidebarOpen, searchableSelectTrigger } from './chat-e2e-helpers.js';

test('new chat: limits block only the affected model and reopening preserves the form', async ({ page }) => {
  let lockouts = [{ harness: 'codex', model: 'model-a', code: 'usage_limit', resetAt: new Date(Date.now() + 3600000).toISOString(), resetSource: 'provider' }];
  await page.route('**/api/usage/plan-limits', (route) => route.fulfill({ json: { ok: true, lockouts } }));
  await page.route('**/api/codex/status', (route) => route.fulfill({ json: { ok: true, ready: true, sdkAvailable: true, cliFound: true } }));
  await page.route('**/api/codex/models*', (route) => route.fulfill({ json: { ok: true, models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] } }));
  await ensureMockNewChatEnvironment(page);
  await ensureSidebarOpen(page);
  await expect(page.locator('.sidebar-workspace-new-btn').first()).toBeVisible();
  await page.locator('.sidebar-workspace-new-btn').first().click();
  const modal = page.locator('#chat-new-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('#chat-new-plan-reviewer-row')).toBeHidden();
  const picker = modal.locator('#chat-new-agent-model');
  await searchableSelectTrigger(picker).click();
  const dropdown = page.locator('.cr-searchable-select-modal:not([hidden])');
  // The new-chat picker opens on "Available models", which hides blocked rows; switch to
  // "All models" to assert that a limited model stays listed but disabled.
  await dropdown.getByRole('button', { name: 'All models' }).click();
  const search = dropdown.locator('input');
  await search.fill('codex');
  const blocked = dropdown.getByRole('option', { name: /^Codex · Model A/ });
  await expect(blocked).toHaveAttribute('aria-disabled', 'true');
  await blocked.click({ force: true });
  await expect(dropdown).toBeVisible();
  await search.fill('model-b');
  await expect(dropdown.getByRole('option')).toHaveCount(1);
  await expect(dropdown.getByRole('option')).toHaveAttribute('aria-disabled', 'false');
  await search.press('Enter');
  await expect(dropdown).toBeHidden();
  await expect(modal.locator('#chat-new-create')).toBeEnabled();
  await expect(picker).toContainText('Codex · Model B');
  await modal.locator('#chat-new-title-input').fill('My chat');
  lockouts = [];
  await searchableSelectTrigger(picker).click();
  await expect(dropdown).toBeVisible();
  await expect(modal.locator('#chat-new-create')).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dropdown).toBeHidden();
  await expect(modal.locator('#chat-new-harness-select')).toHaveValue('codex');
  await expect(modal.locator('#chat-new-model-select')).toHaveValue('model-b');
  await expect(modal.locator('#chat-new-title-input')).toHaveValue('My chat');
  await modal.locator('#chat-new-cancel').click();
  await expect(modal).toBeHidden();
});
