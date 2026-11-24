import { AT_BOTTOM_EPSILON_PX, SCROLL_STICK_THRESHOLD_PX, nextStickToBottom } from '../../../../lib/scrollStickGeometry.js';

// Geometry noise is separate from the shared distance used to resume following.
const GEOMETRY_EPSILON_PX = 0.5;

/** One owner of the conversation's scroll position; nested block scrollers stay independent.
 * @param {any} rv
 */
export function createViewportController(rv) {
  const mount = rv.mountEl;
  const state = { following: true, readingAnchor: null, lastProgrammaticTop: mount.scrollTop };
  let lastObservedTop = mount.scrollTop;
  let disposed = false;
  const listeners = [];

  const visible = () => !disposed && !rv.viewDestroyed && mount.clientHeight > 0;
  const relativeTop = (el) => el.getBoundingClientRect().top - mount.getBoundingClientRect().top;
  function captureAnchor() {
    if (!visible()) return state.readingAnchor;
    const top = mount.getBoundingClientRect().top;
    const cards = [...rv.realStream.children];
    const index = cards.findIndex((el) => el.getBoundingClientRect().bottom > top);
    // Neighbours provide a stable fallback when the visible card is removed or folded.
    const candidates = index < 0 ? [] : [...cards.slice(index, index + 3), ...cards.slice(Math.max(0, index - 1), index)]
      .map((el) => ({ el, seq: el.dataset.historySeq, top: relativeTop(el) }));
    return { candidates, scrollTop: mount.scrollTop };
  }
  function write(top) {
    if (!visible()) return;
    mount.scrollTop = top;
    // Remember the browser's clamped result, not the requested value.
    state.lastProgrammaticTop = mount.scrollTop;
    lastObservedTop = mount.scrollTop;
    rv.lastScrollTop = mount.scrollTop;
  }
  function restoreAnchor(anchor = state.readingAnchor) {
    if (!visible() || !anchor) return;
    const candidates = anchor.candidates.map((item) => {
      const el = item.el?.isConnected ? item.el : item.seq
        ? [...rv.realStream.children].find((card) => card.dataset.historySeq === item.seq) : null;
      return { ...item, el };
    });
    const candidate = candidates.find(({ el }) => el && rv.realStream.contains(el));
    const top = candidate ? mount.scrollTop + relativeTop(candidate.el) - candidate.top : anchor.scrollTop;
    if (Math.abs(top - mount.scrollTop) >= GEOMETRY_EPSILON_PX) write(top);
    else {
      lastObservedTop = mount.scrollTop;
      state.lastProgrammaticTop = mount.scrollTop;
    }
    // Lit may not have measured newly replayed cards yet. Keep the requested
    // anchor through that clamp so the next resize can finish restoring it.
    if (!state.following && !rv.viewportReplaySnapshot && Math.abs(mount.scrollTop - top) < GEOMETRY_EPSILON_PX) {
      state.readingAnchor = captureAnchor();
    }
  }
  function setFollowing(value) {
    if (visible()) lastObservedTop = mount.scrollTop;
    state.following = value === true;
    state.readingAnchor = state.following ? null : captureAnchor();
  }
  function observe(captureReading = true) {
    if (!visible() || rv.suppressScrollStickUpdate) return;
    const top = mount.scrollTop;
    const moved = Math.abs(top - lastObservedTop) >= GEOMETRY_EPSILON_PX;
    if (state.following || moved) state.following = nextStickToBottom({
      stick: state.following, lastScrollTop: lastObservedTop, scrollTop: top,
      maxScroll: mount.scrollHeight - mount.clientHeight, thresholdPx: SCROLL_STICK_THRESHOLD_PX,
    });
    lastObservedTop = top;
    rv.lastScrollTop = top;
    if (state.following) state.readingAnchor = null;
    else if (captureReading && (moved || !state.readingAnchor)) {
      rv.viewportReplaySnapshot = null;
      state.readingAnchor = captureAnchor();
    }
    rv.scrollToBottomButton.hidden = state.following || mount.scrollHeight - mount.clientHeight <= SCROLL_STICK_THRESHOLD_PX;
  }
  function reconcile() {
    if (!visible()) return;
    // RO and rAF can precede the scroll event for an already completed user movement.
    observe();
    if (rv.suppressAutoScroll || rv.preserveViewportAnchor) return;
    if (state.following) {
      if (Math.abs(mount.scrollHeight - mount.clientHeight - mount.scrollTop) >= GEOMETRY_EPSILON_PX) write(mount.scrollHeight);
    } else restoreAnchor();
  }
  const snapshot = () => {
    if (visible()) observe();
    // Chat snapshots outlive mounted panes; never retain detached cards through them.
    const readingAnchor = state.readingAnchor ? {
      scrollTop: state.readingAnchor.scrollTop,
      candidates: state.readingAnchor.candidates.map(({ seq, top }) => ({ seq, top })),
    } : null;
    return { following: state.following, scrollTop: rv.lastScrollTop, readingAnchor };
  };
  function restoreSnapshot(saved) {
    if (!saved || !visible()) return;
    state.following = saved.following === true;
    state.readingAnchor = saved.readingAnchor;
    if (state.following) write(mount.scrollHeight);
    else {
      write(saved.scrollTop);
      restoreAnchor(saved.readingAnchor);
    }
  }
  function ownsGesture(event) {
    for (const el of event.composedPath()) {
      if (el === mount) return true;
      if (!(el instanceof HTMLElement)) continue;
      if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
      const overflow = getComputedStyle(el).overflowY;
      if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(overflow)) return false;
    }
    return false;
  }
  function intent(event) {
    if (!visible() || !ownsGesture(event)) return;
    // Pointer/focus alone never releases following. Observe movement before pending work;
    // upward wheel/keys also cancel a queued follow before their default scroll runs.
    observe();
    const up = event.type === 'wheel' ? event.deltaY < 0
      : event.type === 'keydown' && ['ArrowUp', 'PageUp', 'Home'].includes(event.key);
    if (up && mount.scrollTop > 0) setFollowing(false);
  }
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    mount.addEventListener(type, intent, { passive: true });
    listeners.push(type);
  }
  return {
    state, write, captureAnchor, restoreAnchor, setFollowing, observe, reconcile, snapshot, restoreSnapshot,
    isAtBottom: () => visible() && mount.scrollHeight - mount.clientHeight - mount.scrollTop <= AT_BOTTOM_EPSILON_PX,
    isNearBottom: () => mount.scrollHeight - mount.clientHeight - mount.scrollTop <= SCROLL_STICK_THRESHOLD_PX,
    dispose() {
      disposed = true;
      for (const type of listeners) mount.removeEventListener(type, intent);
      state.readingAnchor = null;
      rv.viewportReplaySnapshot = null;
      rv.pendingViewportAnchor = null;
    },
  };
}
