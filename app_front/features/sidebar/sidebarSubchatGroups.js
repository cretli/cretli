/**
 * Sidebar subchat grouping: settled delegation task/review children are folded
 * under their parent so old finished subchats stop cluttering the tree.
 *
 * Everything here is pure (no DOM), so the classification rules can be unit
 * tested directly. `sidebarView.js` owns the rendering and the persisted
 * per-parent expansion state.
 */

import { hasLiveHarnessWork } from '../chat/chatStatusMeta.js';
import { MAX_SIDEBAR_NEST_INDENT } from './sidebarChatDragBlock.js';

/** A settled child is stale after 30 minutes. */
export const SETTLED_SUBCHAT_STALE_MS = 30 * 60 * 1000;
/** More than this many settled children under one parent always collapses. */
export const SETTLED_SUBCHAT_PARENT_THRESHOLD = 5;
/** A failed child stays visible for 24h after its last update. */
export const SETTLED_SUBCHAT_ERROR_VISIBLE_MS = 24 * 60 * 60 * 1000;
/**
 * Never fold a just-created child: its `_serverRunState` may not have arrived
 * yet, and hiding a live delegation is much worse than keeping one row.
 */
export const SETTLED_SUBCHAT_MIN_AGE_MS = 60 * 1000;

export const SUBCHAT_GROUP_KIND = 'subchat-group';

export const SUBCHAT_OUTCOMES = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  IDLE: 'idle',
  RUNNING: 'running',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function readId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {object | null | undefined} chat
 * @returns {string}
 */
function readChatTimestamp(chat) {
  const updated = readId(chat?.updatedAt);
  if (updated) return updated;
  return readId(chat?.createdAt);
}

/**
 * Age since `updatedAt` (fallback `createdAt`). Unknown timestamps return 0 so
 * the chat is treated as fresh and stays visible.
 *
 * @param {object | null | undefined} chat
 * @param {number} [now]
 * @returns {number}
 */
export function readChatAgeMs(chat, now = Date.now()) {
  const raw = readChatTimestamp(chat);
  if (!raw) return 0;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return 0;
  const clock = Number.isFinite(now) ? now : Date.now();
  return Math.max(0, clock - ts);
}

/**
 * Protocol delegation outcome for a subchat.
 *
 * `_serverRunState.state === 'attention'` carries `delegationStatus` from the
 * backend, which is the only place a completed/failed/interrupted result is
 * distinguishable. Everything else that is not live is treated as idle.
 *
 * @param {object | null | undefined} chat
 * @returns {'completed' | 'failed' | 'interrupted' | 'idle' | 'running'}
 */
export function readSubchatOutcome(chat) {
  if (!chat || typeof chat !== 'object') return SUBCHAT_OUTCOMES.IDLE;
  const server = chat._serverRunState;
  if (server && typeof server === 'object') {
    const state = readId(server.state);
    if (state === 'attention') {
      const status = readId(server.delegationStatus) || SUBCHAT_OUTCOMES.COMPLETED;
      if (status === SUBCHAT_OUTCOMES.FAILED) return SUBCHAT_OUTCOMES.FAILED;
      if (status === SUBCHAT_OUTCOMES.INTERRUPTED) return SUBCHAT_OUTCOMES.INTERRUPTED;
      return SUBCHAT_OUTCOMES.COMPLETED;
    }
    if (state === 'busy' || state === 'waiting') return SUBCHAT_OUTCOMES.RUNNING;
  }
  if (hasLiveHarnessWork(chat)) return SUBCHAT_OUTCOMES.RUNNING;
  return SUBCHAT_OUTCOMES.IDLE;
}

/**
 * @typedef {{
 *   settled: boolean,
 *   outcome: string,
 *   ageMs: number,
 *   stale: boolean,
 *   alwaysVisibleReason: string,
 * }} SubchatClassification
 */

