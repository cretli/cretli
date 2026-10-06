/**
 * Task 1.2 — pending badge patch in the open chat-list modal.
 *
 * Covers:
 * - the pure single-pass patch (add/remove `chat-list-item-sync-badge`, archived
 *   rows untouched, unknown ids ignored, unchanged rows keep DOM identity),
 * - the `createChatView` wrapper: a closed modal performs zero pending DOM work,
 *   an open modal patches only the changed rows and never refreshes model labels,
 * - a wiring lock: `chat.js` must route `onPendingHistoryChange` through the
 *   patch instead of `renderChatList` (no boot-cache build/write, no model-label
 *   refresh, no sidebar render).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyChatListPendingBadgePatch,
  CHAT_LIST_PENDING_BADGE_CLASS,
  derivePendingBadgeMeta,
} from '../app_front/features/chat/chatListPendingBadges.js';
import { createChatView } from '../app_front/features/chat/chatView.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- fake DOM ----------------------------------------------------------------------

function createFakeElement(tag = 'div', dataset = {}) {
  const el = {
    tagName: tag,
    className: '',
    title: '',
    textContent: '',
    dataset: { ...dataset },
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = el.children.indexOf(child);
      if (index < 0) throw new Error('removeChild: not a child');
      el.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      el.parentNode?.removeChild(el);
    },
  };
  return el;
}

function findBadge(row) {
  return row._title.children.find((child) => child.className === CHAT_LIST_PENDING_BADGE_CLASS) || null;
}

function createFakeRow(id, { archived = false, pending = false } = {}) {
  const row = createFakeElement('li', archived ? { chatId: id, archived: '1' } : { chatId: id });
  const title = createFakeElement('span');
  row.appendChild(title);
  row._title = title;
  if (pending) {
    const badge = createFakeElement('span');
    badge.className = CHAT_LIST_PENDING_BADGE_CLASS;
    badge.textContent = '●';
    title.appendChild(badge);
  }
  row.querySelector = (selector) => {
    if (selector === '.chat-list-item-title') return title;
    if (selector === `.${CHAT_LIST_PENDING_BADGE_CLASS}`) return findBadge(row);
    return null;
  };
  return row;
}

function createFakeList(rows) {
  const list = {
    rows,
    querySelectorAllCalls: 0,
    listQuerySelectorCalls: 0,
    querySelectorAll(selector) {
      list.querySelectorAllCalls += 1;
      assert.equal(selector, '.chat-list-item[data-chat-id]');
      return rows;
    },
    // The helper must never look a row up by id over the whole list.
    querySelector() {
      list.listQuerySelectorCalls += 1;
      return null;
    },
  };
  return list;
}

function createFakeDocument(byId) {
  return {
    getElementById(id) {
      return byId[id] || null;
    },
    createElement(tag) {
      return createFakeElement(tag);
    },
  };
}

// --- A. pure helper ----------------------------------------------------------------

{
  const rowA = createFakeRow('a');
  const rowB = createFakeRow('b');
  const rowC = createFakeRow('c', { archived: true });
  const list = createFakeList([rowA, rowB, rowC]);

  const result = applyChatListPendingBadgePatch(
    list,
    { addedIds: ['a', 'c', 'missing'], removedIds: [] },
    { documentRef: createFakeDocument({}), label: 'New activity' }
  );

  assert.equal(result.added, 1, 'only the existing non-archived row gets a badge');
  assert.equal(result.removed, 0);
  assert.equal(result.scanned, 3, 'all rendered rows visited once');
  assert.equal(list.querySelectorAllCalls, 1, 'exactly one pass over the rows');
  assert.equal(list.listQuerySelectorCalls, 0, 'no per-id lookup over the list');
  assert.equal(findBadge(rowA)?.className, CHAT_LIST_PENDING_BADGE_CLASS);
  assert.equal(findBadge(rowA)?.title, 'New activity');
  assert.equal(findBadge(rowA)?.textContent, '●');
  assert.equal(findBadge(rowA)?.parentNode, rowA._title, 'badge lives in the title span');
  assert.equal(findBadge(rowB), null, 'an untouched row stays untouched');
  assert.equal(findBadge(rowC), null, 'archived rows never carry the badge');
}

{
  const rowA = createFakeRow('a', { pending: true });
  const rowB = createFakeRow('b');
  const list = createFakeList([rowA, rowB]);

  const result = applyChatListPendingBadgePatch(
    list,
    { addedIds: [], removedIds: ['a', 'missing'] },
    { documentRef: createFakeDocument({}) }
  );

  assert.equal(result.removed, 1, 'the pending row loses the badge');
  assert.equal(result.added, 0);
  assert.equal(findBadge(rowA), null);
  assert.equal(list.querySelectorAllCalls, 1);
  assert.equal(list.listQuerySelectorCalls, 0);
}

{
  // An idle row and an already-badged row: the second call is a no-op for both.
  const rowA = createFakeRow('a');
  const rowB = createFakeRow('b', { pending: true });
  const list = createFakeList([rowA, rowB]);
  const documentRef = createFakeDocument({});

  const first = applyChatListPendingBadgePatch(
    list,
    { addedIds: ['a', 'b'], removedIds: [] },
    { documentRef }
  );
  assert.equal(first.added, 1, 'only the row without a badge is patched');
  assert.equal(rowB._title.children.length, 1, 'the already-badged row is not double-patched');

  const second = applyChatListPendingBadgePatch(
    list,
    { addedIds: ['a'], removedIds: [] },
    { documentRef }
  );
  assert.equal(second.added, 0, 'a repeat add is idempotent');
  assert.equal(rowA._title.children.length, 1);
}

{
  // No change set and no list must be free of DOM access.
  const list = createFakeList([createFakeRow('a')]);
  const empty = applyChatListPendingBadgePatch(list, { addedIds: [], removedIds: [] });
  assert.deepEqual(empty, { scanned: 0, added: 0, removed: 0 });
  assert.equal(list.querySelectorAllCalls, 0, 'an empty net change does not walk the list');

  const noList = applyChatListPendingBadgePatch(null, { addedIds: ['a'], removedIds: [] });
  assert.deepEqual(noList, { scanned: 0, added: 0, removed: 0 });
}

{
  // Large batch: one pass, changed rows only, identity of untouched rows kept.
  const rows = [];
  const addedIds = [];
  const removedIds = [];
  for (let index = 0; index < 1000; index += 1) {
    const id = `chat-${index}`;
    const pending = index >= 300 && index < 400;
    if (index < 300) addedIds.push(id);
    if (pending) removedIds.push(id);
    rows.push(createFakeRow(id, { pending }));
  }
  const list = createFakeList(rows);
  const untouchedBefore = rows.slice(400);
  const titlesBefore = untouchedBefore.map((row) => row._title.children.length);

  const result = applyChatListPendingBadgePatch(
    list,
    { addedIds, removedIds },
    { documentRef: createFakeDocument({}), label: () => 'New activity' }
  );

  assert.equal(result.scanned, 1000, 'the single pass covers every rendered row');
  assert.equal(result.added, 300, '300 badges appended');
  assert.equal(result.removed, 100, '100 badges removed');
  assert.equal(list.querySelectorAllCalls, 1, 'large batch still uses one pass');
  assert.equal(list.listQuerySelectorCalls, 0, 'large batch issues no per-id lookup');
  for (let index = 0; index < untouchedBefore.length; index += 1) {
    assert.equal(untouchedBefore[index], rows[400 + index], 'untouched row keeps its DOM identity');
    assert.equal(untouchedBefore[index]._title.children.length, titlesBefore[index]);
  }
}

{
  const meta = derivePendingBadgeMeta([
    { id: 'on', _pendingRemoteHistory: true },
    { id: 'off', _pendingRemoteHistory: false },
    { id: '', _pendingRemoteHistory: true },
  ]);
  assert.deepEqual(meta, { addedIds: ['on'], removedIds: ['off'] });
}

// --- B. chatView wrapper: closed modal is a no-op ---------------------------------

const previousDocument = globalThis.document;
/** @param {object} byId */
function withDocument(byId, fn) {
  globalThis.document = createFakeDocument(byId);
  try {
    return fn();
  } finally {
    globalThis.document = previousDocument;
  }
}

