import assert from 'node:assert/strict';
import {
  widgetChatAccessScope,
  widgetChatListScope,
} from '../lib/widget/widget-chat-scope.js';

const ACCESS = {
  installationId: 'inst-1',
  pageSessionId: 'page-1',
  workspaceFile: '/work/project.code-workspace',
  workspaceFolder: '/work/project',
};

function createChat(overrides = {}) {
  return {
    id: 'chat-1',
    widgetInstallationId: 'inst-1',
    widgetPageSessionId: 'page-1',
    workspaceFile: '/work/project.code-workspace',
    workspaceFolder: '/work/project',
    agentTransport: 'sdk',
    ...overrides,
  };
}

function executeTest(name, callback) {
  try {
    callback();
    console.log(`OK: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

executeTest('widgetChatListScope allows matching SDK chat', () => {
  assert.equal(widgetChatListScope(createChat(), ACCESS), true);
});

executeTest('widgetChatListScope allows matching non-SDK chats', () => {
  assert.equal(widgetChatListScope(createChat({ agentTransport: 'openrouter' }), ACCESS), true);
  assert.equal(widgetChatListScope(createChat({ agentTransport: 'opencode' }), ACCESS), true);
});

executeTest('widgetChatListScope rejects chat outside installation or page scope', () => {
  assert.equal(widgetChatListScope(createChat({ widgetInstallationId: 'inst-2' }), ACCESS), false);
  assert.equal(widgetChatListScope(createChat({ widgetPageSessionId: 'page-2' }), ACCESS), false);
});

executeTest('widgetChatAccessScope allows pinned chat from same installation and workspace', () => {
  const pinnedChat = createChat({
    widgetPageSessionId: 'other-page',
    widgetPinnedUrl: 'https://docs.example.com/page',
    agentTransport: 'openrouter',
  });
  assert.equal(widgetChatAccessScope(pinnedChat, ACCESS), true);
});

executeTest('widgetChatAccessScope rejects unpinned chat from another page', () => {
  const notPinnedChat = createChat({
    widgetPageSessionId: 'other-page',
    agentTransport: 'opencode',
  });
  assert.equal(widgetChatAccessScope(notPinnedChat, ACCESS), false);
});

console.log('widget-chat-scope.test.js OK');