/**
 * @param {object | null | undefined} chat
 * @param {{
 *   now?: number,
 *   activeChatId?: string,
 *   isFavorite?: (id: string) => boolean,
 *   isUnread?: (chat: object) => boolean,
 *   hasLiveDescendant?: boolean,
 * }} [context]
 * @returns {SubchatClassification}
 */
export function classifySubchat(chat, context = {}) {
  const id = readId(chat?.id);
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const outcome = readSubchatOutcome(chat);
  const ageMs = readChatAgeMs(chat, now);
  const isFavorite = typeof context.isFavorite === 'function' ? context.isFavorite : () => false;
  const isUnread = typeof context.isUnread === 'function' ? context.isUnread : () => false;

  let alwaysVisibleReason = '';
  if (!id) alwaysVisibleReason = 'missing-id';
  else if (readId(context.activeChatId) && readId(context.activeChatId) === id) alwaysVisibleReason = 'active';
  else if (isFavorite(id)) alwaysVisibleReason = 'favorite';
  else if (isUnread(chat)) alwaysVisibleReason = 'unread';
  else if (context.hasLiveDescendant === true) alwaysVisibleReason = 'live-descendant';
  else if (outcome === SUBCHAT_OUTCOMES.RUNNING) alwaysVisibleReason = 'running';
  else if (outcome === SUBCHAT_OUTCOMES.FAILED && ageMs <= SETTLED_SUBCHAT_ERROR_VISIBLE_MS) {
    alwaysVisibleReason = 'fresh-error';
  }

  return {
    settled: !alwaysVisibleReason,
    outcome,
    ageMs,
    stale: ageMs > SETTLED_SUBCHAT_STALE_MS,
    alwaysVisibleReason,
  };
}

/**
 * @param {object[] | null | undefined} chats
 * @returns {{ total: number, completed: number, failed: number, interrupted: number, idle: number }}
 */
export function summarizeGroup(chats) {
  const summary = { total: 0, completed: 0, failed: 0, interrupted: 0, idle: 0 };
  const list = Array.isArray(chats) ? chats : [];
  for (const chat of list) {
    if (!chat || typeof chat !== 'object') continue;
    summary.total += 1;
    const outcome = readSubchatOutcome(chat);
    if (outcome === SUBCHAT_OUTCOMES.FAILED) summary.failed += 1;
    else if (outcome === SUBCHAT_OUTCOMES.INTERRUPTED) summary.interrupted += 1;
    else if (outcome === SUBCHAT_OUTCOMES.IDLE) summary.idle += 1;
    else summary.completed += 1;
  }
  return summary;
}

/**
 * Return connector levels for ancestor branches that continue past this row.
 * The sidebar renders a flat list, so nested rows need explicit continuation
 * marks for non-last ancestors (their parent rows cannot draw across siblings).
 *
 * @param {{ parentId?: string } | null | undefined} item
 * @param {{ chat?: { id?: string }, parentId?: string, level?: number, isLastChild?: boolean }[]} treeItems
 * @returns {number[]}
 */
export function getAncestorContinuationLevels(item, treeItems) {
  const byId = new Map();
  for (const treeItem of Array.isArray(treeItems) ? treeItems : []) {
    const id = readId(treeItem?.chat?.id);
    if (id) byId.set(id, treeItem);
  }
  const levels = [];
  let parent = byId.get(readId(item?.parentId));
  const seen = new Set();
  while (parent) {
    const id = readId(parent?.chat?.id);
    if (!id || seen.has(id)) break;
    seen.add(id);
    const level = Number(parent.level) || 0;
    if (level > 0 && parent.isLastChild !== true) levels.push(level);
    parent = byId.get(readId(parent.parentId));
  }
  return levels;
}

/** @param {number[]} levels */
export function renderTreeContinuationHtml(levels) {
  return (Array.isArray(levels) ? levels : [])
    .map((level) => Math.min(MAX_SIDEBAR_NEST_INDENT, Math.max(1, Number(level) || 1)))
    .map((level) => '<span class="sidebar-tree-continuation" aria-hidden="true" style="--sidebar-continuation-level:' + String(level) + '"></span>')
    .join('');
}

