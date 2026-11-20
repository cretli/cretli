import fs from 'node:fs';
import os from 'node:os';
import { test, expect } from '@playwright/test';

const PASSWORD = 'e2e-password-phase3b';
const liveBundle = 'public/dist/app/index.bundle.js';
const stampPath = `${os.tmpdir()}/cretli-phase3b-live-dist.json`;

async function csrfHeaders(page) {
  const statusRes = await page.request.get('/api/auth-status', { timeout: 15_000 });
  const status = await statusRes.json().catch(() => ({}));
  const csrfToken = typeof status.csrfToken === 'string' ? status.csrfToken.trim() : '';
  if (!csrfToken) return {};
  return { 'X-Cretli-Csrf': csrfToken };
}

async function dismissOverlays(page) {
  await page.evaluate(() => {
    document.querySelectorAll('cr-first-run-setup').forEach((el) => el.remove());
    const dialog = document.getElementById('connection-status-dialog');
    if (dialog && 'hide' in dialog && typeof dialog.hide === 'function') dialog.hide();
    if (dialog) dialog.removeAttribute('open');
    const reconnect = document.getElementById('chat-reconnect-modal');
    if (reconnect instanceof HTMLElement) reconnect.hidden = true;
  });
}

async function authenticate(page, { acceptDialogs = true } = {}) {
  if (acceptDialogs) {
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });
  }
  const statusRes = await page.request.get('/api/auth-status', { timeout: 15_000 });
  const status = await statusRes.json().catch(() => ({}));
  if (status.configured !== true) {
    const setupRes = await page.request.post('/api/setup', { data: { password: PASSWORD } });
    expect(setupRes.ok()).toBeTruthy();
  } else if (status.authRequired) {
    const loginRes = await page.request.post('/api/login', { data: { password: PASSWORD } });
    expect(loginRes.ok()).toBeTruthy();
  }
  await page.goto('/');
  const loginRoot = page.locator('cr-login-app');
  if (await loginRoot.count()) {
    const passwordInput = page.locator('cr-bar-input#cr-login-password input');
    await expect(passwordInput).toBeVisible();
    await passwordInput.fill(PASSWORD);
    const confirmInput = page.locator('cr-bar-input#cr-login-confirm input');
    if (await confirmInput.count()) {
      await confirmInput.fill(PASSWORD);
    }
    await page.locator('cr-bar-button[variant="primary"]').first().click();
  }
  await expect(page.locator('#app, #chat-panel')).toBeVisible({ timeout: 60_000 });
  await page.request.patch('/api/settings', {
    headers: await csrfHeaders(page),
    data: {
      firstRunSetupDismissed: true,
      workspaceAddPath: '/tmp',
      workspaceAddAs: 'folder',
    },
  });
  await dismissOverlays(page);
}

async function setWorkspaceFolder(page, folder) {
  await page.evaluate((value) => {
    const trigger = document.getElementById('header-workspace-trigger');
    if (trigger) trigger.dataset.workspaceFolder = value;
  }, folder);
}

async function openDelegations(page) {
  await page.goto('/settings/delegations');
  await dismissOverlays(page);
  const section = page.locator('.settings-section[data-settings-tab="delegations"]').first();
  await expect(section).toBeVisible();
  await expect(page.locator('#delegation-center-list')).toBeVisible();
  await expect(page.locator('#delegation-center-filter')).toBeVisible();
}

test.describe('phase IIIb HMR=0 Settings Delegations', () => {
  test('live dist unchanged and Settings Delegations is a screen', async ({ page }) => {
    expect(fs.existsSync(stampPath)).toBeTruthy();
    const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    expect(stamp.liveDistUnchanged).toBe(true);
    expect(stamp.bundleHasCenter).toBe(true);
    if (fs.existsSync(liveBundle)) {
      expect(fs.statSync(liveBundle).mtimeMs).toBe(stamp.liveMtime);
    }
    await authenticate(page);
    await openDelegations(page);
    await expect(page.locator('#settings-tabs .settings-tab[data-settings-tab="delegations"]'))
      .toHaveText(/Delegations|Delegacje/);
    await page.locator('#delegation-center-refresh').click({ force: true });
    await expect(page.locator('#delegation-center-filter')).toBeVisible();
    await expect(page.locator('#delegation-runtime-health')).toBeVisible();
  });

  test('cancelled confirm sends zero retry-delivery requests', async ({ page }) => {
    page.on('dialog', (dialog) => {
      void dialog.dismiss();
    });
    await authenticate(page, { acceptDialogs: false });
    const fixtures = await page.request.get('/api/test/fixtures', { timeout: 15_000 });
    const json = await fixtures.json();
    const chatA = (json.chats || []).find((row) => String(row.title || '').includes('parent A'));
    expect(chatA?.id).toBeTruthy();
    await page.request.patch('/api/settings', {
      headers: await csrfHeaders(page),
      data: {
        firstRunSetupDismissed: true,
        workspaceAddPath: chatA.workspaceFolder,
        workspaceAddAs: 'folder',
      },
    });
    await setWorkspaceFolder(page, chatA.workspaceFolder);
    const started = await page.request.post(`/api/chats/${chatA.id}/delegations`, {
      headers: await csrfHeaders(page),
      data: {
        sourceKind: 'text',
        taskText: 'phase3b confirm',
        executor: { transport: 'opencode', model: 'opencode/test' },
        idempotencyKey: crypto.randomUUID(),
      },
    });
    const startedJson = await started.json();
    expect(startedJson.ok, JSON.stringify(startedJson)).toBeTruthy();
    const jobId = startedJson.delegation.id;
    await expect.poll(async () => {
      const res = await page.request.get(`/api/delegations/${jobId}?field=summary`);
      const body = await res.json();
      return String(body?.delegation?.status || '');
    }, { timeout: 20_000 }).toBe('running');
    await page.request.post(`/api/test/delegations/${jobId}/event`, {
      headers: await csrfHeaders(page),
      data: { kind: 'finished', status: 'completed', report: 'done' },
    });
    await expect.poll(async () => {
      const res = await page.request.post(`/api/test/delegations/${jobId}/event`, {
        headers: await csrfHeaders(page),
        data: { kind: 'mailbox_uncertain' },
      });
      const body = await res.json();
      return body.ok === true && body.delegation?.retryableDelivery === true;
    }, { timeout: 20_000 }).toBe(true);
    await openDelegations(page);
    await setWorkspaceFolder(page, chatA.workspaceFolder);
    await page.locator('#delegation-center-refresh').click({ force: true });
    const card = page.locator(`#delegation-center-list [data-delegation-id="${jobId}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    const btn = card.locator('[data-act="retry-delivery"]');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('data-mailbox-id', /./);
    const posts = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/retry-delivery')) posts.push(req.url());
    });
    await btn.click({ force: true });
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);
  });
});
