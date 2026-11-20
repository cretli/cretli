import { LitElement, css, html, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { proposalActions, proposalPreview, proposalStatusKey } from './docsProposalLogic.js';

export class CrDocProposals extends LitElement {
  static properties = {
    api: { attribute: false }, human: { type: Boolean }, version: { type: Number },
    items: { state: true }, busy: { state: true }, error: { state: true },
  };
  static styles = css`
    :host { display:block; max-height:45vh; overflow:auto; color:var(--cr-text); font-size:var(--cr-font-size-sm); }
    article { border:1px solid var(--cr-border-strong); padding:var(--cr-space-2); margin-bottom:var(--cr-space-2); }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; overflow:auto; max-height:24rem; font-family:var(--cr-font-mono); }
    .meta { color:var(--cr-text-muted); overflow-wrap:anywhere; }
    .actions { display:flex; gap:var(--cr-space-2); }
    [role=alert] { color:var(--cr-error); }
  `;
  constructor() {
    super();
    this.api = null; this.human = false; this.version = 0;
    this.items = []; this.busy = false; this.error = ''; this.generation = 0;
  }
  updated(changed) {
    if (changed.has('api')) { this.busy = false; this.items = []; }
    if (changed.has('api') || changed.has('human') || changed.has('version')) void this.reload();
  }
  async reload(preserveError = false) {
    const generation = ++this.generation;
    if (!preserveError) this.error = '';
    if (!this.human || !this.api) { this.items = []; return; }
    try {
      const { items } = await this.api.proposals();
      if (generation === this.generation) this.items = items;
    } catch { if (generation === this.generation) this.error = t('docs.proposals.error'); }
  }
  async resolve(card, optionId) {
    if (!proposalActions(card, this.human, this.busy)) return;
    const api = this.api;
    this.busy = true; this.error = '';
    try {
      await api.resolveProposal(card, optionId);
      if (api !== this.api) return;
      this.dispatchEvent(new CustomEvent('docs-proposal-resolved', { bubbles: true, composed: true }));
    } catch (error) {
      if (api === this.api) this.error = t(error.status === 409 ? 'docs.proposals.stale' : 'docs.proposals.error');
    } finally {
      if (api === this.api) { this.busy = false; await this.reload(true); }
    }
  }
  render() {
    if (!this.human) return nothing;
    return html`<details><summary>${t('docs.proposals.title')} (${this.items.filter((c) => c.status === 'pending').length})</summary>
      <p role="alert">${this.error}</p>
      ${!this.items.length ? html`<p>${t('docs.proposals.empty')}</p>` : nothing}
      ${this.items.map((card) => {
        const preview = proposalPreview(card);
        return html`<article data-proposal-id=${card.id}>
          <h3>${card.subject.docPath}</h3><p>${t(proposalStatusKey(card))}</p>
          <p class="meta">${t('docs.proposals.source')}: ${card.subject.chatId} · ${card.createdAt}</p>
          ${card.decidedAt ? html`<p class="meta">${t('docs.proposals.decided')}: ${t('docs.proposals.human')} · ${card.decidedAt}</p>` : nothing}
          <pre>${preview.text}</pre>${preview.truncated ? html`<p>${t('docs.proposals.truncated')}</p>
            <details><summary>${t('docs.proposals.fullText')}</summary><pre>${card.proposal.text}</pre></details>` : nothing}
          ${proposalActions(card, this.human) ? html`<div class="actions">
            <cr-bar-button data-proposal-apply ?disabled=${this.busy} @click=${() => this.resolve(card, 'apply')}>${t('docs.proposals.apply')}</cr-bar-button>
            <cr-bar-button data-proposal-reject ?disabled=${this.busy} @click=${() => this.resolve(card, 'reject')}>${t('docs.proposals.reject')}</cr-bar-button>
          </div>` : nothing}
        </article>`;
      })}
    </details>`;
  }
}
if (!customElements.get('cr-doc-proposals')) customElements.define('cr-doc-proposals', CrDocProposals);
