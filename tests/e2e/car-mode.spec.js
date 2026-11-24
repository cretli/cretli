import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { clickSidebarFooterButton, createChatViaApi, cretliCsrfHeaders, deleteChatViaApi, ensureMockNewChatEnvironment } from './chat-e2e-helpers.js';

/**
 * Car mode at phone width (375x812): choose a decision card with big buttons (two steps), stop,
 * listen without the bar covering the controls, type instead, and switch agents across two
 * workspaces by tap and by drag. The decision and presence APIs are mocked in the page.
 */
const card = {
  id: 'card-1', revision: 5, status: 'pending', kind: 'question', title: 'Which database?',
  options: [{ id: 'sqlite', label: 'SQLite' }, { id: 'postgres', label: 'Postgres' }, { id: 'later', label: 'Decide later' }],
  recommended: 'sqlite', workspaceFolder: '', subject: { chatId: 'chat-x' },
};

test.use({ viewport: { width: 375, height: 812 } });

/** Every interactive control inside the car view is a 64 px target and fits the viewport width. */
async function expectBigControls(page) {
  const controls = await page.locator('[data-testid="car-view"] button, [data-testid="car-view"] textarea').evaluateAll((nodes) => nodes
    .filter((node) => node.getBoundingClientRect().width > 0)
    .map((node) => {
      const box = node.getBoundingClientRect();
      return { id: node.dataset.testid || node.textContent.trim().slice(0, 20), height: Math.round(box.height), right: Math.round(box.right) };
    }));
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(control.height, `${control.id} height`).toBeGreaterThanOrEqual(64);
    expect(control.right, `${control.id} fits`).toBeLessThanOrEqual(375);
  }
}

test('car mode: pick, confirm, stop, listening keeps controls free, type instead, stale banner', async ({ page }) => {
  const answers = [];
  let offline = false;
  await page.addInitScript(() => {
    // Frames sent over any WebSocket, so the Stop test can see the cancel sequence.
    window.__sentFrames = [];
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function patched(data) {
      try { window.__sentFrames.push(String(data)); } catch { /* ignore */ }
      return original.call(this, data);
    };
    // No real speech API in the test browser: a stand-in that never hears anything.
    window.SpeechRecognition = class { start() {} stop() { this.onend?.(); } };
  });
  await page.route('**/api/decisions?**', (route) => route.fulfill({ json: { ok: true, revision: 1, items: [card], autonomy: null } }));
  await page.route('**/api/decisions', (route) => route.fulfill({ json: { ok: true, revision: 1, items: [card], autonomy: null } }));
  await page.route('**/api/decisions/card-1', async (route) => {
    answers.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/chats/agent-states**', (route) => (offline
    ? route.abort('failed')
    : route.fulfill({ json: { ok: true, states: { 'chat-x': { state: 'busy' } } } })));

  await ensureMockNewChatEnvironment(page);
  const chat = await createChatViaApi(page.request, { title: 'Car stop chat', transport: 'opencode', model: 'opencode/mock-model', workspaceFolder: process.cwd() });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureMockNewChatEnvironment(page);
  await clickSidebarFooterButton(page, '#header-car-mode-btn');
  const view = page.getByTestId('car-view');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('car-card')).toContainText('Which database?');
  await expectBigControls(page);
  expect(await view.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  // Step one only remembers the pick; nothing is sent yet. Step two sends it with the revision.
  await page.getByTestId('car-option-2').click();
  await expect(page.getByTestId('car-confirm')).toContainText('Postgres');
  expect(answers).toHaveLength(0);
  await expectBigControls(page);
  await page.getByTestId('car-confirm-btn').click();
  await expect.poll(() => answers.length).toBe(1);
  expect(answers[0]).toMatchObject({ optionId: 'postgres', expectedRevision: 5 });

  // Listening: the bar sits in the layout, so Mic, Agents and Stop stay visible and clickable.
  await page.getByTestId('car-mic').click();
  await expect(page.getByTestId('voice-listen-stop')).toBeVisible();
  const stopBox = await page.getByTestId('car-stop').boundingBox();
  const listenBox = await page.locator('.cr-voice-listen').boundingBox();
  expect(stopBox.y + stopBox.height).toBeLessThanOrEqual(812);
  expect(listenBox.y + listenBox.height).toBeLessThanOrEqual(stopBox.y + 1);
  await expectBigControls(page);
  const stopCenter = { x: stopBox.x + stopBox.width / 2, y: stopBox.y + stopBox.height / 2 };
  const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.dataset.testid, stopCenter);
  expect(topmost).toBe('car-stop');

  // Stop is really clicked and the cancel reaches the chat.
  const framesBefore = await page.evaluate(() => window.__sentFrames.length);
  await page.getByTestId('car-stop').click();
  await expect.poll(() => page.evaluate((from) => window.__sentFrames.slice(from).some((frame) => (frame.includes('\u0003') || /\\u0003|cancel|interrupt|stop/i.test(frame))), framesBefore)).toBe(true);
  await page.getByTestId('voice-listen-stop').click();

  // Lost connection: the last data stays but is marked stale; it recovers on its own.
  offline = true;
  await expect(page.getByTestId('car-stale')).toBeVisible({ timeout: 15_000 });
  offline = false;
  await expect(page.getByTestId('car-stale')).toBeHidden({ timeout: 15_000 });

  await page.getByTestId('car-close').click();
  await expect(view).toBeHidden();
  await deleteChatViaApi(page.request, chat.id);
});

