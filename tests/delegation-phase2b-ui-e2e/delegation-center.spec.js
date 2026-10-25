import { test, expect } from '@playwright/test';

const PASSWORD = 'e2e-password-phase2b';

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

async function dismissFirstRunIfPresent(page) {
  const setup = page.locator('cr-first-run-setup');
  for (let i = 0; i < 8; i += 1) {
    if (!(await setup.count())) return;
    const visible = await setup.isVisible().catch(() => false);
    if (!visible) return;
    const skip = setup.locator('cr-bar-button').filter({ hasText: /Skip|Pomiń/i }).first();
    if (await skip.count()) {
      await skip.click({ force: true });
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(250);
  }
  if (await setup.count()) {
    await setup.evaluate((el) => el.remove());
  }
}

async function authenticate(page, { trackSockets = false } = {}) {
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  const statusRes = await page.request.get('/api/auth-status', { timeout: 15_000 });
  const status = await statusRes.json().catch(() => ({}));
  if (status.configured !== true) {
    const setupRes = await page.request.post('/api/setup', { data: { password: PASSWORD } });
    expect(setupRes.ok()).toBeTruthy();
  } else if (status.authRequired) {
    const loginRes = await page.request.post('/api/login', { data: { password: PASSWORD } });
    expect(loginRes.ok()).toBeTruthy();
  }
  if (trackSockets) {
    await page.addInitScript(() => {
      const Orig = window.WebSocket;
      window.__crTestSockets = [];
      window.WebSocket = class extends Orig {
        constructor(...args) {
          super(...args);
          window.__crTestSockets.push(this);
        }
      };
    });
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
  await dismissFirstRunIfPresent(page);
}

async function fixtures(page) {
  const res = await page.request.get('/api/test/fixtures', { timeout: 15_000 });
  const json = await res.json();
  expect(json.ok).toBeTruthy();
  const chats = Array.isArray(json.chats) ? json.chats : [];
  const chatA = chats.find((row) => String(row.title || '').includes('parent A'));
  const chatB = chats.find((row) => String(row.title || '').includes('parent B'));
  expect(chatA?.id).toBeTruthy();
  expect(chatB?.id).toBeTruthy();
  return { chatA, chatB };
}

async function startJob(page, chatId, text) {
  const res = await page.request.post(`/api/chats/${chatId}/delegations`, {
    headers: await csrfHeaders(page),
    timeout: 20_000,
    data: {
      sourceKind: 'text',
      taskText: text,
      executor: { transport: 'opencode', model: 'opencode/test' },
      idempotencyKey: crypto.randomUUID(),
    },
  });
  const json = await res.json();
  expect(json.ok, JSON.stringify(json)).toBeTruthy();
  return json.delegation;
}

async function readSummary(page, jobId) {
  const res = await page.request.get(`/api/delegations/${jobId}?field=summary`, { timeout: 15_000 });
  return res.json();
}

async function waitJobStatus(page, jobId, status) {
  await expect.poll(async () => {
    const json = await readSummary(page, jobId);
    return String(json?.delegation?.status || '');
  }, { timeout: 20_000 }).toBe(status);
}

async function finishJob(page, jobId, status, report) {
  await waitJobStatus(page, jobId, 'running');
  const res = await page.request.post(`/api/test/delegations/${jobId}/event`, {
    headers: await csrfHeaders(page),
    timeout: 15_000,
    data: { kind: 'finished', status, report },
  });
  const json = await res.json();
  expect(json.ok, JSON.stringify(json)).toBeTruthy();
}

async function markMailboxUncertain(page, jobId) {
  await expect.poll(async () => {
    const res = await page.request.post(`/api/test/delegations/${jobId}/event`, {
      headers: await csrfHeaders(page),
      timeout: 15_000,
      data: { kind: 'mailbox_uncertain' },
    });
    const json = await res.json();
    return json.ok === true && json.delegation?.retryableDelivery === true;
  }, { timeout: 20_000 }).toBe(true);
}

async function cancelActiveJobs(page) {
  const res = await page.request.get('/api/delegations?limit=80', { timeout: 15_000 });
  const json = await res.json();
  const rows = Array.isArray(json?.delegations) ? json.delegations : [];
  for (const row of rows) {
    if (row?.active !== true) continue;
    await page.request.post(`/api/delegations/${row.id}/cancel`, {
      headers: await csrfHeaders(page),
      timeout: 15_000,
      data: {},
    }).catch(() => {});
  }
  await expect.poll(async () => {
    const latestRes = await page.request.get('/api/delegations?limit=80', { timeout: 15_000 });
    const latest = await latestRes.json();
    const list = Array.isArray(latest?.delegations) ? latest.delegations : [];
    return list.some((row) => row?.active === true);
  }, { timeout: 20_000 }).toBe(false);
}

async function setWorkspaceFolder(page, folder) {
  await page.evaluate((value) => {
    const trigger = document.getElementById('header-workspace-trigger');
    if (trigger) trigger.dataset.workspaceFolder = value;
  }, folder);
}

async function openBarSelect(page, selector) {
  const host = page.locator(selector);
  await expect(host).toBeVisible();
  const trigger = host.locator('button.trigger, button, [part="control"]').first();
  await trigger.click();
  await expect(page.locator('.cr-bar-select-modal:not([hidden])')).toBeVisible();
}

async function chooseBarSelect(page, selector, labelRe) {
  await openBarSelect(page, selector);
  await page.locator('.cr-bar-select-modal:not([hidden]) .cr-bar-select-item', { hasText: labelRe }).click();
}

async function openSettingsTab(page, tabId) {
  await dismissOverlays(page);
  await dismissFirstRunIfPresent(page);
  const settingsPanel = page.locator('#settings-panel');
  const isActive = await settingsPanel.evaluate((el) => el.classList.contains('active')).catch(() => false);
  if (!isActive) {
    await page.locator('#header-settings-btn').click({ force: true });
  }
  await expect(settingsPanel).toBeVisible();
  const tab = page.locator(`#settings-tabs .settings-tab[data-settings-tab="${tabId}"]`);
  await expect(tab).toBeVisible();
  await tab.click({ force: true });
  const section = page.locator(`.settings-section[data-settings-tab="${tabId}"]`).first();
  if (!(await section.isVisible().catch(() => false))) {
    await page.goto(`/settings/${tabId}`);
    await dismissOverlays(page);
    await dismissFirstRunIfPresent(page);
  }
  await expect(section).toBeVisible();
  if (tabId === 'interface') {
    await expect(page.locator('#lang-select')).toBeVisible();
  }
  if (tabId === 'delegations') {
    await expect(page.locator('#delegation-center-list')).toBeVisible();
  }
}

test.describe('delegation center and live WS reconnect', () => {
  test('filters, retry kinds, keyboard, PL/EN, mobile, workspace scope', async ({ page }) => {
    await authenticate(page);
    const { chatA, chatB } = await fixtures(page);
    await page.request.patch('/api/settings', {
      headers: await csrfHeaders(page),
      data: {
        firstRunSetupDismissed: true,
        workspaceAddPath: chatA.workspaceFolder,
        workspaceAddAs: 'folder',
      },
    });
    await setWorkspaceFolder(page, chatA.workspaceFolder);
    const jobA = await startJob(page, chatA.id, 'center job a');
    await finishJob(page, jobA.id, 'completed', 'done a');
    const jobFail = await startJob(page, chatA.id, 'center job failed');
    await finishJob(page, jobFail.id, 'failed', 'boom');
    const jobDelivery = await startJob(page, chatA.id, 'center job delivery');
    await finishJob(page, jobDelivery.id, 'completed', 'done delivery');
    await markMailboxUncertain(page, jobDelivery.id);
    const jobB = await startJob(page, chatB.id, 'center job b');
    await openSettingsTab(page, 'delegations');
    await expect(page.locator('#settings-tabs .settings-tab[data-settings-tab="delegations"]'))
      .toHaveText(/Delegations|Delegacje/);
    await expect(page.locator('#delegation-runtime-health')).toBeVisible();
    await expect(page.locator('#delegation-runtime-health')).toContainText(/Server process is up|Proces serwera działa/);
    await expect(page.locator('#delegation-runtime-health')).toContainText(/Worker running|Worker działa/);
    await expect(page.locator('#delegation-center-filter')).toBeVisible();
    await page.locator('#delegation-center-refresh').click({ force: true });
    const cardA = page.locator(`#delegation-center-list [data-delegation-id="${jobA.id}"]`);
    const cardFail = page.locator(`#delegation-center-list [data-delegation-id="${jobFail.id}"]`);
    const cardDelivery = page.locator(`#delegation-center-list [data-delegation-id="${jobDelivery.id}"]`);
    await expect(cardA).toBeVisible();
    await expect(cardA.locator('[data-act="retry-task"]')).toBeVisible();
    await expect(cardA.locator('[data-act="ack"]')).toBeVisible();
    await expect(cardDelivery.locator('[data-act="retry-delivery"]')).toBeVisible();
    await page.evaluate((id) => {
      const btn = document.querySelector(`#delegation-center-list [data-delegation-id="${id}"] [data-act="retry-task"]`);
      if (!(btn instanceof HTMLElement)) return;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    }, jobA.id);
    await expect.poll(async () => {
      const json = await readSummary(page, jobA.id);
      return Number(json?.delegation?.attemptCount || 0);
    }, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await page.evaluate((id) => {
      const btn = document.querySelector(`#delegation-center-list [data-delegation-id="${id}"] [data-act="retry-delivery"]`);
      if (!(btn instanceof HTMLElement)) return;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
    }, jobDelivery.id);
    await chooseBarSelect(page, '#delegation-center-filter', /Failed|Nieudane/);
    await expect(cardFail).toBeVisible();
    await expect(cardA).toHaveCount(0);
    await chooseBarSelect(page, '#delegation-center-filter', /All|Wszystkie/);
    await expect(cardA).toBeVisible();
    await cardA.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(cardA).toBeVisible();
    await expect(page.locator('#delegation-center-refresh')).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 800 });
    await setWorkspaceFolder(page, chatA.workspaceFolder);
    await page.locator('#delegation-center-refresh').click({ force: true });
    await expect(cardA).toBeVisible();
    await expect(page.locator(`#delegation-center-list [data-delegation-id="${jobB.id}"]`)).toHaveCount(0);
    await openSettingsTab(page, 'interface');
    await chooseBarSelect(page, '#lang-select', /^Polski$/);
    await openSettingsTab(page, 'delegations');
    await expect(page.locator('#delegation-center-refresh')).toContainText('Odśwież');
    await expect(page.locator('#delegation-runtime-health')).toContainText('Proces serwera działa');
    await expect(page.locator('#delegation-runtime-health')).toContainText('Worker działa');
  });

  test('browser reconnects to live WS of this isolated instance', async ({ page }) => {
    await authenticate(page, { trackSockets: true });
    const { chatA } = await fixtures(page);
    await cancelActiveJobs(page);
    const job = await startJob(page, chatA.id, 'reconnect live ws');
    await waitJobStatus(page, job.id, 'running');
    await page.goto('/chat');
    await dismissOverlays(page);
    await dismissFirstRunIfPresent(page);
    const chatItem = page.locator(`#app-sidebar .sidebar-chat-item[data-chat-id="${chatA.id}"]`);
    if (await chatItem.count()) {
      await page.locator('#header-menu-btn').click({ force: true }).catch(() => {});
      await chatItem.click({ force: true });
    } else {
      await page.evaluate((id) => {
        const item = document.querySelector(`.sidebar-chat-item[data-chat-id="${id}"]`);
        if (item instanceof HTMLElement) item.click();
      }, chatA.id);
    }
    const card = page.locator(`[data-delegation-id="${job.id}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => page.evaluate(() => (
      (window.__crTestSockets || []).some((ws) => ws.readyState === WebSocket.OPEN)
    )), { timeout: 20_000 }).toBe(true);
    await page.evaluate(() => {
      for (const ws of window.__crTestSockets || []) {
        try { ws.close(); } catch (_) {}
      }
    });
    await expect.poll(async () => page.evaluate(() => (
      (window.__crTestSockets || []).some((ws) => ws.readyState === WebSocket.OPEN)
    )), { timeout: 20_000 }).toBe(true);
    await page.request.post(`/api/test/delegations/${job.id}/event`, {
      headers: await csrfHeaders(page),
      timeout: 15_000,
      data: { kind: 'waiting_for_input' },
    });
    await expect(card).toContainText(/Needs a reply|Wymaga odpowiedzi|waiting_for_input/i, { timeout: 20_000 });
  });
});
