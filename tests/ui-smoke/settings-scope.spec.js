import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage } from '../e2e/chat-e2e-helpers.js';
import { ensureScopedRouteContext, buildScopedPanelPath, cretliCsrfHeaders } from '../e2e/spa-route-helpers.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Settings scope badges render and follow workspace changes at desktop and mobile sizes', async ({ page }, testInfo) => {
  const viewport = testInfo.project.use.viewport;
  await ensureAuthenticatedPage(page);
  const scope = await ensureScopedRouteContext(page.request);
  const secondWorkspaceFolder = fs.mkdtempSync(path.join(process.env.WORKSPACES_SCAN_DIR || os.tmpdir(), 'settings-scope-ws-'));
  const seeded = await page.request.patch('/api/settings', {
    headers: await cretliCsrfHeaders(page.request),
    data: { workspaceAddPath: secondWorkspaceFolder, workspaceAddAs: 'folder' },
  });
  expect(seeded.ok()).toBe(true);
  await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'settings', 'interface'), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#settings-panel.active')).toBeVisible({ timeout: 60_000 });
  const header = page.locator('#header-workspace-trigger');
  const contexts = await page.request.get('/api/workspaces?refresh=1&scan=1&sync=1').then((response) => response.json());
  const first = contexts.workspaces.find((row) => row.workspaceKey === scope.workspaceKey);
  const second = contexts.workspaces.find((row) => row.workspaceDir === secondWorkspaceFolder);
  expect(first && second).toBeTruthy();
  const firstName = first.name;
  const secondName = path.basename(secondWorkspaceFolder);
  await page.goto(buildScopedPanelPath(second.workspaceKey, second.folders[0].folderKey, 'settings', 'interface'), { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#settings-panel.active')).toBeVisible();
  await expect(page.locator('#settings-panel [data-settings-scope="workspace"] cr-scope-badge').first()).toContainText(secondName);

  for (const tab of ['interface', 'delegations', 'execution', 'watcher']) {
    await page.locator(`#settings-tabs .settings-tab[data-settings-tab="${tab}"]`).evaluate(button => button.click());
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-active-settings-tab', tab);
    await expect(page.locator('#settings-panel [data-settings-scope]:visible cr-scope-badge').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${tab}-${viewport.width}px.png`), fullPage: false });
    const badgeNames = await page.locator('#settings-panel [data-settings-scope]:visible cr-scope-badge').evaluateAll((items) => items.map((item) => ({
      scope: item.scope,
      label: item.label,
      name: item.name,
      emptyLabel: item.emptyLabel,
      text: item.shadowRoot?.textContent?.trim() || '',
    })));
    await testInfo.attach(`${tab}-badges`, { body: JSON.stringify(badgeNames, null, 2), contentType: 'application/json' });
    if (tab === 'interface') await expect(page.locator('#settings-panel [data-settings-scope="workspace"] cr-scope-badge').first()).toContainText(secondName);
  }

  await page.goto(buildScopedPanelPath(first.workspaceKey, first.folders[0].folderKey, 'settings', 'interface'), { waitUntil: 'domcontentloaded' });
  await page.locator('#settings-tabs .settings-tab[data-settings-tab="interface"]').evaluate(button => button.click());
  await expect(page.locator('#settings-panel [data-settings-scope="workspace"] cr-scope-badge').first()).toContainText(firstName);
});
