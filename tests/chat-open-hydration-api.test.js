import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../app_front/features/chat/services/chatOpenHydration.js', import.meta.url), 'utf8')
  .replace(/^import\b[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');

for (const transport of ['sdk', 'codex', 'claude', 'opencode', 'openrouter']) {
  test(`empty ${transport} history uses only a supported API fallback`, async () => {
    let apiCalls = 0;
    let completed = false;
    const context = vm.createContext({
      api: { getChatSdkMessages: async () => { apiCalls++; return { ok: true, formatted: '' }; } },
      readSdkChatHistoryStateAsync: async () => null,
      preloadMarkdownEngine: async () => null,
      setTimeout,
      hydrateSdkRichViewFromLocalCache: async () => ({ hydratedRecords: [], structuredReplayDone: false }),
      shouldArmCachedHistorySyncIndicator: () => false,
      shouldLogColdBootCachedRender: () => false,
      chatShell: {},
      captureHydrationHttpBoundary: () => ({}),
      pullChatHistoryFromServer: async () => ({ headSeq: 0, events: [] }),
      isHydrationHttpBoundaryCurrent: () => true,
      CHAT_HISTORY_INITIAL_TAIL: 100,
      waitForHistoryReplaySettled: async () => {},
      clearSdkOpenTerminalHydrating: () => {},
      chatHost: {
        chatTransport: { completeSdkHistoryHydration: () => { completed = true; } },
        ensureChatConnection: () => {},
      },
      updateAwaitingInput: () => {},
      renderChatTerminalState: () => {},
      armOlderSdkHistory: () => {},
      refreshRelatedChatHistoryLinks: () => {},
    });
    vm.runInContext(source, context);
    await context.hydrateOpenedChat({ id: 'empty-chat', agentTransport: transport });
    assert.equal(apiCalls, transport === 'sdk' ? 1 : 0);
    assert.equal(completed, true, 'empty history still finishes hydration');
  });
}
