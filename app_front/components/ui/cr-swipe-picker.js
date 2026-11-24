/**
 * cr-swipe-picker — quick single choice from a short list (Lit, shadow DOM).
 *
 * A strip of chips with the selected one centred. Tap a chip, press Left/Right, or swipe
 * the strip sideways to step to the neighbour (with a haptic tick on touch devices).
 * Fires `cr-change` with `detail.value`.
 *
 * items: Array<{ value: string, label: string, color?: string, icon?: string, iconSrc?: string, iconInvert?: boolean }>
 * `icon` is a text glyph (emoji); `iconSrc` is an image URL such as a harness logo.
 */
import { LitElement, css, html } from 'lit';
import { haptic } from '../../lib/haptics.js';

/** Finger travel per vertical step. */
const VSTEP_PX = 34;
/** Finger travel per step while dragging. */
const STEP_PX = 44;
/** Release speed (px/ms) from which a swipe keeps going on its own, and from which it runs to the end. */
const FLICK_MIN_SPEED = 0.9;
const FLICK_TO_END_SPEED = 4;
/** Finger travel inside the sample window below which a release is not a flick. */
const FLICK_MIN_TRAVEL_PX = 40;
const FLICK_MIN_INTERVAL_MS = 28;
const FLICK_MAX_INTERVAL_MS = 120;
/** Quiet time after the last step before the single change event fires. */
const EMIT_SETTLE_MS = 140;
const COLORS = new Set(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray']);

class CrSwipePicker extends LitElement {
  static properties = {
    items: { attribute: false },
    value: { type: String },
    label: { type: String },
  };

  static styles = css`
    :host {
      display: block;
      max-width: 100%;
      /* Vertical drags are reported as cr-vstep, so the page must not scroll with them. */
      touch-action: none;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .strip {
      display: flex;
      gap: var(--cr-space-2);
      overflow: hidden;
      padding: var(--cr-space-1);
      border: 1px solid var(--cr-field-border);
      border-radius: var(--cr-radius-sm);
      background: var(--cr-field-bg);
    }
    .chip {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: var(--cr-space-2);
      height: 2.2rem;
      padding: 0 var(--cr-space-3);
      border: 1px solid transparent;
      border-radius: var(--cr-radius-sm);
      background: transparent;
      color: var(--cr-text-muted);
      font: inherit;
      font-size: var(--cr-font-size-md);
      cursor: pointer;
      white-space: nowrap;
      transition: background var(--cr-transition), color var(--cr-transition);
    }
    .chip[aria-selected='true'] {
      background: var(--cr-active);
      border-color: var(--cr-border-strong);
      color: var(--cr-text);
      font-weight: 500;
    }
    .chip:focus-visible {
      outline: 2px solid var(--cr-accent);
      outline-offset: -2px;
    }
    .marker {
      flex-shrink: 0;
      width: 0.7rem;
      height: 0.7rem;
      border-radius: 50%;
      border: 1px solid var(--accent, var(--cr-border-strong));
      background: var(--accent, transparent);
    }
    .marker.has-icon {
      width: auto;
      height: auto;
      border: 0;
      background: none;
      font-size: calc(var(--cr-font-size-lg) * 1.05);
      line-height: 1;
    }
    .logo {
      flex-shrink: 0;
      width: 1.1rem;
      height: 1.1rem;
      object-fit: contain;
    }
    .logo.invert {
      filter: invert(1);
    }
    @media (prefers-reduced-motion: reduce) {
      .strip { scroll-behavior: auto; }
    }
  `;

  constructor() {
    super();
    /** @type {Array<{ value: string, label: string, color?: string, icon?: string, iconSrc?: string, iconInvert?: boolean }>} */
    this.items = [];
    this.value = '';
    this.label = '';
    /** @type {{ x: number, y: number, lastStepX: number, lastStepY?: number, samples: Array<{ x: number, t: number }>, moved: boolean, locked: '' | 'x' | 'y' } | null} */
    this._drag = null;
    this._swiped = false;
    this._momentum = 0;
    this._emitTimer = 0;
    this._emittedValue = '';
    this._scrollTarget = 0;
    this._raf = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this._emittedValue = this.value;
    this.addEventListener('pointerdown', this._onDown);
    this.addEventListener('pointermove', this._onMove);
    this.addEventListener('pointerup', this._onUp);
    this.addEventListener('pointercancel', this._onCancel);
    this.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback() {
    this.removeEventListener('pointerdown', this._onDown);
    this.removeEventListener('pointermove', this._onMove);
    this.removeEventListener('pointerup', this._onUp);
    this.removeEventListener('pointercancel', this._onCancel);
    this.removeEventListener('keydown', this._onKey);
    this._stopMomentum();
    clearTimeout(this._emitTimer);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    super.disconnectedCallback();
  }

  updated() {
    // Keep the selected chip centred. The strip chases its target every frame instead of
    // using CSS smooth scrolling, which restarts on each step and stutters during a fast swipe.
    const strip = this.renderRoot.querySelector('.strip');
    const chip = this.renderRoot.querySelector('.chip[aria-selected="true"]');
    if (!(strip instanceof HTMLElement) || !(chip instanceof HTMLElement)) return;
    this._scrollTarget = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2;
    if (!this._raf) this._raf = requestAnimationFrame(this._chase);
  }

  _chase = () => {
    this._raf = 0;
    const strip = this.renderRoot.querySelector('.strip');
    if (!(strip instanceof HTMLElement)) return;
    const diff = this._scrollTarget - strip.scrollLeft;
    if (Math.abs(diff) < 0.5) { strip.scrollLeft = this._scrollTarget; return; }
    strip.scrollLeft += diff * 0.28;
    this._raf = requestAnimationFrame(this._chase);
  };

  _stopMomentum() {
    if (this._momentum) clearTimeout(this._momentum);
    this._momentum = 0;
  }

  _onDown = (ev) => {
    this._stopMomentum();
    this._drag = { x: ev.clientX, y: ev.clientY, lastStepX: ev.clientX, samples: [{ x: ev.clientX, t: ev.timeStamp }], moved: false, locked: '' };
    this._swiped = false;
  };

  _onMove = (ev) => {
    const drag = this._drag;
    if (!drag) return;
    drag.samples.push({ x: ev.clientX, t: ev.timeStamp });
    // Only the last ~100 ms matter for the release speed.
    while (drag.samples.length > 2 && ev.timeStamp - drag.samples[0].t > 100) drag.samples.shift();
    const totalX = ev.clientX - drag.x;
    const totalY = ev.clientY - drag.y;
    if (!drag.locked) {
      // Decide once whether this is a sideways swipe (the picker follows) or a vertical scroll.
      if (Math.abs(totalX) < 8 && Math.abs(totalY) < 8) return;
      drag.locked = Math.abs(totalX) < Math.abs(totalY) ? 'y' : 'x';
      drag.lastStepY = drag.y;
      try { this.setPointerCapture(ev.pointerId); } catch (_) { /* optional */ }
    }
    drag.moved = true;
    if (drag.locked === 'y') {
      // Up = next. The host decides what a vertical step means and reports whether it did something.
      let dy = ev.clientY - drag.lastStepY;
      while (Math.abs(dy) >= VSTEP_PX) {
        const dir = dy < 0 ? 1 : -1;
        const detail = { dir, handled: false };
        this.dispatchEvent(new CustomEvent('cr-vstep', { detail, bubbles: true, composed: true }));
        if (detail.handled) haptic('tick');
        drag.lastStepY += -dir * VSTEP_PX;
        dy = ev.clientY - drag.lastStepY;
        if (!detail.handled) { drag.lastStepY = ev.clientY; break; }
      }
      return;
    }
    // The choice follows the finger: one step per STEP_PX, a tick on each.
    let dx = ev.clientX - drag.lastStepX;
    while (Math.abs(dx) >= STEP_PX) {
      const dir = dx < 0 ? 1 : -1;
      if (!this._step(dir)) { drag.lastStepX = ev.clientX; break; }
      drag.lastStepX += -dir * STEP_PX;
      dx = ev.clientX - drag.lastStepX;
    }
  };

  _onCancel = () => { this._drag = null; };

  _onUp = (ev) => {
    const drag = this._drag;
    this._drag = null;
    if (!drag || !drag.moved) return;
    this._swiped = true;
    setTimeout(() => { this._swiped = false; }, 0);
    if (drag.locked === 'y') {
      this.dispatchEvent(new CustomEvent('cr-vstep-end', { bubbles: true, composed: true }));
      return;
    }
    const first = drag.samples[0];
    const dt = Math.max(1, ev.timeStamp - first.t);
    const velocity = (ev.clientX - first.x) / dt; // px per ms, negative = leftwards
    const speed = Math.abs(velocity);
    // A short twitch can read as a fast flick; demand real travel and a real time window.
    if (speed < FLICK_MIN_SPEED || Math.abs(ev.clientX - first.x) < FLICK_MIN_TRAVEL_PX || dt < 30) return;
    this._flick(velocity < 0 ? 1 : -1, speed);
  };

  /**
   * Momentum after a quick swipe: keeps stepping in the swipe direction. A faster swipe
   * goes further and ticks faster; a very fast one runs to the end of the list.
   * @param {1 | -1} dir
   * @param {number} speed px per ms
   */
  _flick(dir, speed) {
    const items = Array.isArray(this.items) ? this.items : [];
    const at = Math.max(0, items.findIndex((item) => item.value === this.value));
    const remaining = dir > 0 ? items.length - 1 - at : at;
    if (remaining <= 0) return;
    const steps = speed >= FLICK_TO_END_SPEED ? remaining : Math.min(remaining, Math.max(1, Math.round(speed * 1.5)));
    // Faster swipe, shorter pause between steps (and between haptic ticks).
    const interval = Math.min(FLICK_MAX_INTERVAL_MS, Math.max(FLICK_MIN_INTERVAL_MS, 70 / speed));
    let left = steps;
    const tick = () => {
      this._momentum = 0;
      if (left-- <= 0 || !this._step(dir)) return;
      if (left > 0) this._momentum = setTimeout(tick, interval);
    };
    this._momentum = setTimeout(tick, interval);
  }

  _onKey = (ev) => {
    if (ev.key === 'ArrowRight') { ev.preventDefault(); this._step(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); this._step(-1); }
  };

  /**
   * @param {number} delta
   * @returns {boolean} false at the end of the list
   */
  _step(delta) {
    const items = Array.isArray(this.items) ? this.items : [];
    if (items.length < 2) return false;
    const at = Math.max(0, items.findIndex((item) => item.value === this.value));
    const next = Math.min(items.length - 1, Math.max(0, at + delta));
    if (next === at) return false;
    this.value = items[next].value;
    haptic('tick');
    this._emitSoon();
    return true;
  }

  /** @param {string} value */
  _choose(value) {
    if (value === this.value) return;
    this.value = value;
    haptic('tick');
    this._emit();
  }

  /** Steps during a drag or flick settle into one change event, so heavy listeners run once. */
  _emitSoon() {
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => this._emit(), EMIT_SETTLE_MS);
  }

  _emit() {
    clearTimeout(this._emitTimer);
    if (this.value === this._emittedValue) return;
    this._emittedValue = this.value;
    this.dispatchEvent(new CustomEvent('cr-change', { detail: { value: this.value }, bubbles: true, composed: true }));
  }

  render() {
    const items = Array.isArray(this.items) ? this.items : [];
    return html`
      <div class="strip" role="listbox" aria-label=${this.label || ''}>
        ${items.map((item) => {
          const color = COLORS.has(String(item.color || '')) ? item.color : '';
          const icon = String(item.icon || '').trim();
          const selected = item.value === this.value;
          return html`
            <button
              type="button"
              class="chip"
              role="option"
              aria-selected=${selected ? 'true' : 'false'}
              @click=${() => { if (!this._swiped) this._choose(item.value); }}
            >
              ${item.iconSrc
                ? html`<img class="logo${item.iconInvert ? ' invert' : ''}" src=${item.iconSrc} alt="" aria-hidden="true" />`
                : html`<span
                    class="marker${icon ? ' has-icon' : ''}"
                    style=${color ? `--accent: var(--cr-ws-${color})` : ''}
                    aria-hidden="true"
                  >${icon}</span>`}${item.label}
            </button>
          `;
        })}
      </div>
    `;
  }
}

if (!customElements.get('cr-swipe-picker')) customElements.define('cr-swipe-picker', CrSwipePicker);
export { CrSwipePicker };
