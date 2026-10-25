import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import { ensureScopedRouteContext } from './spa-route-helpers.js';

test.describe.configure({ mode: 'serial' });

test('invalid files path is stripped and shows a notice', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  await ensureScopedRouteContext(page.request);
  await page.goto('/files?path=..%2Foutside', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#files-panel.active')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#cr-navigation-resource-notice')).toBeVisible({ timeout: 15_000 });
  const url = new URL(page.url());
  expect(url.pathname.replace(/\/$/, '')).toBe('/files');
  expect(url.searchParams.has('path')).toBe(false);
});

test('unknown tasks run id is stripped from the URL', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  await ensureScopedRouteContext(page.request);
  await page.goto('/tasks?run=e2e-unknown-run-id', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#tasks-panel.active')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#cr-navigation-resource-notice')).toBeVisible({ timeout: 15_000 });
  const url = new URL(page.url());
  expect(url.searchParams.has('run')).toBe(false);
});
