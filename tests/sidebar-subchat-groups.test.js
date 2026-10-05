import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTLED_SUBCHAT_ERROR_VISIBLE_MS,
  SETTLED_SUBCHAT_PARENT_THRESHOLD,
  SETTLED_SUBCHAT_STALE_MS,
  SUBCHAT_GROUP_KIND,
  classifySubchat,
  formatSubchatCount,
  getAncestorContinuationLevels,
  formatSubchatParentBadge,
  formatSubchatSummary,
  groupSettledChildren,
  readChatAgeMs,
  readSubchatOutcome,
  renderSubchatGroupHtml,
  resolvePluralCategory,
  summarizeGroup,
} from '../app_front/features/sidebar/sidebarSubchatGroups.js';
import { flattenChatsTree } from '../lib/chat-tree.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');

function isoAgo(ms) {
  return new Date(NOW - ms).toISOString();
}

/**
 * @param {string} id
 * @param {string} [parent]
 * @param {object} [extra]
 */
function chat(id, parent, extra = {}) {
  const row = { id, title: id, updatedAt: isoAgo(SETTLED_SUBCHAT_STALE_MS + 60 * 1000), ...extra };
  if (parent) row.forkParentChatId = parent;
  return row;
}

function tree(chats) {
  return flattenChatsTree(chats);
}

test('readChatAgeMs falls back to createdAt and treats unknown timestamps as fresh', () => {
  const stale = { id: 'a', createdAt: isoAgo(SETTLED_SUBCHAT_STALE_MS * 2) };
  assert.equal(readChatAgeMs(stale, NOW) > SETTLED_SUBCHAT_STALE_MS, true);
  assert.equal(readChatAgeMs({ id: 'b' }, NOW), 0);
  assert.equal(readChatAgeMs({ id: 'c', updatedAt: 'not-a-date' }, NOW), 0);
});

test('readSubchatOutcome reads the delegation status from _serverRunState', () => {
  assert.equal(readSubchatOutcome({ _serverRunState: { state: 'attention', delegationStatus: 'completed' } }), 'completed');
  assert.equal(readSubchatOutcome({ _serverRunState: { state: 'attention', delegationStatus: 'failed' } }), 'failed');
  assert.equal(readSubchatOutcome({ _serverRunState: { state: 'attention', delegationStatus: 'interrupted' } }), 'interrupted');
  assert.equal(readSubchatOutcome({ _serverRunState: { state: 'attention' } }), 'completed');
  assert.equal(readSubchatOutcome({ _serverRunState: { state: 'busy' } }), 'running');
  assert.equal(readSubchatOutcome({ _serverRunState: { state: 'waiting' } }), 'running');
  assert.equal(readSubchatOutcome({}), 'idle');
});

test('classifySubchat: stale completed child is settled, fresh completed child is not stale', () => {
  const stale = classifySubchat(
    { id: 'old', updatedAt: isoAgo(SETTLED_SUBCHAT_STALE_MS + 60 * 1000), _serverRunState: { state: 'attention', delegationStatus: 'completed' } },
    { now: NOW },
  );
  assert.equal(stale.settled, true);
  assert.equal(stale.outcome, 'completed');
  assert.equal(stale.stale, true);

  const fresh = classifySubchat({ id: 'new', updatedAt: isoAgo(5 * 60 * 1000) }, { now: NOW });
  assert.equal(fresh.settled, true);
  assert.equal(fresh.stale, false);
});

test('classifySubchat: a failed child stays visible for 24h then becomes settled', () => {
  const failedNow = {
    id: 'f1',
    updatedAt: isoAgo(60 * 60 * 1000),
    _serverRunState: { state: 'attention', delegationStatus: 'failed' },
  };
  const fresh = classifySubchat(failedNow, { now: NOW });
  assert.equal(fresh.settled, false);
  assert.equal(fresh.alwaysVisibleReason, 'fresh-error');

  const oldFailed = {
    id: 'f2',
    updatedAt: isoAgo(SETTLED_SUBCHAT_ERROR_VISIBLE_MS + 60 * 1000),
    _serverRunState: { state: 'attention', delegationStatus: 'failed' },
  };
  const old = classifySubchat(oldFailed, { now: NOW });
  assert.equal(old.settled, true);
  assert.equal(old.outcome, 'failed');
});

