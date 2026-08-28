import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchWorkspaceBySpokenName,
  workspaceSpokenLabel,
} from '../app_front/features/voice/voiceWorkspaceMatch.js';

const workspaces = [
  { name: 'shop.example', workspaceFile: '/home/user/www/shop.example/shop.code-workspace' },
  { name: 'cretli', workspaceFile: '/home/user/www/cretli/cretli.code-workspace' },
  { name: 'libs', workspaceFile: '/home/user/www/libs/libs.code-workspace' },
];

test('picks a workspace by spoken fragment', () => {
  const actual = matchWorkspaceBySpokenName(workspaces, 'shop');
  assert.equal(actual.match?.name, 'shop.example');
});

test('picks a workspace by its file stem', () => {
  const actual = matchWorkspaceBySpokenName(workspaces, 'cretli');
  assert.equal(actual.match?.name, 'cretli');
});

test('reports several matches instead of guessing', () => {
  const crowded = [
    ...workspaces,
    { name: 'shop-staging', workspaceFile: '/tmp/shop-staging.code-workspace' },
  ];
  const actual = matchWorkspaceBySpokenName(crowded, 'shop');
  assert.equal(actual.ambiguous, true);
  assert.ok(actual.candidates.includes('shop.example'));
  assert.ok(actual.candidates.includes('shop-staging'));
});

test('returns no match for an unknown name', () => {
  const actual = matchWorkspaceBySpokenName(workspaces, 'unknown-app');
  assert.equal(actual.match, null);
});

test('labels a workspace from the file when name is missing', () => {
  assert.equal(
    workspaceSpokenLabel({ workspaceFile: '/a/b/MyApp.code-workspace' }),
    'MyApp'
  );
});
