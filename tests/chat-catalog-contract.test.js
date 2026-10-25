import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CHAT_CATALOG_ERROR_CODES,
  ChatCatalogError,
  createChatCatalog,
  readChatCatalog,
} from '../lib/chat-catalog.js';
import { getChatsReadStats, loadChats, peekChats, saveChats } from '../lib/persist/chats-persist.js';

const folderA = path.join(ISOLATED_DATA_DIR, 'ws-a');
const folderB = path.join(ISOLATED_DATA_DIR, 'ws-b');
const fixture = () => [
  { id: 'root-a', workspaceFolder: folderA, widgetInstallationId: 'w1' },
  { id: 'child-a1', workspaceFolder: folderA, forkParentChatId: 'root-a', widgetInstallationId: 'w1' },
  { id: 'child-a2', workspaceFolder: folderA, forkParentChatId: ' root-a ', archivedAt: '2026-01-01T00:00:00Z' },
  { id: 'root-b', workspaceFolder: folderB, widgetInstallationId: 'w2' },
  { id: 'dup', workspaceFolder: folderA, title: 'first' },
  { id: 'dup', workspaceFolder: folderB, title: 'second' },
  { title: 'no id', workspaceFolder: folderA },
  null,
];

test.after(() => removeIsolatedDataDir());

test('get: exact id, first duplicate wins, non-string and unknown ids give null', () => {
  const catalog = createChatCatalog(fixture(), { revision: 'r1' });
  assert.equal(catalog.get('root-a').id, 'root-a');
  assert.equal(catalog.get('dup').title, 'first');
  assert.equal(catalog.get(' root-a'), null, 'no trimming: identical to find(row.id === id)');
  assert.equal(catalog.get('missing'), null);
  for (const bad of [undefined, null, 7, {}, '']) assert.equal(catalog.get(bad), null);
  assert.equal(catalog.size, 7, 'non-object rows are dropped, rows without id are kept');
});

test('require: typed NOT_FOUND and OUT_OF_SCOPE errors, transports map them themselves', () => {
  const catalog = createChatCatalog(fixture());
  assert.equal(catalog.require('root-a', { workspaceFolder: folderA }).id, 'root-a');
  assert.throws(() => catalog.require('nope'), (err) => (
    err instanceof ChatCatalogError && err.code === CHAT_CATALOG_ERROR_CODES.NOT_FOUND
  ));
  assert.throws(() => catalog.require('root-b', { workspaceFolder: folderA }), (err) => (
    err.code === CHAT_CATALOG_ERROR_CODES.OUT_OF_SCOPE
  ));
  assert.throws(() => catalog.require('root-a', { widgetInstallationId: 'w2' }), (err) => (
    err.code === CHAT_CATALOG_ERROR_CODES.OUT_OF_SCOPE
  ));
});

test('list: store order, scope and archive filters, empty scope means everything', () => {
  const catalog = createChatCatalog(fixture());
  assert.equal(catalog.list().length, 7);
  assert.equal(catalog.list({ scope: {} }), catalog.list(), 'unscoped list is zero-copy');
  assert.deepEqual(
    catalog.list({ scope: { workspaceFolder: folderA } }).map((c) => c.id),
    ['root-a', 'child-a1', 'child-a2', 'dup', undefined],
  );
  assert.deepEqual(catalog.list({ archived: 'only' }).map((c) => c.id), ['child-a2']);
  assert.equal(catalog.list({ archived: 'exclude' }).length, 6);
  assert.deepEqual(
    catalog.list({ scope: { widgetInstallationId: 'w2' } }).map((c) => c.id),
    ['root-b'],
  );
  assert.throws(() => catalog.list({ archived: 'bogus' }), (err) => (
    err.code === CHAT_CATALOG_ERROR_CODES.INVALID_ARGUMENT
  ));
});

test('children and counts follow forkParentChatId and the same scope rules', () => {
  const catalog = createChatCatalog(fixture());
  assert.deepEqual(catalog.children('root-a').map((c) => c.id), ['child-a1', 'child-a2']);
  assert.deepEqual(catalog.children('leaf'), []);
  assert.deepEqual(catalog.children(undefined), []);
  assert.deepEqual({ ...catalog.counts() }, { total: 7, archived: 1, live: 6, roots: 5 });
  assert.deepEqual({ ...catalog.counts({ scope: { workspaceFolder: folderB } }) }, {
    total: 2, archived: 0, live: 2, roots: 2,
  });
});

