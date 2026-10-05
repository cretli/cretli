import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import {
  extendHistorySliceToTurnStart,
  isUserTurnBoundaryRecord,
  selectTurnAlignedHistoryWindow,
  splitHistoryPageAtUserTurn,
} from '../lib/sdk/sdk-history-turn-window.js';
import {
  appendChatHistoryEvents,
  deleteChatHistory,
  getChatHistoryPage,
} from '../lib/persist/chat-history-persist.js';

function userRec(text = 'u') {
  return { kind: 'sdk', event: { type: 'user', text } };
}

function localUserRec(text = 'u') {
  return { kind: 'localUser', text };
}

function thinkingRec(text) {
  return { kind: 'sdk', event: { type: 'thinking', text } };
}

function toolRec(name) {
  return { kind: 'sdk', event: { type: 'tool_call', name, status: 'completed' } };
}

function assistantRec(text) {
  return {
    kind: 'sdk',
    event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

// --- boundary predicate ---

assert.equal(isUserTurnBoundaryRecord(null), false);
assert.equal(isUserTurnBoundaryRecord(assistantRec('a')), false);
assert.equal(isUserTurnBoundaryRecord(thinkingRec('t')), false);
assert.equal(isUserTurnBoundaryRecord(toolRec('read')), false);
assert.equal(isUserTurnBoundaryRecord(userRec()), true);
assert.equal(isUserTurnBoundaryRecord(localUserRec()), true);

// --- regression: a tail cut that lands mid-run must be pulled back to the run opening ---
//
// Live stream: user('new') -> thinking -> tool a -> tool b -> assistant -> tool c.
// The leading thinking block owns the run's first Activity tray. If replay starts at
// tool a (the naive tail cut) the thinking block is missing, tool a/b build a standalone
// Activity tray and tool c (after the assistant) lands elsewhere => the tray splits.

const olderRun = [localUserRec('old'), assistantRec('old answer')];
const newRun = [
  userRec('new'),
  thinkingRec('plan'),
  toolRec('a'),
  toolRec('b'),
  assistantRec('mid answer'),
  toolRec('c'),
];
const fullHistory = [...olderRun, ...newRun];
const splitWindow = selectTurnAlignedHistoryWindow(fullHistory, 4);
assert.deepEqual(
  splitWindow,
  newRun,
  'mid-run tail cut expands back to the user turn so the leading Thinking block is replayed'
);
assert.equal(
  splitWindow[1].event.type,
  'thinking',
  'leading Thinking block that owns the first tray is present'
);
assert.equal(
  splitWindow.filter((record) => record.event.type === 'assistant').length,
  1,
  'assistant boundary is preserved so the later tray stays a distinct, intended tray'
);
assert.equal(splitWindow[splitWindow.length - 1].event.name, 'c');

// A window that already starts on a user turn is returned unchanged (no over-expansion).
const alignedTail = selectTurnAlignedHistoryWindow(fullHistory.concat([userRec('next'), toolRec('d')]), 2);
assert.deepEqual(alignedTail.map((record) => record.event.type), ['user', 'tool_call']);
assert.equal(alignedTail[0].event.text, 'next');

// No user turn anywhere: keep the whole list (history begins mid-run; only a full render
// can be coherent, so nothing may be silently dropped).
const noBoundary = [thinkingRec('t'), toolRec('a'), assistantRec('x')];
assert.deepEqual(selectTurnAlignedHistoryWindow(noBoundary, 2), noBoundary);

// Short lists are returned as a copy, untouched.
assert.deepEqual(selectTurnAlignedHistoryWindow(newRun, 99), newRun);

// --- regression: a page without a user turn must not be rendered (page-boundary split) ---

const midRunPage = [toolRec('x'), toolRec('y'), assistantRec('z')];
assert.deepEqual(
  splitHistoryPageAtUserTurn(midRunPage),
  { buffered: midRunPage, renderable: [] },
  'a page that starts mid-run is buffered whole instead of splitting its Activity tray'
);

const pageWithTurn = [toolRec('old'), assistantRec('old'), userRec('u'), thinkingRec('t'), toolRec('a')];
assert.deepEqual(splitHistoryPageAtUserTurn(pageWithTurn), {
  buffered: [toolRec('old'), assistantRec('old')],
  renderable: [userRec('u'), thinkingRec('t'), toolRec('a')],
});

const pageAtTurn = [userRec('u'), thinkingRec('t'), toolRec('a')];
assert.deepEqual(splitHistoryPageAtUserTurn(pageAtTurn), {
  buffered: [],
  renderable: pageAtTurn,
});

// --- server page extension ---

const pool = [
  { seq: 1, rec: localUserRec('old') },
  { seq: 2, rec: assistantRec('old answer') },
  { seq: 3, rec: userRec('new') },
  { seq: 4, rec: thinkingRec('plan') },
  { seq: 5, rec: toolRec('a') },
  { seq: 6, rec: toolRec('b') },
  { seq: 7, rec: assistantRec('mid answer') },
];
const tailSlice = pool.slice(-3);
assert.deepEqual(tailSlice.map((row) => row.seq), [5, 6, 7]);

assert.deepEqual(
  extendHistorySliceToTurnStart(pool, tailSlice, 2000).map((row) => row.seq),
  [3, 4, 5, 6, 7],
  'server tail page expands to the run user turn so the leading Thinking block is shipped'
);

assert.deepEqual(
  extendHistorySliceToTurnStart(pool, tailSlice, 3).map((row) => row.seq),
  [5, 6, 7],
  'extension stops at maxLen instead of growing without bound'
);

assert.deepEqual(
  extendHistorySliceToTurnStart(pool, pool.slice(-5), 2000).map((row) => row.seq),
  [3, 4, 5, 6, 7],
  'a page already starting on the user turn is returned unchanged'
);

assert.deepEqual(extendHistorySliceToTurnStart([], tailSlice, 2000), tailSlice);
assert.deepEqual(extendHistorySliceToTurnStart(pool, [], 2000), []);

// --- integration: GET page wire-up keeps the run opening in the fetched window ---

const pageChatId = 'sdk-history-turn-window-page-test';
deleteChatHistory(pageChatId);
appendChatHistoryEvents(pageChatId, 'session-turn-window', [
  { rec: localUserRec('old') },
  { rec: assistantRec('old answer') },
  { rec: userRec('new') },
  { rec: thinkingRec('plan') },
  { rec: toolRec('a') },
  { rec: toolRec('b') },
  { rec: assistantRec('mid answer') },
]);
const fetchedPage = getChatHistoryPage(pageChatId, { limit: 3 });
assert.deepEqual(
  fetchedPage.events.map((row) => row.seq),
  [3, 4, 5, 6, 7],
  'server page expands to the user turn so the leading Thinking block is shipped'
);
assert.equal(fetchedPage.hasOlder, true);
deleteChatHistory(pageChatId);

function watcherRec(text) {
  return { kind: 'meta', variant: 'watcher', payload: JSON.stringify({ text }) };
}

const notices = [];
for (let index = 0; index < 30; index += 1) notices.push(watcherRec(`n${index}`));
const noticeWindow = selectTurnAlignedHistoryWindow(notices, 10);
assert.equal(noticeWindow.length, 10);
assert.equal(JSON.parse(noticeWindow[0].payload).text, 'n20');
assert.equal(JSON.parse(noticeWindow[noticeWindow.length - 1].payload).text, 'n29');
assert.deepEqual(splitHistoryPageAtUserTurn(notices.slice(0, 5)), {
  buffered: [],
  renderable: notices.slice(0, 5),
});
const noticePool = notices.map((rec, index) => ({ seq: index + 1, rec }));
assert.equal(
  extendHistorySliceToTurnStart(noticePool, noticePool.slice(-10), 2000).length,
  10,
);

const noticeChatId = 'sdk-history-turn-window-notices';
deleteChatHistory(noticeChatId);
appendChatHistoryEvents(noticeChatId, '', notices.map((rec) => ({ rec })));
const noticePage = getChatHistoryPage(noticeChatId, { limit: 10 });
assert.equal(noticePage.events.length, 10);
assert.equal(noticePage.hasOlder, true);
assert.equal(noticePage.events[0].seq, 21);
deleteChatHistory(noticeChatId);

console.log('sdk-history-turn-window.test.js OK');
