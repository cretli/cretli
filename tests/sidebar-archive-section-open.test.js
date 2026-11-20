import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveArchiveSectionOpen } from '../app_front/features/sidebar/sidebarArchiveGroupPass.js';

const base = {
  searching: false,
  userOpen: false,
  archivedChats: [{ id: 'archived-1' }, { id: 'archived-2' }],
  activeChatId: 'archived-1',
  collapsedForChatId: '',
};

test('an archived active chat opens the section by itself', () => {
  assert.equal(resolveArchiveSectionOpen(base), true);
});

test('the user can collapse the section over an archived active chat', () => {
  assert.equal(resolveArchiveSectionOpen({ ...base, collapsedForChatId: 'archived-1' }), false);
});

test('opening another archived chat reopens a collapsed section', () => {
  assert.equal(resolveArchiveSectionOpen({ ...base, activeChatId: 'archived-2', collapsedForChatId: 'archived-1' }), true);
});

test('a live active chat does not open the section', () => {
  assert.equal(resolveArchiveSectionOpen({ ...base, activeChatId: 'live-1' }), false);
  assert.equal(resolveArchiveSectionOpen({ ...base, activeChatId: '' }), false);
});

test('search and an explicit open win over a collapse', () => {
  assert.equal(resolveArchiveSectionOpen({ ...base, collapsedForChatId: 'archived-1', searching: true }), true);
  assert.equal(resolveArchiveSectionOpen({ ...base, collapsedForChatId: 'archived-1', userOpen: true }), true);
});