test('classifySubchat keeps active, favorite, unread and running chats visible', () => {
  const base = { id: 'c1', updatedAt: isoAgo(SETTLED_SUBCHAT_STALE_MS * 4) };
  assert.equal(classifySubchat(base, { now: NOW, activeChatId: 'c1' }).settled, false);
  assert.equal(classifySubchat(base, { now: NOW, isFavorite: () => true }).settled, false);
  assert.equal(classifySubchat(base, { now: NOW, isUnread: () => true }).settled, false);
  assert.equal(classifySubchat({ ...base, _serverRunState: { state: 'busy' } }, { now: NOW }).settled, false);
});

test('groupSettledChildren folds one stale child and recomputes isLastChild', () => {
  const chats = [
    chat('root'),
    chat('old', 'root', { _serverRunState: { state: 'attention', delegationStatus: 'completed' } }),
    chat('live', 'root', { updatedAt: isoAgo(1000) }),
  ];
  const grouped = groupSettledChildren(tree(chats), { now: NOW });
  const ids = grouped.items.map((item) => (item.isGroup ? item.id : item.chat.id));
  assert.deepEqual(ids, ['root', `${SUBCHAT_GROUP_KIND}:root`, 'live']);
  const group = grouped.groups[0];
  assert.equal(group.parentId, 'root');
  assert.equal(group.level, 1);
  assert.equal(group.summary.total, 1);
  assert.equal(group.summary.completed, 1);
  assert.equal(group.expanded, false);
  assert.equal(group.isLastChild, false);
  assert.deepEqual([...grouped.hiddenIds], ['old']);
  const live = grouped.items.find((item) => item.chat?.id === 'live');
  assert.equal(live.isLastChild, true);
});

test('groupSettledChildren groups every settled child when a parent has more than the threshold', () => {
  const chats = [chat('root')];
  const total = SETTLED_SUBCHAT_PARENT_THRESHOLD + 1;
  for (let i = 0; i < total; i += 1) {
    chats.push(chat(`c${i}`, 'root', { updatedAt: isoAgo(5 * 60 * 1000) }));
  }
  const grouped = groupSettledChildren(tree(chats), { now: NOW });
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0].summary.total, total);
  assert.equal(grouped.hiddenIds.size, total);
});

test('groupSettledChildren keeps a small set of fresh settled children visible', () => {
  const chats = [chat('root'), chat('c0', 'root', { updatedAt: isoAgo(5 * 60 * 1000) })];
  const grouped = groupSettledChildren(tree(chats), { now: NOW });
  assert.equal(grouped.groups.length, 0);
  assert.equal(grouped.hiddenIds.size, 0);
  assert.deepEqual(grouped.items.map((item) => item.chat.id), ['root', 'c0']);
});

test('groupSettledChildren never folds a child younger than the minimum age', () => {
  const chats = [chat('root')];
  for (let i = 0; i < SETTLED_SUBCHAT_PARENT_THRESHOLD + 2; i += 1) {
    chats.push(chat(`c${i}`, 'root', { updatedAt: isoAgo(30 * 1000) }));
  }
  const grouped = groupSettledChildren(tree(chats), { now: NOW });
  assert.equal(grouped.groups.length, 0);
});

test('groupSettledChildren keeps a settled child that has a live descendant', () => {
  const chats = [
    chat('root'),
    chat('bridge', 'root'),
    chat('running', 'bridge', { _serverRunState: { state: 'busy' }, updatedAt: isoAgo(2000) }),
  ];
  const grouped = groupSettledChildren(tree(chats), { now: NOW });
  assert.equal(grouped.groups.length, 0);
  assert.equal(grouped.hiddenIds.size, 0);
  assert.deepEqual(grouped.items.map((item) => item.chat.id), ['root', 'bridge', 'running']);
});

test('groupSettledChildren hides the whole subtree of a folded child', () => {
  const chats = [
    chat('root'),
    chat('old', 'root'),
    chat('old-child', 'old'),
    chat('old-grandchild', 'old-child'),
  ];
  const grouped = groupSettledChildren(tree(chats), { now: NOW });
  assert.deepEqual([...grouped.hiddenIds].sort(), ['old', 'old-child', 'old-grandchild']);
  const group = grouped.groups[0];
  assert.deepEqual(group.allChildIds.sort(), ['old', 'old-child', 'old-grandchild']);
  assert.deepEqual(group.childIds, ['old']);
});

test('groupSettledChildren expands the group when the active chat is a child', () => {
  const chats = [chat('root'), chat('old', 'root'), chat('other', 'root')];
  const grouped = groupSettledChildren(tree(chats), { now: NOW, activeChatId: 'other' });
  const group = grouped.groups[0];
  assert.equal(group.expanded, true);
  assert.equal(grouped.hiddenIds.size, 0);
  assert.deepEqual(grouped.items.map((item) => (item.isGroup ? item.id : item.chat.id)), [
    'root',
    `${SUBCHAT_GROUP_KIND}:root`,
    'old',
    'other',
  ]);
});

