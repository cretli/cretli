/**
 * Base class of the live regions inside the Watcher settings panel.
 *
 * A region is a light-DOM Lit element that renders one card from the store.
 * `renderHtml()` reads signals, so the element re-renders exactly when the state
 * it shows changes. Light DOM keeps the existing ids, the settings stylesheet
 * and the delegated listeners (bound on the region element itself) working.
 */

import { LitElement, html } from 'lit';
import { SignalWatcher } from '@lit-labs/signals';
import { probeSync } from '../../../../lib/perfProbe.js';
import { watcherFragment } from '../safeHtml.js';
import { ws } from '../store.js';

export class WatcherRegion extends SignalWatcher(LitElement) {
  /** Re-render on a language change. The Scout editor opts out to keep a draft. */
  trackLanguage = true;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute('data-watcher-region', '');
  }

  /** Markup of the region, built from store reads. @returns {string} */
  renderHtml() {
    return '';
  }

  /** Imperative follow-up after the DOM was replaced (listeners, countdowns). */
  afterRender() {}

  /** Panel root that hosts this region. @returns {HTMLElement} */
  get panelRoot() {
    return /** @type {HTMLElement} */ (this.closest('#settings-watcher-root') || this);
  }

  render() {
    if (this.trackLanguage) void ws.langRev;
    return probeSync(`watcher.region.${this.localName}`, () => html`${watcherFragment(this.renderHtml())}`);
  }

  updated() {
    this.afterRender();
  }
}

/**
 * Register one region element.
 *
 * @param {string} tag
 * @param {(region: WatcherRegion) => string} renderHtml
 * @param {{ afterRender?: (region: WatcherRegion) => void, trackLanguage?: boolean }} [options]
 * @returns {typeof WatcherRegion}
 */
export function defineWatcherRegion(tag, renderHtml, options = {}) {
  const existing = customElements.get(tag);
  if (existing) return /** @type {typeof WatcherRegion} */ (existing);
  class Region extends WatcherRegion {
    trackLanguage = options.trackLanguage !== false;

    renderHtml() {
      return renderHtml(this);
    }

    afterRender() {
      options.afterRender?.(this);
    }
  }
  customElements.define(tag, Region);
  return Region;
}
