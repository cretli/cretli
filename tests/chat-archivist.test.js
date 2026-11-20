import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createChatArchivist, parseArchivistVerdict } from '../lib/chat-archivist.js';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { collectForkSubtreeIds } from '../lib/chat-tree.js';

test.after(removeIsolatedDataDir);
const NOW = Date.parse('2026-11-19T12:00:00Z');
const OLD = new Date(NOW - 10 * 86400000).toISOString();
let counter = 0;
function world(extra = {}) {
  const chats = [{ id: 'root', title: 'Finish task', updatedAt: OLD, workspaceFolder: '/workspace' }];
  const pages = new Map();
  const page = () => ({ ok: true, headSeq: 2, events: [
    { seq: 1, rec: { kind: 'localUser', text: 'Implement the requested fix.' } },
    { seq: 2, rec: { kind: 'sdk', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'The fix is implemented and tested. All requested work is complete.' }] } } } },
  ] });
  const updates = [];
  const deps = {
    storePath: path.join(ISOLATED_DATA_DIR, `archivist-${counter++}.json`),
    now: () => NOW,
    loadChats: async () => structuredClone(chats),
    history: async (id) => structuredClone(pages.get(id) || page()),
    isChatRunConfirmedIdle: () => true,
    listChildren: () => [], listForChat: () => [],
    listTodos: async () => ({ items: [] }), loadLayout: () => ({ favoriteChatIds: [] }),
    generate: async () => ({ text: JSON.stringify({ verdict: 'completed', reason: 'Explicit completion.', evidence: chats.map((chat) => ({ chatId: chat.id, seq: 2 })) }), provider: 'fake', model: 'test' }),
    updateChat: async (id, patch) => {
      updates.push({ id, patch });
      const ids = collectForkSubtreeIds(chats, id);
      for (const chat of chats) if (ids.has(chat.id)) {
        chat.archivedAt = patch.archived ? new Date(NOW).toISOString() : '';
        chat.updatedAt = new Date(NOW).toISOString();
      }
      return chats.find((chat) => chat.id === id);
    },
    ...extra,
  };
  return { chats, pages, updates, deps, service: createChatArchivist(deps), page };
}

test('assessment uses bounded evidence, does not archive, and persists across instances', async () => {
  const w = world();
  const assessment = await w.service.assess('root');
  assert.equal(assessment.verdict, 'completed');
  assert.deepEqual(w.updates, []);
  assert.equal((await createChatArchivist(w.deps).report()).items[0].id, assessment.id);
  assert.equal(assessment.model, 'test');
});

test('explicit archive and restore cover the whole family and record the decisions', async () => {
  const w = world();
  w.chats.push({ id: 'child', title: 'Child', forkParentChatId: 'root', updatedAt: OLD });
  const assessment = await w.service.assess('root');
  const action = await w.service.archive(assessment.id);
  assert.equal(action.status, 'archived');
  assert.equal(w.updates.length, 1);
  assert.ok(w.chats.every((chat) => chat.archivedAt));
  await w.service.restore(action.id);
  assert.ok(w.chats.every((chat) => !chat.archivedAt));
  assert.deepEqual((await w.service.report()).items.map((row) => row.kind), ['restore', 'archive', 'assessment']);
});

test('unsupported verdicts, malformed JSON, and invented citations cannot authorize archive', async () => {
  for (const text of ['yes', '{}', '{"verdict":"completed","reason":"done","evidence":[{"chatId":"root","seq":99}]}']) {
    const w = world({ generate: async () => ({ text }) });
    const assessment = await w.service.assess('root');
    assert.equal(assessment.verdict, 'uncertain');
    await assert.rejects(() => w.service.archive(assessment.id), { code: 'assessment_required' });
  }
  assert.equal(parseArchivistVerdict('{"verdict":"completed","reason":"done","evidence":[{"chatId":"root","seq":1}]}', [{ chatId: 'root', seq: 1, role: 'user' }]).verdict, 'uncertain');
});

test('completion requires evidence for every family member', async () => {
  const w = world({ generate: async () => ({ text: '{"verdict":"completed","reason":"done","evidence":[{"chatId":"root","seq":2}]}' }) });
  w.chats.push({ id: 'child', forkParentChatId: 'root', updatedAt: OLD });
  assert.equal((await w.service.assess('root')).verdict, 'uncertain');
});

