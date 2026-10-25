import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArchiveConfirmMessage,
  countArchiveSubtree,
  resolveArchiveConfirmPluralCategory,
} from '../app_front/features/chat/chatArchiveConfirm.js';

function chat(id, parent = '') {
  const row = { id, title: id };
  if (parent) row.forkParentChatId = parent;
  return row;
}

test('countArchiveSubtree counts the clicked chat plus live descendants', () => {
  const chats = [chat('root'), chat('a', 'root'), chat('b', 'a'), chat('c', 'root'), chat('other')];
  assert.deepEqual(countArchiveSubtree(chats, 'root'), { total: 4, subchats: 3 });
  assert.deepEqual(countArchiveSubtree(chats, 'a'), { total: 2, subchats: 1 });
  assert.deepEqual(countArchiveSubtree(chats, 'other'), { total: 1, subchats: 0 });
});

test('countArchiveSubtree ignores already archived rows', () => {
  const archived = chat('b', 'a');
  archived.archivedAt = '2026-10-05T00:00:00.000Z';
  const chats = [chat('root'), chat('a', 'root'), archived, chat('c', 'a')];
  assert.deepEqual(countArchiveSubtree(chats, 'root'), { total: 3, subchats: 2 });
});

test('countArchiveSubtree is safe for unknown ids and non-arrays', () => {
  assert.deepEqual(countArchiveSubtree([chat('root')], 'missing'), { total: 0, subchats: 0 });
  assert.deepEqual(countArchiveSubtree(null, 'root'), { total: 0, subchats: 0 });
});

test('resolveArchiveConfirmPluralCategory follows Polish categories', () => {
  assert.equal(resolveArchiveConfirmPluralCategory(1, 'pl'), 'one');
  assert.equal(resolveArchiveConfirmPluralCategory(2, 'pl'), 'few');
  assert.equal(resolveArchiveConfirmPluralCategory(4, 'pl'), 'few');
  assert.equal(resolveArchiveConfirmPluralCategory(5, 'pl'), 'many');
  assert.equal(resolveArchiveConfirmPluralCategory(12, 'pl'), 'many');
  assert.equal(resolveArchiveConfirmPluralCategory(22, 'pl'), 'few');
  assert.equal(resolveArchiveConfirmPluralCategory(2, 'en'), 'other');
  assert.equal(resolveArchiveConfirmPluralCategory(1, 'en'), 'one');
});

test('buildArchiveConfirmMessage uses the single-chat text when nothing cascades', () => {
  const translate = (key) => (key === 'chat.archiveConfirmSingle' ? 'single' : key);
  assert.equal(buildArchiveConfirmMessage(1, 0, translate, 'en'), 'single');
});

test('buildArchiveConfirmMessage interpolates count and subchats', () => {
  const translate = (key, vars) => {
    if (key === 'chat.archiveConfirmCount.many') {
      return `many:${vars.count}/${vars.subchats}`;
    }
    return key;
  };
  assert.equal(buildArchiveConfirmMessage(7, 6, translate, 'pl'), 'many:7/6');
});

test('buildArchiveConfirmMessage falls back to the other category', () => {
  const seen = [];
  const translate = (key, vars) => {
    seen.push(key);
    if (key === 'chat.archiveConfirmCount.other') return `other:${vars.count}`;
    return key;
  };
  // Polish "few" has no entry here, so the helper must retry with "other".
  assert.equal(buildArchiveConfirmMessage(3, 2, translate, 'pl'), 'other:3');
  assert.deepEqual(seen, ['chat.archiveConfirmCount.few', 'chat.archiveConfirmCount.other']);
});