/**
 * Compact glyph summary shown on the collapsed group header, e.g. `7 ✓, 1 ✗`.
 *
 * @param {{ completed?: number, idle?: number, failed?: number, interrupted?: number }} summary
 * @returns {string}
 */
export function formatSubchatSummary(summary) {
  const parts = [];
  const ok = Math.max(0, Number(summary?.completed) || 0) + Math.max(0, Number(summary?.idle) || 0);
  const failed = Math.max(0, Number(summary?.failed) || 0);
  const interrupted = Math.max(0, Number(summary?.interrupted) || 0);
  if (ok) parts.push(ok + ' ✓');
  if (failed) parts.push(failed + ' ✗');
  if (interrupted) parts.push(interrupted + ' ⏸');
  return parts.join(', ');
}

/**
 * @param {number} count
 * @param {string} lang
 * @returns {'one' | 'few' | 'many' | 'other'}
 */
export function resolvePluralCategory(count, lang = 'en') {
  const n = Math.abs(Math.trunc(Number(count) || 0));
  if (String(lang).toLowerCase().startsWith('pl')) {
    if (n === 1) return 'one';
    if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return 'few';
    return 'many';
  }
  return n === 1 ? 'one' : 'other';
}

/**
 * Pluralized "{count} settled subchat(s)". Uses `sidebar.subchatCount.*` keys.
 *
 * @param {number} count
 * @param {string} lang
 * @param {(key: string, vars?: Record<string, string|number>) => string} translate
 * @returns {string}
 */
export function formatSubchatCount(count, lang, translate) {
  const tFn = typeof translate === 'function' ? translate : (key) => key;
  const category = resolvePluralCategory(count, lang);
  const value = String(Math.max(0, Math.trunc(Number(count) || 0)));
  const key = `sidebar.subchatCount.${category}`;
  const label = tFn(key, { count: value });
  if (label === key) return tFn('sidebar.subchatCount.other', { count: value });
  return label;
}

/**
 * @typedef {{
 *   kind: 'subchat-group',
 *   isGroup: true,
 *   id: string,
 *   parentId: string,
 *   level: number,
 *   isLastChild: boolean,
 *   expanded: boolean,
 *   summary: { total: number, completed: number, failed: number, interrupted: number, idle: number },
 *   children: object[],
 *   childIds: string[],
 *   allChildIds: string[],
 * }} SubchatGroupNode
 *
 * `childIds` are the folded direct children. `allChildIds` is the whole settled
 * subtree hidden (and archived) by this group.
 */

/**
 * Fold settled children of each parent into a single group node.
 *
 * Call this on `flattenChatsTree(...)` output *before*
 * `capSidebarVisibleTreeChats` so hidden rows never consume the visible cap.
 *
 * @param {{ chat: object, level: number, parentId: string, isLastChild: boolean }[]} treeItems
 * @param {{
 *   now?: number,
 *   activeChatId?: string,
 *   searching?: boolean,
 *   isFavorite?: (id: string) => boolean,
 *   isUnread?: (chat: object) => boolean,
 *   isExpanded?: (parentId: string) => boolean,
 * }} [options]
 * @returns {{
 *   items: object[],
 *   groups: SubchatGroupNode[],
 *   hiddenIds: Set<string>,
 *   summaries: Map<string, object>,
 *   settledCountByParent: Map<string, number>,
 * }}
 */