test('car mode: header dictation is moved into the view without covering Stop', async ({ page }) => {
  await page.addInitScript(() => {
    window.SpeechRecognition = class { start() {} stop() { this.onend?.(); } };
  });
  await page.route('**/api/decisions**', (route) => route.fulfill({ json: { ok: true, revision: 1, items: [], autonomy: null } }));
  await ensureMockNewChatEnvironment(page);
  await clickSidebarFooterButton(page, '#header-voice-mode-btn');
  await expect(page.locator('.cr-voice-listen')).toHaveCount(1);
  await clickSidebarFooterButton(page, '#header-car-mode-btn');
  await expect(page.getByTestId('car-view')).toBeVisible();
  await expect(page.locator('.cr-voice-listen')).toHaveCount(1);
  const stop = await page.getByTestId('car-stop').boundingBox();
  const centre = { x: stop.x + stop.width / 2, y: stop.y + stop.height / 2 };
  const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.dataset.testid, centre);
  expect(topmost).toBe('car-stop');
});

test('car mode: no speech recognition shows the large message and an inline type-instead field', async ({ page }) => {
  await page.addInitScript(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  await page.route('**/api/decisions**', (route) => route.fulfill({ json: { ok: true, revision: 1, items: [], autonomy: null } }));
  await ensureMockNewChatEnvironment(page);
  await clickSidebarFooterButton(page, '#header-car-mode-btn');
  await page.getByTestId('car-mic').click();
  await expect(page.getByTestId('voice-listen-error')).toBeVisible();
  await expectBigControls(page);
  await page.getByTestId('voice-type-instead').click();
  await expect(page.getByTestId('car-typing')).toBeVisible();
  await expect(page.getByTestId('car-typing-input')).toBeVisible();
  await expectBigControls(page);
});

test('car mode agents screen: two workspaces, switch by tap and by drag with active chat and workspace asserted', async ({ page }) => {
  await page.route('**/api/decisions**', (route) => route.fulfill({ json: { ok: true, revision: 1, items: [], autonomy: null } }));
  let failing = false;
  await page.route('**/api/chats/agent-states**', (route) => (failing
    ? route.abort('failed')
    : route.fulfill({ json: { ok: true, states: {} } })));

  await ensureMockNewChatEnvironment(page);
  // A second, different workspace folder.
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-ws-'));
  await page.request.patch('/api/settings', {
    headers: await cretliCsrfHeaders(page.request),
    data: { workspaceAddPath: otherDir, workspaceAddAs: 'folder' },
  });
  const tag = `run${Date.now()}`;
  const chatA = await createChatViaApi(page.request, { title: `Car agent alpha ${tag}`, transport: 'opencode', model: 'opencode/mock-model', workspaceFolder: process.cwd() });
  const chatB = await createChatViaApi(page.request, { title: `Car agent beta ${tag}`, transport: 'opencode', model: 'opencode/mock-model', workspaceFolder: otherDir });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ensureMockNewChatEnvironment(page);
  await clickSidebarFooterButton(page, '#header-car-mode-btn');
  await page.getByTestId('car-agents-toggle').click();
  await expect(page.getByTestId('car-agents')).toBeVisible();
  await expectBigControls(page);

  const rows = page.getByTestId('car-agent-row').filter({ hasText: tag });
  await expect(rows).toHaveCount(2);
  const activeBefore = await page.getByTestId('car-chat').getAttribute('data-chat-id');
  const workspaceBefore = await page.getByTestId('car-chat').getAttribute('data-workspace');

  // Tap: the big button on a row that is not open switches chat and workspace.
  const tapTarget = page.locator('[data-testid="car-agent-row"]:not(.is-active)').filter({ hasText: tag }).first();
  const tapId = await tapTarget.getAttribute('data-chat-id');
  await tapTarget.getByTestId('car-agent-switch').click();
  await expect(page.getByTestId('car-agents')).toBeHidden();
  await expect(page.getByTestId('car-chat')).toHaveAttribute('data-chat-id', tapId);
  expect(tapId).not.toBe(activeBefore);
  const workspaceAfterTap = await page.getByTestId('car-chat').getAttribute('data-workspace');
  if (activeBefore === chatA.id || activeBefore === chatB.id) expect(workspaceAfterTap).not.toBe(workspaceBefore);

  // Drag: a long horizontal drag on the other row switches back.
  await page.getByTestId('car-agents-toggle').click();
  await expect(page.locator('.cr-car-agents__row.is-active')).toHaveAttribute('data-chat-id', tapId);
  const dragTarget = page.locator('[data-testid="car-agent-row"]:not(.is-active)').filter({ hasText: tag }).first();
  const dragId = await dragTarget.getAttribute('data-chat-id');
  await dragTarget.scrollIntoViewIfNeeded();
  const box = await dragTarget.boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('car-agents')).toBeHidden();
  await expect(page.getByTestId('car-chat')).toHaveAttribute('data-chat-id', dragId);
  expect(dragId).not.toBe(tapId);
  expect([chatA.id, chatB.id]).toContain(dragId);

  // Reconnect: the stale banner shows while presence cannot be fetched and clears on its own.
  failing = true;
  await expect(page.getByTestId('car-stale')).toBeVisible({ timeout: 15_000 });
  failing = false;
  await expect(page.getByTestId('car-stale')).toBeHidden({ timeout: 15_000 });
  await deleteChatViaApi(page.request, chatA.id);
  await deleteChatViaApi(page.request, chatB.id);
});
