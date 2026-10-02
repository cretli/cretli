import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir; must be set before the persist modules are imported.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-title-history-'));
process.env.CRETLI_DATA_DIR = dataDir;

const {
  addChat,
  applyAutoTitle,
  deleteChat,
  inferChatTitleSource,
  loadChats,
  saveChats,
  updateChat,
} = await import('../lib/persist/chats-persist.js');
const { getChatTitleHistory, MAX_TITLE_HISTORY } = await import(
  '../lib/persist/chat-title-history-persist.js'
);
const { __clearChatListUpdateClientsForTest, subscribeChatListUpdates } = await import(
  '../lib/chat-list-updates.js'
);

function fakeWs(sent) {
  return { readyState: 1, bufferedAmount: 0, send: (m) => sent.push(JSON.parse(m)), once() {} };
}

try {
  // migration: placeholder names => default, everything else => manual, temp skipped
  saveChats([
    { id: 'm1', title: 'Claude chat 872', cursorSessionId: 's1' },
    { id: 'm2', title: 'Codex chat 865', cursorSessionId: 's2' },
    { id: 'm3', title: 'Chat 3', cursorSessionId: 's3' },
    { id: 'm4', title: 'Fix login bug', cursorSessionId: 's4' },
    { id: 'm5', title: '[Temp] Chat title', cursorSessionId: 's5', isTemporary: true, forkKind: 'title' },
  ]);
  const migrated = Object.fromEntries(loadChats().map((c) => [c.id, c.titleSource]));
  assert.equal(migrated.m1, 'default');
  assert.equal(migrated.m2, 'default');
  assert.equal(migrated.m3, 'default');
  assert.equal(migrated.m4, 'manual');
  assert.equal(migrated.m5, undefined);
  assert.equal(inferChatTitleSource({ title: 'SDK chat 1' }), 'default');

  // new chats: default title => default; explicit title => manual
  const fresh = addChat('sess-a', 'Claude chat 5', undefined, undefined, undefined, {});
  assert.equal(fresh.titleSource, 'default');
  const named = addChat('sess-b', 'My project', undefined, undefined, undefined, {});
  assert.equal(named.titleSource, 'manual');
  const temp = addChat('sess-t', '[Temp] Chat title', undefined, undefined, undefined, {
    isTemporary: true,
    forkKind: 'title',
  });
  assert.equal(temp.titleSource, undefined);

  // auto applies on default, appends history, broadcasts
  const sent = [];
  subscribeChatListUpdates(fakeWs(sent));
  const r1 = applyAutoTitle(fresh.id, 'api: add title service', { reason: 'first' });
  assert.equal(r1.applied, true);
  assert.equal(r1.chat.titleSource, 'auto');
  assert.equal(r1.chat.titleRev, 1);
  assert.deepEqual(sent.at(-1), { type: 'chatsChanged', reason: 'title', chatId: fresh.id });
  let hist = getChatTitleHistory(fresh.id);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].source, 'auto');
  assert.equal(hist[0].reason, 'first');

  // dedup identical title
  const r2 = applyAutoTitle(fresh.id, 'api: add title service');
  assert.equal(r2.applied, false);
  assert.equal(r2.skipped, 'unchanged');
  assert.equal(getChatTitleHistory(fresh.id).length, 1);

  // manual rename: source manual, history, auto no longer overrides
  const renamed = updateChat(fresh.id, { title: 'Mine' });
  assert.equal(renamed.titleSource, 'manual');
  assert.equal(getChatTitleHistory(fresh.id).at(-1).source, 'manual');
  const blocked = applyAutoTitle(fresh.id, 'something else');
  assert.equal(blocked.applied, false);
  assert.equal(blocked.skipped, 'manual');
  assert.equal(loadChats().find((c) => c.id === fresh.id).title, 'Mine');

  // explicit regenerate overrides manual
  const forced = applyAutoTitle(fresh.id, 'forced: regenerated', { force: true, reason: 'regenerate' });
  assert.equal(forced.applied, true);
  assert.equal(forced.chat.titleSource, 'auto');

  // race: generation started at rev N, manual rename in the meantime => stale / manual wins
  const racer = addChat('sess-r', 'Codex chat 9', undefined, undefined, undefined, {});
  const observed = loadChats().find((c) => c.id === racer.id).titleRev || 0;
  updateChat(racer.id, { title: 'Typed by user' });
  const lost = applyAutoTitle(racer.id, 'late auto title', { expectedVersion: observed });
  assert.equal(lost.applied, false);
  assert.equal(loadChats().find((c) => c.id === racer.id).title, 'Typed by user');
  // stale with force still blocked by CAS
  const stale = applyAutoTitle(racer.id, 'late auto title', { expectedVersion: observed, force: true });
  assert.equal(stale.skipped, 'stale');

  // unknown chat / empty title
  assert.equal(applyAutoTitle('nope', 'x').skipped, 'not_found');
  assert.equal(applyAutoTitle(fresh.id, '  ').skipped, 'empty');

  // history cap
  const capped = addChat('sess-c', 'Qwen chat 1', undefined, undefined, undefined, {});
  for (let i = 0; i < MAX_TITLE_HISTORY + 5; i += 1) applyAutoTitle(capped.id, `topic ${i}`, { force: true });
  const capHist = getChatTitleHistory(capped.id);
  assert.equal(capHist.length, MAX_TITLE_HISTORY);
  assert.equal(capHist.at(-1).title, `topic ${MAX_TITLE_HISTORY + 4}`);

  // list stays small: history is not embedded in chats.json
  assert.equal(Object.prototype.hasOwnProperty.call(loadChats().find((c) => c.id === capped.id), 'titleHistory'), false);

  // delete cleans history
  deleteChat(capped.id);
  assert.equal(getChatTitleHistory(capped.id).length, 0);

  // PATCH route ignores client-supplied titleSource
  const src = fs.readFileSync(new URL('../lib/routes/chats-routes.js', import.meta.url), 'utf8');
  assert.match(src, /delete body\.titleSource;/);
  assert.match(src, /delete body\.titleHistory;/);

  console.log('chat-title-history.test.js OK');
} finally {
  __clearChatListUpdateClientsForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
