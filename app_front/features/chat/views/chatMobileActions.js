/**
 * Chat pane mobile overscroll action bar (pull up past the bottom to reveal archive / delete / more).
 */
import { isChatArchived, isForkSubtreeBusy } from '../../../../lib/chat-tree.js';
import { t } from '../../../i18n/index.js';
import { hasLiveHarnessWork } from '../chatStatusMeta.js';
import {
  requestArchiveChatConfirmed,
  requestDeleteChat,
  requestRestoreChat,
} from '../services/chatDeleteArchive.js';
import { chats } from '../state/chatRuntimeState.js';

/**
 * Mount the mobile pull-up action bar (archive / delete / more) behind the chat viewport.
 * @param {{ chat: any, pane: HTMLElement, container: HTMLElement, viewportWrap: HTMLElement }} args
 */
export function mountChatMobileOverscrollActions({ chat, pane, container, viewportWrap }) {
  const mobileActions = document.createElement('div');
  mobileActions.className = 'chat-mobile-overscroll-actions';
  mobileActions.setAttribute('aria-label', t('logs.moreActionsAria'));
  const appendActionButton = (action, variant, icon, label) => {
    const button = document.createElement('cr-bar-button');
    if (variant) button.setAttribute('variant', variant);
    button.dataset.chatAction = action;
    const iconEl = document.createElement('span');
    iconEl.className = `mdi ${icon}`;
    iconEl.setAttribute('aria-hidden', 'true');
    const labelEl = document.createElement('span');
    labelEl.className = 'chat-mobile-action-label';
    labelEl.textContent = label;
    button.append(iconEl, labelEl);
    mobileActions.appendChild(button);
  };
  appendActionButton('archive', '', 'mdi-archive-arrow-down-outline', t('chat.archive'));
  appendActionButton('delete', 'danger', 'mdi-delete-outline', t('chat.delete'));
  appendActionButton('more', '', 'mdi-dots-horizontal', t('logs.moreActionsTitle'));
  viewportWrap.appendChild(mobileActions);
  // Pull-up reveal: the chat slides up over actions that sit behind it. A short pull springs
  // back; a long pull (past the commit distance) keeps the actions open.
  const PULL_RESISTANCE = 0.7;
  mobileActions.style.transform = 'translateY(100%)';
  let gesture = null;
  let actionsOpen = false;
  const isAtBottom = () => container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
  // The bar overlaps the chat's bottom padding so the visible gap above the buttons equals
  // GAP_ABOVE_BUTTONS_PX regardless of the padding value in CSS (computed, not hardcoded).
  const GAP_ABOVE_BUTTONS_PX = 10;
  const getBarOverlap = () => Math.max(
    0,
    (parseFloat(getComputedStyle(container).paddingBottom) || 0) - GAP_ABOVE_BUTTONS_PX,
  );
  const getOpenDistance = () => Math.max(0, mobileActions.offsetHeight - getBarOverlap());
  let slidePx = 0;
  let slideFrame = 0;
  const applySlide = (px) => {
    slidePx = px;
    container.style.transform = px ? `translateY(${-px}px)` : '';
    // The action bar rides the chat's bottom edge: it enters from below in step with the slide.
    const barHeight = mobileActions.offsetHeight;
    const openDistance = getOpenDistance();
    // A hidden pane (another chat is active) measures 0px: a pixel offset would then park the
    // bar at translateY(0) and it would show up expanded when the chat is opened again.
    if (px <= 0 || barHeight <= 0 || openDistance <= 0) {
      mobileActions.style.transform = 'translateY(100%)';
      return;
    }
    mobileActions.style.transform = `translateY(${barHeight * (1 - px / openDistance)}px)`;
  };
  // One rAF loop writes both transforms in the same frame, so chat and bar cannot drift apart
  // (two independent CSS transitions could finish at different speeds).
  const setSlide = (px, animate) => {
    cancelAnimationFrame(slideFrame);
    container.style.transition = 'none';
    mobileActions.style.transition = 'none';
    if (!animate) { applySlide(px); return; }
    const from = slidePx;
    const startedAt = performance.now();
    const step = (now) => {
      const progress = Math.min(1, (now - startedAt) / 200);
      applySlide(from + (px - from) * (1 - (1 - progress) ** 3));
      if (progress < 1) slideFrame = requestAnimationFrame(step);
    };
    slideFrame = requestAnimationFrame(step);
  };
  const setActionsOpen = (open) => {
    actionsOpen = open;
    viewportWrap.classList.toggle('chat-mobile-actions-open', open);
    if (open) container.scrollTop = container.scrollHeight;
    setSlide(open ? getOpenDistance() : 0, true);
  };
  const refreshArchiveButton = () => {
    const archiveButton = mobileActions.querySelector('[data-chat-action="archive"]');
    if (!archiveButton) return;
    const archived = isChatArchived(chat);
    archiveButton.querySelector('.chat-mobile-action-label').textContent = t(archived ? 'chat.restore' : 'chat.archive');
    archiveButton.querySelector('.mdi')?.classList.toggle('mdi-archive-arrow-up-outline', archived);
    archiveButton.querySelector('.mdi')?.classList.toggle('mdi-archive-arrow-down-outline', !archived);
  };
  viewportWrap.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches[0];
    if (!touch || mobileActions.contains(event.target)) { gesture = null; return; }
    gesture = { startY: touch.clientY, anchorY: actionsOpen || isAtBottom() ? touch.clientY : null, committed: false };
  }, { passive: true });
  viewportWrap.addEventListener('touchmove', (event) => {
    const touch = event.changedTouches[0];
    if (!gesture || !touch) return;
    if (gesture.anchorY == null) {
      if (!isAtBottom()) return;
      gesture.anchorY = touch.clientY;
    }
    const height = getOpenDistance();
    const base = actionsOpen ? height : 0;
    const pull = (gesture.anchorY - touch.clientY) * PULL_RESISTANCE;
    // While the bar is open or being pulled the drag belongs to the slide, not to chat scrolling
    // (a small scroll would eat the bottom padding and leave the gap above the buttons shrunk).
    if ((actionsOpen || pull > 0) && event.cancelable) event.preventDefault();
    const shown = Math.max(0, Math.min(height, base + pull));
    if (!actionsOpen && pull <= 0) { setSlide(0, false); return; }
    refreshArchiveButton();
    setSlide(shown, false);
    // Commit once the pull is well past the fully revealed bar.
    const committed = !actionsOpen ? pull >= height * 1.35 : pull > -height * 0.5;
    if (committed !== gesture.committed) {
      gesture.committed = committed;
      if (committed && !actionsOpen) navigator.vibrate?.(15);
    }
  }, { passive: false });
  const finishGesture = () => {
    if (!gesture) return;
    const wasCommitted = gesture.committed;
    const moved = gesture.anchorY != null;
    gesture = null;
    if (!moved) return;
    setActionsOpen(actionsOpen ? wasCommitted : wasCommitted);
  };
  viewportWrap.addEventListener('touchend', finishGesture, { passive: true });
  container.addEventListener('click', () => { if (actionsOpen) setActionsOpen(false); });
  // A quick flick can scroll the chat away from the bottom while the bar is open (or being
  // pulled); the bar belongs to the bottom edge only, so tuck it away as soon as that happens.
  container.addEventListener('scroll', () => {
    if (!actionsOpen && slidePx <= 0) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= 24) return;
    gesture = null;
    setActionsOpen(false);
  }, { passive: true });
  // Switching to another chat deactivates this pane: reset the bar at once (no animation) so it
  // is already closed when the user comes back.
  new MutationObserver(() => {
    if (pane.classList.contains('active') || (!actionsOpen && slidePx <= 0)) return;
    gesture = null;
    actionsOpen = false;
    viewportWrap.classList.remove('chat-mobile-actions-open');
    setSlide(0, false);
  }).observe(pane, { attributes: true, attributeFilter: ['class'] });
  // Typing starts (send bar focused, soft keyboard opens): tuck the action bar away.
  pane.addEventListener('focusin', (event) => {
    if (actionsOpen && !mobileActions.contains(event.target)) setActionsOpen(false);
  });
  viewportWrap.addEventListener('touchcancel', finishGesture, { passive: true });
  mobileActions.addEventListener('click', (event) => {
    const button = event.target.closest('[data-chat-action]');
    if (!button) return;
    const action = button.dataset.chatAction;
    if (action === 'more') {
      setActionsOpen(false);
      // Deferred: the dropdown closes on any outside click, including this very event bubbling up.
      window.setTimeout(() => document.getElementById('chat-toolbar-more-btn')?.click(), 0);
      return;
    }
    const id = chat.id;
    // Always ask first here: a stray swipe-and-tap must not archive or delete a chat silently.
    if (action === 'delete') {
      requestDeleteChat(id, { forceConfirm: true });
    } else if (isChatArchived(chat)) {
      void requestRestoreChat(id);
    } else if (!isForkSubtreeBusy(chats, id, hasLiveHarnessWork)) {
      void requestArchiveChatConfirmed(id, { forceConfirm: true });
    }
    setActionsOpen(false);
  });
}
