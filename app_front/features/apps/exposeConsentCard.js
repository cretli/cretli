import { LitElement, css, html } from 'lit';
import '../../components/ui/index.js';
import { apiFetchJson } from '../../core/api/runtime.js';
import { t } from '../../i18n/index.js';

/** Window event the chat socket dispatches when a chat's port exposure prompts changed. */
export const PORT_EXPOSE_CONSENT_EVENT = 'cretli:port-expose-consent';

/**
 * Prompt shown in the chat when an agent asks to expose a port to the LAN and the
 * policy is `ask`. Answers: allow once, deny. The server owns the pending list,
 * so a reload or reconnect restores the card; this element only mirrors it.
 */
class CrExposeConsent extends LitElement {
  static properties = {
    chatId: { type: String, attribute: 'chat-id' },
    _prompts: { state: true },
    _busyId: { state: true },
    _error: { state: true },
  };

  static styles = css`
    :host { display: block; }
    :host([hidden]) { display: none; }
    .prompt {
      margin: var(--cr-space-2) 0;
      padding: var(--cr-space-3);
      border: 1px solid var(--cr-border-strong);
      border-radius: var(--cr-radius-sm);
      background: var(--cr-surface);
      color: var(--cr-text);
      font-size: var(--cr-font-size-sm);
    }
    .text { margin: 0 0 var(--cr-space-2); overflow-wrap: anywhere; }
    .hint { margin: 0 0 var(--cr-space-2); color: var(--cr-text-muted); overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: var(--cr-space-2); }
    .error { margin: var(--cr-space-2) 0 0; color: var(--cr-error); }
  `;

  constructor() {
    super();
    this.chatId = '';
    this._prompts = [];
    this._busyId = '';
    this._error = false;
    this._onEvent = (event) => {
      const target = String(event?.detail?.chatId || '');
      if (target && target === this.chatId) void this.refresh();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(PORT_EXPOSE_CONSENT_EVENT, this._onEvent);
    void this.refresh();
  }

  disconnectedCallback() {
    window.removeEventListener(PORT_EXPOSE_CONSENT_EVENT, this._onEvent);
    super.disconnectedCallback();
  }

  async refresh() {
    if (!this.chatId) return;
    try {
      const url = `/api/port-exposures/consent?chatId=${encodeURIComponent(this.chatId)}`;
      const payload = await apiFetchJson(url, undefined, 'getPortExposeConsent');
      this._prompts = Array.isArray(payload?.prompts) ? payload.prompts : [];
    } catch {
      // The next live frame retries; a failed read must not break the chat.
    }
    this.hidden = this._prompts.length === 0;
  }

  async _answer(prompt, decision) {
    this._busyId = prompt.id;
    this._error = false;
    try {
      const payload = await apiFetchJson(`/api/port-exposures/consent/${encodeURIComponent(prompt.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: this.chatId, decision }),
      }, 'postPortExposeConsent');
      if (payload?.ok === false) this._error = true;
    } catch {
      this._error = true;
    }
    this._busyId = '';
    await this.refresh();
  }

  render() {
    return html`${this._prompts.map((prompt) => html`
      <div class="prompt" role="group" data-port-expose-consent>
        <p class="text">${t('chat.portExposeConsentText', { port: prompt.port })}</p>
        ${prompt.reason ? html`<p class="hint">${t('chat.portExposeConsentReason', { reason: prompt.reason })}</p>` : ''}
        ${prompt.ttlMs ? html`<p class="hint">${t('chat.portExposeConsentTtl', { minutes: Math.max(1, Math.round(prompt.ttlMs / 60000)) })}</p>` : ''}
        <div class="actions">
          <cr-bar-button variant="primary" ?disabled=${this._busyId === prompt.id}
            @click=${() => this._answer(prompt, 'once')}>${t('chat.portExposeConsentOnce')}</cr-bar-button>
          <cr-bar-button ?disabled=${this._busyId === prompt.id}
            @click=${() => this._answer(prompt, 'deny')}>${t('chat.portExposeConsentDeny')}</cr-bar-button>
        </div>
        ${this._error ? html`<p class="error" data-tone="error">${t('chat.portExposeConsentError')}</p>` : ''}
      </div>`)}`;
  }
}

if (!customElements.get('cr-expose-consent')) customElements.define('cr-expose-consent', CrExposeConsent);
export { CrExposeConsent };
