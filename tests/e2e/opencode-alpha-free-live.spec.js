import { test } from '@playwright/test';
import {
  answerLatestOpenCodeQuestion,
  assertNoHardSdkErrorInPane,
  attachChatDebugOnFailure,
  CHAT_E2E_LIVE_TIMEOUT_MS,
  createChatViaApi,
  deleteChatViaApi,
  ensureAuthenticatedPage,
  getAssistantBlockCount,
  maybeResolveOpenCodePermission,
  selectChatInSidebar,
  sendPromptFromActivePane,
  waitForAssistantBlockGrowth,
  waitForOpenCodeQuestionBlock,
  waitForStatusInActivePane,
} from './chat-e2e-helpers.js';

const isLiveRun = process.env.CHAT_E2E_LIVE === '1';
const openCodeModel = process.env.CHAT_E2E_OPENCODE_MODEL || 'opencode/x-preview-f-free';
const openCodeWorkspaceFolder = process.env.CHAT_E2E_WORKSPACE_FOLDER || process.cwd();

test.describe.configure({ mode: 'serial' });

test.describe('live: OpenCode alpha free flow @live @opencode-alpha', () => {
  test.skip(!isLiveRun, 'Set CHAT_E2E_LIVE=1 to run live OpenCode scenario.');

  test('@live @opencode-alpha creates chat and validates response/question/permission flow', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    let chatId = '';
    try {
      await ensureAuthenticatedPage(page);
      const chat = await createChatViaApi(page.request, {
        title: `E2E OpenCode alpha ${Date.now()}`,
        transport: 'opencode',
        mode: 'agent',
        model: openCodeModel,
        workspaceFolder: openCodeWorkspaceFolder,
      });
      chatId = chat.id;
      await selectChatInSidebar(page, chat.id);
      let assistantCount = await getAssistantBlockCount(page);
      await sendPromptFromActivePane(page, 'Reply with a short greeting in one sentence.');
      await waitForStatusInActivePane(page, /(Agent pracuje|Wymaga akcji)/i, 45_000);
      try {
        ({ count: assistantCount } = await waitForAssistantBlockGrowth(
          page,
          assistantCount,
          90_000,
        ));
      } catch {
        testInfo.annotations.push({
          type: 'note',
          description: 'Permission prompt finished without additional assistant block within 90s.',
        });
      }
      await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji|Agent pracuje)/i, 45_000);
      const questionPrompt = [
        'Use interactive question UI to ask me exactly one short multiple-choice question.',
        'Do not answer yet. Wait for my selection.',
      ].join('\n');
      await sendPromptFromActivePane(page, questionPrompt);
      let usedInteractiveQuestion = true;
      try {
        await waitForOpenCodeQuestionBlock(page, 40_000);
        await waitForStatusInActivePane(page, /Wymaga akcji/i, 30_000);
        await answerLatestOpenCodeQuestion(page);
        ({ count: assistantCount } = await waitForAssistantBlockGrowth(
          page,
          assistantCount,
          CHAT_E2E_LIVE_TIMEOUT_MS,
        ));
      } catch {
        usedInteractiveQuestion = false;
        const questionReply = await waitForAssistantBlockGrowth(
          page,
          assistantCount,
          CHAT_E2E_LIVE_TIMEOUT_MS,
        );
        assistantCount = questionReply.count;
        if (!questionReply.latestText.includes('?')) {
          testInfo.annotations.push({
            type: 'note',
            description: 'Question prompt completed without question marker in assistant output.',
          });
        }
      }
      if (!usedInteractiveQuestion) {
        testInfo.annotations.push({
          type: 'note',
          description: 'Question flow used plain assistant question, not interactive question UI.',
        });
      }
      const permissionPrompt = [
        'Write a file at .tmp/opencode-alpha-e2e.txt with line: hello-opencode-alpha.',
        'If permission is required, request it and continue after approval.',
        'When done, confirm in one short sentence.',
      ].join('\n');
      await sendPromptFromActivePane(page, permissionPrompt);
      const permissionSeen = await maybeResolveOpenCodePermission(page, 25_000);
      if (!permissionSeen) {
        testInfo.annotations.push({
          type: 'note',
          description: 'No permission prompt observed; current OpenCode policy may auto-allow workspace writes.',
        });
      }
      try {
        ({ count: assistantCount } = await waitForAssistantBlockGrowth(
          page,
          assistantCount,
          90_000,
        ));
      } catch {
        testInfo.annotations.push({
          type: 'note',
          description: 'Permission prompt finished without additional assistant block within 90s.',
        });
      }
      await waitForStatusInActivePane(page, /(Gotowy|Wymaga akcji|Agent pracuje)/i, 45_000);
      await assertNoHardSdkErrorInPane(page);
    } catch (error) {
      await attachChatDebugOnFailure(page, chatId, testInfo);
      throw error;
    } finally {
      await deleteChatViaApi(page.request, chatId);
    }
  });
});
