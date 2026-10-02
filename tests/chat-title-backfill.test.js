/**
 * Backfill + end-to-end title flows. Fake generator and isolated data dir: no network,
 * no real chats.json is touched.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { addChat, loadChats, updateChat } from '../lib/persist/chats-persist.js';
import { appendChatHistoryEvents, loadChatHistory } from '../lib/persist/chat-history-persist.js';
import { getChatTitleHistory } from '../lib/persist/chat-title-history-persist.js';
import { saveSettings } from '../lib/persist/settings.js';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';
import { createChatTitleService, __setChatTitleServiceForTest } from '../lib/chat-title-service.js';
import { runChatTitleBackfill, normalizeBackfillLimit, MAX_BACKFILL_LIMIT } from '../lib/chat-title-backfill.js';
import { registerChatsRoutes } from '../lib/routes/chats-routes.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const tick = () => new Promise((r) => setTimeout(r, 20));
const seed = (title, sess, extras = {}, withUser = true) => {
  const chat = addChat(sess, title, undefined, undefined, undefined, extras);
  if (withUser) {
    appendChatHistoryEvents(chat.id, sess, [{ rec: { kind: 'localUser', text: `Zadanie dla ${sess}` } }]);
  }
  return chat;
};

try {
  let calls = 0;
  let prompts = [];
  let key = true;
  const generate = async ({ prompt }) => {
    if (!key) return null;
    calls += 1;
    prompts.push(prompt);
    return `area: generated ${calls}`;
  };
  const mkService = () => createChatTitleService({ generate, log: () => {} });
  __setChatTitleServiceForTest(mkService());

  const a = seed('Claude chat 1', 's-a');
  const b = seed('Codex chat 2', 's-b');
  const c = seed('Qwen chat 3', 's-c');
  const manual = seed('Moja nazwa', 's-m');
  const temp = seed('[Temp] Chat title', 's-t', { isTemporary: true, forkKind: 'title' });
  const deleg = seed('Claude chat 4', 's-d', { delegationId: 'd', delegationParentChatId: 'p' });
  const archived = seed('Claude chat 5', 's-ar');
  updateChat(archived.id, { archived: true });
  const empty = seed('Claude chat 6', 's-e', {}, false);

  // --- dry-run is the default: no model call, no write
  const dry = await runChatTitleBackfill();
  assert.equal(dry.mode, 'dry-run');
  assert.deepEqual(new Set(dry.candidates.map((x) => x.chatId)), new Set([a.id, b.id, c.id]));
  assert.equal(dry.skipped.temporary, 1);
  assert.equal(dry.skipped.delegation, 1);
  assert.equal(dry.skipped.archived, 1);
  assert.equal(dry.skipped.no_content, 1);
  assert.equal(calls, 0);
  assert.equal(loadChats().find((x) => x.id === a.id).title, 'Claude chat 1');

  // an apply request that is not literally `true` stays a dry-run
  assert.equal((await runChatTitleBackfill({ apply: 'true' })).mode, 'dry-run');

  // --- propose: generates proposals, still writes nothing
  const proposed = await runChatTitleBackfill({ propose: true, generate });
  assert.equal(proposed.mode, 'propose');
  assert.equal(proposed.results.length, 3);
  assert.ok(proposed.results.every((r) => r.status === 'applied' && /^area: generated/.test(r.title)));
  assert.equal(calls, 3);
  assert.equal(loadChats().find((x) => x.id === a.id).title, 'Claude chat 1');
  assert.equal(loadChats().find((x) => x.id === a.id).titleSource, 'default');
  assert.equal(getChatTitleHistory(a.id).length, 0);

  // --- apply with a cost cap
  calls = 0;
  const limited = await runChatTitleBackfill({ apply: true, limit: 2 });
  assert.equal(limited.mode, 'apply');
  assert.equal(limited.results.filter((r) => r.status === 'applied').length, 2);
  assert.equal(limited.stoppedEarly, 'limit');
  assert.equal(calls, 2);
  const rest = await runChatTitleBackfill({ apply: true });
  assert.equal(rest.results.filter((r) => r.status === 'applied').length, 1);
  const after = loadChats();
  for (const id of [a.id, b.id, c.id]) {
    const row = after.find((x) => x.id === id);
    assert.equal(row.titleSource, 'auto');
    assert.match(row.title, /^area: generated/);
    assert.equal(getChatTitleHistory(id)[0].reason, 'backfill');
  }
  // untouched: manual, temp, delegation, archived, empty
  assert.equal(after.find((x) => x.id === manual.id).title, 'Moja nazwa');
  assert.equal(after.find((x) => x.id === temp.id).title, '[Temp] Chat title');
  assert.equal(after.find((x) => x.id === deleg.id).title, 'Claude chat 4');
  assert.equal(after.find((x) => x.id === archived.id).title, 'Claude chat 5');
  assert.equal(after.find((x) => x.id === empty.id).title, 'Claude chat 6');
  // idempotent: nothing left to do
  assert.equal((await runChatTitleBackfill()).candidates.length, 0);

  // the title prompt never lands in chat history
  for (const id of [a.id, b.id, c.id]) {
    const doc = loadChatHistory(id);
    assert.ok(!JSON.stringify(doc).includes('Name a chat between'));
  }
  assert.ok(prompts.every((p) => p.includes('<chat_data>')));

  // --- no generator (no key) aborts the queue instead of burning through every chat
  const k1 = seed('Claude chat 7', 's-k1');
  seed('Claude chat 8', 's-k2');
  key = false;
  const nokey = await runChatTitleBackfill({ apply: true });
  assert.equal(nokey.stoppedEarly, 'no_generator');
  assert.equal(nokey.results.length, 0);
  assert.equal(loadChats().find((x) => x.id === k1.id).titleSource, 'default');
  key = true;

  // --- disabled mode aborts too
  saveSettings({ autoTitle: { mode: 'off' } });
  __setChatTitleServiceForTest(mkService());
  assert.equal((await runChatTitleBackfill({ apply: true })).stoppedEarly, 'disabled');
  saveSettings({ autoTitle: { mode: 'first' } });
  __setChatTitleServiceForTest(mkService());

  assert.equal(normalizeBackfillLimit(undefined), 25);
  assert.equal(normalizeBackfillLimit(99999), MAX_BACKFILL_LIMIT);
  assert.equal(normalizeBackfillLimit('abc'), 25);

  // --- route: default body => dry-run; apply only with literal true
  const handlers = new Map();
  const app = {};
  for (const verb of ['get', 'post', 'patch', 'delete']) app[verb] = (p, fn) => handlers.set(`${verb.toUpperCase()} ${p}`, fn);
  registerChatsRoutes(app, {});
  const call = (body) => new Promise((resolve) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(o) { resolve(o); } };
    handlers.get('POST /api/chats/backfill-titles')({ params: {}, query: {}, body }, res);
  });
  calls = 0;
  const routeDry = await call({});
  assert.equal(routeDry.ok, true);
  assert.equal(routeDry.mode, 'dry-run');
  assert.equal(calls, 0);
  assert.equal((await call({ apply: 'yes' })).mode, 'dry-run');
  const routeApply = await call({ apply: true, limit: 1 });
  assert.equal(routeApply.mode, 'apply');
  assert.equal(routeApply.results.filter((r) => r.status === 'applied').length, 1);

  // --- end-to-end through a room kernel: manual is never overwritten, [Temp] does not loop
  const kernel = createAgentRoomKernel({ transport: 'claude', persistHistory: () => {}, recordUsage: () => {} });
  const finish = (chat) => {
    const room = kernel.createRoomState({ sessionKey: `k-${chat.id}`, chatId: chat.id });
    kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'r1', status: 'completed' });
  };
  calls = 0;
  const manualChat = seed('Claude chat 90', 's-90');
  updateChat(manualChat.id, { title: 'Reczna nazwa' });
  const tempChat = seed('[Temp] Chat title', 's-91', { isTemporary: true, forkKind: 'title' });
  finish(manualChat);
  finish(tempChat);
  await tick();
  assert.equal(calls, 0);
  assert.equal(loadChats().find((x) => x.id === manualChat.id).title, 'Reczna nazwa');
  assert.equal(loadChats().find((x) => x.id === tempChat.id).title, '[Temp] Chat title');

  console.log('chat-title-backfill.test.js OK');
} finally {
  __setChatTitleServiceForTest(null);
  removeIsolatedDataDir();
}
