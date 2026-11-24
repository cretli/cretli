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

const openItems = [{ title: 'Finish review', detail: 'Review the remaining change.' }, { title: 'Document', detail: 'Write the missing docs.' }];
function followupWorld(extra = {}) {
  return world({ dataDir: path.join(ISOLATED_DATA_DIR, `todos-${counter++}`), listTodos: realListTodos,
    generate: async () => ({ text: JSON.stringify({ verdict: 'needs_action', reason: 'Work remains', openItems }) }), ...extra });
}
import { addTodo as realAddTodo, listTodos as realListTodos } from '../lib/persist/todos-store.js';
import { CHAT_ARCHIVE_GRACE_MS } from '../lib/chat-archive-policy.js';
const selection = [{ index: 0, title: 'Edited review' }, { index: 1, title: 'Document' }];

test('manual grace is retained for both archive operations; idle and old records retain day thresholds', async () => {
  for (const followups of [false, true]) {
    const w = followups ? followupWorld() : world();
    w.chats[0].updatedAt = new Date(NOW - 3600000).toISOString();
    await assert.rejects(() => w.service.assess('root'), { code: 'family_blocked' });
    const a = await w.service.assess('root', { mode: 'manual' });
    assert.equal(a.graceMs, CHAT_ARCHIVE_GRACE_MS);
    assert.equal(a.refSeq, 2);
    assert.equal((await (followups ? w.service.archiveWithFollowups(a.id, selection) : w.service.archive(a.id))).status, 'archived');
  }
  const recent = world();
  recent.chats[0].updatedAt = new Date(NOW - 300000).toISOString();
  await assert.rejects(() => recent.service.assess('root', { mode: 'manual' }), { code: 'family_blocked' });
  const old = world();
  const a = await old.service.assess('root');
  const doc = JSON.parse(fs.readFileSync(old.deps.storePath));
  delete doc.items[0].graceMs;
  fs.writeFileSync(old.deps.storePath, JSON.stringify(doc));
  assert.equal((await old.service.archive(a.id)).status, 'archived');
});

test('open items are bounded and filtered without changing verdict; refSeq falls back to head', async () => {
  for (const input of [null, {}, [null, {}, { title: 1, detail: 'x' }, ...Array(8).fill({ title: 'x'.repeat(150), detail: 'y'.repeat(700) })]]) {
    const parsed = parseArchivistVerdict(JSON.stringify({ verdict: 'needs_action', reason: 'pending', openItems: input }), []);
    assert.equal(parsed.verdict, 'needs_action');
    assert.ok(parsed.openItems.length <= 5);
    for (const item of parsed.openItems) { assert.equal(item.title.length, 120); assert.equal(item.detail.length, 600); }
  }
  assert.deepEqual(parseArchivistVerdict(JSON.stringify({ verdict: 'uncertain', reason: 'unknown', openItems }), []).openItems, []);
  const w = followupWorld({ history: async () => ({ headSeq: 7, events: [{ seq: 1, rec: { kind: 'localUser', text: 'Do work' } }] }) });
  assert.equal((await w.service.assess('root')).refSeq, 7);
});

test('followups create unlinked ideas in the root workspace, archive family, replay and restore', async () => {
  const w = followupWorld();
  w.chats.push({ id: 'child', forkParentChatId: 'root', updatedAt: OLD, workspaceFolder: '/workspace' });
  const a = await w.service.assess('root');
  const action = await w.service.archiveWithFollowups(a.id, selection);
  assert.equal(action.status, 'archived');
  assert.equal(action.members.length, 2);
  assert.ok(action.archivedAt);
  const todos = (await realListTodos(w.deps.dataDir, '/workspace')).items;
  assert.equal(todos.length, 2);
  for (const todo of todos) {
    assert.equal(todo.status, 'idea');
    assert.ok(!todo.createdByChatId);
    assert.deepEqual(todo.linkedChatIds || [], []);
    assert.match(todo.body, /cretli-ref chat=root seq=2/);
  }
  assert.deepEqual(await w.service.archiveWithFollowups(a.id, selection), action);
  await w.service.restore(action.id);
  assert.ok(w.chats.every((chat) => !chat.archivedAt));
  assert.equal((await realListTodos(w.deps.dataDir, '/workspace')).items.length, 2);
});

