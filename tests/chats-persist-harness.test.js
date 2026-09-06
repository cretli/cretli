import assert from 'node:assert/strict';
import fs from 'fs';
import {
  isCodeBuddyChat,
  isCodexChat,
  isDeepSeekChat,
  isQwenChat,
  isOpenCodeChat,
  isOpenRouterChat,
  isSdkChat,
  normalizeAgentTransport,
  usesHarnessWebSocket,
} from '../lib/agent-transport.js';
import { loadChats, saveChats, updateChat } from '../lib/persist/chats-persist.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

const dataFile = resolveDataPath('chats.json');
const backup = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : null;

try {
  saveChats([
    {
      id: '1',
      title: 'SDK',
      cursorSessionId: 's1',
      agentTransport: 'sdk',
      createdAt: new Date().toISOString(),
    },
    {
      id: '2',
      title: 'OR',
      cursorSessionId: 's2',
      agentTransport: 'openrouter',
      createdAt: new Date().toISOString(),
    },
    {
      id: '3',
      title: 'OC',
      cursorSessionId: 's3',
      agentTransport: 'opencode',
      opencodeSessionId: 'oc-sess-1',
      createdAt: new Date().toISOString(),
    },
    {
      id: '4',
      title: 'CB',
      cursorSessionId: 's4',
      agentTransport: 'codebuddy',
      codebuddySessionId: 'cb-sess-1',
      createdAt: new Date().toISOString(),
    },
    {
      id: '5',
      title: 'DSH',
      cursorSessionId: 's5',
      agentTransport: 'deepseek',
      deepseekSessionId: 'dsh-sess-1',
      createdAt: new Date().toISOString(),
    },
    {
      id: '6',
      title: 'CX',
      cursorSessionId: 's6',
      agentTransport: 'codex',
      codexThreadId: 'cx-thread-1',
      createdAt: new Date().toISOString(),
    },
    {
      id: '7',
      title: 'QW',
      cursorSessionId: 's7',
      agentTransport: 'qwen',
      qwenSessionId: 'qwen-sess-1',
      createdAt: new Date().toISOString(),
    },
  ]);
  const loaded = loadChats();
  assert.equal(loaded.length, 7);
  assert.ok(loaded.some((chat) => chat.agentTransport === 'openrouter'));
  assert.ok(loaded.some((chat) => chat.agentTransport === 'opencode'));
  assert.ok(loaded.some((chat) => chat.opencodeSessionId === 'oc-sess-1'));
  assert.ok(loaded.some((chat) => chat.agentTransport === 'codebuddy'));
  assert.ok(loaded.some((chat) => chat.codebuddySessionId === 'cb-sess-1'));
  assert.ok(loaded.some((chat) => chat.agentTransport === 'deepseek'));
  assert.ok(loaded.some((chat) => chat.deepseekSessionId === 'dsh-sess-1'));
  assert.ok(loaded.some((chat) => chat.agentTransport === 'codex'));
  assert.ok(loaded.some((chat) => chat.codexThreadId === 'cx-thread-1'));
  assert.ok(loaded.some((chat) => chat.agentTransport === 'qwen'));
  assert.ok(loaded.some((chat) => chat.qwenSessionId === 'qwen-sess-1'));
  const archived = updateChat('2', { archived: true });
  assert.equal(typeof archived?.archivedAt, 'string');
  const restored = updateChat('2', { archived: false });
  assert.equal(Object.hasOwn(restored || {}, 'archivedAt'), false);
  updateChat('1', { widgetPinnedUrl: 'http://host/page' });
  updateChat('2', { widgetPinnedUrl: 'http://host/page/' });
  const afterPin = loadChats();
  assert.equal(afterPin.find((chat) => chat.id === '1')?.widgetPinnedUrl, undefined);
  assert.equal(afterPin.find((chat) => chat.id === '2')?.widgetPinnedUrl, 'http://host/page/');
  updateChat('1', { sdkMode: 'ask' });
  assert.equal(loadChats().find((chat) => chat.id === '1')?.sdkMode, 'ask');
} finally {
  if (backup == null) {
    if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  } else {
    fs.writeFileSync(dataFile, backup, 'utf8');
  }
}

assert.equal(normalizeAgentTransport('openrouter'), 'openrouter');
assert.equal(normalizeAgentTransport('opencode'), 'opencode');
assert.equal(normalizeAgentTransport('codebuddy'), 'codebuddy');
assert.equal(normalizeAgentTransport('deepseek'), 'deepseek');
assert.equal(normalizeAgentTransport('codex'), 'codex');
assert.equal(normalizeAgentTransport('qwen'), 'qwen');
assert.equal(isOpenRouterChat({ agentTransport: 'openrouter' }), true);
assert.equal(isOpenCodeChat({ agentTransport: 'opencode' }), true);
assert.equal(isCodeBuddyChat({ agentTransport: 'codebuddy' }), true);
assert.equal(isDeepSeekChat({ agentTransport: 'deepseek' }), true);
assert.equal(isCodexChat({ agentTransport: 'codex' }), true);
assert.equal(isQwenChat({ agentTransport: 'qwen' }), true);
assert.equal(isSdkChat({ agentTransport: 'sdk' }), true);
assert.equal(usesHarnessWebSocket({ agentTransport: 'opencode' }), true);
assert.equal(usesHarnessWebSocket({ agentTransport: 'codebuddy' }), true);
assert.equal(usesHarnessWebSocket({ agentTransport: 'deepseek' }), true);
assert.equal(usesHarnessWebSocket({ agentTransport: 'codex' }), true);
assert.equal(usesHarnessWebSocket({ agentTransport: 'qwen' }), true);
assert.equal(usesHarnessWebSocket({ agentTransport: 'sdk' }), true);
assert.equal(usesHarnessWebSocket({}), false);
assert.equal(usesHarnessWebSocket({ id: 't-1', title: 'Terminal 1', ws: {} }), false);

console.log('chats-persist-harness.test.js OK');
