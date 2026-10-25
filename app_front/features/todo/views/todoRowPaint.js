import { t } from '../../../i18n/index.js';
import { getChatsList, getTerminalStateMetaPublic } from '../../chat/index.js';
import { resolveTodoStatusIcon, isTodoReviewedButOpen } from '../todoStatusIcon.js';
import { hasApprovedAncestorPlan } from '../state/todoStage.js';
import { resolveAggregateReviewBadge, shouldShowLeafReviewBadge } from '../todoReviewBadge.js';
import { createTodoStageStepperEl, buildTodoStageView } from '../todoStageView.js';

/** Update only the icon so live events preserve row controls and animation. */
export function paintTodoStatusIcon(el, item, allItems) {
  const statusIcon = resolveTodoStatusIcon(item, allItems, getChatsList(), getTerminalStateMetaPublic);
  const iconEl = el.querySelector('.todo-item-status-icon');
  if (iconEl) {
    const iconClass = `todo-item-status-icon mdi ${statusIcon.icon}${statusIcon.spinning ? ' mdi-spin' : ''}`;
    if (iconEl.className !== iconClass) iconEl.className = iconClass;
    iconEl.title = t(statusIcon.labelKey, { title: statusIcon.title });
  }
}

/**
 * Paint the review badge of one row. The element never changes the row height:
 * it is a single nowrap flex item with an ellipsis cap, and below 640px the
 * component collapses to the icon in CSS (the label stays in `title` /
 * `aria-label`).
 */
export function paintTodoReviewBadge(el, row, allItems) {
  const badge = el.querySelector('.todo-row-review');
  if (!(badge instanceof HTMLElement)) return;
  // A reviewed-but-open leaf shows the "Close" action instead: the PASS is
  // already implied by its status icon.
  const show = row.hasChildren
    ? !!resolveAggregateReviewBadge(row.item?.review)
    : shouldShowLeafReviewBadge(row.item) && !isTodoReviewedButOpen(row.item, allItems);
  badge.hidden = !show;
  if (!show) return;
  // Property assignment only: Lit diffs the object, so an identical snapshot
  // re-renders nothing and a live refresh does not flicker rows.
  const reviewBadge = /** @type {any} */ (badge);
  if (reviewBadge.item !== row.item) reviewBadge.item = row.item;
  if (reviewBadge.hasChildren !== !!row.hasChildren) reviewBadge.hasChildren = !!row.hasChildren;
}

/**
 * Repaints the stage stepper only when its derived view changed, so a live
 * refresh of hundreds of rows does not rebuild identical DOM.
 * @param {HTMLElement} el
 * @param {object} item
 * @param {object[]} allItems
 */
export function paintTodoStageStepper(el, item, allItems) {
  const host = el.querySelector('.todo-row-stage-host');
  if (!(host instanceof HTMLElement)) return;
  const context = { planInherited: hasApprovedAncestorPlan(allItems, item) };
  const view = buildTodoStageView(item, context);
  const key = view.steps.map((step) => `${step.id}:${step.state}:${step.hint}`).join('|') + `|${view.current}`;
  if (host.dataset.stageKey === key) return;
  host.dataset.stageKey = key;
  host.replaceChildren(createTodoStageStepperEl(item, context));
}

/**
 * "Close" shortcut for a leaf whose code review passed but whose status was
 * never set to done; it replaces the misleading ready/dependency marks.
 *
 * @param {HTMLElement} el
 * @param {{ title?: string }} item
 * @param {boolean} show
 */
export function paintTodoRowClose(el, item, show) {
  const button = el.querySelector('.todo-row-close');
  if (!(button instanceof HTMLElement)) return;
  button.hidden = !show;
  if (!show) return;
  const label = button.querySelector('.todo-row-close-label');
  if (label instanceof HTMLElement) setTextIfChanged(label, t('todo.closeReviewed'));
  const hint = t('todo.closeReviewedHint');
  button.title = hint;
  button.setAttribute('aria-label', `${t('todo.closeReviewed')}: ${String(item?.title || '')}`);
}

/** @param {HTMLElement} el @param {string} text */
export function setTextIfChanged(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** @param {HTMLElement} el @param {string} key @param {string} value */
export function setIfChanged(el, key, value) {
  if (el.dataset[key] !== value) el.dataset[key] = value;
}
