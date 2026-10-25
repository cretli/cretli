import assert from 'node:assert/strict';
import test from 'node:test';
import { matchChatBySpokenTitle } from '../app_front/features/voice/voiceChatMatch.js';

const chats = [
  { id: 'a', title: 'nowa funkcjonalność' },
  { id: 'b', title: 'Czat SDK 184' },
  { id: 'c', title: 'Czat SDK 185' },
  { id: 'd', title: 'Czat SDK 186' },
  { id: 'e', title: 'Fix reversed chat overflow' },
];

test('matches Polish Czat with spoken English chat', () => {
  const actual = matchChatBySpokenTitle(chats, 'chat sdk 185');
  assert.equal(actual.match?.id, 'c');
});

test('ignores a repeated chat word from speech', () => {
  const actual = matchChatBySpokenTitle(chats, 'chat chat SDK 185');
  assert.equal(actual.match?.id, 'c');
});

test('matches by the number when it is unique', () => {
  const actual = matchChatBySpokenTitle(chats, '185');
  assert.equal(actual.match?.id, 'c');
});

test('does not pick a neighbouring SDK chat', () => {
  const actual = matchChatBySpokenTitle(chats, 'sdk 184');
  assert.equal(actual.match?.id, 'b');
});

test('reports several matches instead of guessing', () => {
  const crowded = [...chats, { id: 'f', title: 'Notes 185' }];
  const actual = matchChatBySpokenTitle(crowded, '185');
  assert.equal(actual.ambiguous, true);
  assert.ok(actual.candidates.includes('Czat SDK 185'));
  assert.ok(actual.candidates.includes('Notes 185'));
});

test('returns no match for an unknown title', () => {
  const actual = matchChatBySpokenTitle(chats, 'missing chat');
  assert.equal(actual.match, null);
});
