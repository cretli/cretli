import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import {
  buildGitScopedPath,
  ensureScopedRouteContext,
} from './spa-route-helpers.js';

test.describe.configure({ mode: 'serial' });

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ workspaceKey: string, folderKey: string }} scope
 */
async function assertGitWorktreesSubview(page, scope) {
  const url = new URL(page.url());
  expect(url.pathname.replace(/\/$/, '')).toBe('/git/worktrees');
  expect(url.searchParams.get('ws')).toBe(scope.workspaceKey);
  expect(url.searchParams.get('folder')).toBe(scope.folderKey);
  await expect(page.locator('#git-panel.active')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#git-worktrees')).toBeVisible();
  const worktreesTab = page.locator('[data-git-view="worktrees"]').first();
  await expect(worktreesTab).toHaveClass(/active/);
  await expect(worktreesTab).toHaveAttribute('aria-selected', 'true');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ workspaceKey: string, folderKey: string }} scope
 */
async function assertGitMainSubview(page, scope) {
  const url = new URL(page.url());
  expect(url.pathname.replace(/\/$/, '')).toBe('/git');
  expect(url.searchParams.get('ws')).toBe(scope.workspaceKey);
  expect(url.searchParams.get('folder')).toBe(scope.folderKey);
  await expect(page.locator('#git-panel.active')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#git-main-view')).toBeVisible();
  await expect(page.locator('#git-worktrees')).toBeHidden();
}

test('/git/worktrees keeps ws, folder and subview after reload', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const scope = await ensureScopedRouteContext(page.request);
  const target = buildGitScopedPath(scope.workspaceKey, scope.folderKey, 'worktrees');
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await assertGitWorktreesSubview(page, scope);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await assertGitWorktreesSubview(page, scope);
});

test('back and forward between /git and /git/worktrees preserves scoped URL', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const scope = await ensureScopedRouteContext(page.request);
  await page.goto(buildGitScopedPath(scope.workspaceKey, scope.folderKey, 'worktrees'), {
    waitUntil: 'domcontentloaded',
  });
  await assertGitWorktreesSubview(page, scope);
  await page.goto(buildGitScopedPath(scope.workspaceKey, scope.folderKey, 'main'), {
    waitUntil: 'domcontentloaded',
  });
  await assertGitMainSubview(page, scope);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await assertGitWorktreesSubview(page, scope);
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await assertGitMainSubview(page, scope);
});

test('direct link to /git/worktrees opens Git worktrees subview', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const scope = await ensureScopedRouteContext(page.request);
  await page.goto('/chat', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#chat-panel.active')).toBeVisible();
  await page.goto(buildGitScopedPath(scope.workspaceKey, scope.folderKey, 'worktrees'), {
    waitUntil: 'domcontentloaded',
  });
  await assertGitWorktreesSubview(page, scope);
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ workspaceKey: string, folderKey: string }} scope
 * @param {string} tabId
 */
async function assertSettingsTabRoute(page, scope, tabId) {
  const url = new URL(page.url());
  expect(url.pathname.replace(/\/$/, '')).toBe(`/settings/${tabId}`);
  expect(url.searchParams.get('ws')).toBe(scope.workspaceKey);
  expect(url.searchParams.get('folder')).toBe(scope.folderKey);
  await expect(page.locator('#settings-panel.active')).toBeVisible({ timeout: 60_000 });
  const tabBtn = page.locator(`#settings-tabs .settings-tab[data-settings-tab="${tabId}"]`).first();
  await expect(tabBtn).toHaveClass(/active/);
  await expect(tabBtn).toHaveAttribute('aria-selected', 'true');
}

test('from /git/worktrees open Settings tab keeps scope and back returns to worktrees', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const scope = await ensureScopedRouteContext(page.request);
  const settingsTabId = 'connection';
  await page.goto(buildGitScopedPath(scope.workspaceKey, scope.folderKey, 'worktrees'), {
    waitUntil: 'domcontentloaded',
  });
  await assertGitWorktreesSubview(page, scope);
  await page.locator('#header-settings-btn').click();
  await expect(page.locator('#settings-panel.active')).toBeVisible({ timeout: 60_000 });
  await page.locator(`#settings-tabs .settings-tab[data-settings-tab="${settingsTabId}"]`).click();
  await assertSettingsTabRoute(page, scope, settingsTabId);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await assertGitWorktreesSubview(page, scope);
});
