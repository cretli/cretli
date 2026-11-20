import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { parseTimeoutProgressNotice } from '../lib/notices.js';
import { isValidSdkHistoryRecord } from '../lib/persist/chat-history-validate.js';
import {
  appendChatHistoryEvents,
  deleteChatHistory,
  getChatHistoryPage,
} from '../lib/persist/chat-history-persist.js';

const chatId = 'timeout-progress-history-test';
const firstText = '[SDK] Brak nowych zdarzeń od 21s. Próg ostrzegawczy za ok. 2979s.';
const secondText = '[SDK] Brak nowych zdarzeń od 36s. Próg ostrzegawczy za ok. 2964s.';
const firstProgress = parseTimeoutProgressNotice(firstText);
const secondProgress = parseTimeoutProgressNotice(secondText);

assert.equal(firstProgress?.idleSeconds, 21);
assert.equal(secondProgress?.idleSeconds, 36);

const firstRec = {
  kind: 'meta',
  variant: 'notice',
  payload: firstText,
  progress: firstProgress,
};
const secondRec = {
  kind: 'meta',
  variant: 'notice',
  payload: secondText,
  progress: secondProgress,
};
assert.equal(isValidSdkHistoryRecord(firstRec), true);
assert.equal(isValidSdkHistoryRecord(secondRec), true);

deleteChatHistory(chatId);
const appended = appendChatHistoryEvents(chatId, 'session-timeout-progress', [
  { rec: firstRec },
  { rec: secondRec },
]);
assert.equal(appended.ok, true);
assert.equal(appended.appended.length, 2);

const page = getChatHistoryPage(chatId, { limit: 80 });
assert.equal(page.ok, true);
assert.equal(page.events.length, 2);
assert.deepEqual(page.events[0].rec.progress, firstProgress);
assert.deepEqual(page.events[1].rec.progress, secondProgress);
assert.equal(parseTimeoutProgressNotice(page.events[0].rec.payload)?.idleSeconds, 21);
assert.equal(parseTimeoutProgressNotice(page.events[1].rec.payload)?.idleSeconds, 36);
assert.equal(page.events[0].seq < page.events[1].seq, true);

deleteChatHistory(chatId);
console.log('timeout-progress-history tests passed.');
