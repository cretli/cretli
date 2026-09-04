import { test, expect } from '@playwright/test';
import {
  assertNoHardSdkErrorInPane,
  attachChatDebugOnFailure,
  buildPromptExpectingToken,
  buildResponseToken,
  CHAT_E2E_LIVE_TIMEOUT_MS,
  createChatViaApi,
  deleteChatViaApi,
  ensureAuthenticatedPage,
  getActiveChatPane,
  setActiveModeInPane,
  selectChatInSidebar,
  sendPromptFromActivePane,
  waitForStatusInActivePane,
  waitForTokenInUiOrHistory,
} from './chat-e2e-helpers.js';

const isLiveRun = process.env.CHAT_E2E_LIVE === '1';

test.describe.configure({ mode: 'serial' });

test.describe('live: chat harnesses @live', () => {
  test.skip(!isLiveRun, 'Set CHAT_E2E_LIVE=1 to run live chat scenarios.');

  /** @type {Array<'sdk' | 'opencode' | 'openrouter'>} */
  const transports = ['sdk', 'opencode', 'openrouter'];
  for (const transport of transports) {
    test(`@live ${transport}: send prompt and wait for response`, async ({ page }, testInfo) => {
      let chatId = '';
      try {
        await ensureAuthenticatedPage(page);
        const mode = transport === 'openrouter' ? 'plan' : 'agent';
        const chat = await createChatViaApi(page.request, {
          title: `E2E ${transport} ${Date.now()}`,
          transport,
          mode,
        });
        chatId = chat.id;
        await selectChatInSidebar(page, chat.id);
        const expectedToken = buildResponseToken(transport);
        const prompt = buildPromptExpectingToken(expectedToken);
        await sendPromptFromActivePane(page, prompt);
        await waitForStatusInActivePane(page, /(Agent pracuje|Wymaga akcji)/i, 45_000);
        await waitForTokenInUiOrHistory(page, chat.id, expectedToken, CHAT_E2E_LIVE_TIMEOUT_MS);
        await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji)/i, 45_000);
        if (transport === 'openrouter') {
          await setActiveModeInPane(page, 'agent');
          const secondToken = buildResponseToken(`${transport}-agent`);
          await sendPromptFromActivePane(page, buildPromptExpectingToken(secondToken));
          await waitForTokenInUiOrHistory(page, chat.id, secondToken, CHAT_E2E_LIVE_TIMEOUT_MS);
          await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji)/i, 45_000);
        }
        await assertNoHardSdkErrorInPane(page);
        if (transport === 'opencode') {
          const pane = await getActiveChatPane(page);
          const pendingQuestion = pane.locator('.sdk-rich-opencode-question');
          const pendingPermission = pane.locator('.sdk-rich-opencode-permission');
          const hasInteractive = (await pendingQuestion.count()) > 0 || (await pendingPermission.count()) > 0;
          if (hasInteractive) {
            const replyButtons = pane.locator('.sdk-rich-opencode-question-submit, .sdk-rich-opencode-permission-actions button');
            await test.step('validate OpenCode interactive controls when present', async () => {
              if ((await replyButtons.count()) > 0) {
                  await expect(replyButtons.first()).toBeVisible();
              }
            });
          }
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
