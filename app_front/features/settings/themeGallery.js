import { LitElement, css, html } from 'lit';
import { getTerminalTheme } from '../terminal/services/terminalTheme.js';
import { styleMap } from 'lit/directives/style-map.js';
import { themes } from '../../core/theme/themes/index.js';
import { t } from '../../i18n/index.js';
import '../../components/ui/index.js';
import { themeRadioTarget } from './themeGalleryState.js';

export class CrThemeGallery extends LitElement {
  static properties = { controller: { attribute: false }, systemTheme: { attribute: false } };

  static styles = css`
    :host { display: block; font: var(--cr-font-size-sm) var(--cr-font-ui); color: var(--cr-text); }
    .field { display: grid; gap: var(--cr-space-2); margin-bottom: var(--cr-space-4); }
    .group { margin: var(--cr-space-3) 0; }
    h4 { font-size: var(--cr-font-size-sm); margin: var(--cr-space-3) 0 var(--cr-space-2); }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: var(--cr-space-2); }
    button { display: grid; gap: var(--cr-space-2); padding: var(--cr-space-2); border: 1px solid var(--cr-border-strong); border-radius: var(--cr-radius-sm); background: var(--cr-surface); color: var(--cr-text); font: inherit; text-align: left; cursor: pointer; }
    button[aria-checked=true] { border-color: var(--cr-accent); box-shadow: inset 0 0 0 1px var(--cr-accent); }
    button:focus-visible { outline: 2px solid var(--cr-accent); outline-offset: 2px; }
    .preview { display: flex; height: 3.5rem; background: var(--preview-bg); border-radius: var(--cr-radius-sm); overflow: hidden; }
    .sidebar { width: 24%; background: var(--preview-sidebar); border-top: 3px solid var(--preview-accent); }
    .code { display: grid; align-content: center; gap: 0.3rem; padding: var(--cr-space-2); flex: 1; }
    .line { height: 0.2rem; width: 80%; background: var(--line); }
    .line:nth-child(2) { width: 55%; } .line:nth-child(3) { width: 70%; }
    .badge { font-size: var(--cr-font-size-xs); color: var(--cr-text-muted); }
    .hint { color: var(--cr-text-muted); margin: 0 0 var(--cr-space-3); }
  `;

  constructor() {
    super();
    this.controller = null;
    this.systemTheme = null;
    this.refresh = () => this.requestUpdate();
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('cr-theme-change', this.refresh);
    window.addEventListener('cr-lang-changed', this.refresh);
  }

  disconnectedCallback() {
    window.removeEventListener('cr-theme-change', this.refresh);
    window.removeEventListener('cr-lang-changed', this.refresh);
    super.disconnectedCallback();
  }

  entries(appearance) {
    return [...themes.values()].filter((theme) => theme.appearance === appearance)
      .sort((a, b) => Number(b.id === `cretli-${appearance}`) - Number(a.id === `cretli-${appearance}`));
  }

  preview(theme) {
    const palette = getTerminalTheme(theme.id);
    const token = (key) => theme.tokens[key] || palette.blue;
    const colors = ['keyword', 'string', 'number', 'title'];
    return html`<span class="preview" aria-hidden="true" style=${styleMap({
      '--preview-bg': theme.tokens['--cr-bg'] || theme.themeColor,
      '--preview-sidebar': theme.tokens['--cr-surface'] || palette.selectionInactiveBackground,
      '--preview-accent': token('--cr-accent'),
    })}><span class="sidebar"></span><span class="code">${colors.map((key) => html`<span class="line" style=${styleMap({ '--line': theme.syntax?.[key] || palette[({ keyword: 'magenta', string: 'green', number: 'cyan', title: 'blue' })[key]] })}></span>`)}</span></span>`;
  }

  choose(id) { this.controller.select(id); this.requestUpdate(); }

  onKey(event) {
    // Only theme tiles take part in roving focus; other buttons (e.g. the cr-bar-select trigger) are ignored.
    const tile = event.target?.closest?.('[role="radio"]');
    /** @type {HTMLButtonElement[]} */
    const radios = [...this.renderRoot.querySelectorAll('[role="radiogroup"] [role="radio"]')]
      .map((el) => /** @type {HTMLButtonElement} */ (el));
    const index = radios.indexOf(tile);
    if (index < 0) return;
    const target = themeRadioTarget(event.key, index, radios.length);
    if (target === null) return;
    // preventDefault also stops the native button click on Enter/Space so the tile is selected exactly once.
    event.preventDefault();
    this.choose(radios[target].value);
    radios[target].focus();
  }

  render() {
    if (!this.controller) return html``;
    const preference = this.controller.preference();
    const system = preference === 'system';
    return html`
      <label class="field">${t('settings.themeMode')}
        <cr-bar-select aria-label=${t('settings.themeMode')} .value=${system ? 'system' : 'fixed'}
          .options=${[{ value: 'fixed', label: t('settings.themeFixed') }, { value: 'system', label: t('settings.themeSystem') }]}
          @change=${(event) => { this.controller.mode(event.target.value); this.requestUpdate(); }}></cr-bar-select>
      </label>
      ${system ? ['light', 'dark'].map((appearance) => html`
        <label class="field">${t(`settings.themeSystem${appearance === 'light' ? 'Light' : 'Dark'}`)}
          <cr-bar-select aria-label=${t(`settings.themeSystem${appearance === 'light' ? 'Light' : 'Dark'}`)} .value=${this.systemTheme(appearance)}
            .options=${this.entries(appearance).map((theme) => ({ value: theme.id, label: theme.label }))}
            @change=${(event) => { this.controller.system(appearance, event.target.value); this.requestUpdate(); }}></cr-bar-select>
        </label>`) : html`
        <p class="hint">${t('settings.themeGalleryHint')}</p>
        <div role="radiogroup" aria-label=${t('settings.theme')}>
          ${['dark', 'light'].map((appearance) => html`<div class="group" role="group" aria-label=${t(`settings.theme${appearance === 'dark' ? 'Dark' : 'Light'}`)}>
            <h4>${t(`settings.theme${appearance === 'dark' ? 'Dark' : 'Light'}`)}</h4>
            <div class="tiles">${this.entries(appearance).map((theme) => html`
              <button type="button" role="radio" value=${theme.id} aria-checked=${String(theme.id === preference)}
                tabindex=${theme.id === preference ? 0 : -1} @click=${() => this.choose(theme.id)} @keydown=${this.onKey}>
                ${this.preview(theme)}<span>${theme.label}</span>
                ${theme.id === `cretli-${appearance}` ? html`<span class="badge">${t('settings.themeDefault')}</span>` : ''}
              </button>`)}</div>
          </div>`)}
        </div>`}`;
  }
}

if (!customElements.get('cr-theme-gallery')) customElements.define('cr-theme-gallery', CrThemeGallery);
