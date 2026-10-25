import { getChatsList, getTerminalStateMetaPublic } from '../../chat/index.js';
import { resolveTodoStatusIcon, isTodoReviewedButOpen } from '../todoStatusIcon.js';
import { hasApprovedAncestorPlan } from '../state/todoStage.js';
import {
  isTodoAwaitingIntegration,
  isTodoIntegrationBlockedByReview,
} from '../../../../lib/todo-integration-state.js';
import { getCurrentLang, t } from '../../../i18n/index.js';
import {
  canAddTodoChild,
  formatTodoAssigneeBadge,
  isBatchSelectableItem,
  readTodoRowMark,
  readTodoRowBlockKind,
  isTodoDeferredOverdue,
} from '../todoTreeView.js';
import { findBatchEntryForTodo } from '../todoBatchSelection.js';
import {
  paintTodoStatusIcon,
  paintTodoReviewBadge,
  paintTodoStageStepper,
  paintTodoRowClose,
  setTextIfChanged,
  setIfChanged,
} from './todoRowPaint.js';
import { isWatcherAutopilot } from '../../watcher/watcherPanel.js';
import { formatTodoMetaText } from '../services/todoCardActions.js';
import { buildTodoTreeRows, getVisibleTodoItems } from '../services/todoPanelContext.js';
import { S, paintedRowSignatures, todoList } from '../state/todoPanelState.js';
import { batchReasonText, setBatchControlVisible } from './todoBatchView.js';

/**
 * @param {HTMLElement} el
 * @param {{ item: object, level: number, hasChildren: boolean, collapsed: boolean }} row
 */
/** Re-paint queued/claimed badges after the watcher view changes without a full list fetch. */
export function repaintTodoRowBadges() {
  if (!S.listEl || !S.latestItems.length) return;
  const visibleItems = getVisibleTodoItems();
  if (!visibleItems.length) return;
  const rows = buildTodoTreeRows(visibleItems);
  const wrapEl = S.listEl.querySelector('.todo-rows');
  if (!wrapEl) return;
  const byId = new Map(rows.map((row) => [String(row.item.id), row]));
  wrapEl.querySelectorAll('.todo-row').forEach((el) => {
    const row = byId.get(String(el.dataset.id || ''));
    if (row) paintTodoRow(el, row);
  });
}

/**
 * Row checkbox: visible only in selection mode and only on eligible rows. The
 * server's `batchEligibility.mode` decides eligibility, never the client.
 *
 * @param {HTMLElement} el
 * @param {object} item
 */
export function paintTodoRowSelection(el, item) {
  const box = el.querySelector('.todo-row-select');
  if (!(box instanceof HTMLElement)) return;
  const selectable = isBatchSelectableItem(item);
  const visible = S.batchSelectionMode && selectable;
  // cr-checkbox `:host { display: inline-flex }` beats the UA `[hidden]` rule.
  setBatchControlVisible(box, visible);
  el.dataset.batchSelectable = selectable ? 'true' : 'false';
  const selected = visible && todoList.batchSelected.get().has(String(item.id || ''));
  el.dataset.batchSelected = selected ? 'true' : 'false';
  if ('checked' in box && box.checked !== selected) box.checked = selected;
  if (visible) {
    const label = t('todo.batchSelectRow', { title: String(item.title || '') });
    box.setAttribute('aria-label', label);
    box.title = label;
  }
}

/**
 * Per-row badge mirroring the batch entry state (`queued`, `running`,
 * `awaiting_confirmation`, `merged`, `verified`, `failed`, `skipped`, `cancelled`).
 * The banner stays the place for reasons and actions.
 *
 * @param {HTMLElement} el
 * @param {object} item
 */
