import assert from 'node:assert/strict';
import fs from 'fs';
import {
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
  ]);
  const loaded = loadChats();
  assert.equal(loaded.length, 3);
  assert.ok(loaded.some((chat) => chat.agentTransport === 'openrouter'));
  assert.ok(loaded.some((chat) => chat.agentTransport === 'opencode'));
  assert.ok(loaded.some((chat) => chat.opencodeSessionId === 'oc-sess-1'));
  const archived = updateChat('2', { archived: true });
  assert.equal(typeof archived?.archivedAt, 'string');
  const restored = updateChat('2', { archived: false });
  assert.equal(Object.hasOwn(restored || {}, 'archivedAt'), false);
} finally {
  if (backup == null) {
    if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  } else {
    fs.writeFileSync(dataFile, backup, 'utf8');
  }
}

assert.equal(normalizeAgentTransport('openrouter'), 'openrouter');
assert.equal(normalizeAgentTransport('opencode'), 'opencode');
assert.equal(isOpenRouterChat({ agentTransport: 'openrouter' }), true);
assert.equal(isOpenCodeChat({ agentTransport: 'opencode' }), true);
assert.equal(isSdkChat({ agentTransport: 'sdk' }), true);
assert.equal(usesHarnessWebSocket({ agentTransport: 'opencode' }), true);

console.log('chats-persist-harness.test.js OK');
