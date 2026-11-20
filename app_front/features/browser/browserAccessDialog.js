import { LitElement, css, html, nothing } from 'lit';
import '../../components/ui/index.js';
import { apiFetchJson } from '../../core/api/runtime.js';
import { t } from '../../i18n/index.js';

/** One global queue covers requests from chats outside the current panel/workspace. */
export class CrBrowserAccessDialog extends LitElement {
  static properties = {
    _prompts: { state: true },
    _busy: { state: true },
    _error: { state: true },
  };

  static styles = css`
    :host { --cr-dialog-max-width: 30rem; }
    p { margin: 0 0 var(--cr-space-3); font-size: var(--cr-font-size-sm); overflow-wrap: anywhere; }
    .detail { color: var(--cr-text-muted); }
    .actions { display: flex; flex-wrap: wrap; gap: var(--cr-space-2); }
    .error { color: var(--cr-error); }
  `;

  constructor() {
    super();
    this._prompts = [];
    this._busy = false;
    this._error = false;
    this._reading = false;
    this._refresh = () => { void this.refresh(); };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('cretli:browser-consent', this._refresh);
    window.addEventListener('online', this._refresh);
    document.addEventListener('visibilitychange', this._refresh);
    // The global queue also works with no chat socket, for example in Settings.
    this._timer = setInterval(this._refresh, 5000);
    this._refresh();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    window.removeEventListener('cretli:browser-consent', this._refresh);
    window.removeEventListener('online', this._refresh);
    document.removeEventListener('visibilitychange', this._refresh);
    super.disconnectedCallback();
  }

  async refresh() {
    if (document.hidden || this._reading || this._busy) return;
    this._reading = true;
    try {
      const result = await apiFetchJson('/api/browser/requests', undefined, 'getBrowserRequests');
      const prompts = Array.isArray(result?.prompts) ? result.prompts : [];
      if (prompts[0]?.id !== this._prompts[0]?.id) this._error = false;
      this._prompts = prompts;
    } catch {
      // Reconnect/visibility and the next poll retry without granting anything.
    } finally {
      this._reading = false;
    }
  }

  async answer(prompt, decision) {
    if (this._busy) return;
    this._busy = true;
    this._error = false;
    const kind = prompt.kind === 'chrome' ? 'access' : 'consent';
    try {
      const result = await apiFetchJson(`/api/browser/${kind}/${encodeURIComponent(prompt.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: prompt.chatId, decision }),
      }, 'postBrowserAccess');
      if (result?.ok !== true && result?.code !== 'not-found') {
        this._error = true;
        return;
      }
      window.dispatchEvent(new CustomEvent('cretli:browser-consent', { detail: { chatId: prompt.chatId } }));
    } catch {
      this._error = true;
    } finally {
      this._busy = false;
      await this.refresh();
    }
  }

  render() {
    const prompt = this._prompts[0];
    if (!prompt) return nothing;
    const chrome = prompt.kind === 'chrome';
    return html`<cr-dialog open persistent .heading=${t('chat.browserAccessTitle')}>
      <p>${t('chat.browserAccessChat', { chat: prompt.chatTitle || t('chat.browserAccessUntitled') })}</p>
      <p class="detail">${chrome ? t('chat.browserAccessChrome') : t('chat.browserConsentText', { origin: prompt.origin })}</p>
      ${this._prompts.length > 1 ? html`<p class="detail">${t('chat.browserAccessQueue', { count: this._prompts.length })}</p>` : nothing}
      ${this._error ? html`<p class="error" role="alert">${t('chat.browserConsentError')}</p>` : nothing}
      <div slot="actions" class="actions">
        <cr-bar-button ?disabled=${this._busy} @click=${() => this.answer(prompt, 'deny')}>${t('chat.browserConsentDeny')}</cr-bar-button>
        ${!chrome ? html`<cr-bar-button ?disabled=${this._busy} @click=${() => this.answer(prompt, 'allow')}>${t('chat.browserConsentAlways')}</cr-bar-button>` : nothing}
        <cr-bar-button variant="primary" ?disabled=${this._busy} @click=${() => this.answer(prompt, chrome ? 'allow' : 'once')}>
          ${t(chrome ? 'chat.browserAccessAllow' : 'chat.browserConsentOnce')}
        </cr-bar-button>
      </div>
    </cr-dialog>`;
  }
}

if (!customElements.get('cr-browser-access-dialog')) customElements.define('cr-browser-access-dialog', CrBrowserAccessDialog);

export function initBrowserAccessDialog() {
  if (!document.querySelector('cr-browser-access-dialog')) document.body.appendChild(document.createElement('cr-browser-access-dialog'));
}
