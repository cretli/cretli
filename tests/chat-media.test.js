import '../tests/helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  MAX_CHAT_MEDIA_FILES, chatMediaUrl, configureChatMedia, removeChatMedia, saveChatMediaSync,
} from '../lib/chat-media.js';

const DIR = path.join(ISOLATED_DATA_DIR, 'media-unit');

test('saves with private modes and returns an API url', () => {
  configureChatMedia({ dataDir: DIR, enabled: true });
  const saved = saveChatMediaSync('chat-a', Buffer.from('x'));
  assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(saved.path)).mode & 0o777, 0o700);
  assert.equal(saved.url, chatMediaUrl('chat-a', saved.file));
  assert.match(saved.url, /^\/api\/chats\/chat-a\/media\/\d{13}-[a-f0-9-]{36}\.jpg$/);
});

test('keeps at most the shared limit of files', () => {
  configureChatMedia({ dataDir: DIR, enabled: true });
  for (let i = 0; i < MAX_CHAT_MEDIA_FILES + 5; i += 1) saveChatMediaSync('chat-b', Buffer.from('x'));
  assert.equal(fs.readdirSync(path.join(DIR, 'chat-media', 'chat-b')).length, MAX_CHAT_MEDIA_FILES);
});

test('returns null when disabled, chatId empty/invalid, or operator chat', () => {
  configureChatMedia({ dataDir: DIR, enabled: true });
  assert.equal(saveChatMediaSync('', Buffer.from('x')), null);
  assert.equal(saveChatMediaSync('../evil', Buffer.from('x')), null);
  assert.equal(saveChatMediaSync('cretli-operator-browser', Buffer.from('x')), null);
  configureChatMedia({ dataDir: DIR, enabled: false });
  assert.equal(saveChatMediaSync('chat-a', Buffer.from('x')), null);
});

test('removeChatMedia deletes one chat only', () => {
  configureChatMedia({ dataDir: DIR, enabled: true });
  saveChatMediaSync('chat-c', Buffer.from('x'));
  removeChatMedia('chat-c');
  assert.equal(fs.existsSync(path.join(DIR, 'chat-media', 'chat-c')), false);
  assert.equal(fs.existsSync(path.join(DIR, 'chat-media', 'chat-a')), true);
  removeChatMedia('');
  assert.equal(fs.existsSync(path.join(DIR, 'chat-media')), true);
});
