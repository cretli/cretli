import { expect, test } from '@playwright/test';
import {
  assertNoHardSdkErrorInPane,
  assertSdkDiagModelAndRunStatus,
  attachChatDebugOnFailure,
  buildPromptExpectingToken,
  buildResponseToken,
  CHAT_E2E_LIVE_TIMEOUT_MS,
  countTokenOccurrencesInActivePane,
  createChatViaApi,
  deleteChatViaApi,
  ensureAuthenticatedPage,
  fetchChatDiag,
  getAssistantBlockCount,
  getAssistantHistoryCount,
  selectChatInSidebar,
  sendPromptFromActivePane,
  stopActiveRunFromActivePane,
  waitForSdkDiagErrorCode,
  waitForSdkAssistantResponse,
  waitForStatusInActivePane,
  waitForTokenInUiOrHistory,
} from './chat-e2e-helpers.js';

const isLiveRun = process.env.CHAT_E2E_LIVE === '1';
const isRecoveryMode = process.env.CHAT_E2E_SDK_RECOVERY === '1';
const sdkFastModel = process.env.CHAT_E2E_SDK_FAST_MODEL || 'composer-2.5::fast=true';
const sdkWorkspaceFolder = process.env.CHAT_E2E_WORKSPACE_FOLDER || process.cwd();

test.describe.configure({ mode: 'serial' });

