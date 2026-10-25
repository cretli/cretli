/**
 * Root element of the Watcher settings: renders the loading / error / form state
 * from `ws.panelModel` and re-binds the form only when a new form was rendered.
 */

import { LitElement, html } from 'lit';
import { SignalWatcher } from '@lit-labs/signals';
import { t } from '../../../../i18n/index.js';
import { probeSync } from '../../../../lib/perfProbe.js';
import { bindWatcherPanel } from '../bindings.js';
import { applyWatcherTab } from '../runtime.js';
import { watcherFragment } from '../safeHtml.js';
import { ws } from '../store.js';
import './watcherRegions.js';

export class CrWatcherPanel extends SignalWatcher(LitElement) {
  /** @type {DocumentFragment | null} */
  _fragment = null;

  _fragmentRev = -1;

  _boundRev = -1;

  createRenderRoot() {
    return this;
  }

  render() {
    const model = ws.panelModel;
    // Tracked: a tab change re-runs `updated()` so the hidden panels follow it.
    void ws.tab;
    void ws.langRev;
    if (model.kind === 'ready') {
      // The fragment is built once per rendered form. Re-rendering with the same
      // (already inserted) fragment is a no-op, so a tab change never rebuilds
      // the form; a new form replaces the previous nodes in one Lit commit.
      if (this._fragmentRev !== model.rev) {
        this._fragment = probeSync('watcher.panel.parse', () => watcherFragment(model.html));
        this._fragmentRev = model.rev ?? -1;
      }
      return html`${this._fragment}`;
    }
    if (model.kind === 'error') return html`<p class="message" data-tone="error">${model.message}</p>`;
    return html`<p class="settings-hint">${t('settings.watcherLoading')}</p>`;
  }

  updated() {
    const model = ws.peek('panelModel');
    if (model.kind !== 'ready') return;
    const root = /** @type {HTMLElement} */ (this.closest('#settings-watcher-root') || this);
    if (this._boundRev !== model.rev) {
      this._boundRev = model.rev ?? -1;
      bindWatcherPanel(root, model.data);
    } else {
      applyWatcherTab(root);
    }
  }
}

if (!customElements.get('cr-watcher-panel')) customElements.define('cr-watcher-panel', CrWatcherPanel);

/**
 * Mount the panel element exactly once; later calls return the same element, so
 * repeated refreshes can never stack a second copy of the form.
 *
 * @param {HTMLElement} root
 * @returns {HTMLElement}
 */
export function mountWatcherPanel(root) {
  const existing = root.querySelector(':scope > cr-watcher-panel');
  if (existing) return /** @type {HTMLElement} */ (existing);
  const panel = document.createElement('cr-watcher-panel');
  root.replaceChildren(panel);
  return panel;
}