export function groupSettledChildren(treeItems, options = {}) {
  const list = Array.isArray(treeItems) ? treeItems : [];
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const activeChatId = readId(options.activeChatId);
  const searching = options.searching === true;
  const isExpanded = typeof options.isExpanded === 'function' ? options.isExpanded : () => false;

  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const item of list) {
    const id = readId(item?.chat?.id);
    if (id) byId.set(id, item);
  }

  // Chats that must stay visible: the active chat, plus every ancestor of the
  // active chat or of a live chat (a settled chat with a live descendant).
  /** @type {Set<string>} */
  const protectedChatIds = new Set();
  // Only the active chat's ancestors force a group open. A live descendant
  // protects its ancestors from folding but must not expand unrelated groups.
  /** @type {Set<string>} */
  const activeAncestorIds = new Set();
  const markAncestors = (startParentId, target) => {
    let parentId = readId(startParentId);
    const seen = new Set();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      target.add(parentId);
      parentId = readId(byId.get(parentId)?.parentId);
    }
  };
  if (activeChatId) {
    protectedChatIds.add(activeChatId);
    markAncestors(byId.get(activeChatId)?.parentId, protectedChatIds);
    markAncestors(byId.get(activeChatId)?.parentId, activeAncestorIds);
  }
  for (const item of list) {
    const id = readId(item?.chat?.id);
    if (!id || id === activeChatId) continue;
    if (readSubchatOutcome(item.chat) === SUBCHAT_OUTCOMES.RUNNING) {
      markAncestors(item?.parentId, protectedChatIds);
    }
  }

  /** @type {Map<string, object[]>} */
  const childrenByParent = new Map();
  for (const item of list) {
    const parentId = readId(item?.parentId);
    const id = readId(item?.chat?.id);
    if (!parentId || !id) continue;
    const bucket = childrenByParent.get(parentId) || [];
    bucket.push(item);
    childrenByParent.set(parentId, bucket);
  }

  /** @type {Map<string, SubchatClassification>} */
  const classifications = new Map();
  /** @type {Map<string, number>} */
  const settledCountByParent = new Map();
  for (const item of list) {
    const id = readId(item?.chat?.id);
    if (!id) continue;
    const classification = classifySubchat(item.chat, {
      now,
      activeChatId,
      isFavorite: options.isFavorite,
      isUnread: options.isUnread,
      hasLiveDescendant: protectedChatIds.has(id),
    });
    classifications.set(id, classification);
    const parentId = readId(item?.parentId);
    if (parentId && classification.settled) {
      settledCountByParent.set(parentId, (settledCountByParent.get(parentId) || 0) + 1);
    }
  }

  /**
   * Whole settled subtree under one folded child: the child itself plus every
   * descendant reachable through settled parents only. A favorite/unread/active
   * descendant (or one with live work) keeps its own row and is never folded nor
   * archived, so folding a finished branch cannot hide or archive a chat the
   * user still cares about.
   *
   * @param {string} rootId
   * @returns {Set<string>}
   */
  const settledSubtreeOf = (rootId) => {
    const out = new Set();
    const stack = [rootId];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      out.add(current);
      for (const child of childrenByParent.get(current) || []) {
        const childId = readId(child?.chat?.id);
        if (!childId || seen.has(childId)) continue;
        if (classifications.get(childId)?.settled === true) stack.push(childId);
      }
    }
    return out;
  };

  /** @type {Map<string, SubchatGroupNode>} */
  const groupByParent = new Map();
  /** @type {SubchatGroupNode[]} */
  const groups = [];
  /** @type {Map<string, object>} */
  const summaries = new Map();
  /** @type {Set<string>} */
  const suppressedIds = new Set();

  for (const [parentId, bucket] of childrenByParent) {
    const settled = bucket.filter((item) => {
      const classification = classifications.get(readId(item?.chat?.id));
      return classification?.settled === true;
    });
    if (!settled.length) continue;
    const useThreshold = settled.length > SETTLED_SUBCHAT_PARENT_THRESHOLD;
    const grouped = settled.filter((item) => {
      const classification = classifications.get(readId(item?.chat?.id));
      if (!classification) return false;
      if (classification.ageMs <= SETTLED_SUBCHAT_MIN_AGE_MS) return false;
      return useThreshold || classification.stale === true;
    });
    if (!grouped.length) continue;

    const parentItem = byId.get(parentId);
    const rawParentLevel = Number(parentItem?.level);
    const parentLevel = Number.isFinite(rawParentLevel) && rawParentLevel >= 0 ? rawParentLevel : 0;
    const expanded = searching || isExpanded(parentId) || activeAncestorIds.has(parentId);
    const childChats = grouped.map((item) => item.chat);
    const allChildIds = new Set();
    for (const item of grouped) {
      const childId = readId(item?.chat?.id);
      if (childId) allChildIds.add(childId);
      for (const descendantId of settledSubtreeOf(childId)) allChildIds.add(descendantId);
    }
    /** @type {SubchatGroupNode} */
    const group = {
      kind: SUBCHAT_GROUP_KIND,
      isGroup: true,
      id: `${SUBCHAT_GROUP_KIND}:${parentId}`,
      parentId,
      level: parentLevel + 1,
      isLastChild: false,
      expanded,
      summary: summarizeGroup(childChats),
      children: childChats,
      childIds: grouped.map((item) => readId(item?.chat?.id)).filter(Boolean),
      allChildIds: [...allChildIds],
    };
    groupByParent.set(parentId, group);
    groups.push(group);
    summaries.set(parentId, group.summary);
    if (!expanded) {
      for (const id of allChildIds) suppressedIds.add(id);
    }
  }

  const items = [];
  for (const item of list) {
    const id = readId(item?.chat?.id);
    if (!id) {
      items.push(item);
      continue;
    }
    if (suppressedIds.has(id)) continue;
    items.push(item);
    const group = groupByParent.get(id);
    if (group) items.push(group);
  }

  const lastVisibleChildByParent = new Map();
  for (const node of items) {
    const parentId = readId(node?.parentId);
    const id = node?.isGroup ? readId(node?.id) : readId(node?.chat?.id);
    if (parentId && id) lastVisibleChildByParent.set(parentId, node);
  }
  const normalized = items.map((node) => {
    const parentId = readId(node?.parentId);
    const level = Number(node?.level) || 0;
    const isLastChild = level > 0 && parentId
      ? lastVisibleChildByParent.get(parentId) === node
      : false;
    return { ...node, isLastChild };
  });

  return {
    items: normalized,
    groups: normalized.filter((node) => node?.isGroup),
    hiddenIds: suppressedIds,
    summaries,
    settledCountByParent,
  };
}

