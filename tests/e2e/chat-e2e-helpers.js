import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { expect } from '@playwright/test';
import {
  getSdkDiagRunStatusCandidates,
  normalizeSdkRunStatusValue,
} from './chat-e2e-sdk-contract.js';

export const CHAT_E2E_PASSWORD = process.env.CHAT_E2E_PASSWORD || 'chat-e2e-pass-123';
export const CHAT_E2E_LIVE_TIMEOUT_MS = Number.parseInt(process.env.CHAT_E2E_LIVE_TIMEOUT_MS || '180000', 10);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nowStamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function readModeBarText(modeBar) {
  return modeBar.evaluate((el) => {
    const fromShadow = el?.shadowRoot?.textContent || '';
    const fromHost = el?.textContent || '';
    return `${fromShadow} ${fromHost}`.replace(/\s+/g, ' ').trim();
  });
}

async function readStatusSurfaceText(page) {
  const toolbar = page.locator('.chat-fullscreen-bar').first();
  const sidebarActive = page.locator('#app-sidebar .sidebar-chat-item.is-active').first();
  const toolbarText = (await toolbar.count()) > 0 ? normalizeWhitespace(await toolbar.textContent()) : '';
  const sidebarText = (await sidebarActive.count()) > 0 ? normalizeWhitespace(await sidebarActive.textContent()) : '';
  return `${toolbarText} ${sidebarText}`.trim();
}

export function buildResponseToken(prefix) {
  const normalizedPrefix = String(prefix || 'token').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  return `e2e-${normalizedPrefix}-${nowStamp()}`;
}

export function buildPromptExpectingToken(token) {
  const normalizedToken = String(token || '').trim();
  assert.ok(normalizedToken, 'Expected a non-empty token');
  return [
    'Return exactly one line with this token and nothing else:',
    normalizedToken,
  ].join('\n');
}

export async function ensureAuthenticatedPage(page) {
  await page.goto('/');
  const loginRoot = page.locator('cr-login-app');
  if (await loginRoot.count() === 0) {
    await expect(page.locator('#chat-panel')).toBeVisible();
    return;
  }
  const passwordInput = page.locator('cr-bar-input#cr-login-password input');
  await expect(passwordInput).toBeVisible();
  await passwordInput.fill(CHAT_E2E_PASSWORD);
  const confirmInput = page.locator('cr-bar-input#cr-login-confirm input');
  if (await confirmInput.count() > 0) {
    await confirmInput.fill(CHAT_E2E_PASSWORD);
  }
  const submitButton = page.locator('cr-bar-button[variant="primary"] button');
  await expect(submitButton).toBeVisible();
  await submitButton.click();
  await expect(page.locator('#chat-panel')).toBeVisible({ timeout: 60_000 });
}

