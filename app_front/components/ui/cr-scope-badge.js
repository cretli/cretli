import { LitElement, css, html } from 'lit';

class CrScopeBadge extends LitElement {
  static properties = {
    scope: { type: String, reflect: true },
    label: { type: String },
    name: { type: String },
    emptyLabel: { type: String, attribute: 'empty-label' },
  };

  static styles = css`
    :host { display: block; max-width: 100%; margin-block: var(--cr-space-2); }
    .badge {
      display: inline-block; max-width: 100%; box-sizing: border-box;
      padding: var(--cr-space-1) var(--cr-space-2);
      border: 1px solid var(--cr-border); border-radius: var(--cr-radius-sm);
      color: var(--cr-text-muted); background: var(--cr-surface);
      font: var(--cr-font-size-sm) var(--cr-font-ui); overflow-wrap: anywhere;
    }
  `;

  constructor() {
    super();
    this.scope = 'global';
    this.label = '';
    this.name = '';
    this.emptyLabel = '';
  }

  render() {
    const scoped = this.scope === 'workspace' || this.scope === 'folder';
    return html`<span class="badge">${this.label}${scoped ? html`: ${this.name.trim() || this.emptyLabel}` : ''}</span>`;
  }
}

if (!customElements.get('cr-scope-badge')) customElements.define('cr-scope-badge', CrScopeBadge);
export { CrScopeBadge };
