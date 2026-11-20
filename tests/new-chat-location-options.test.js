import assert from 'node:assert/strict';
import { buildNewChatLocationOptions, encodeNewChatLocation, decodeNewChatLocation,
  readNewChatLocationFavorites, toggleNewChatLocationFavorite } from '../app_front/features/chat/newChatLocationOptions.js';

const storage = new Map();
globalThis.localStorage = { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
const folders = [{ value: '/workspace/z-app', label: 'Z app' }, { value: '/workspace/a-app', label: 'A app' }];
const worktrees = new Map([
  ['/workspace/a-app', [{ todoId: 'task-a', branch: 'feature/shared', title: 'Task A', worktreePath: '/workspace/a-tree' }]],
  ['/workspace/z-app', [{ todoId: 'task-z', branch: 'feature/shared', title: 'Task Z', worktreePath: '/workspace/z-tree' }]],
]);
const favorite = encodeNewChatLocation('/workspace/a-app', 'task-a');
const options = buildNewChatLocationOptions(folders, worktrees, new Set([favorite]), (key) => key, 'en');
assert.deepEqual(options.map((row) => row.group), ['A app', 'A app', 'Z app', 'Z app']);
assert.deepEqual(decodeNewChatLocation(options[0].value), { folder: '/workspace/a-app', todoId: '' });
assert.equal(options[1].value, favorite);
assert.equal(options[1].favorite, true);
assert.equal(options[1].description, '/workspace/a-tree');
assert.notEqual(options[1].value, options[3].value, 'same branches in different folders must retain distinct identities');
assert.equal(folders[0].label, 'Z app', 'sorting must not mutate the workspace folder list');
assert.equal(buildNewChatLocationOptions(folders, new Map(), new Set(), (key) => key).length, 2);
for (const invalid of ['bad', '{}', '[1,2]', '["",""]', '["/workspace/app"]']) assert.equal(decodeNewChatLocation(invalid), null);
assert.equal(readNewChatLocationFavorites().size, 0);
toggleNewChatLocationFavorite(favorite);
assert.equal(readNewChatLocationFavorites().has(favorite), true);
toggleNewChatLocationFavorite(favorite);
assert.equal(readNewChatLocationFavorites().has(favorite), false);
toggleNewChatLocationFavorite('bad');
assert.equal(readNewChatLocationFavorites().size, 0);
console.log('new-chat-location-options.test.js OK');