test('open TODOs, live runs, favorites, and pending delegations prevent assessment', async () => {
  for (const deps of [
    { listTodos: async () => ({ items: [{ status: 'doing', linkedChatIds: ['root'] }] }) },
    { isChatRunConfirmedIdle: () => false },
    { loadLayout: () => ({ favoriteChatIds: ['root'] }) },
    { listChildren: () => [{ status: 'running' }] },
    { listForChat: () => [{ status: 'running' }] },
    { listTodos: async () => { throw new Error('unreadable'); } },
  ]) {
    const w = world(deps);
    await assert.rejects(() => w.service.assess('root'));
    assert.deepEqual(w.updates, []);
  }
});

test('a change while the model runs invalidates even a positive answer', async () => {
  const w = world();
  const original = w.deps.generate;
  w.deps.generate = async () => {
    w.pages.set('root', { ...w.page(), headSeq: 3 });
    return original();
  };
  assert.equal((await w.service.assess('root')).reason, 'chat_changed');
});

test('new messages, a new descendant, and open TODOs after assessment block archive', async () => {
  for (const change of [
    (w) => w.pages.set('root', { ...w.page(), headSeq: 3 }),
    (w) => w.chats.push({ id: 'new', updatedAt: OLD, forkParentChatId: 'root' }),
    (w) => { w.deps.listTodos = async () => ({ items: [{ status: 'todo', chatId: 'root' }] }); },
  ]) {
    const w = world();
    const assessment = await w.service.assess('root');
    change(w);
    await assert.rejects(() => w.service.archive(assessment.id));
    assert.deepEqual(w.updates, []);
  }
});

test('provider failures and missing history remain uncertain', async () => {
  const unavailable = world({ generate: async () => { throw new Error('provider error'); } });
  assert.equal((await unavailable.service.assess('root')).reason, 'provider_unavailable');
  const empty = world({ history: async () => ({ ok: true, headSeq: 0, events: [] }) });
  assert.equal((await empty.service.assess('root')).reason, 'insufficient_history');
});

test('an assessment cannot be reused after restore or used after expiry', async () => {
  const w = world();
  const assessment = await w.service.assess('root');
  const action = await w.service.archive(assessment.id);
  await w.service.restore(action.id);
  await assert.rejects(() => w.service.archive(assessment.id), { code: 'assessment_used' });
  let clock = NOW;
  const expired = world({ now: () => clock });
  const old = await expired.service.assess('root');
  clock += 86400001;
  await assert.rejects(() => expired.service.archive(old.id), { code: 'assessment_expired' });
});

test('write failures stay in the journal and corrupt journals fail closed', async () => {
  const w = world({ updateChat: async () => { throw new Error('write failed'); } });
  const assessment = await w.service.assess('root');
  await assert.rejects(() => w.service.archive(assessment.id));
  assert.equal((await w.service.report()).items[0].status, 'failed');
  fs.writeFileSync(w.deps.storePath, '{broken');
  await assert.rejects(() => w.service.archive(assessment.id));
});

test('restoration refuses changed families and preserves unrelated archived descendants', async () => {
  const w = world();
  const assessment = await w.service.assess('root');
  const action = await w.service.archive(assessment.id);
  w.chats.push({ id: 'new', forkParentChatId: 'root', updatedAt: OLD, archivedAt: 'other' });
  await assert.rejects(() => w.service.restore(action.id), { code: 'chat_changed' });
  assert.equal(w.updates.length, 1);
  const mixed = world();
  mixed.chats.push({ id: 'archived-child', forkParentChatId: 'root', updatedAt: OLD, archivedAt: 'old' });
  await assert.rejects(() => mixed.service.assess('root'), { code: 'family_blocked' });
});

test('concurrent archive requests serialize and only one changes the store', async () => {
  const w = world();
  const assessment = await w.service.assess('root');
  const results = await Promise.allSettled([w.service.archive(assessment.id), w.service.archive(assessment.id)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(w.updates.length, 1);
});
