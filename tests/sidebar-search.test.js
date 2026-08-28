import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSidebarSearch } from '../app_front/features/sidebar/sidebarSearch.js';

test('empty query matches every item', () => {
  assert.equal(matchesSidebarSearch('', { title: 'SDK chat 157', workspaceName: 'cretli' }), true);
  assert.equal(matchesSidebarSearch('   ', { title: 'Hej', workspaceName: 'fade' }), true);
  assert.equal(matchesSidebarSearch(null, { title: 'Hej' }), true);
});

test('matches chat title case-insensitively', () => {
  const item = { title: 'SDK chat 157', workspaceName: 'cretli' };
  assert.equal(matchesSidebarSearch('sdk', item), true);
  assert.equal(matchesSidebarSearch('CHAT 157', item), true);
  assert.equal(matchesSidebarSearch('  157  ', item), true);
});

test('matches workspace name so a project query shows the whole group', () => {
  const item = { title: 'Hej', workspaceName: 'Cursor Remote' };
  assert.equal(matchesSidebarSearch('cursor', item), true);
  assert.equal(matchesSidebarSearch('REMOTE', item), true);
});

test('returns false when neither title nor workspace matches', () => {
  const item = { title: 'SDK chat 157', workspaceName: 'cretli' };
  assert.equal(matchesSidebarSearch('fade', item), false);
  assert.equal(matchesSidebarSearch('missing', { title: '', workspaceName: '' }), false);
});
