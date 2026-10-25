import { LitElement, css, html, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import '../../components/ui/cr-bar-select.js';
import {
  compareSendWithPreview,
  formatContextSize,
  groupContextEntries,
} from './chatContextPanelModel.js';

/**
 * "Context of this chat": what the last real send delivered and what the next
 * one would deliver. Read-only; selection changes are a later stage and only
 * make sense once this preview works.
 *
 * @property {string} chatId
 */
class CrChatContextPanel extends LitElement {
  static properties = {
    chatId: { type: String, attribute: 'chat-id' },
    _latest: { state: true },
    _preview: { state: true },
    _error: { state: true },
    _loading: { state: true },
    _config: { state: true },
    _configError: { state: true },
    _saved: { state: true },
  };

  static styles = css`
    :host { display: block; font-size: var(--cr-font-size-sm, 0.8rem); color: var(--cr-text); }
    h4 { margin: var(--cr-space-3, 0.75rem) 0 var(--cr-space-1, 0.25rem); font-size: var(--cr-font-size-md, 0.85rem); }
    .row { display: flex; gap: var(--cr-space-2, 0.5rem); align-items: baseline; padding: 0.15rem 0; }
    .name { font-family: var(--cr-font-mono); overflow-wrap: anywhere; }
    .meta { color: var(--cr-text-muted); font-size: var(--cr-font-size-xs, 0.72rem); }
    .warn { color: var(--cr-error); }
    .toolbar { display: flex; gap: var(--cr-space-2, 0.5rem); align-items: center; }
    .hint { color: var(--cr-text-muted); font-size: var(--cr-font-size-xs, 0.72rem); }
  `;

  constructor() {
    super();
    this.chatId = '';
    this._latest = null;
    this._preview = null;
    this._error = '';
    this._loading = false;
    this._config = null;
    this._configError = '';
    this._saved = false;
  }

  updated(changed) {
    if (changed.has('chatId') && this.chatId) void this.refresh();
  }

  async refresh() {
    if (!this.chatId || this._loading) return;
    this._loading = true;
    this._error = '';
    const query = `chatId=${encodeURIComponent(this.chatId)}`;
    try {
      // Snapshot first; the preview is stored as the marker the next send compares against.
      const snapshot = await (await fetch(`/api/chat-context/snapshot?${query}`)).json();
      const preview = await (await fetch(`/api/chat-context/preview?${query}`)).json();
      if (!snapshot.ok) throw new Error(snapshot.error || snapshot.code);
      if (!preview.ok) throw new Error(preview.error || preview.code);
      this._latest = snapshot.latest;
      this._preview = preview.preview;
      await this.loadConfig();
    } catch (err) {
      this._error = String(err?.message || err);
    } finally {
      this._loading = false;
    }
  }

  async loadConfig() {
    this._configError = '';
    try {
      const data = await (await fetch(`/api/context-settings?chatId=${encodeURIComponent(this.chatId)}`)).json();
      if (!data.ok) throw new Error(data.error || data.code);
      this._config = data;
    } catch (err) {
      this._configError = String(err?.message || err);
    }
  }

  /** Chat-level override of the AGENTS.md mode; the empty value clears it. */
  async _setAgentsMode(value) {
    this._saved = false;
    const body = { level: 'chat', settings: { agentsMd: { mode: value || null } } };
    try {
      const res = await fetch(`/api/context-settings?chatId=${encodeURIComponent(this.chatId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || data.code);
      this._saved = true;
      await this.loadConfig();
    } catch (err) {
      this._configError = String(err?.message || err);
    }
  }

  _renderConfig() {
    const config = this._config;
    if (!config) return this._configError ? html`<p class="warn">${this._configError}</p>` : nothing;
    const settings = config.settings;
    const agents = config.agentsMd;
    const mode = settings.effective['agentsMd.mode'];
    const chatOverride = settings.provenance['agentsMd.mode']?.layer === 'chat' ? mode : '';
    const effect = settings.effects['agentsMd.mode'];
    const options = ['', 'auto', 'off', 'force'].map((value) => ({
      value,
      label: value ? t(`chat.ctxCfgMode_${value}`) : t('chat.ctxCfgModeInherit'),
    }));
    return html`
      <h4>${t('chat.ctxCfgTitle')}</h4>
      <p class="hint">${settings.repoConfig.active ? t('chat.ctxCfgRepoActive', { keys: settings.repoConfig.changes.join(', ') || '—' }) : t('chat.ctxCfgRepoInactive')}</p>
      ${settings.repoConfig.error ? html`<p class="warn">${settings.repoConfig.error}</p>` : nothing}
      ${Object.entries(settings.effective).map(([key, value]) => html`
        <div class="row"><span class="name">${key}</span><span>${String(value)}</span>
          <span class="meta">${t(`chat.ctxCfgLayer_${settings.provenance[key].layer}`)}</span></div>`)}
      <div class="row"><span class="name">agentsMd.mode</span>
        <cr-bar-select size="sm" .options=${options} .value=${chatOverride}
          @cr-change=${(e) => this._setAgentsMode(e.detail.value)}></cr-bar-select></div>
      <p class="hint">${t(`chat.ctxCfgEffect_${effect.effect}`)} ${effect.retraction ? t('chat.ctxCfgRetraction') : ''}</p>
      ${this._saved ? html`<p class="hint">${t('chat.ctxCfgSaved')}</p>` : nothing}
      ${settings.blocked.length ? html`<p class="warn">${t('chat.ctxCfgBlocked', { keys: settings.blocked.map((b) => b.key).join(', ') })}</p>` : nothing}
      <h4>${t('chat.ctxCfgAgentsTitle')}</h4>
      <p class="hint">${t(`chat.ctxCfgDelivery_${agents.delivery.reason}`)}</p>
      ${agents.warnings.length ? html`<p class="warn">${agents.warnings.join(' ')}</p>` : nothing}
      ${agents.chain.map((row) => html`<div class="row"><span class="name">${row.relPath}</span>
        <span class="meta">${formatContextSize(row.sizeBytes)}</span></div>`)}
      ${agents.nested.length ? html`<p class="hint">${t('chat.ctxCfgNested', { count: String(agents.nested.length) })}</p>` : nothing}
      ${config.globs.length ? html`<p class="hint">${t('chat.ctxCfgGlobs', { count: String(config.globs.length) })} ${t('chat.ctxCfgGlobsNote')}</p>` : nothing}`;
  }

  _renderSummary(title, snapshot) {
    if (!snapshot) return html`<p class="hint">${t('chat.ctxPanelNoSend')}</p>`;
    return html`<div class="row"><strong>${title}</strong>
      <span class="meta">${t('chat.ctxPanelRevision')}: ${snapshot.revision}</span>
      <span class="meta">${t('chat.ctxPanelHash')}: ${String(snapshot.payloadHash || '').slice(0, 12)}</span>
      <span class="meta">${formatContextSize(snapshot.payloadLength)}</span></div>`;
  }

  _renderGroups(snapshot) {
    if (!snapshot) return nothing;
    return groupContextEntries(snapshot).map((group) => html`
      <h4>${t(`chat.ctxPanelCat_${group.id}`)} (${group.entries.length})</h4>
      ${group.entries.length ? group.entries.map((row) => html`
        <div class="row"><span class="name">${row.relPath}</span>
          <span class="meta">${row.kind} · ${formatContextSize(row.sizeBytes)} · ${t(`chat.ctxPanelReason_${row.reason}`) === `chat.ctxPanelReason_${row.reason}` ? row.reason : t(`chat.ctxPanelReason_${row.reason}`)}</span></div>`)
        : html`<p class="hint">—</p>`}`);
  }

  render() {
    const verdict = compareSendWithPreview(this._latest, this._preview);
    return html`
      <div class="toolbar"><cr-bar-button @click=${() => this.refresh()} ?disabled=${this._loading}>${t('chat.ctxPanelRefresh')}</cr-bar-button></div>
      <p class="hint">${t('chat.ctxPanelNoReadEvidence')}</p>
      ${this._error ? html`<p class="warn">${this._error}</p>` : nothing}
      ${this._renderSummary(t('chat.ctxPanelLastSend'), this._latest)}
      ${this._latest?.delivery?.matchesAssembler === false ? html`<p class="warn">${t('chat.ctxPanelDrift')}</p>` : nothing}
      ${this._latest?.preview?.changedSincePreview ? html`<p class="warn">${t('chat.ctxPanelChangedSincePreview')}</p>` : nothing}
      ${this._renderSummary(t('chat.ctxPanelNextSend'), this._preview)}
      ${verdict === 'changed' ? html`<p class="warn">${t('chat.ctxPanelChangedFromLast')}</p>` : nothing}
      ${this._renderGroups(this._preview)}
      ${this._renderConfig()}`;
  }
}

if (!customElements.get('cr-chat-context-panel')) customElements.define('cr-chat-context-panel', CrChatContextPanel);
export { CrChatContextPanel };
