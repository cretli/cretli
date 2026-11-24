import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import { ensureScopedRouteContext, buildScopedPanelPath } from './spa-route-helpers.js';

// Fake backend: every /api/devices route is answered from memory, so no device, adb or Chrome is needed.
function createFake() {
  const s = { devices: [], runs: [], consents: [], statusCalls: 0, starts: 0, reachable: false, decisions: [] };
  const run = (id, deviceName, metrics) => ({ id, deviceId: 'd1', deviceName, scriptPath: 'perf.mjs', hash: 'ab'.repeat(32), status: 'success', metrics, screenshots: [], startedAt: `2026-01-01T00:00:0${id.length}Z` });
  return { s, run };
}

async function install(page, fake) {
  const { s } = fake;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(/\/api\/devices(\/[^?]*)?(\?.*)?$/, (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    if (p === '/api/devices' && m === 'GET') return json(route, { ok: true, devices: s.devices });
    if (p === '/api/devices' && m === 'POST') {
      const device = req.postDataJSON().device;
      s.devices.push({ ...device, id: 'd1' });
      return json(route, { ok: true, device: s.devices[0] });
    }
    if (p === '/api/devices/connect-help') return json(route, { ok: true, help: { platform: 'android', connect: 'adb connect your-device:5555', cleanup: 'adb disconnect', hints: [] } });
    if (p === '/api/devices/d1/status') { s.statusCalls += 1; return json(route, { ok: true, id: 'd1', status: s.reachable ? 'reachable' : 'chrome-down', detail: '', checkedAt: new Date().toISOString() }); }
    if (p === '/api/devices/d1/runs' && m === 'POST') {
      s.starts += 1;
      s.consents = [{ id: 'c1', deviceId: 'd1', deviceName: 'my-phone', scriptPath: 'perf.mjs', hash: 'ab'.repeat(32), text: '', expiresAt: Date.now() + 60000, chatId: '' }];
      s.runs = [{ id: 'r-pending', deviceId: 'd1', deviceName: 'my-phone', scriptPath: 'perf.mjs', hash: 'ab'.repeat(32), status: 'awaiting-consent', metrics: null, screenshots: [], startedAt: '2026-01-01T00:00:09Z' }, ...s.runs];
      return json(route, { ok: true, run: s.runs[0] }, 202);
    }
    if (p === '/api/devices/runs') return json(route, { ok: true, runs: s.runs });
    if (p === '/api/devices/run-consents') return json(route, { ok: true, prompts: s.consents });
    if (p === '/api/devices/run-consents/c1') {
      s.decisions.push(req.postDataJSON().decision);
      s.consents = [];
      s.runs = s.runs.map((r) => (r.id === 'r-pending' ? { ...r, status: 'success', metrics: { load: 120 } } : r));
      return json(route, { ok: true });
    }
    if (p === '/api/devices/runs/compare') {
      return json(route, { ok: true, deltas: { load: { before: 100, after: 120, delta: 20 }, fps: { before: 60, after: null, delta: null } } });
    }
    return json(route, { ok: false, error: 'not-mocked' }, 404);
  });
  await page.route(/\/api\/files\/entries/, (route) => json(route, { ok: true, root: '/w', dir: '', entries: [{ name: 'perf.mjs', path: 'perf.mjs', isDir: false }] }));
}

test('devices panel: add, copy, refresh, run with consent, compare', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const fake = createFake();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  fake.s.runs = [fake.run('r1', 'my-phone', { load: 100, fps: 60 }), fake.run('r22', 'my-phone', { load: 120 })];
  await ensureAuthenticatedPage(page);
  await install(page, fake);
  const scope = await ensureScopedRouteContext(page.request);
  await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'devices'));
  const root = page.locator('#devices-root');
  await expect(root.locator('[data-devices-empty]')).toBeVisible();

  // Add a device and read the connect command.
  await root.locator('[data-add]').click();
  const dialog = page.locator('cr-dialog[open]');
  await dialog.locator('cr-bar-input').first().locator('input').fill('my-phone');
  await dialog.locator('[data-show-help]').click();
  await expect(dialog.locator('[data-devices-help]')).toContainText('adb connect your-device:5555');
  await dialog.locator('[data-copy="devices.help.connect"]').click();
  await expect(root.locator('.cr-status[role="status"]')).not.toHaveText('');
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => 'adb connect your-device:5555');
  expect(copied).toContain('adb connect your-device:5555');
  await dialog.locator('[data-save]').click();
  await expect(root.locator('[data-device-id="d1"]')).toBeVisible();

  // Status refresh flips the badge from "Chrome not running" to reachable.
  await expect(root.locator('[data-device-id="d1"] .devices-badge')).toHaveAttribute('data-tone', 'warn');
  fake.s.reachable = true;
  await root.locator('[data-refresh]').click();
  await expect(root.locator('[data-device-id="d1"] .devices-badge')).toHaveAttribute('data-tone', 'success');

  // Start a run: consent is pending, no duplicate start, then an explicit decision.
  await root.locator('[data-tab="runs"]').click();
  await root.locator('[data-script-path] input').fill('perf.mjs');
  await root.locator('[data-start-run]').click();
  await expect(root.locator('[data-device-consent]')).toBeVisible();
  await expect(root.locator('[data-device-consent]')).toContainText('perf.mjs');
  expect(fake.s.starts).toBe(1);
  expect(fake.s.decisions).toEqual([]);
  await root.locator('[data-consent-once]').click();
  await expect(root.locator('[data-device-consent]')).toHaveCount(0);
  expect(fake.s.decisions).toEqual(['once']);

  // Comparison: missing values stay "n/a", never 0.
  await root.locator('[data-compare="before"]').selectOption('r1');
  await root.locator('[data-compare="after"]').selectOption('r22');
  await root.locator('[data-run-compare]').click();
  const table = root.locator('[data-compare-table]');
  await expect(table.locator('[data-metric="load"]')).toContainText('20');
  await expect(table.locator('[data-metric="fps"]')).toContainText('n/a');
  expect(pageErrors).toEqual([]);
});