test('snapshot is immutable and read calls are idempotent', () => {
  const catalog = createChatCatalog(fixture(), { revision: 'r1' });
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.list()));
  assert.ok(Object.isFrozen(catalog.children('root-a')));
  assert.throws(() => catalog.list().push({ id: 'x' }), TypeError);
  assert.equal(catalog.get('root-a'), catalog.get('root-a'));
  assert.deepEqual(catalog.counts(), catalog.counts());
  assert.equal(catalog.revision, 'r1');
});

test('readChatCatalog: revision follows the store, writes go through saveChats only', () => {
  assert.equal(readChatCatalog().revision, '', 'no store file yet: empty revision, empty catalog');
  assert.equal(readChatCatalog().size, 0);
  saveChats([{ id: 'one', workspaceFolder: folderA }]);
  const first = readChatCatalog();
  assert.notEqual(first.revision, '');
  assert.equal(readChatCatalog().revision, first.revision, 'unchanged store keeps the revision');
  assert.deepEqual(first.list().map((c) => c.id), loadChats().map((c) => c.id));
  saveChats([{ id: 'one', workspaceFolder: folderA }, { id: 'two', workspaceFolder: folderA }]);
  const second = readChatCatalog();
  assert.notEqual(second.revision, first.revision);
  assert.equal(first.size, 1, 'an older snapshot never changes');
  assert.equal(second.size, 2);
});

test('readChatCatalog: repeated read-only snapshots do not copy or mutate persisted rows', () => {
  saveChats(fixture());
  const beforeRows = JSON.stringify(peekChats());
  const beforeCopies = getChatsReadStats().listCopies;
  for (let i = 0; i < 1000; i += 1) readChatCatalog().list();
  assert.equal(getChatsReadStats().listCopies, beforeCopies);
  assert.equal(JSON.stringify(peekChats()), beforeRows);
});

test('catalog module has no store writers (writes stay in chats-persist.js)', () => {
  const source = fs.readFileSync(new URL('../lib/chat-catalog.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(saveChats|updateChat|addChat|writeJsonAtomic|writeFileSync|renameSync)\b/);
});

test('readChatCatalog: same size and mtime but different bytes gives a different revision', () => {
  const file = path.join(ISOLATED_DATA_DIR, 'chats.json');
  saveChats([{ id: 'aaa', workspaceFolder: folderA }]);
  const first = readChatCatalog();
  const before = fs.statSync(file);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"aaa"', '"bbb"'));
  fs.utimesSync(file, before.atime, before.mtime);
  const second = readChatCatalog();
  assert.equal(fs.statSync(file).size, before.size);
  assert.notEqual(second.revision, first.revision);
  assert.ok(second.get('bbb'));
  assert.equal(second.get('aaa'), null);
});

test('get: rows with an empty or non-string id are not indexed', () => {
  const catalog = createChatCatalog([{ id: '' }, { id: 5 }, { title: 'x' }, { id: 'ok' }]);
  assert.equal(catalog.get(''), null);
  assert.equal(catalog.get(5), null);
  assert.equal(catalog.size, 4);
  assert.throws(() => catalog.require(''), (e) => e.code === CHAT_CATALOG_ERROR_CODES.NOT_FOUND);
  assert.ok(catalog.get('ok'));
});

test('empty scope: injected matcher is skipped consistently in list, counts and require', () => {
  let calls = 0;
  const catalog = createChatCatalog([{ id: 'a' }, { id: 'b' }], { matchesWorkspace: () => { calls += 1; return false; } });
  assert.equal(catalog.list({ scope: {} }).length, 2);
  assert.equal(catalog.counts({ scope: {} }).total, 2);
  assert.equal(catalog.require('a', {}).id, 'a');
  assert.equal(catalog.require('a').id, 'a');
  assert.equal(calls, 0);
  assert.throws(() => catalog.require('a', { workspaceFolder: '/x' }), (e) => e.code === CHAT_CATALOG_ERROR_CODES.OUT_OF_SCOPE);
});
