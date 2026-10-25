/** Keeps `--cr-keyboard-offset` in sync with the on-screen keyboard (visualViewport). */

function isEditableElement(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  return !!el.isContentEditable;
}

export function initMobileKeyboardOffsetSync() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const vv = window.visualViewport;
  if (!vv) return;

  let rafId = 0;
  const setOffset = (px) => {
    const value = Math.max(0, Math.round(px || 0));
    document.documentElement.style.setProperty('--cr-keyboard-offset', `${value}px`);
    document.body.classList.toggle('mobile-keyboard-open', value > 0);
    window.dispatchEvent(new CustomEvent('cr-keyboard-offset-change'));
  };
  const computeKeyboardOffset = () => {
    const innerH = Number(window.innerHeight) || 0;
    const docH = Number(document.documentElement?.clientHeight) || innerH;
    const viewportBottom = (Number(vv.height) || 0) + (Number(vv.offsetTop) || 0);
    const fromInner = innerH - viewportBottom;
    const fromDoc = docH - viewportBottom;
    const candidates = [fromInner, fromDoc].filter((n) => Number.isFinite(n) && n > 0);
    if (candidates.length === 0) return 0;
    const raw = Math.min(...candidates);
    if (raw < 48) return 0;
    // Guard: Android sometimes reports an inflated offset (IME plus extra system UI).
    const maxReasonable = Math.round(innerH * 0.55);
    if (raw > maxReasonable) return maxReasonable;
    return raw;
  };

  const updateOffset = () => {
    rafId = 0;
    const activeEl = document.activeElement;
    if (!isEditableElement(activeEl)) {
      setOffset(0);
      return;
    }
    const keyboardPx = computeKeyboardOffset();
    setOffset(keyboardPx);
  };
  const scheduleUpdate = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(updateOffset);
  };

  vv.addEventListener('resize', scheduleUpdate);
  vv.addEventListener('scroll', scheduleUpdate);
  window.addEventListener('orientationchange', scheduleUpdate);
  document.addEventListener('focusin', scheduleUpdate, true);
  document.addEventListener(
    'focusout',
    () => {
      setTimeout(scheduleUpdate, 80);
    },
    true
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    setOffset(0);
  });
  window.addEventListener('pageshow', () => {
    if (document.hidden) return;
    setOffset(0);
  });
  scheduleUpdate();
}