test('groupSettledChildren lets the active parent collapse its settled-child group', () => {
  const chats = [chat('root'), chat('old', 'root')];
  const grouped = groupSettledChildren(tree(chats), { now: NOW, activeChatId: 'root' });
  assert.equal(grouped.groups[0].expanded, false);
  assert.deepEqual([...grouped.hiddenIds], ['old']);
});

test('group row gets the correct last-child connector state', () => {
  const onlyGroup = groupSettledChildren(tree([chat('root'), chat('old', 'root')]), { now: NOW });
  assert.equal(onlyGroup.groups[0].isLastChild, true);
  assert.match(renderSubchatGroupHtml(onlyGroup.groups[0]), /sidebar-subchat-group is-last-child/);

  const groupWithVisibleSibling = groupSettledChildren(
    tree([chat('root'), chat('old', 'root'), chat('live', 'root', { updatedAt: isoAgo(1000) })]),
    { now: NOW },
  );
  assert.equal(groupWithVisibleSibling.groups[0].isLastChild, false);
  assert.equal(groupWithVisibleSibling.items.find((item) => item.chat?.id === 'live').isLastChild, true);
});

test('nested group keeps a connector for each non-last ancestor branch', () => {
  const tree = [
    { chat: { id: 'root' }, level: 0, parentId: '', isLastChild: false },
    { chat: { id: 'child' }, level: 1, parentId: 'root', isLastChild: false },
    { chat: { id: 'grandchild' }, level: 2, parentId: 'child', isLastChild: true },
  ];
  assert.deepEqual(getAncestorContinuationLevels({ parentId: 'grandchild' }, tree), [1]);
  assert.deepEqual(getAncestorContinuationLevels({ parentId: 'child' }, tree), [1]);
});

test('groupSettledChildren forces every group open while searching', () => {
  const chats = [chat('root'), chat('old', 'root')];
  const grouped = groupSettledChildren(tree(chats), { now: NOW, searching: true });
  assert.equal(grouped.groups[0].expanded, true);
  assert.equal(grouped.hiddenIds.size, 0);
});

test('groupSettledChildren honors a persisted per-parent expansion', () => {
  const chats = [chat('root'), chat('old', 'root')];
  const collapsed = groupSettledChildren(tree(chats), { now: NOW });
  assert.equal(collapsed.groups[0].expanded, false);
  const expanded = groupSettledChildren(tree(chats), {
    now: NOW,
    isExpanded: (parentId) => parentId === 'root',
  });
  assert.equal(expanded.groups[0].expanded, true);
  assert.equal(expanded.hiddenIds.size, 0);
});

test('groupSettledChildren keeps the group collapsed when a sibling is running', () => {
  const chats = [
    chat('root'),
    chat('old', 'root', { _serverRunState: { state: 'attention', delegationStatus: 'completed' } }),
    chat('running', 'root', { _serverRunState: { state: 'busy' }, updatedAt: isoAgo(2000) }),
  ];
  const grouped = groupSettledChildren(tree(chats), { now: NOW });
  assert.equal(grouped.groups[0].expanded, false);
  assert.equal(grouped.hiddenIds.has('old'), true);
  assert.equal(grouped.items.some((item) => item.chat?.id === 'running'), true);
});

test('summarizeGroup and formatSubchatSummary report completed, failed and interrupted', () => {
  const summary = summarizeGroup([
    { _serverRunState: { state: 'attention', delegationStatus: 'completed' } },
    { _serverRunState: { state: 'attention', delegationStatus: 'completed' } },
    { _serverRunState: { state: 'attention', delegationStatus: 'failed' } },
    { _serverRunState: { state: 'attention', delegationStatus: 'interrupted' } },
    { _serverRunState: { state: 'attention', delegationStatus: 'failed' } },
  ]);
  assert.deepEqual(summary, { total: 5, completed: 2, failed: 2, interrupted: 1, idle: 0 });
  assert.equal(formatSubchatSummary(summary), '2 ✓, 2 ✗, 1 ⏸');
  assert.equal(formatSubchatSummary({ completed: 0, failed: 0, interrupted: 0, idle: 0 }), '');
});

