import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage, ensureMockNewChatEnvironment } from './chat-e2e-helpers.js';

// Fake backend: the Apps and Network routes are answered from this in-memory state, so the test needs
// no real processes, Windows host or powershell.exe.
function createFakeBackend() {
  const s = {
    running: false, exposure: null, helperInstalled: false, installReply: { ok: false, state: 'cancelled' },
    deadRule: true, suggestionAdds: [],
  };
  const policy = { range: { min: 3000, max: 9999 }, denylist: [9222], defaultTtlMs: 28800000, maxTtlMs: 604800000, agentMode: 'ask', backend: 'auto' };
  const app = () => ({
    id: 'demo', name: 'Demo app', exposure: 'local', autoStart: false, status: s.running ? 'running' : 'stopped',
    runId: s.running ? 'run-1' : null, pid: s.running ? 4242 : null, lastChangeAt: new Date().toISOString(), errors: [],
    ports: [{ port: 5173, bind: '0.0.0.0', role: 'http', listening: s.running, listener: s.running ? { address: '0.0.0.0', pid: 4242, command: 'node' } : null, ownedBy: s.running ? 'app' : 'none', warnings: [] }],
  });
  const report = () => ({
    schemaVersion: 1, collectedAt: new Date().toISOString(), platform: 'wsl2', partial: false, reasons: [], networkingMode: 'nat',
    portproxy: s.deadRule ? [{ listenAddress: '0.0.0.0', listenPort: 6000, connectAddress: '172.20.0.2', connectPort: 6000 }] : [],
    listeners: [], cretli: { lanHost: '198.51.100.2', bind: '127.0.0.1', lanExposed: false },
    helper: { state: s.helperInstalled ? 'ready' : 'helper_missing', installed: s.helperInstalled, version: s.helperInstalled ? '1' : null },
    issues: s.deadRule ? [{ code: 'dead-proxy', level: 'warning', description: 'Proxy port 6000 has no matching listener on destination port 6000.', command: 'netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=6000', needsAdmin: true, needsWslRestart: false }] : [],
  });
  return { s, policy, app, report };
}