export async function ensureSidebarOpen(page) {
  const sidebar = page.locator('#app-sidebar');
  if (await sidebar.isVisible()) return true;
  const menuButton = page.locator('#header-menu-btn').first();
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  try {
    await expect(sidebar).toBeVisible({ timeout: 4_000 });
    return true;
  } catch {
    await page.evaluate(() => {
      try {
        localStorage.setItem('cretli-sidebar-open', '1');
      } catch (_) {}
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ensureAuthenticatedPage(page);
    if (await page.locator('#app-sidebar').isVisible()) {
      return true;
    }
    return false;
  }
}

async function cretliCsrfHeaders(request) {
  const statusRes = await request.get('/api/auth-status');
  const status = await statusRes.json().catch(() => ({}));
  const csrfToken = typeof status.csrfToken === 'string' ? status.csrfToken.trim() : '';
  if (!csrfToken) return {};
  return { 'X-Cretli-Csrf': csrfToken };
}

export async function createChatViaApi(request, input) {
  const title = String(input?.title || '').trim();
  const transport = String(input?.transport || 'sdk').trim();
  const mode = input?.mode === 'plan' ? 'plan' : 'agent';
  const model = String(input?.model || '').trim();
  const workspaceFile = String(input?.workspaceFile || '').trim();
  const workspaceFolder = String(input?.workspaceFolder || '').trim();
  assert.ok(title, 'Chat title is required');
  const response = await request.post('/api/chats', {
    headers: await cretliCsrfHeaders(request),
    data: {
      title,
      agentTransport: transport,
      sdkMode: mode,
      ...(model ? { model } : {}),
      ...(workspaceFile ? { workspaceFile } : {}),
      ...(workspaceFolder ? { workspaceFolder } : {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload?.ok !== true || !payload?.chat?.id) {
    const reason = payload?.error || `${response.status()} ${response.statusText()}`;
    throw new Error(`Failed to create "${transport}" chat: ${reason}`);
  }
  return payload.chat;
}

export async function deleteChatViaApi(request, chatId) {
  const id = String(chatId || '').trim();
  if (!id) return;
  await request.delete(`/api/chats/${encodeURIComponent(id)}`, {
    headers: await cretliCsrfHeaders(request),
  }).catch(() => {});
}

export async function selectChatInSidebar(page, chatId) {
  const id = String(chatId || '').trim();
  assert.ok(id, 'Chat id is required');
  const chatItemLocator = () => page.locator(`#app-sidebar .sidebar-chat-item[data-chat-id="${id}"]`);
  const sidebarVisible = await ensureSidebarOpen(page);
  let chatItem = chatItemLocator();
  if (sidebarVisible) {
    try {
      await expect(chatItem).toBeVisible({ timeout: 8_000 });
      await chatItem.click();
      await expect(page.locator('.chat-tab-pane.active')).toBeVisible();
      return;
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ensureAuthenticatedPage(page);
      const sidebarVisibleAfterReload = await ensureSidebarOpen(page);
      if (sidebarVisibleAfterReload) {
        chatItem = chatItemLocator();
        await expect(chatItem).toBeVisible({ timeout: 30_000 });
        await chatItem.click();
        await expect(page.locator('.chat-tab-pane.active')).toBeVisible();
        return;
      }
    }
  }
  const clicked = await page.evaluate((targetChatId) => {
    const item = document.querySelector(`#app-sidebar .sidebar-chat-item[data-chat-id="${targetChatId}"]`);
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  }, id);
  if (!clicked) {
    throw new Error(`Chat item not found in sidebar DOM for chat id: ${id}`);
  }
  await expect(page.locator('.chat-tab-pane.active')).toBeVisible();
}

export async function getActiveChatPane(page) {
  const pane = page.locator('.chat-tab-pane.active').first();
  await expect(pane).toBeVisible();
  return pane;
}

export async function sendPromptFromActivePane(page, prompt) {
  const pane = await getActiveChatPane(page);
  const input = pane.locator('.send-keys-input').first();
  await expect(input).toBeVisible();
  await input.fill(prompt);
  const sendButton = pane.locator('.send-keys-btn').first();
  await expect(sendButton).toBeVisible();
  await sendButton.click();
}

export async function stopActiveRunFromActivePane(page) {
  const sidebar = page.locator('#app-sidebar');
  if (await sidebar.isVisible()) {
    const menuButton = page.locator('#header-menu-btn').first();
    if ((await menuButton.count()) > 0) {
      await menuButton.click({ force: true }).catch(() => {});
    }
  }
  const pane = await getActiveChatPane(page);
  const inlineStopButton = pane.locator('.send-keys-stop-btn').first();
  if ((await inlineStopButton.count()) > 0 && (await inlineStopButton.isVisible())) {
    await inlineStopButton.click({ force: true });
    return;
  }
  const toggleExtraButton = pane.locator('.send-keys-toggle-extra-btn').first();
  if ((await toggleExtraButton.count()) > 0 && (await toggleExtraButton.isVisible())) {
    await toggleExtraButton.click({ force: true });
    const extraStopButton = pane.locator('.send-bar-extra-stop-btn').first();
    if ((await extraStopButton.count()) > 0 && (await extraStopButton.isVisible())) {
      await extraStopButton.click({ force: true });
      return;
    }
    // Close the extra bar again before trying the top toolbar menu.
    await toggleExtraButton.click({ force: true }).catch(() => {});
  }
  // The Stop action now lives in the chat toolbar menu (next to Delete chat).
  const menuStopClicked = await page.evaluate(async () => {
    const moreBtn = document.getElementById('chat-toolbar-more-btn');
    if (!(moreBtn instanceof HTMLElement)) return false;
    moreBtn.click();
    await new Promise((r) => setTimeout(r, 250));
    const stopItem = document.getElementById('chat-stop-menu-btn');
    if (!(stopItem instanceof HTMLElement)) return false;
    if (!(stopItem.offsetWidth || stopItem.offsetHeight)) return false;
    stopItem.click();
    return true;
  });
  if (menuStopClicked) return;
  // Matches both the English and Polish UI labels of the stop button.
  const roleStopButton = pane.getByRole('button', { name: /Stop|Zatrzymaj/i }).first();
  if ((await roleStopButton.count()) > 0 && (await roleStopButton.isVisible())) {
    await roleStopButton.click({ force: true });
    return;
  }
  const cancelledViaDiagnostics = await page.evaluate(() => {
    const cancelButton = document.getElementById('chat-diag-cancel');
    if (!(cancelButton instanceof HTMLButtonElement)) return false;
    cancelButton.click();
    return true;
  });
  if (cancelledViaDiagnostics) return;
  throw new Error('Could not find a visible Stop action in active chat pane.');
}

export async function waitForStatusInActivePane(page, pattern, timeoutMs = 30_000) {
  const modeBar = page.locator('.chat-tab-pane.active cr-sdk-mode-bar').first();
  const startedAt = Date.now();
  let useModeBar = false;
  if (await modeBar.count()) {
    try {
      await expect(modeBar).toBeVisible({ timeout: 4_000 });
      useModeBar = true;
    } catch {
      useModeBar = false;
    }
  }
  while (Date.now() - startedAt <= timeoutMs) {
    const text = useModeBar
      ? await readModeBarText(modeBar)
      : await readStatusSurfaceText(page);
    if (pattern.test(text)) return text;
    await sleep(300);
  }
  const current = useModeBar
    ? await readModeBarText(modeBar)
    : await readStatusSurfaceText(page);
  throw new Error(`Expected status ${pattern} in mode bar. Current value: "${current}"`);
}

export async function setActiveModeInPane(page, mode) {
  const normalizedMode = mode === 'plan' ? 'plan' : 'agent';
  const modeBar = page.locator('.chat-tab-pane.active cr-sdk-mode-bar').first();
  if (await modeBar.count()) {
    try {
      await expect(modeBar).toBeVisible({ timeout: 4_000 });
      await modeBar.evaluate((el, targetMode) => {
        const root = el?.shadowRoot;
        if (!root) throw new Error('Mode bar shadow root is not available');
        const labels = targetMode === 'plan'
          ? ['plan', 'ask']
          : ['agent'];
        const button = [...root.querySelectorAll('.btn')].find((entry) => {
          const text = String(entry.textContent || '').trim().toLowerCase();
          return labels.includes(text);
        });
        if (!button) throw new Error(`Mode button not found: ${targetMode}`);
        button.click();
      }, normalizedMode);
      return;
    } catch {
      // fallback to light-DOM mode buttons
    }
  }
  const labels = normalizedMode === 'plan' ? ['Plan', 'Ask'] : ['Agent'];
  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first();
    if (await button.count()) {
      await button.click();
      return;
    }
  }
  throw new Error(`Mode button not found in fallback flow: ${normalizedMode}`);
}

export async function fetchChatHistory(request, chatId) {
  const id = String(chatId || '').trim();
  const response = await request.get(`/api/chats/${encodeURIComponent(id)}/history?since=0&limit=5000`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload?.ok !== true || !Array.isArray(payload?.events)) {
    return [];
  }
  return payload.events;
}

export async function fetchChatDiag(request, chatId) {
  const id = String(chatId || '').trim();
  assert.ok(id, 'Chat id is required');
  const response = await request.get(`/api/chats/${encodeURIComponent(id)}/diag`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload?.ok !== true) {
    const reason = payload?.error || `${response.status()} ${response.statusText()}`;
    throw new Error(`Failed to fetch chat diag for ${id}: ${reason}`);
  }
  return payload;
}

export async function waitForSdkDiagRunStatus(request, chatId, input = {}) {
  const timeoutMs = Number.isFinite(input?.timeoutMs)
    ? Number(input.timeoutMs)
    : CHAT_E2E_LIVE_TIMEOUT_MS;
  const expectedStatusesInput = Array.isArray(input?.expectedStatuses)
    ? input.expectedStatuses
    : ['completed'];
  const expectedStatuses = expectedStatusesInput
    .map((value) => normalizeSdkRunStatusValue(typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  assert.ok(expectedStatuses.length > 0, 'At least one expected SDK run status is required');
  const startedAt = Date.now();
  let lastDiag = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const diag = await fetchChatDiag(request, chatId);
    lastDiag = diag;
    const statuses = getSdkDiagRunStatusCandidates(diag)
      .map((value) => normalizeSdkRunStatusValue(value))
      .filter(Boolean);
    if (statuses.some((status) => expectedStatuses.includes(status))) {
      return diag;
    }
    await sleep(500);
  }
  const lastStatus = getSdkDiagRunStatusCandidates(lastDiag).join(', ') || null;
  throw new Error(
    `Timed out waiting for SDK diag run status (${expectedStatuses.join(', ')}). Last status: ${String(lastStatus)}`,
  );
}

export async function waitForSdkDiagErrorCode(request, chatId, input = {}) {
  const timeoutMs = Number.isFinite(input?.timeoutMs)
    ? Number(input.timeoutMs)
    : CHAT_E2E_LIVE_TIMEOUT_MS;
  const expectedCodesInput = Array.isArray(input?.expectedCodes)
    ? input.expectedCodes
    : ['run_stuck_auto_recovery'];
  const expectedCodes = expectedCodesInput
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  assert.ok(expectedCodes.length > 0, 'At least one expected SDK error code is required');
  const startedAt = Date.now();
  let lastDiag = null;
  while (Date.now() - startedAt <= timeoutMs) {
    const diag = await fetchChatDiag(request, chatId);
    lastDiag = diag;
    const code =
      diag?.room && typeof diag.room === 'object' && typeof diag.room.lastErrorCode === 'string'
        ? diag.room.lastErrorCode.trim()
        : '';
    if (expectedCodes.includes(code)) {
      return diag;
    }
    await sleep(500);
  }
  const lastCode =
    lastDiag?.room && typeof lastDiag.room === 'object' && typeof lastDiag.room.lastErrorCode === 'string'
      ? lastDiag.room.lastErrorCode
      : null;
  throw new Error(
    `Timed out waiting for SDK diag error code (${expectedCodes.join(', ')}). Last code: ${String(lastCode)}`,
  );
}

export async function assertSdkDiagModelAndRunStatus(request, chatId, input = {}) {
  const expectedModel = String(input?.expectedModel || '').trim();
  assert.ok(expectedModel, 'Expected SDK model is required');
  const expectedStatusesInput = Array.isArray(input?.expectedStatuses)
    ? input.expectedStatuses
    : ['completed'];
  const expectedStatuses = expectedStatusesInput
    .map((value) => normalizeSdkRunStatusValue(typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  const diag = await waitForSdkDiagRunStatus(request, chatId, {
    expectedStatuses,
    timeoutMs: input?.timeoutMs,
  });
  const transport = typeof diag?.transport === 'string' ? diag.transport.trim() : '';
  assert.equal(transport, 'sdk', `Expected SDK transport in diag, received "${transport || 'empty'}"`);
  const chatModel = typeof diag?.model === 'string' ? diag.model.trim() : '';
  assert.equal(chatModel, expectedModel, `Expected chat.model "${expectedModel}" but received "${chatModel || 'empty'}"`);
  const roomModel = typeof diag?.room?.modelId === 'string' ? diag.room.modelId.trim() : '';
  assert.equal(roomModel, expectedModel, `Expected room.modelId "${expectedModel}" but received "${roomModel || 'empty'}"`);
  if (input?.strictModel === true) {
    assert.equal(
      diag?.modelAudit?.strictModelActive === true || diag?.room?.strictModelActive === true,
      true,
      'Expected strict model mode to be active in diag.',
    );
    const fallbackApplied =
      diag?.modelAudit?.lastModelFallback?.applied === true ||
      diag?.room?.lastModelFallback?.applied === true;
    assert.equal(fallbackApplied, false, 'Strict model scenario must not silently apply fallback.');
  }
  return diag;
}

function toAssistantHistoryRecords(historyRows) {
  return historyRows
    .map((eventRow) => (eventRow && typeof eventRow === 'object' ? eventRow.rec : null))
    .map((rec) => {
      if (!rec || typeof rec !== 'object') return null;
      if (rec.type === 'assistant') return rec;
      if (rec.type === 'sdkEvent' && rec.event && typeof rec.event === 'object' && rec.event.type === 'assistant') {
        return rec.event;
      }
      return null;
    })
    .filter(Boolean);
}

export async function getAssistantHistoryCount(request, chatId) {
  const history = await fetchChatHistory(request, chatId);
  return toAssistantHistoryRecords(history).length;
}

export async function waitForAssistantHistoryGrowth(request, chatId, baselineCount, timeoutMs = CHAT_E2E_LIVE_TIMEOUT_MS) {
  const startedAt = Date.now();
  const baseline = Number.isFinite(baselineCount) ? Number(baselineCount) : 0;
  while (Date.now() - startedAt <= timeoutMs) {
    const history = await fetchChatHistory(request, chatId);
    const assistantRecords = toAssistantHistoryRecords(history);
    if (assistantRecords.length > baseline) {
      return {
        count: assistantRecords.length,
        latest: assistantRecords[assistantRecords.length - 1],
      };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for assistant response in history for chat ${chatId}`);
}

export async function getAssistantBlockCount(page) {
  const pane = await getActiveChatPane(page);
  return pane.locator('.sdk-rich-assistant-md').count();
}

export async function waitForAssistantBlockGrowth(page, baselineCount, timeoutMs = CHAT_E2E_LIVE_TIMEOUT_MS) {
  const pane = await getActiveChatPane(page);
  const baseline = Number.isFinite(baselineCount) ? Number(baselineCount) : 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const blocks = pane.locator('.sdk-rich-assistant-md');
    const count = await blocks.count();
    if (count > baseline) {
      const latest = blocks.last();
      const latestText = normalizeWhitespace(await latest.textContent());
      if (latestText) {
        return { count, latestText };
      }
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for assistant block growth in UI');
}

export async function waitForSdkAssistantResponse(page, request, chatId, input = {}) {
  const baselineAssistantBlocks = Number.isFinite(input?.baselineAssistantBlocks)
    ? Number(input.baselineAssistantBlocks)
    : 0;
  const baselineAssistantHistory = Number.isFinite(input?.baselineAssistantHistory)
    ? Number(input.baselineAssistantHistory)
    : 0;
  const timeoutMs = Number.isFinite(input?.timeoutMs)
    ? Number(input.timeoutMs)
    : CHAT_E2E_LIVE_TIMEOUT_MS;
  const ui = await waitForAssistantBlockGrowth(page, baselineAssistantBlocks, timeoutMs);
  const [historyResult, diagResult] = await Promise.allSettled([
    waitForAssistantHistoryGrowth(request, chatId, baselineAssistantHistory, timeoutMs),
    waitForSdkDiagRunStatus(request, chatId, {
      expectedStatuses: ['completed'],
      timeoutMs,
    }),
  ]);
  const history = historyResult.status === 'fulfilled' ? historyResult.value : null;
  const diag = diagResult.status === 'fulfilled' ? diagResult.value : null;
  if (!history && !diag) {
    const historyReason = historyResult.status === 'rejected' ? String(historyResult.reason?.message || historyResult.reason) : '';
    const diagReason = diagResult.status === 'rejected' ? String(diagResult.reason?.message || diagResult.reason) : '';
    throw new Error(`SDK response evidence missing (history+diag). history=${historyReason}; diag=${diagReason}`);
  }
  return { ui, history, diag };
}

export async function waitForTokenInUiOrHistory(page, chatId, token, timeoutMs = CHAT_E2E_LIVE_TIMEOUT_MS) {
  const startedAt = Date.now();
  const expectedToken = String(token || '').trim();
  assert.ok(expectedToken, 'Expected token is required');
  while (Date.now() - startedAt <= timeoutMs) {
    const pane = await getActiveChatPane(page);
    const paneText = normalizeWhitespace(await pane.textContent());
    const escaped = expectedToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const paneOccurrences = (paneText.match(new RegExp(escaped, 'g')) || []).length;
    if (paneOccurrences >= 2) return;
    const history = await fetchChatHistory(page.request, chatId);
    const assistantRecords = toAssistantHistoryRecords(history);
    const containsInHistory = assistantRecords.some((payload) =>
      JSON.stringify(payload).includes(expectedToken)
    );
    if (containsInHistory) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for token "${expectedToken}" in UI/history`);
}

export async function countTokenOccurrencesInActivePane(page, token) {
  const pane = await getActiveChatPane(page);
  const value = await pane.textContent();
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = String(value || '').match(new RegExp(escaped, 'g'));
  return matches ? matches.length : 0;
}

export async function attachChatDebugOnFailure(page, chatId, testInfo) {
  const id = String(chatId || '').trim();
  if (!id) return;
  let statusTailPayload = {
    ok: false,
    error: 'Could not fetch status-tail',
  };
  try {
    const response = await page.request.get(
      `/api/chats/${encodeURIComponent(id)}/status-tail?limit=8000`,
      { timeout: 10_000 },
    );
    statusTailPayload = await response.json().catch(() => ({
      ok: false,
      error: 'Could not parse status-tail JSON',
    }));
  } catch (error) {
    statusTailPayload = {
      ok: false,
      error: `status-tail request failed: ${String(error?.message || error)}`,
    };
  }
  const outputPath = testInfo.outputPath(`status-tail-${id}.json`);
  await fs.writeFile(outputPath, JSON.stringify(statusTailPayload, null, 2), 'utf8');
  await testInfo.attach(`status-tail-${id}`, {
    path: outputPath,
    contentType: 'application/json',
  });
  let diagPayload = {
    ok: false,
    error: 'Could not fetch diag',
  };
  try {
    const response = await page.request.get(
      `/api/chats/${encodeURIComponent(id)}/diag`,
      { timeout: 10_000 },
    );
    diagPayload = await response.json().catch(() => ({
      ok: false,
      error: 'Could not parse diag JSON',
    }));
  } catch (error) {
    diagPayload = {
      ok: false,
      error: `diag request failed: ${String(error?.message || error)}`,
    };
  }
  const diagOutputPath = testInfo.outputPath(`diag-${id}.json`);
  await fs.writeFile(diagOutputPath, JSON.stringify(diagPayload, null, 2), 'utf8');
  await testInfo.attach(`diag-${id}`, {
    path: diagOutputPath,
    contentType: 'application/json',
  });
}

export async function assertNoHardSdkErrorInPane(page) {
  const pane = await getActiveChatPane(page);
  const normalized = normalizeWhitespace(await pane.textContent());
  const forbidden = ['sdkError', 'SDK error', 'OpenCode error', 'OpenRouter error'];
  const hit = forbidden.find((entry) => normalized.includes(entry));
  if (hit) {
    throw new Error(`Detected hard error marker in chat pane: ${hit}`);
  }
}

export async function waitForOpenCodeQuestionBlock(page, timeoutMs = 45_000) {
  const pane = await getActiveChatPane(page);
  const questionBlock = pane.locator('.sdk-rich-opencode-question').last();
  await expect(questionBlock).toBeVisible({ timeout: timeoutMs });
  return questionBlock;
}

export async function answerLatestOpenCodeQuestion(page) {
  const questionBlock = await waitForOpenCodeQuestionBlock(page);
  const optionButton = questionBlock.locator('.sdk-rich-opencode-question-option').first();
  if (await optionButton.count()) {
    await optionButton.click();
  } else {
    const customInput = questionBlock.locator('.sdk-rich-opencode-question-custom');
    if (await customInput.count()) {
      await customInput.fill('Yes');
    }
  }
  const submitButton = questionBlock.locator('.sdk-rich-opencode-question-submit');
  await expect(submitButton).toBeVisible();
  await submitButton.click();
}

export async function maybeResolveOpenCodePermission(page, timeoutMs = 20_000) {
  const pane = await getActiveChatPane(page);
  const permissionBlock = pane.locator('.sdk-rich-opencode-permission').last();
  try {
    await expect(permissionBlock).toBeVisible({ timeout: timeoutMs });
  } catch {
    return false;
  }
  const allowOnce = permissionBlock.locator('.sdk-rich-opencode-permission-once');
  await expect(allowOnce).toBeVisible();
  await allowOnce.click();
  return true;
}
