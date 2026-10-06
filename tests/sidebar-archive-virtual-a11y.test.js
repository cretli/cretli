import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSidebarChatRowHtml } from '../app_front/features/sidebar/sidebarChatRowModel.js';
import {
  computeArchiveOptionAria,
  findArchiveLogicalIndexByChatId,
  resolveArchiveStoredLogicalIndex,
  resolveNextArchiveLogicalIndex,
} from '../app_front/features/sidebar/sidebarArchiveVirtualNavigation.js';
import {
  __resetSidebarArchiveVirtualFocusForTest,
  clearSidebarArchiveVirtualFocus,
  reconcileArchiveFocusAfterWindowChange,
  setSidebarArchiveVirtualFocus,
  shouldRestoreArchiveFocusAfterGesture,
  tickSidebarArchiveGestureFocusSnapshot,
} from '../app_front/features/sidebar/sidebarArchiveVirtualFocus.js';
import { findArchiveGroupForChatId } from '../app_front/features/sidebar/sidebarArchiveSidebarFocus.js';
import {
  __resetSidebarArchiveGroupPassForTest,
  beginSidebarArchiveGroupPass,
  endSidebarArchiveGroupPass,
  registerSidebarArchiveGroup,
} from '../app_front/features/sidebar/sidebarArchiveGroupPass.js';

const rowDeps = {
  t: (key) => key,
  escapeHtml: (value) => String(value ?? ''),
  resolveSidebarHarnessIcon: () => '',
  renderChatActionButtonsHtml: () => '',
  canPinChatToUrl: () => false,
};

test('computeArchiveOptionAria uses 1-based posinset and flat setsize', () => {
  assert.deepEqual(computeArchiveOptionAria(0, 1500), { ariaPosInSet: 1, ariaSetSize: 1500 });
  assert.deepEqual(computeArchiveOptionAria(1499, 1500), { ariaPosInSet: 1500, ariaSetSize: 1500 });
  assert.equal(computeArchiveOptionAria(-1, 10), null);
});

test('resolveNextArchiveLogicalIndex matches listbox keyboard wrapping', () => {
  assert.equal(resolveNextArchiveLogicalIndex('End', 0, 100), 99);
  assert.equal(resolveNextArchiveLogicalIndex('Home', 50, 100), 0);
  assert.equal(resolveNextArchiveLogicalIndex('ArrowDown', 99, 100), 0);
});

test('findArchiveLogicalIndexByChatId resolves stable tree index', () => {
  const tree = [{ chat: { id: 'a' } }, { chat: { id: 'b' } }];
  assert.equal(findArchiveLogicalIndexByChatId(tree, 'b'), 1);
  assert.equal(findArchiveLogicalIndexByChatId(tree, 'missing'), -1);
});

test('resolveArchiveStoredLogicalIndex realigns stale index after reorder', () => {
  const before = [{ chat: { id: 'a' } }, { chat: { id: 'b' } }];
  assert.equal(resolveArchiveStoredLogicalIndex({ chatId: 'b', logicalIndex: 0 }, before), 1);
  const after = [{ chat: { id: 'b' } }, { chat: { id: 'a' } }];
  assert.equal(resolveArchiveStoredLogicalIndex({ chatId: 'b', logicalIndex: 1 }, after), 0);
});

test('buildSidebarChatRowHtml emits aria-setsize and aria-posinset in archive list', () => {
  const html = buildSidebarChatRowHtml(
    { id: 'arch-42', title: 'T', agentTransport: 'sdk' },
    '',
    {
      archived: true,
      inArchiveList: true,
      ariaSetSize: 500,
      ariaPosInSet: 43,
      archiveLogicalIndex: 42,
    },
    rowDeps,
  );
  assert.match(html, /aria-setsize="500"/);
  assert.match(html, /aria-posinset="43"/);
  assert.match(html, /data-archive-logical-index="42"/);
});

test('findArchiveGroupForChatId resolves workspace sidebar key from registration', () => {
  __resetSidebarArchiveGroupPassForTest();
  __resetSidebarArchiveVirtualFocusForTest();
  beginSidebarArchiveGroupPass();
  registerSidebarArchiveGroup('/ws/b', {
    sidebarKey: '/ws/b',
    openSection: true,
    count: 1,
    activeChatId: '',
    archiveTree: [{ chat: { id: 'only-b' }, level: 0, isLastChild: true, parentId: '', continuationLevels: [] }],
    deps: { t: (k) => k },
  });
  endSidebarArchiveGroupPass();
  const body = {
    querySelectorAll: () => [{
      getAttribute: () => '/ws/b',
    }],
  };
  const located = findArchiveGroupForChatId(body, 'only-b');
  assert.equal(located?.sidebarKey, '/ws/b');
  assert.equal(located?.logicalIndex, 0);
});

test('gesture focus restore requires snapshot taken at gesture start', () => {
  __resetSidebarArchiveVirtualFocusForTest();
  setSidebarArchiveVirtualFocus('/ws/g', { chatId: 'arch-1', logicalIndex: 1 });
  tickSidebarArchiveGestureFocusSnapshot(false);
  tickSidebarArchiveGestureFocusSnapshot(true);
  assert.equal(shouldRestoreArchiveFocusAfterGesture('/ws/g'), false);
  tickSidebarArchiveGestureFocusSnapshot(false);
});

test('clearSidebarArchiveVirtualFocus drops stale logical target', () => {
  __resetSidebarArchiveVirtualFocusForTest();
  setSidebarArchiveVirtualFocus('/ws/x', { chatId: 'a', logicalIndex: 3 });
  clearSidebarArchiveVirtualFocus('/ws/x');
  assert.equal(reconcileArchiveFocusAfterWindowChange({
    sidebarKey: '/ws/x',
    archiveTree: [{ chat: { id: 'a' } }],
    startIndex: 0,
    endIndex: 1,
    fromUserScroll: true,
    listEl: null,
  }), false);
});

test('reconcileArchiveFocusAfterWindowChange skips programmatic window moves', () => {
  assert.equal(
    reconcileArchiveFocusAfterWindowChange({
      sidebarKey: '/ws',
      archiveTree: [{ chat: { id: 'a' } }],
      startIndex: 0,
      endIndex: 1,
      fromUserScroll: false,
      listEl: null,
    }),
    false,
  );
});