test('changed stamp creates no todo; completed and uncertain cannot create followups', async () => {
  const w = followupWorld();
  const a = await w.service.assess('root');
  w.pages.set('root', { ...w.page(), headSeq: 3 });
  await assert.rejects(() => w.service.archiveWithFollowups(a.id, selection), { code: 'chat_changed' });
  assert.equal((await realListTodos(w.deps.dataDir, '/workspace')).items.length, 0);
  for (const verdict of ['completed', 'uncertain']) {
    const other = world({ generate: async () => ({ text: JSON.stringify({ verdict, reason: 'reason', evidence: [{ chatId: 'root', seq: 2 }] }) }) });
    const assessment = await other.service.assess('root');
    await assert.rejects(() => other.service.archiveWithFollowups(assessment.id, selection), { code: 'assessment_required' });
  }
});

test('failed archive resumes after expiry, skips recorded ids, rejects changed payload and returns ids on changed chat', async () => {
  let clock = NOW;
  const w = followupWorld({ now: () => clock, updateChat: async () => { throw new Error('write failure'); } });
  const a = await w.service.assess('root');
  await assert.rejects(() => w.service.archiveWithFollowups(a.id, selection));
  assert.equal((await w.service.report()).items[0].status, 'failed');
  await assert.rejects(() => w.service.archiveWithFollowups(a.id, [{ index: 0, title: 'Different' }]), { code: 'followups_payload_mismatch' });
  w.pages.set('root', { ...w.page(), headSeq: 3 });
  await assert.rejects(() => w.service.archiveWithFollowups(a.id, selection), (error) => error.code === 'chat_changed' && Object.keys(error.action.todoIds).length === 2);
  w.pages.clear();
  clock += 2 * 86400000;
  w.deps.addTodo = async () => { throw new Error('recorded ids must be skipped'); };
  w.deps.updateChat = async () => { w.chats[0].archivedAt = new Date(clock).toISOString(); return w.chats[0]; };
  // updateChat is captured when the service is constructed.
  const resumed = createChatArchivist(w.deps);
  assert.equal((await resumed.archiveWithFollowups(a.id, selection)).status, 'archived');
  assert.equal((await realListTodos(w.deps.dataDir, '/workspace')).items.length, 2);
});

test('crash window after addTodo replays its key; already archived recovery precedes snapshot', async () => {
  let crash = true;
  const w = followupWorld({ addTodo: async (...args) => {
    const result = await realAddTodo(...args);
    if (crash) { crash = false; throw new Error('crash before id persistence'); }
    return result;
  } });
  const a = await w.service.assess('root');
  await assert.rejects(() => w.service.archiveWithFollowups(a.id, selection));
  assert.equal((await realListTodos(w.deps.dataDir, '/workspace')).items.length, 1);
  const action = await w.service.archiveWithFollowups(a.id, selection);
  assert.equal((await realListTodos(w.deps.dataDir, '/workspace')).items.length, 2);
  const doc = JSON.parse(fs.readFileSync(w.deps.storePath));
  doc.items.find((row) => row.id === action.id).status = 'pending';
  fs.writeFileSync(w.deps.storePath, JSON.stringify(doc));
  const recovered = await w.service.archiveWithFollowups(a.id, selection);
  assert.equal(recovered.status, 'archived');
  assert.equal(recovered.archivedAt, w.chats[0].archivedAt);
  assert.deepEqual(recovered.members, action.members);
  w.chats.push({ id: 'new', forkParentChatId: 'root', archivedAt: 'different' });
  await assert.rejects(() => w.service.restore(action.id), { code: 'chat_changed' });
});

test('followup validation and expiry happen before any write, with old assessment grace fallback', async () => {
  let clock = NOW;
  const w = followupWorld({ now: () => clock });
  const a = await w.service.assess('root');
  for (const selected of [[], [{ index: 9, title: 'Task' }], [{ index: 0, title: '' }], [{ index: 0, title: 'x'.repeat(121) }], [selection[0], selection[0]]]) {
    await assert.rejects(() => w.service.archiveWithFollowups(a.id, selected), { code: 'invalid_request' });
  }
  assert.equal((await w.service.report()).items.length, 1);
  clock += 86400001;
  await assert.rejects(() => w.service.archiveWithFollowups(a.id, selection), { code: 'assessment_expired' });
  clock = NOW;
  const doc = JSON.parse(fs.readFileSync(w.deps.storePath));
  delete doc.items[0].graceMs;
  fs.writeFileSync(w.deps.storePath, JSON.stringify(doc));
  assert.equal((await w.service.archiveWithFollowups(a.id, selection)).status, 'archived');
});
