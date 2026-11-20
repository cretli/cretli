import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import {
  buildGitScopedPath,
  buildScopedPanelPath,
  ensureScopedRouteContext,
  trackSettingsPatchRequests,
} from './spa-route-helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {Promise<{ workspaceKey: string, folderKey: string, secondFolderKey?: string }> | null} */
let sharedScopePromise = null;

/**
 * @param {import('@playwright/test').APIRequestContext} request
 */
function loadSharedScope(request) {
  if (!sharedScopePromise) {
    sharedScopePromise = ensureScopedRouteContext(request);
  }
  return sharedScopePromise;
}

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
}

test('explicit deep link wins over stored route on warm boot to /', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const sharedScope = await loadSharedScope(page.request);
  await page.evaluate(() => {
    localStorage.setItem('cretli-view-route-v1', JSON.stringify({
      v: 1,
      canonical: '/agents',
      at: Date.now(),
    }));
    sessionStorage.setItem('cretli-view-route-v1', JSON.stringify({
      v: 1,
      canonical: '/tasks',
      at: Date.now(),
    }));
  });
  const target = buildGitScopedPath(sharedScope.workspaceKey, sharedScope.folderKey, 'worktrees');
  const tracker = trackSettingsPatchRequests(page);
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  const url = new URL(page.url());
  expect(url.pathname.replace(/\/$/, '')).toBe('/git/worktrees');
  expect(url.searchParams.get('ws')).toBe(sharedScope.workspaceKey);
  await expect(page.locator('#git-worktrees')).toBeVisible({ timeout: 60_000 });
  expect(tracker.patchUrls, 'scoped navigation must not PATCH global /api/settings').toEqual([]);
});

test('scoped /chat survives reload (F5)', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const sharedScope = await loadSharedScope(page.request);
  const target = buildScopedPanelPath(sharedScope.workspaceKey, sharedScope.folderKey, 'chat');
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#chat-panel.active')).toBeVisible({ timeout: 60_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const url = new URL(page.url());
  expect(url.pathname.replace(/\/$/, '')).toBe('/chat');
  expect(url.searchParams.get('ws')).toBe(sharedScope.workspaceKey);
  await expect(page.locator('#chat-panel.active')).toBeVisible();
});

test('settings third-level tab (connection) survives reload', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const sharedScope = await loadSharedScope(page.request);
  const tabId = 'connection';
  await page.goto(buildScopedPanelPath(sharedScope.workspaceKey, sharedScope.folderKey, 'settings', tabId), {
    waitUntil: 'domcontentloaded',
  });
  await assertSettingsTabRoute(page, sharedScope, tabId);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await assertSettingsTabRoute(page, sharedScope, tabId);
});

test('legacy ?panel= and ?tab= opens canonical settings route', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const sharedScope = await loadSharedScope(page.request);
  const params = new URLSearchParams({
    panel: 'settings',
    tab: 'workspace',
    ws: sharedScope.workspaceKey,
    folder: sharedScope.folderKey,
  });
  await page.goto(`/?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await assertSettingsTabRoute(page, sharedScope, 'workspace');
});

const E2E_TODO_RESOURCE_ID = 'e2e-spa-route-todo-resource';

/**
 * @param {string} workspaceKey
 * @param {string} folderKey
 * @param {string} [todoId]
 */
function buildScopedTodoPath(workspaceKey, folderKey, todoId) {
  const params = new URLSearchParams({ ws: workspaceKey, folder: folderKey });
  if (todoId) params.set('todo', todoId);
  return `/todo?${params.toString()}`;
}

test('scoped /todo?todo= survives reload (F5)', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const sharedScope = await loadSharedScope(page.request);
  const target = buildScopedTodoPath(sharedScope.workspaceKey, sharedScope.folderKey, E2E_TODO_RESOURCE_ID);
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#todo-panel.active')).toBeVisible({ timeout: 60_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const url = new URL(page.url());
  expect(url.pathname.replace(/\/$/, '')).toBe('/todo');
  expect(url.searchParams.get('todo')).toBe(E2E_TODO_RESOURCE_ID);
  expect(url.searchParams.get('ws')).toBe(sharedScope.workspaceKey);
  await expect(page.locator('#todo-panel.active')).toBeVisible();
});

test('back and forward between scoped todo and git preserves todo query', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const sharedScope = await loadSharedScope(page.request);
  const todoUrl = buildScopedTodoPath(sharedScope.workspaceKey, sharedScope.folderKey, E2E_TODO_RESOURCE_ID);
  const gitUrl = buildGitScopedPath(sharedScope.workspaceKey, sharedScope.folderKey, 'main');
  await page.goto(todoUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#todo-panel.active')).toBeVisible({ timeout: 60_000 });
  await page.goto(gitUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#git-main-view')).toBeVisible({ timeout: 60_000 });
  await page.goBack({ waitUntil: 'domcontentloaded' });
  const backUrl = new URL(page.url());
  expect(backUrl.pathname.replace(/\/$/, '')).toBe('/todo');
  expect(backUrl.searchParams.get('todo')).toBe(E2E_TODO_RESOURCE_ID);
  expect(backUrl.searchParams.get('ws')).toBe(sharedScope.workspaceKey);
  await page.goForward({ waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/git');
});

test('back and forward between scoped chat and git preserves query context', async ({ page }) => {
  await ensureAuthenticatedPage(page);
  const sharedScope = await loadSharedScope(page.request);
  const chatUrl = buildScopedPanelPath(sharedScope.workspaceKey, sharedScope.folderKey, 'chat');
  const gitUrl = buildGitScopedPath(sharedScope.workspaceKey, sharedScope.folderKey, 'main');
  await page.goto(chatUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#chat-panel.active')).toBeVisible({ timeout: 60_000 });
  await page.goto(gitUrl, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#git-main-view')).toBeVisible({ timeout: 60_000 });
  await page.goBack({ waitUntil: 'domcontentloaded' });
  const backUrl = new URL(page.url());
  expect(backUrl.pathname.replace(/\/$/, '')).toBe('/chat');
  expect(backUrl.searchParams.get('ws')).toBe(sharedScope.workspaceKey);
  await page.goForward({ waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/git');
});
