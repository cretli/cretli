/**
 * Routes: POST /api/chats/:id/regenerate-title, GET /api/chats/:id/title-history,
 * POST /api/chats/:id/title-lock. Fake express app, fake generator, isolated data dir.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat, loadChats, updateChat, applyAutoTitle } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents } from '../lib/persist/chat-history-persist.js';
import { createChatTitleService, __setChatTitleServiceForTest } from '../lib/chat-title-service.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const handlers = new Map();
const app = {};
for (const verb of ['get', 'post', 'patch', 'delete']) {
  app[verb] = (p, fn) => handlers.set(`${verb.toUpperCase()} ${p}`, fn);
}
registerChatsRoutes(app, {});

function invoke(method, urlPath, req = {}) {
  const fn = handlers.get(`${method} ${urlPath}`);
  assert.ok(fn, `handler ${method} ${urlPath}`);
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    fn({ params: {}, query: {}, body: {}, ...req }, res);
  });
}

try {
  let output = 'area: generated one';
  __setChatTitleServiceForTest(
    createChatTitleService({ generate: async () => output, log: () => {} }),
  );

  const chat = addChat('sess-r', 'Claude chat 11', undefined, undefined, undefined, {});
  appendChatHistoryEvents(chat.id, 'sess-r', [{ rec: { kind: 'localUser', text: 'Napraw logowanie' } }]);

  assert.equal((await invoke('POST', '/api/chats/:id/regenerate-title', { params: { id: 'nope' } })).status, 404);
  assert.equal((await invoke('GET', '/api/chats/:id/title-history', { params: { id: 'nope' } })).status, 404);

  // regenerate on a default chat
  const first = await invoke('POST', '/api/chats/:id/regenerate-title', { params: { id: chat.id } });
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.chat.title, 'area: generated one');
  assert.equal(first.body.chat.titleSource, 'auto');

  // explicit regenerate overrides manual (title stays 'auto' source afterwards)
  updateChat(chat.id, { title: 'My own name' });
  assert.equal(loadChats().find((c) => c.id === chat.id).titleSource, 'manual');
  output = 'area: generated two';
  const forced = await invoke('POST', '/api/chats/:id/regenerate-title', { params: { id: chat.id } });
  assert.equal(forced.body.ok, true);
  assert.equal(forced.body.chat.title, 'area: generated two');
  assert.equal(forced.body.chat.titleSource, 'auto');

  // history (outside the list payload)
  const hist = await invoke('GET', '/api/chats/:id/title-history', { params: { id: chat.id } });
  assert.equal(hist.body.ok, true);
  assert.deepEqual(hist.body.history.map((h) => [h.title, h.source]), [
    ['area: generated one', 'auto'],
    ['My own name', 'manual'],
    ['area: generated two', 'auto'],
  ]);
  assert.equal(hist.body.history[2].reason, 'regenerate');
  const list = await invoke('GET', '/api/chats', { query: {} });
  assert.ok(!JSON.stringify(list.body.chats.find((c) => c.id === chat.id)).includes('titleHistory'));

  // lock / unlock
  const locked = await invoke('POST', '/api/chats/:id/title-lock', { params: { id: chat.id }, body: { locked: true } });
  assert.equal(locked.body.chat.titleSource, 'manual');
  assert.equal(locked.body.chat.title, 'area: generated two');
  assert.equal(applyAutoTitle(chat.id, 'area: nope', {}).skipped, 'manual');
  const unlocked = await invoke('POST', '/api/chats/:id/title-lock', { params: { id: chat.id }, body: { locked: false } });
  assert.equal(unlocked.body.chat.titleSource, 'auto');
  assert.equal((await invoke('POST', '/api/chats/:id/title-lock', { params: { id: 'nope' }, body: {} })).status, 404);

  // restore of an old title = PATCH title => manual, recorded in history
  const patched = await invoke('PATCH', '/api/chats/:id', { params: { id: chat.id }, body: { title: 'area: generated one' } });
  assert.equal(patched.body.chat.titleSource, 'manual');

  // no generator (no key) => 503, chat untouched
  __setChatTitleServiceForTest(createChatTitleService({ generate: async () => null, log: () => {} }));
  const noKey = await invoke('POST', '/api/chats/:id/regenerate-title', { params: { id: chat.id } });
  assert.equal(noKey.status, 503);
  assert.equal(noKey.body.ok, false);
  assert.equal(noKey.body.reason, 'no_generator');

  console.log('chat-title-routes.test.js OK');
} finally {
  __setChatTitleServiceForTest(null);
  removeIsolatedDataDir();
}