export function paintTodoRowBatchBadge(el, item) {
  const badge = el.querySelector('.todo-row-batch-badge');
  if (!(badge instanceof HTMLElement)) return;
  const entry = S.activeBatch ? findBatchEntryForTodo(S.activeBatch, item?.id) : null;
  if (!entry) {
    badge.hidden = true;
    badge.textContent = '';
    badge.removeAttribute('data-batch-state');
    badge.removeAttribute('title');
    return;
  }
  const label = t(`todo.batchEntryState_${entry.state}`);
  badge.hidden = false;
  badge.textContent = label;
  badge.dataset.batchState = String(entry.state || '');
  const reason = entry.reason ? batchReasonText(entry.reason, 'entry') : '';
  const detail = reason ? `${label} · ${reason}` : label;
  badge.title = detail;
  badge.setAttribute('aria-label', detail);
}

/**
 * Signature of everything `paintTodoRow` reads for one row: the item itself, the
 * tree position and the values it derives from other rows or global state
 * (marks, status icon, selection, batch entry, language, viewport). Equal
 * signatures mean a repaint would write identical DOM, so it is skipped.
 *
 * @param {{ item: Record<string, any>, level: number, hasChildren?: boolean, collapsed?: boolean }} row
 * @returns {string}
 */
export function computeTodoRowSignature(row) {
  const item = row.item;
  const status = String(item.status || 'idea');
  const icon = resolveTodoStatusIcon(item, S.latestItems, getChatsList(), getTerminalStateMetaPublic);
  const reviewedOpen = !row.hasChildren && isTodoReviewedButOpen(item, S.latestItems);
  const markKind = reviewedOpen || status === 'done' || status === 'deferred' ? '' : readTodoRowMark(S.latestItems, item);
  const blockKind = markKind === 'blocked' ? readTodoRowBlockKind(S.latestItems, item) : '';
  const batchEntry = S.activeBatch ? findBatchEntryForTodo(S.activeBatch, item.id) : null;
  const narrow = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 640px)').matches;
  const selected = S.batchSelectionMode && isBatchSelectableItem(item) && todoList.batchSelected.get().has(String(item.id || ''));
  return JSON.stringify([
    item,
    row.level, !!row.hasChildren, !!row.collapsed,
    icon.icon, icon.spinning, icon.labelKey, icon.title,
    reviewedOpen, markKind, blockKind,
    status === 'deferred' && isTodoDeferredOverdue(item),
    canAddTodoChild(S.latestItems, String(item.id || '')),
    hasApprovedAncestorPlan(S.latestItems, item),
    formatTodoMetaText(item),
    isWatcherAutopilot(),
    S.batchSelectionMode, isBatchSelectableItem(item), selected,
    batchEntry ? [batchEntry.state, batchEntry.reason] : null,
    getCurrentLang(), narrow,
  ]);
}

/** Repaint a row only when its signature changed. */
export function paintTodoRowIfChanged(el, row) {
  const signature = computeTodoRowSignature(row);
  if (paintedRowSignatures.get(el) === signature) return false;
  paintTodoRow(el, row);
  paintedRowSignatures.set(el, signature);
  return true;
}