test('resolvePluralCategory follows Polish plural rules', () => {
  assert.equal(resolvePluralCategory(1, 'pl'), 'one');
  assert.equal(resolvePluralCategory(2, 'pl'), 'few');
  assert.equal(resolvePluralCategory(4, 'pl'), 'few');
  assert.equal(resolvePluralCategory(5, 'pl'), 'many');
  assert.equal(resolvePluralCategory(12, 'pl'), 'many');
  assert.equal(resolvePluralCategory(14, 'pl'), 'many');
  assert.equal(resolvePluralCategory(22, 'pl'), 'few');
  assert.equal(resolvePluralCategory(25, 'pl'), 'many');
  assert.equal(resolvePluralCategory(112, 'pl'), 'many');
  assert.equal(resolvePluralCategory(122, 'pl'), 'few');
  assert.equal(resolvePluralCategory(1, 'en'), 'one');
  assert.equal(resolvePluralCategory(7, 'en'), 'other');
});

test('formatSubchatCount picks the language plural key and interpolates the count', () => {
  const dict = {
    'sidebar.subchatCount.one': '{count} zakończony subczat',
    'sidebar.subchatCount.few': '{count} zakończone subczaty',
    'sidebar.subchatCount.many': '{count} zakończonych subczatów',
  };
  const t = (key, vars) => {
    let value = dict[key];
    if (value === undefined) return key;
    for (const [name, replacement] of Object.entries(vars || {})) {
      value = value.split(`{${name}}`).join(String(replacement));
    }
    return value;
  };
  assert.equal(formatSubchatCount(1, 'pl', t), '1 zakończony subczat');
  assert.equal(formatSubchatCount(3, 'pl', t), '3 zakończone subczaty');
  assert.equal(formatSubchatCount(8, 'pl', t), '8 zakończonych subczatów');
});

