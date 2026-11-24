import { test, expect } from '@playwright/test';
import http from 'node:http';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import { ensureScopedRouteContext, buildScopedPanelPath } from './spa-route-helpers.js';

let stub;
test.afterEach(async () => {
  if (stub?.listening) await new Promise((resolve) => stub.close(resolve));
  stub = null;
});

test('fleet panel registers an instance and reflects polling online and offline', async ({ page }) => {
  let online = true;
  stub = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (!online) { res.writeHead(503).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: {
      schemaVersion: 1, instance: { online: true }, activeWatcherCycles: 2, blockedTodos: 1, plansAwaitingApproval: 3,
      providerUsage: { cursor: { utilizationPercent: 25, limitPercent: 80 } },
    } } }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  await ensureAuthenticatedPage(page);
  const scope = await ensureScopedRouteContext(page.request);
  const skipWorkspace = page.getByRole('button', { name: 'Skip for now' });
  if (await skipWorkspace.isVisible().catch(() => false)) await skipWorkspace.click();
  await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'fleet'));
  await page.getByRole('button', { name: 'Add instance' }).click();
  const dialog = page.locator('cr-dialog[open]');
  const fields = dialog.locator('cr-bar-input');
  await fields.nth(0).locator('input').fill('your-pc');
  await fields.nth(1).locator('input').fill('acme');
  await fields.nth(2).locator('input').fill(`http://127.0.0.1:${stub.address().port}`);
  await fields.nth(3).locator('input').fill('test-token');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  const tile = page.locator('cr-fleet-tile');
  await expect(tile).toContainText('Online', { timeout: 45_000 });
  await expect(tile).toContainText('your-pc');
  await expect(tile).toContainText('25% / 80%');
  online = false;
  await new Promise((resolve) => stub.close(resolve));
  await expect(tile).toContainText('Offline', { timeout: 180_000 });
});
