import { test, expect } from '@playwright/test';
import {
  attachChatDebugOnFailure,
  buildPromptExpectingToken,
  buildResponseToken,
  CHAT_E2E_LIVE_TIMEOUT_MS,
  countTokenOccurrencesInActivePane,
  createChatViaApi,
  deleteChatViaApi,
  ensureAuthenticatedPage,
  selectChatInSidebar,
  sendPromptFromActivePane,
  waitForStatusInActivePane,
  waitForTokenInUiOrHistory,
} from './chat-e2e-helpers.js';

const isLiveRun = process.env.CHAT_E2E_LIVE === '1';

test.describe.configure({ mode: 'serial' });

test.describe('live: reconnect and replay @live', () => {
  test.skip(!isLiveRun, 'Set CHAT_E2E_LIVE=1 to run reconnect scenarios.');

  /** @type {Array<'sdk' | 'opencode' | 'openrouter'>} */
  const transports = ['sdk', 'opencode', 'openrouter'];
  for (const transport of transports) {
    test(`@live ${transport}: reload restores state without duplicate replay`, async ({ page }, testInfo) => {
      let chatId = '';
      try {
        await ensureAuthenticatedPage(page);
        const chat = await createChatViaApi(page.request, {
          title: `E2E reconnect ${transport} ${Date.now()}`,
          transport,
          mode: 'agent',
        });
        chatId = chat.id;
        await selectChatInSidebar(page, chat.id);
        const responseToken = buildResponseToken(`${transport}-reconnect`);
        await sendPromptFromActivePane(page, buildPromptExpectingToken(responseToken));
        await waitForTokenInUiOrHistory(page, chat.id, responseToken, CHAT_E2E_LIVE_TIMEOUT_MS);
        await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji)/i, 45_000);
        const beforeReloadCount = await countTokenOccurrencesInActivePane(page, responseToken);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await ensureAuthenticatedPage(page);
        await selectChatInSidebar(page, chat.id);
        await waitForTokenInUiOrHistory(page, chat.id, responseToken, 60_000);
        await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji|Agent pracuje)/i, 45_000);
        const afterReloadCount = await countTokenOccurrencesInActivePane(page, responseToken);
        if (beforeReloadCount > 0) {
          expect(afterReloadCount).toBe(beforeReloadCount);
        }
      } catch (error) {
        await attachChatDebugOnFailure(page, chatId, testInfo);
        throw error;
      } finally {
        await deleteChatViaApi(page.request, chatId);
      }
    });
  }
});