test.describe('live: SDK composer fast flow @live @sdk-composer-fast', () => {
  test.skip(!isLiveRun, 'Set CHAT_E2E_LIVE=1 to run live SDK composer fast scenario.');
  test('@live @sdk-composer-fast strict fast model + reconnect parity', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    let chatId = '';
    try {
      await ensureAuthenticatedPage(page);
      const chat = await createChatViaApi(page.request, {
        title: `E2E SDK fast ${Date.now()}`,
        transport: 'sdk',
        mode: 'agent',
        model: sdkFastModel,
        workspaceFolder: sdkWorkspaceFolder,
      });
      chatId = chat.id;
      await selectChatInSidebar(page, chat.id);
      const baselineAssistantBlocks = await getAssistantBlockCount(page);
      const baselineAssistantHistory = await getAssistantHistoryCount(page.request, chat.id);
      const responseToken = buildResponseToken('sdk-composer-fast');
      await sendPromptFromActivePane(page, buildPromptExpectingToken(responseToken));
      await waitForStatusInActivePane(page, /(Agent pracuje|Wymaga akcji)/i, 45_000);
      await waitForSdkAssistantResponse(page, page.request, chat.id, {
        baselineAssistantBlocks,
        baselineAssistantHistory,
        timeoutMs: CHAT_E2E_LIVE_TIMEOUT_MS,
      });
      await waitForTokenInUiOrHistory(page, chat.id, responseToken, CHAT_E2E_LIVE_TIMEOUT_MS);
      await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji)/i, 45_000);
      await assertNoHardSdkErrorInPane(page);
      const beforeReloadTokenCount = await countTokenOccurrencesInActivePane(page, responseToken);
      await assertSdkDiagModelAndRunStatus(page.request, chat.id, {
        expectedModel: sdkFastModel,
        expectedStatuses: ['completed'],
        timeoutMs: 90_000,
        strictModel: true,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ensureAuthenticatedPage(page);
      await selectChatInSidebar(page, chat.id);
      await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji|Agent pracuje)/i, 45_000);
      await waitForTokenInUiOrHistory(page, chat.id, responseToken, 60_000);
      const afterReloadTokenCount = await countTokenOccurrencesInActivePane(page, responseToken);
      if (beforeReloadTokenCount > 0) {
        expect(afterReloadTokenCount).toBe(beforeReloadTokenCount);
      }
      await assertSdkDiagModelAndRunStatus(page.request, chat.id, {
        expectedModel: sdkFastModel,
        expectedStatuses: ['completed'],
        timeoutMs: 90_000,
        strictModel: true,
      });
      await assertNoHardSdkErrorInPane(page);
    } catch (error) {
      await attachChatDebugOnFailure(page, chatId, testInfo);
      throw error;
    } finally {
      await deleteChatViaApi(page.request, chatId);
    }
  });

  test('@live @sdk-composer-fast cancel active run returns idle with diagnostic outcome', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    let chatId = '';
    try {
      await ensureAuthenticatedPage(page);
      const chat = await createChatViaApi(page.request, {
        title: `E2E SDK cancel ${Date.now()}`,
        transport: 'sdk',
        mode: 'agent',
        model: sdkFastModel,
        workspaceFolder: sdkWorkspaceFolder,
      });
      chatId = chat.id;
      await selectChatInSidebar(page, chat.id);
      const longPrompt = [
        'Write a long response with exactly 80 numbered lines.',
        'Each line should contain at least 12 words and include one short practical coding tip.',
      ].join('\n');
      await sendPromptFromActivePane(page, longPrompt);
      await waitForStatusInActivePane(page, /(Agent pracuje|Wymaga akcji)/i, 45_000);
      await stopActiveRunFromActivePane(page);
      await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji)/i, 60_000);
      await assertNoHardSdkErrorInPane(page);
      await assertSdkDiagModelAndRunStatus(page.request, chat.id, {
        expectedModel: sdkFastModel,
        expectedStatuses: ['cancelled', 'completed'],
        timeoutMs: 90_000,
        strictModel: true,
      });
    } catch (error) {
      await attachChatDebugOnFailure(page, chatId, testInfo);
      throw error;
    } finally {
      await deleteChatViaApi(page.request, chatId);
    }
  });

  test('@live @sdk-composer-fast multi-client reconnect keeps SDK state consistent', async ({ browser, page }, testInfo) => {
    test.setTimeout(480_000);
    let chatId = '';
    let secondaryContext = null;
    let secondaryPage = null;
    try {
      await ensureAuthenticatedPage(page);
      const chat = await createChatViaApi(page.request, {
        title: `E2E SDK multi-client ${Date.now()}`,
        transport: 'sdk',
        mode: 'agent',
        model: sdkFastModel,
        workspaceFolder: sdkWorkspaceFolder,
      });
      chatId = chat.id;
      await selectChatInSidebar(page, chat.id);
      const responseToken = buildResponseToken('sdk-multiclient');
      await sendPromptFromActivePane(page, buildPromptExpectingToken(responseToken));
      await waitForStatusInActivePane(page, /(Agent pracuje|Wymaga akcji)/i, 45_000);
      await waitForTokenInUiOrHistory(page, chat.id, responseToken, CHAT_E2E_LIVE_TIMEOUT_MS);
      await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji)/i, 45_000);
      const beforeReloadCount = await countTokenOccurrencesInActivePane(page, responseToken);
      secondaryContext = await browser.newContext({
        ignoreHTTPSErrors: true,
      });
      secondaryPage = await secondaryContext.newPage();
      await ensureAuthenticatedPage(secondaryPage);
      await selectChatInSidebar(secondaryPage, chat.id);
      await waitForTokenInUiOrHistory(secondaryPage, chat.id, responseToken, 60_000);
      await waitForStatusInActivePane(secondaryPage, /(Gotowy|Wymaga akcji|Agent pracuje)/i, 45_000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ensureAuthenticatedPage(page);
      await selectChatInSidebar(page, chat.id);
      await waitForTokenInUiOrHistory(page, chat.id, responseToken, 60_000);
      const afterReloadCount = await countTokenOccurrencesInActivePane(page, responseToken);
      if (beforeReloadCount > 0) {
        expect(afterReloadCount).toBe(beforeReloadCount);
      }
      await assertSdkDiagModelAndRunStatus(page.request, chat.id, {
        expectedModel: sdkFastModel,
        expectedStatuses: ['completed'],
        timeoutMs: 90_000,
        strictModel: true,
      });
      const diag = await fetchChatDiag(page.request, chat.id);
      expect(diag?.room?.modelId).toBe(sdkFastModel);
      expect(diag?.room?.strictModelActive).toBe(true);
    } catch (error) {
      await attachChatDebugOnFailure(page, chatId, testInfo);
      if (secondaryPage) {
        await attachChatDebugOnFailure(secondaryPage, chatId, testInfo).catch(() => {});
      }
      throw error;
    } finally {
      if (secondaryContext) {
        await secondaryContext.close();
      }
      await deleteChatViaApi(page.request, chatId);
    }
  });

  test('@live @sdk-recovery SDK timeout auto-recovery exposes diagnostic code', async ({ page }, testInfo) => {
    test.skip(!isRecoveryMode, 'Set CHAT_E2E_SDK_RECOVERY=1 to run SDK recovery scenario.');
    test.setTimeout(480_000);
    let chatId = '';
    try {
      await ensureAuthenticatedPage(page);
      const chat = await createChatViaApi(page.request, {
        title: `E2E SDK recovery ${Date.now()}`,
        transport: 'sdk',
        mode: 'agent',
        model: sdkFastModel,
        workspaceFolder: sdkWorkspaceFolder,
      });
      chatId = chat.id;
      await selectChatInSidebar(page, chat.id);
      const recoveryPrompt = [
        'Use the shell tool and execute exactly this command: sleep 8',
        'After the command, return exactly one line: sdk-recovery-check',
      ].join('\n');
      await sendPromptFromActivePane(page, recoveryPrompt);
      await waitForStatusInActivePane(page, /(Agent pracuje|Wymaga akcji)/i, 45_000);
      await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji|Agent pracuje)/i, 180_000);
      await waitForSdkDiagErrorCode(page.request, chat.id, {
        expectedCodes: ['run_stuck_auto_recovery', 'cursor_rate_limit'],
        timeoutMs: 180_000,
      });
      const diag = await fetchChatDiag(page.request, chat.id);
      const recoveryCode = String(diag?.room?.lastErrorCode || '');
      expect(['run_stuck_auto_recovery', 'cursor_rate_limit']).toContain(recoveryCode);
      if (recoveryCode === 'cursor_rate_limit') {
        testInfo.annotations.push({
          type: 'note',
          description: 'Recovery profile hit Cursor API rate limit before idle-timeout recovery could trigger.',
        });
      }
      const chatModel = String(diag?.model || '').trim();
      const roomModel = String(diag?.room?.modelId || '').trim();
      expect(chatModel).toBe(sdkFastModel);
      expect(roomModel).toBe(sdkFastModel);
      expect(diag?.room?.strictModelActive).toBe(true);
    } catch (error) {
      await attachChatDebugOnFailure(page, chatId, testInfo);
      throw error;
    } finally {
      await deleteChatViaApi(page.request, chatId);
    }
  });
});