/**
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
function translate(key, vars = {}) {
  const dict = {
    'sidebar.settledSubchats': 'Zakończone subczaty',
    'sidebar.subchatCount.one': '{count} zakończony subczat',
    'sidebar.subchatCount.few': '{count} zakończone subczaty',
    'sidebar.subchatCount.many': '{count} zakończonych subczatów',
    'sidebar.subchatGroupLabel': '{label} ({parent})',
    'sidebar.expandGroup': 'Rozwiń {label}',
    'sidebar.collapseGroup': 'Zwiń {label}',
    'sidebar.subchatSummary': 'Podsumowanie zakończonych subczatów: {summary}',
    'sidebar.subchatParentSummary': 'Zakończone subczaty w tym czacie: {summary}',
    'sidebar.archiveSettled': 'Archiwizuj zakończone subczaty',
  };
  let value = dict[key];
  if (value === undefined) return key;
  for (const [name, replacement] of Object.entries(vars)) {
    value = value.split(`{${name}}`).join(String(replacement));
  }
  return value;
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function subchatGroup(overrides = {}) {
  return {
    kind: SUBCHAT_GROUP_KIND,
    isGroup: true,
    id: `${SUBCHAT_GROUP_KIND}:root`,
    parentId: 'root',
    level: 1,
    isLastChild: false,
    expanded: false,
    summary: { total: 3, completed: 2, failed: 1, interrupted: 0, idle: 0 },
    children: [],
    childIds: ['a', 'b', 'c'],
    allChildIds: ['a', 'b', 'c'],
    ...overrides,
  };
}

test('a searched settled child stays reachable when its parent is filtered out', () => {
  // Search filters the workspace list first, so an orphaned child is re-rooted
  // by flattenChatsTree and must not be swallowed by a group it cannot show.
  const grouped = groupSettledChildren(tree([chat('old')]), { now: NOW, searching: true });
  assert.equal(grouped.groups.length, 0);
  assert.equal(grouped.hiddenIds.size, 0);
  assert.deepEqual(grouped.items.map((item) => item.chat.id), ['old']);
});

test('groupSettledChildren keeps a favorite descendant of a folded child visible', () => {
  const chats = [chat('root'), chat('old', 'root'), chat('fav', 'old'), chat('plain', 'old')];
  const grouped = groupSettledChildren(tree(chats), {
    now: NOW,
    isFavorite: (id) => id === 'fav',
  });
  assert.deepEqual([...grouped.hiddenIds].sort(), ['old', 'plain']);
  const group = grouped.groups[0];
  assert.deepEqual([...group.allChildIds].sort(), ['old', 'plain']);
  assert.equal(group.allChildIds.includes('fav'), false, 'a favorite child must never be archived');
  const ids = grouped.items.map((item) => (item.isGroup ? item.id : item.chat.id));
  assert.equal(ids.includes('fav'), true, 'the favorite grandchild stays reachable');
});

test('renderSubchatGroupHtml has no nested interactive controls', () => {
  const html = renderSubchatGroupHtml(subchatGroup(), {
    sidebarKey: '/ws',
    lang: 'pl',
    translate,
    escapeHtml,
    canArchive: true,
    parentTitle: 'Rodzic',
  });
  assert.equal(html.includes('role="button"'), false, 'no interactive wrapper around buttons');
  const toggleClose = html.indexOf('</button>');
  const archiveOpen = html.indexOf('sidebar-subchat-group-archive');
  assert.ok(toggleClose > -1, 'toggle button closes');
  assert.ok(archiveOpen > toggleClose, 'archive button is a sibling, not nested in the toggle');
  assert.ok(html.indexOf('sidebar-subchat-group-count') > toggleClose, 'count occupies a sibling column');
  assert.ok(html.indexOf('sidebar-subchat-group-summary') > toggleClose, 'summary occupies a sibling column');
  assert.ok(html.includes('sidebar-subchat-group-favorite-spacer'), 'favorite column stays reserved');
  assert.match(html, /<button type="button" class="sidebar-subchat-group-toggle" aria-expanded="false"/);
  assert.match(html, /class="sidebar-chat-action sidebar-subchat-group-archive"/);
  assert.equal((html.match(/<button/g) || []).length, 2, 'exactly toggle + archive buttons');
});

test('renderSubchatGroupHtml labels the toggle with its parent and escapes it', () => {
  const collapsed = renderSubchatGroupHtml(subchatGroup(), {
    sidebarKey: '/ws',
    lang: 'pl',
    translate,
    escapeHtml,
    canArchive: false,
    parentTitle: 'Rodzic <x>',
  });
  assert.ok(
    collapsed.includes('Rozwiń 3 zakończone subczaty (Rodzic &lt;x&gt;)'),
    'collapsed toggle announces the parent and the plural count',
  );
  assert.equal(collapsed.includes('Rodzic <x>'), false, 'parent title is escaped');
  assert.equal(collapsed.includes('sidebar-subchat-group-archive'), false, 'no archive button without a handler');

  const expanded = renderSubchatGroupHtml(subchatGroup({ expanded: true }), {
    sidebarKey: '/ws',
    lang: 'pl',
    translate,
    escapeHtml,
    canArchive: true,
    parentTitle: 'Rodzic',
  });
  assert.match(expanded, /aria-expanded="true"/);
  assert.ok(expanded.includes('Zwiń 3 zakończone subczaty (Rodzic)'));
  assert.ok(expanded.includes('2 ✓, 1 ✗'), 'summary stays on the group row');
});

test('formatSubchatParentBadge summarizes collapsed children only when present', () => {
  assert.equal(formatSubchatParentBadge(null, translate), null);
  assert.equal(formatSubchatParentBadge({ total: 0 }, translate), null);
  const badge = formatSubchatParentBadge(
    { total: 3, completed: 2, failed: 1, interrupted: 0, idle: 0 },
    translate,
  );
  assert.deepEqual(badge, {
    label: '2 ✓, 1 ✗',
    title: 'Zakończone subczaty w tym czacie: 2 ✓, 1 ✗',
  });
});

test('groupSettledChildren forms no group for an orphan but folds a settled branch under a present parent', () => {
  // Missing parent => flattenChatsTree re-roots the settled child to level 0. A
  // re-rooted chat has no parent bucket, so it must stay visible rather than be
  // swallowed by a group whose parent row the sidebar never renders.
  const orphan = groupSettledChildren(tree([chat('orphan', 'gone')]), { now: NOW });
  assert.equal(orphan.groups.length, 0, 'an orphaned child has no present parent to group under');
  assert.equal(orphan.hiddenIds.size, 0, 'the re-rooted child is never folded into an invisible group');
  assert.deepEqual(orphan.items.map((item) => item.chat.id), ['orphan']);

  // Present parent => the whole settled branch (child + descendants) folds into
  // one compound group whose allChildIds covers every hidden descendant.
  const nested = groupSettledChildren(
    tree([chat('root'), chat('old', 'root'), chat('old-child', 'old')]),
    { now: NOW },
  );
  assert.equal(nested.groups.length, 1);
  const group = nested.groups[0];
  assert.equal(group.parentId, 'root');
  assert.deepEqual(group.childIds, ['old'], 'only the folded direct child heads the group');
  assert.deepEqual(
    [...group.allChildIds].sort(),
    ['old', 'old-child'],
    'the compound group covers the whole settled subtree',
  );
  assert.deepEqual([...nested.hiddenIds].sort(), ['old', 'old-child']);
});
