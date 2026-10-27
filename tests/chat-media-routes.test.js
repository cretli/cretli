import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { configureChatMedia, saveChatMediaSync } from '../lib/chat-media.js';
import { registerChatMediaRoutes } from '../lib/routes/chat-media-routes.js';

const DIR = path.join(ISOLATED_DATA_DIR, 'media-routes');
configureChatMedia({ dataDir: DIR, enabled: true });
let handler;
registerChatMediaRoutes({ get: (_p, fn) => { handler = fn; } });

function call(params, extra = {}) {
  const out = { headers: {}, status: 200 };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
    setHeader(k, v) { out.headers[k] = v; },
    sendFile(f) { out.file = f; return this; },
  };
  handler({ params, ...extra }, res);
  return out;
}

const chat = addChat('sess-media', 'Media chat', undefined, undefined, undefined, {});
const saved = saveChatMediaSync(chat.id, Buffer.from('jpegdata'));

test('200 with whitelisted type and cache headers', () => {
  const r = call({ chatId: chat.id, file: saved.file });
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'image/jpeg');
  assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(r.headers['Cache-Control'], /private.*immutable/);
  assert.equal(fs.readFileSync(r.file, 'utf8'), 'jpegdata');
});

test('widget and MCP integration callers get 403', () => {
  assert.equal(call({ chatId: chat.id, file: saved.file }, { widgetAccess: {} }).status, 403);
  assert.equal(call({ chatId: chat.id, file: saved.file }, { mcpIntegration: {} }).status, 403);
});

test('bad chatId or file format is 400', () => {
  assert.equal(call({ chatId: 'a b', file: saved.file }).status, 400);
  assert.equal(call({ chatId: chat.id, file: '../x.jpg' }).status, 400);
  assert.equal(call({ chatId: chat.id, file: 'a.svg' }).status, 400);
});

test('unknown chat is 404', () => {
  assert.equal(call({ chatId: 'nope', file: saved.file }).status, 404);
});

test('missing file is 404', () => {
  const r = call({ chatId: chat.id, file: '0000000000000-00000000-0000-0000-0000-000000000000.jpg' });
  assert.equal(r.status, 404);
});

test('symlink is rejected with 400', () => {
  const dir = path.dirname(saved.path);
  const outside = path.join(DIR, 'outside.jpg');
  fs.writeFileSync(outside, 'secret');
  const name = '1111111111111-11111111-1111-1111-1111-111111111111.jpg';
  fs.symlinkSync(outside, path.join(dir, name));
  assert.equal(call({ chatId: chat.id, file: name }).status, 400);
});