async function install(page, fake) {
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/apps/status*', (r) => json(r, { ok: true, workspace: '/w', valid: true, errors: [], lanHost: '198.51.100.2', network: { platform: 'wsl2', helper: 'ready' }, apps: [fake.app()], orphans: [{ port: 8081, bind: '0.0.0.0', pid: 99, command: 'python', killHint: 'kill 99' }] }));
  await page.route('**/api/apps/suggestions*', (r) => json(r, { ok: true, suggestions: [{
    file: 'package.json', source: 'package.json', app: { id: 'suggested-web', name: 'Suggested web', start: { taskLabel: 'Start web', command: 'npm', args: ['run', 'dev'] }, ports: [{ port: 4173, bind: '127.0.0.1', role: 'http' }], exposure: 'local' },
  }] }));
  await page.route(/\/api\/apps(\?.*)?$/, (r) => {
    if (r.request().method() === 'POST') {
      fake.s.suggestionAdds.push(r.request().postDataJSON().app);
      return json(r, { ok: true, app: r.request().postDataJSON().app });
    }
    return json(r, { ok: true, apps: [] });
  });
  await page.route('**/api/apps/demo/start*', (r) => { fake.s.running = true; return json(r, { ok: true }); });
  await page.route('**/api/apps/demo/stop*', (r) => { fake.s.running = false; fake.s.exposure = null; return json(r, { ok: true }); });
  await page.route('**/api/port-exposures/policy', (r) => json(r, { ok: true, policy: fake.policy }));
  await page.route(/\/api\/port-exposures(\?.*)?$/, (r) => {
    if (r.request().method() === 'POST') {
      fake.s.exposure = { port: 5173, owner: 'app:demo', state: 'active', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
      return json(r, { ok: true, entry: fake.s.exposure, commands: [] });
    }
    const open = fake.s.exposure && Date.parse(fake.s.exposure.expiresAt) > Date.now() ? [fake.s.exposure] : [];
    return json(r, { ok: true, policy: fake.policy, backend: { kind: 'wsl-nat' }, exposures: open, history: [], foreign: [] });
  });
  await page.route('**/api/net-env', (r) => json(r, fake.report()));
  await page.route('**/api/net-env?*', (r) => json(r, fake.report()));
  await page.route('**/api/net-env/netd/install-info', (r) => json(r, { ok: true, supported: true, sha256: 'ab'.repeat(32), command: 'powershell.exe -NoProfile ...' }));
  await page.route('**/api/net-env/netd/install*', (r) => {
    if (fake.s.installReply.state === 'success') fake.s.helperInstalled = true;
    return json(r, fake.s.installReply, 200);
  });
}

test('apps panel: start, expose with TTL, LAN URL, expiry; orphans are read-only', async ({ page }) => {
  const fake = createFakeBackend();
  await install(page, fake);
  await page.setViewportSize({ width: 360, height: 800 });
  await ensureMockNewChatEnvironment(page);
  await page.locator('.tab[data-panel="apps"]').click();
  await page.waitForFunction(() => window.__crAppBootReady === true);
  await expect(page.locator('#apps-panel')).toHaveClass(/active/);
  const root = page.locator('#apps-root');
  await expect(root.getByText('Demo app')).toBeVisible();
  await root.getByRole('button', { name: /^(Start|Uruchom)$/ }).click();
  await expect(root.getByText(/Running|Działa/).first()).toBeVisible();
  await root.getByRole('button', { name: /Expose to LAN|Wystaw w LAN/ }).click();
  await expect(root.getByText('http://198.51.100.2:5173')).toBeVisible();
  // TTL elapsed on the fake backend: the next poll/refresh no longer lists the exposure.
  fake.s.exposure.expiresAt = new Date(Date.now() - 1000).toISOString();
  await root.getByRole('button', { name: /Refresh|Odśwież/ }).first().click();
  await expect(root.getByText('http://198.51.100.2:5173')).toHaveCount(0);
  // Orphans: no button may end a process.
  await root.locator('.cr-tab[data-tab="ports"]').click();
  const orphans = root.locator('.apps-orphans');
  await expect(orphans.getByRole('button', { name: /kill/i })).toHaveCount(1); // "Copy kill command" only
  await expect(orphans.getByRole('button', { name: /^(Kill|Stop|Zakończ|Zabij)/i })).toHaveCount(0);
  // 360px: no horizontal scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('apps panel: review a complete suggestion before adding it', async ({ page }) => {
  const fake = createFakeBackend();
  await install(page, fake);
  await ensureMockNewChatEnvironment(page);
  await page.locator('.tab[data-panel="apps"]').click();
  await page.waitForFunction(() => window.__crAppBootReady === true);
  const root = page.locator('#apps-root');
  await root.locator('.cr-tab[data-tab="suggestions"]').click();
  await expect(root.getByRole('heading', { name: /Found in this project|Znalezione w projekcie/ })).toBeVisible();
  const row = root.locator('[data-suggestion-id="suggested-web"]');
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: /Review definition|Sprawdź definicję/ })).toBeVisible();
  await row.getByRole('button', { name: /Review definition|Sprawdź definicję/ }).click();
  const dialog = root.locator('cr-dialog');
  await expect(dialog.getByText('Start web')).toBeVisible();
  await expect(dialog.getByText('npm run dev')).toBeVisible();
  await expect(dialog.getByText(':4173 http')).toBeVisible();
  await expect(dialog.getByText(':4173 http · 127.0.0.1')).toBeVisible();
  expect(fake.s.suggestionAdds).toHaveLength(0);
  await dialog.getByRole('button', { name: /^(Add|Dodaj)$/ }).click();
  await expect.poll(() => fake.s.suggestionAdds.length).toBe(1);
  expect(fake.s.suggestionAdds[0]).toMatchObject({
    id: 'suggested-web', name: 'Suggested web',
    start: { taskLabel: 'Start web', command: 'npm', args: ['run', 'dev'] },
    ports: [{ port: 4173, bind: '127.0.0.1', role: 'http' }], exposure: 'local',
  });
});

test('network tab: dead rule suggestion and helper install states', async ({ page }) => {
  const fake = createFakeBackend();
  fake.s.exposure = { port: 6000, owner: 'user', state: 'active', expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  fake.s.helperInstalled = false;
  await install(page, fake);
  await ensureAuthenticatedPage(page);
  await page.waitForFunction(() => window.__crAppBootReady === true);
  await page.goto('/settings/connection-network');
  const root = page.locator('.network-settings-root');
  await root.locator('.cr-tab[data-tab="diagnostics"]').click();
  await expect(root.getByText(/Rules with no app behind them|Reguły bez działającej aplikacji/)).toBeVisible();
  // Repair is offered only when the helper is running and the rule is in the ledger.
  await expect(root.getByRole('button', { name: /^(Repair|Napraw)$/ })).toHaveCount(0);
  await root.locator('.cr-tab[data-tab="status"]').click();

  for (const [reply, state] of [[{ ok: false, state: 'cancelled' }, 'cancelled'], [{ ok: false, state: 'failed', message: 'boom' }, 'failed'], [{ ok: true, state: 'success' }, 'success']]) {
    fake.s.installReply = reply;
    await root.getByRole('button', { name: /^(Install|Zainstaluj)$/ }).click();
    await expect(page.getByText(/UAC/).first()).toBeVisible();
    await page.locator('[data-install-confirm]').click();
    await expect(root.locator(`[data-install-state="${state}"]`)).toBeVisible();
  }
  // After a successful install the helper runs and the repair button for the dead rule appears.
  await root.locator('.cr-tab[data-tab="diagnostics"]').click();
  await expect(root.getByRole('button', { name: /^(Repair|Napraw)$/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
