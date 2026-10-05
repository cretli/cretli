import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { appendChatHistoryEvents, loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { collectChatHistoryContextStats } from '../lib/sdk/sdk-context-stats.js';

const historyDir = path.join(ISOLATED_DATA_DIR, 'chat-history');
const originalRead = fs.readFileSync;
let historyReads = 0;
fs.readFileSync = function readFileSyncCounting(target, ...args) {
  if (String(target).includes(`${path.sep}chat-history${path.sep}`)) historyReads += 1;
  return originalRead.call(this, target, ...args);
};

/**
 * @param {string} chatId
 * @param {number} padLength
 */
function writeHistory(chatId, padLength) {
  const doc = {
    v: 1,
    chatId,
    cursorSessionId: '',
    headSeq: 0,
    updatedAt: '',
    events: [],
    pad: 'x'.repeat(padLength),
  };
  fs.writeFileSync(path.join(historyDir, `${chatId}.json`), JSON.stringify(doc));
}

try {
  fs.mkdirSync(historyDir, { recursive: true });
  writeHistory('reopen-chat', 20);
  historyReads = 0;
  const first = loadChatHistory('reopen-chat');
  const second = loadChatHistory('reopen-chat');
  assert.equal(first?.chatId, 'reopen-chat');
  assert.equal(second?.headSeq, 0);
  assert.equal(second?.usageSummary, first?.usageSummary);
  assert.equal(historyReads, 1);
  const appended = appendChatHistoryEvents('reopen-chat', '', [{
    rec: { kind: 'localUser', text: 'hello' },
  }]);
  assert.equal(appended.ok, true);
  const withUsage = appendChatHistoryEvents('reopen-chat', '', [{
    rec: {
      kind: 'sdk',
      event: { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadTokens: 4 } },
    },
  }]);
  assert.equal(withUsage.ok, true);
  const stored = JSON.parse(fs.readFileSync(path.join(historyDir, 'reopen-chat.json'), 'utf8'));
  assert.equal('usageSummary' in stored, false);
  historyReads = 0;
  const afterSave = loadChatHistory('reopen-chat');
  assert.equal(afterSave?.headSeq, withUsage.headSeq);
  assert.equal(afterSave?.usageSummary?.localUserCount, 1);
  assert.equal(afterSave?.usageSummary?.lastUsageInputTokens, 12);
  historyReads = 0;
  const stats = collectChatHistoryContextStats('reopen-chat');
  assert.equal(stats.localUserCount, 1);
  assert.equal(stats.lastUsageInputTokens, 12);
  assert.equal(historyReads, 0, 'diag reads the cached usage snapshot');
  historyReads = 0;
  for (let index = 0; index < 9; index += 1) {
    writeHistory(`sized-${index}`, index * 40);
    loadChatHistory(`sized-${index}`);
  }
  historyReads = 0;
  loadChatHistory('sized-8');
  assert.equal(historyReads, 0, 'the heaviest cached chat stays in memory');
  loadChatHistory('sized-0');
  assert.equal(historyReads, 1, 'the smallest chat is evicted once eight heavier files are cached');
  console.log('chat-history-cache.test.js ok');
} finally {
  fs.readFileSync = originalRead;
}