function createView(documentRef, { onModelRefresh } = {}) {
  return createChatView({
    getTerminalStateMeta: () => ({ tone: 'idle', label: 'Ready' }),
    escapeHtml: (value) => String(value),
    refreshModelSelectLabels: onModelRefresh,
    getPendingRemoteHistoryLabel: () => 'New activity',
  });
}

{
  const modal = { hidden: true };
  const rowA = createFakeRow('a');
  const list = createFakeList([rowA]);
  const modelRefreshes = { count: 0 };
  withDocument({ 'chat-list-modal': modal, 'chat-list-items': list }, () => {
    const view = createView(globalThis.document, {
      onModelRefresh: () => {
        modelRefreshes.count += 1;
      },
    });
    view.applyChatListPendingBadges([{ id: 'a', _pendingRemoteHistory: true }], {
      addedIds: ['a'],
      removedIds: [],
    });
    assert.equal(list.querySelectorAllCalls, 0, 'closed modal never walks its rows');
    assert.equal(findBadge(rowA), null, 'closed modal stores no pending DOM');
    assert.equal(modelRefreshes.count, 0, 'pending never refreshes model labels');
  });
}

{
  const modal = { hidden: false };
  const rowA = createFakeRow('a');
  const list = createFakeList([rowA]);
  const modelRefreshes = { count: 0 };
  withDocument({ 'chat-list-modal': modal, 'chat-list-items': list }, () => {
    const view = createView(globalThis.document, {
      onModelRefresh: () => {
        modelRefreshes.count += 1;
      },
    });
    view.applyChatListPendingBadges([{ id: 'a', _pendingRemoteHistory: true }], {
      addedIds: ['a'],
      removedIds: [],
    });
    assert.equal(list.querySelectorAllCalls, 1, 'open modal patches its rows');
    assert.equal(findBadge(rowA)?.textContent, '●');
    assert.equal(modelRefreshes.count, 0, 'pending patch does not refresh model labels');
  });
}

