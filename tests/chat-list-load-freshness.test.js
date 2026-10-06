import assert from 'node:assert/strict';
import {
  buildChatListLoadScopeKey,
  decideChatListNetworkLoad,
  normalizeChatListLoadQuery,
  trimPendingChatListLoadQuery,
  isChatListLoadSnapshotStale,
  CHAT_LIST_FULL_INDEX_FRESH_MS,
} from '../app_front/features/chat/chatListLoadFreshness.js';

{
  const normalized = normalizeChatListLoadQuery({ includeArchived: true, preferChatId: ' x ' });
  assert.equal(normalized.includeArchived, true);
  assert.equal(normalized.preferChatId, 'x');
  assert.equal(buildChatListLoadScopeKey(normalized), 'full');
}

{
  const decision = decideChatListNetworkLoad({
    nowMs: 1000,
    normalized: normalizeChatListLoadQuery({ includeArchived: true }),
    hasInFlight: true,
    inFlightScopeKey: 'full',
    lastSuccess: null,
    session: { sessionId: 's1', generation: 1 },
    listRevision: 0,
  });
  assert.equal(decision, 'join-in-flight');
}

{
  const decision = decideChatListNetworkLoad({
    nowMs: 1000,
    normalized: normalizeChatListLoadQuery({}),
    hasInFlight: true,
    inFlightScopeKey: 'live',
    lastSuccess: null,
    session: { sessionId: 's1', generation: 1 },
    listRevision: 0,
  });
  assert.equal(decision, 'join-in-flight');
}

{
  const decision = decideChatListNetworkLoad({
    nowMs: 1000,
    normalized: normalizeChatListLoadQuery({ includeArchived: true }),
    hasInFlight: true,
    inFlightScopeKey: 'live',
    lastSuccess: null,
    session: { sessionId: 's1', generation: 1 },
    listRevision: 0,
  });
  assert.equal(decision, 'fetch');
}

{
  const snapshot = {
    scopeKey: 'full',
    completedAtMs: 1000,
    sessionId: 's1',
    generation: 1,
    listRevisionAtComplete: 2,
  };
  const decision = decideChatListNetworkLoad({
    nowMs: 1000 + CHAT_LIST_FULL_INDEX_FRESH_MS,
    normalized: normalizeChatListLoadQuery({ includeArchived: true }),
    hasInFlight: false,
    inFlightScopeKey: null,
    lastSuccess: snapshot,
    session: { sessionId: 's1', generation: 1 },
    listRevision: 2,
  });
  assert.equal(decision, 'skip-fresh');
}

{
  const snapshot = {
    scopeKey: 'full',
    completedAtMs: 1000,
    sessionId: 's1',
    generation: 1,
    listRevisionAtComplete: 2,
  };
  const decision = decideChatListNetworkLoad({
    nowMs: 1000 + CHAT_LIST_FULL_INDEX_FRESH_MS + 1,
    normalized: normalizeChatListLoadQuery({ includeArchived: true }),
    hasInFlight: false,
    inFlightScopeKey: null,
    lastSuccess: snapshot,
    session: { sessionId: 's1', generation: 1 },
    listRevision: 2,
  });
  assert.equal(decision, 'fetch');
}

{
  const snap = {
    scopeKey: 'full',
    completedAtMs: 1000,
    sessionId: 's1',
    generation: 1,
    listRevisionAtComplete: 2,
  };
  assert.equal(isChatListLoadSnapshotStale(snap, { sessionId: 's2', generation: 1 }, 2), true);
}

assert.equal(trimPendingChatListLoadQuery('full', { includeArchived: true }), null);
assert.ok(trimPendingChatListLoadQuery('live', { includeArchived: true }));

assert.ok(
  trimPendingChatListLoadQuery('full', { includeArchived: true, forceRefresh: true }),
  'forceRefresh pending is never dropped by trim',
);

console.log('chat-list-load-freshness.test.js OK');
