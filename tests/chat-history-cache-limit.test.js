import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  getChatHistoryCacheStats,
  loadChatHistory,
  MAX_CACHED_CHAT_HISTORIES,
  MAX_CACHED_CHAT_HISTORY_BYTES,
} from '../lib/persist/chat-history-persist.js';

function writeHistory(chatId, padBytes) {
  const dir = path.join(ISOLATED_DATA_DIR, 'chat-history');
  fs.mkdirSync(dir, { recursive: true });
  const doc = { v: 1, chatId, cursorSessionId: '', headSeq: 0, updatedAt: '', events: [], pad: 'x'.repeat(padBytes) };
  fs.writeFileSync(path.join(dir, `${chatId}.json`), JSON.stringify(doc));
}

test('history cache is bounded by entry count', () => {
  for (let i = 0; i < MAX_CACHED_CHAT_HISTORIES + 4; i += 1) {
    writeHistory(`count-${i}`, 100);
    assert.ok(loadChatHistory(`count-${i}`));
  }
  assert.ok(getChatHistoryCacheStats().entries <= MAX_CACHED_CHAT_HISTORIES);
});

test('history cache is bounded by total bytes and keeps the newest entry', () => {
  const pad = Math.floor(MAX_CACHED_CHAT_HISTORY_BYTES / 3);
  for (let i = 0; i < 5; i += 1) {
    writeHistory(`big-${i}`, pad + i);
    assert.equal(loadChatHistory(`big-${i}`).chatId, `big-${i}`);
  }
  const stats = getChatHistoryCacheStats();
  assert.ok(stats.bytes <= MAX_CACHED_CHAT_HISTORY_BYTES, `cached ${stats.bytes} bytes`);
  assert.ok(stats.entries >= 1);
  // A single file above the budget is still served and cached alone.
  writeHistory('huge', MAX_CACHED_CHAT_HISTORY_BYTES + 1024);
  assert.equal(loadChatHistory('huge').chatId, 'huge');
  assert.equal(getChatHistoryCacheStats().entries, 1);
});