{
  // Meta omitted: the wrapper derives the change set from the changed chats.
  const modal = { hidden: false };
  const rowA = createFakeRow('a');
  const list = createFakeList([rowA]);
  withDocument({ 'chat-list-modal': modal, 'chat-list-items': list }, () => {
    const view = createView(globalThis.document);
    view.applyChatListPendingBadges([{ id: 'a', _pendingRemoteHistory: true }]);
    assert.equal(findBadge(rowA)?.className, CHAT_LIST_PENDING_BADGE_CLASS);
  });
}

// --- C. wiring lock: chat.js must not full-render on pending -----------------------

const chatSource = readFileSync(path.join(ROOT, 'app_front/chat.js'), 'utf8');
const callbackMatch = chatSource.match(/onPendingHistoryChange:\s*\(([^)]*)\)\s*=>\s*\{([^}]*)\}/);
assert.ok(callbackMatch, 'chat.js still wires onPendingHistoryChange');
assert.match(
  callbackMatch[2],
  /chatView\.applyChatListPendingBadges\(/,
  'the pending callback must patch the open modal'
);
assert.doesNotMatch(
  callbackMatch[2],
  /renderChatList\s*\(/,
  'the pending callback must not run the full renderChatList (no cache build/write, no model labels)'
);

const viewSource = readFileSync(path.join(ROOT, 'app_front/features/chat/chatView.js'), 'utf8');
assert.match(
  viewSource,
  /applyChatListPendingBadgePatch\(/,
  'chatView must use the single-pass badge patch'
);
assert.match(
  viewSource,
  /const patch = Array\.isArray\(meta\?\.addedIds\)/,
  'chatView must pass the publisher meta through to the patch'
);

console.log('chat-list-pending-badges.test.js OK');