export function paintTodoRow(el, row) {
  const id = String(row.item.id || '');
  const status = String(row.item.status || 'idea');
  // Every write below is skipped when the value is unchanged: a full-list repaint
  // otherwise restyles and re-lays-out hundreds of rows for no visible change.
  setIfChanged(el, 'id', id);
  setIfChanged(el, 'status', status);
  const className = `todo-row todo-row--${status}`;
  if (el.className !== className) el.className = className;
  const levelText = String(row.level);
  if (el.style.getPropertyValue('--todo-level') !== levelText) el.style.setProperty('--todo-level', levelText);
  setIfChanged(el, 'level', levelText);
  if (el.getAttribute('aria-level') !== String(row.level + 1)) el.setAttribute('aria-level', String(row.level + 1));
  const toggle = el.querySelector('.todo-row-toggle');
  const title = el.querySelector('.todo-row-title');
  const worktreeBadge = el.querySelector('.todo-row-worktree-badge');
  const meta = el.querySelector('.todo-row-meta');
  const badge = el.querySelector('.todo-row-badge');
  const mark = el.querySelector('.todo-row-mark');
  const grip = el.querySelector('.todo-row-grip');
  const add = el.querySelector('.todo-row-add');
  const menu = el.querySelector('.todo-row-menu');
  const main = el.querySelector('.todo-row-main');
  paintTodoStatusIcon(el, row.item, S.latestItems);
  paintTodoReviewBadge(el, row, S.latestItems);
  paintTodoRowSelection(el, row.item);
  paintTodoRowBatchBadge(el, row.item);
  if (worktreeBadge instanceof HTMLElement) {
    const usesWorktree = row.item?.executionMode === 'worktree' || row.item?.worktree?.live === true;
    worktreeBadge.hidden = !usesWorktree;
    worktreeBadge.title = t('sidebar.worktreeTitle');
    worktreeBadge.setAttribute('aria-label', t('sidebar.worktreeTitle'));
  }
  if (title) setTextIfChanged(title, String(row.item.title || ''));
  if (grip instanceof HTMLElement) grip.setAttribute('aria-label', t('todo.dragHandle'));
  if (main instanceof HTMLElement) main.setAttribute('aria-label', t('todo.editTask'));
  if (menu instanceof HTMLElement) {
    menu.setAttribute('aria-label', t('todo.rowMenu'));
    menu.title = t('todo.rowMenu');
  }
  paintTodoStageStepper(el, row.item, S.latestItems);
  const metaText = formatTodoMetaText(row.item);
  if (meta instanceof HTMLElement) {
    meta.hidden = !metaText;
    setTextIfChanged(meta, metaText);
  }
  if (toggle instanceof HTMLButtonElement) {
    toggle.hidden = !row.hasChildren;
    toggle.textContent = '';
    const icon = document.createElement('span');
    icon.className = `mdi ${row.collapsed ? 'mdi-chevron-right' : 'mdi-chevron-down'}`;
    icon.setAttribute('aria-hidden', 'true');
    toggle.appendChild(icon);
    toggle.setAttribute('aria-label', row.collapsed ? t('todo.expand') : t('todo.collapse'));
    if (row.hasChildren) el.setAttribute('aria-expanded', row.collapsed ? 'false' : 'true');
    else el.removeAttribute('aria-expanded');
  }
  const claimedBy = String(row.item?.claimedByChatId || '').trim();
  const isClaimed = !!claimedBy;
  const isQueued = !isClaimed && status === 'ready' && isWatcherAutopilot();
  const isIntegrationReady = isTodoAwaitingIntegration(row.item);
  const isIntegrationReviewBlocked = isTodoIntegrationBlockedByReview(row.item);
  // Applied to the working directory; target-branch proof is still required.
  const isIntegrationApplied = isIntegrationReady && !!String(row.item?.integration?.appliedAt || '').trim();
  const isSmartMerging = isIntegrationReady && String(row.item?.integration?.reason || '') === 'smart_merge_running';
  const integrationLabel = isSmartMerging
    ? t('todo.smartMergeRunningBadge')
    : isIntegrationApplied
      ? t('todo.integrationAppliedBadge')
      : isIntegrationReviewBlocked ? t('todo.integrationReviewFailed') : t('todo.integrationReady');
  const showIntegrationReviewFailed = isIntegrationReviewBlocked && !isSmartMerging && !isIntegrationApplied;
  const assigneeBadge = formatTodoAssigneeBadge(row.item);
  let badgeFull = '';
  let badgeKind = '';
  if (isIntegrationReady) {
    badgeFull = integrationLabel;
    badgeKind = 'integration';
  } else if (isClaimed) {
    badgeFull = t('todo.claimedBy', { chat: claimedBy.slice(0, 8) });
    badgeKind = 'claimed';
  } else if (isQueued) {
    badgeFull = t('todo.queued');
    badgeKind = 'queued';
  } else {
    badgeFull = assigneeBadge;
  }
  if (badge instanceof HTMLElement) {
    const narrow = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 640px)').matches;
    const badgeText = narrow && !isClaimed && !isQueued && !isIntegrationReady
      ? String(row.item?.assignee?.harness || '').trim()
      : badgeFull;
    // The integration label is already shown by the row mark; do not repeat it.
    badge.hidden = !badgeText || isIntegrationReady;
    badge.textContent = badgeText;
    badge.dataset.kind = badgeKind;
    if (isClaimed) badge.title = t('todo.claimedBy', { chat: claimedBy });
    else if (badgeFull) badge.title = badgeFull;
    else badge.removeAttribute('title');
  }
  const isReviewedOpen = !row.hasChildren && isTodoReviewedButOpen(row.item, S.latestItems);
  paintTodoRowClose(el, row.item, isReviewedOpen);
  // Finished work is not "ready to start" nor "waiting on a dependency".
  // Deferred work is neither ready nor blocked; it only flags a passed revisit date.
  /** @type {string} */
  let markKind = isReviewedOpen || status === 'done' || status === 'deferred' ? '' : readTodoRowMark(S.latestItems, row.item);
  if (status === 'deferred' && isTodoDeferredOverdue(row.item)) markKind = 'overdue';
  if (isIntegrationReady) markKind = 'integration';
  if (mark instanceof HTMLElement) {
    mark.hidden = !markKind;
    const blockKind = markKind === 'blocked' ? readTodoRowBlockKind(S.latestItems, row.item) : '';
    mark.textContent = markKind === 'integration'
      ? integrationLabel
      : markKind === 'overdue'
        ? t('todo.deferredOverdue')
        : blockKind === 'action'
        ? t('todo.blockedAction')
        : blockKind === 'dependency'
          ? t('todo.blockedDependency')
          : markKind === 'blocked' ? t('todo.blocked') : t('todo.ready');
    mark.dataset.mark = markKind === 'integration'
      ? (showIntegrationReviewFailed ? 'review-failed' : 'integration')
      : (blockKind ? `blocked-${blockKind}` : markKind);
    // Narrow rows show blocked marks as an icon; the text stays in aria-label/title.
    const iconOnly = (markKind === 'blocked' || markKind === 'integration') && typeof window !== 'undefined'
      && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
    mark.dataset.label = mark.textContent;
    if (iconOnly) {
      mark.setAttribute('data-icon-only', '');
      mark.textContent = '';
      const markIcon = document.createElement('span');
      markIcon.className = `mdi ${markKind === 'integration' && !showIntegrationReviewFailed ? 'mdi-source-merge' : blockKind === 'dependency' ? 'mdi-timer-sand' : 'mdi-alert-circle-outline'}`;
      markIcon.setAttribute('aria-hidden', 'true');
      mark.appendChild(markIcon);
    } else {
      mark.removeAttribute('data-icon-only');
    }
    const blockedReason = String(row.item?.blockedReason || '').trim();
    const blockDetail = markKind === 'integration'
      ? (isSmartMerging
        ? t('todo.smartMergeRunningHint')
        : isIntegrationApplied
          ? t('todo.integrationWorkingDirectoryHint')
          : isIntegrationReviewBlocked ? t('todo.integrationReviewFailedHint') : t('todo.integrationReadyHint'))
      : blockKind === 'action'
        ? blockedReason
        : blockKind === 'dependency' ? t('todo.blockedDependencyHint') : '';
    if (blockDetail) {
      mark.title = blockDetail;
      mark.setAttribute('aria-label', `${mark.dataset.label}: ${blockDetail}`);
    } else if (iconOnly) {
      mark.title = String(mark.dataset.label || '');
      mark.setAttribute('aria-label', String(mark.dataset.label || ''));
    } else {
      mark.removeAttribute('title');
      mark.removeAttribute('aria-label');
    }
  }
  if (add instanceof HTMLButtonElement) {
    const allowed = canAddTodoChild(S.latestItems, id);
    add.disabled = !allowed;
    add.setAttribute('aria-label', t('todo.addChild'));
    add.title = allowed ? t('todo.addChild') : t('todo.depthLimit');
  }
}
