import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import {
  buildGitScopedPath,
  buildScopedPanelPath,
  cretliCsrfHeaders,
  ensureScopedRouteContext,
  projectRoot,
  resolveScopedRouteContext,
  trackSettingsPatchRequests,
} from './spa-route-helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {Promise<{ workspaceKey: string, folderKey: string, secondFolderKey?: string }> | null} */
let sharedScopePromise = null;

/**
 * @param {import('@playwright/test').APIRequestContext} request
 */
async function loadSharedScopeWithSecondFolder(request) {
  if (sharedScopePromise) return sharedScopePromise;
  sharedScopePromise = (async () => {
    let scope = await ensureScopedRouteContext(request);
    if (scope.secondFolderKey) return scope;
    const libPath = path.join(projectRoot, 'lib');
    const patch = await request.patch('/api/settings', {
      headers: await cretliCsrfHeaders(request),
      data: { workspaceAddPath: libPath, workspaceAddAs: 'folder' },
    });
    const body = await patch.json().catch(() => ({}));
    if (patch.ok() && body?.ok === true) {
      scope = await resolveScopedRouteContext(request);
    }
    return scope;
  })();
  return sharedScopePromise;
}

test('two tabs with different folder keys keep distinct URLs without global settings PATCH on navigation', async ({ browser }) => {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  await ensureAuthenticatedPage(pageA);
  const sharedScope = await loadSharedScopeWithSecondFolder(pageA.request);
  if (!sharedScope.secondFolderKey) {
    await context.close();
    test.skip(true, 'need at least two enabled folders in one workspace for this matrix row');
  }
  const pageB = await context.newPage();
  await ensureAuthenticatedPage(pageB);
  const trackerA = trackSettingsPatchRequests(pageA);
  const trackerB = trackSettingsPatchRequests(pageB);
  const urlA = buildScopedPanelPath(sharedScope.workspaceKey, sharedScope.folderKey, 'chat');
  const urlB = buildScopedPanelPath(
    sharedScope.workspaceKey,
    sharedScope.secondFolderKey,
    'todo',
  );
  await pageA.goto(urlA, { waitUntil: 'domcontentloaded' });
  await pageB.goto(urlB, { waitUntil: 'domcontentloaded' });
  await expect(pageA.locator('#chat-panel.active')).toBeVisible({ timeout: 60_000 });
  await expect(pageB.locator('#todo-panel.active')).toBeVisible({ timeout: 60_000 });
  expect(new URL(pageA.url()).searchParams.get('folder')).toBe(sharedScope.folderKey);
  expect(new URL(pageB.url()).searchParams.get('folder')).toBe(sharedScope.secondFolderKey);
  trackerA.reset();
  trackerB.reset();
  const gitA = buildGitScopedPath(sharedScope.workspaceKey, sharedScope.folderKey, 'worktrees');
  await pageA.goto(gitA, { waitUntil: 'domcontentloaded' });
  await pageA.goBack({ waitUntil: 'domcontentloaded' });
  await pageB.reload({ waitUntil: 'domcontentloaded' });
  expect(new URL(pageB.url()).searchParams.get('folder')).toBe(sharedScope.secondFolderKey);
  expect(new URL(pageB.url()).pathname.replace(/\/$/, '')).toBe('/todo');
  expect(trackerA.patchUrls, 'tab A popstate/goto must not PATCH /api/settings').toEqual([]);
  expect(trackerB.patchUrls, 'tab B reload must not PATCH /api/settings').toEqual([]);
  await context.close();
});

test('new tab direct link uses session storage, not the other tab URL', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await ensureAuthenticatedPage(first);
  const sharedScope = await loadSharedScopeWithSecondFolder(first.request);
  await first.goto(buildScopedPanelPath(sharedScope.workspaceKey, sharedScope.folderKey, 'chat'), {
    waitUntil: 'domcontentloaded',
  });
  const second = await context.newPage();
  await ensureAuthenticatedPage(second);
  const worktrees = buildGitScopedPath(sharedScope.workspaceKey, sharedScope.folderKey, 'worktrees');
  await second.goto(worktrees, { waitUntil: 'domcontentloaded' });
  expect(new URL(second.url()).pathname.replace(/\/$/, '')).toBe('/git/worktrees');
  expect(new URL(first.url()).pathname.replace(/\/$/, '')).toBe('/chat');
  await context.close();
});