/**
 * Markup for one collapsed/expanded "settled subchats" row.
 *
 * The row is split into two sibling controls: a real `<button>` that toggles the
 * group and a real `<button>` that archives it. There is intentionally no
 * interactive wrapper (no `role="button"` around a nested button), so the
 * archive action stays in the accessibility tree and Enter/Space on it does not
 * also toggle the group.
 *
 * @param {SubchatGroupNode | null | undefined} group
 * @param {{
 *   sidebarKey?: string,
 *   lang?: string,
 *   translate?: (key: string, vars?: Record<string, string|number>) => string,
 *   escapeHtml?: (value: unknown) => string,
 *   canArchive?: boolean,
 *   parentTitle?: string,
 * }} [options]
 * @returns {string}
 */
export function renderSubchatGroupHtml(group, options = {}) {
  const escape = typeof options.escapeHtml === 'function'
    ? options.escapeHtml
    : (value) => String(value ?? '');
  const translate = typeof options.translate === 'function' ? options.translate : (key) => key;
  const lang = options.lang || 'en';
  const sidebarKey = String(options.sidebarKey || '');
  const expanded = group?.expanded === true;
  const parentId = String(group?.parentId || '');
  const count = Number(group?.summary?.total)
    || (Array.isArray(group?.childIds) ? group.childIds.length : 0);
  const summaryLabel = formatSubchatSummary(group?.summary);
  const parentTitle = String(options.parentTitle || '').trim();
  const countLabel = formatSubchatCount(count, lang, translate);
  const labelledCount = parentTitle
    ? translate('sidebar.subchatGroupLabel', { label: countLabel, parent: parentTitle })
    : countLabel;
  const toggleLabel = expanded
    ? translate('sidebar.collapseGroup', { label: labelledCount })
    : translate('sidebar.expandGroup', { label: labelledCount });
  const summaryTitle = summaryLabel
    ? translate('sidebar.subchatSummary', { summary: summaryLabel })
    : '';
  const canArchive = options.canArchive === true && (group?.allChildIds?.length || 0) > 0;
  const indentLevel = Math.min(
    MAX_SIDEBAR_NEST_INDENT,
    Math.max(1, Number(group?.level) || 1),
  );
  const continuationHtml = renderTreeContinuationHtml(options.continuationLevels);
  return (
    '<li class="sidebar-subchat-group' +
    (options.canPin === true ? ' has-pin-actions' : '') +
    (expanded ? ' is-expanded' : '') +
    (group?.isLastChild === true ? ' is-last-child' : '') +
    '" data-sidebar-key="' +
    escape(sidebarKey) +
    '" data-subchat-group="1" data-parent-id="' +
    escape(parentId) +
    '" data-group-summary="' +
    escape(summaryLabel) +
    '" style="--sidebar-nest-level:' +
    String(indentLevel) +
    '">' +
    continuationHtml +
    '<div class="sidebar-subchat-group-header">' +
    '<button type="button" class="sidebar-subchat-group-toggle" aria-expanded="' +
    (expanded ? 'true' : 'false') +
    '" aria-label="' +
    escape(toggleLabel) +
    (summaryTitle ? '" aria-description="' + escape(summaryTitle) : '') +
    '" title="' +
    escape(toggleLabel) +
    '" data-parent-id="' +
    escape(parentId) +
    '">' +
    '<span class="sidebar-subchat-group-chevron mdi mdi-chevron-' +
    (expanded ? 'down' : 'right') +
    '" aria-hidden="true"></span>' +
    '<span class="mdi mdi-check-circle-outline sidebar-subchat-group-icon" aria-hidden="true"></span>' +
    '<span class="sidebar-subchat-group-title">' +
    escape(translate('sidebar.settledSubchats')) +
    '</span>' +
    '</button>' +
    '<span class="sidebar-subchat-group-count" aria-hidden="true">' +
    String(count) +
    '</span>' +
    (summaryLabel
      ? '<span class="sidebar-subchat-group-summary" aria-hidden="true" title="' +
        escape(summaryTitle) +
        '">' +
        escape(summaryLabel) +
        '</span>'
      : '') +
    '<span class="sidebar-subchat-group-pin-spacer" aria-hidden="true"></span>' +
    (canArchive
      ? '<button type="button" class="sidebar-chat-action sidebar-subchat-group-archive" title="' +
        escape(translate('sidebar.archiveSettled')) +
        '" aria-label="' +
        escape(translate('sidebar.archiveSettled')) +
        '" data-parent-id="' +
        escape(parentId) +
        '">' +
        '<span class="mdi mdi-archive-arrow-down-outline" aria-hidden="true"></span>' +
        '</button>'
      : '') +
    '<span class="sidebar-subchat-group-favorite-spacer" aria-hidden="true"></span>' +
    '</div>' +
    '</li>'
  );
}

/**
 * Compact summary badge shown on the parent row while its settled-subchat group
 * is collapsed. `{ label, title }` or `null` when there is nothing collapsed.
 *
 * @param {{ total?: number, completed?: number, failed?: number, interrupted?: number, idle?: number } | null | undefined} summary
 * @param {(key: string, vars?: Record<string, string|number>) => string} translate
 * @returns {{ label: string, title: string } | null}
 */
export function formatSubchatParentBadge(summary, translate) {
  const total = Math.max(0, Math.trunc(Number(summary?.total) || 0));
  if (!total) return null;
  const label = formatSubchatSummary(summary) || String(total);
  const tFn = typeof translate === 'function' ? translate : (key) => key;
  return {
    label,
    title: tFn('sidebar.subchatParentSummary', { summary: label }),
  };
}
