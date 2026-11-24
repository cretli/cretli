import { LitElement, css } from 'lit';
import '../../components/ui/index.js';
import { apiFetchJson } from '../../core/api/runtime.js';
import { renderRunConsentView } from './runConsentView.js';
import { t } from '../../i18n/index.js';

/** Consent for trusted host measurement scripts, restored from the server. */
export const DEVICE_RUN_CONSENT_EVENT = 'cretli:device-run-consent';

class CrDeviceRunConsent extends LitElement {
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
    window.addEventListener(DEVICE_RUN_CONSENT_EVENT, this._onEvent);
    void this.refresh();
  }

  disconnectedCallback() {
    window.removeEventListener(DEVICE_RUN_CONSENT_EVENT, this._onEvent);
    super.disconnectedCallback();
  }

  async refresh() {
    if (!this.chatId) return;
    try {
      const url = `/api/devices/chat-run-consents?chatId=${encodeURIComponent(this.chatId)}`;
      const payload = await apiFetchJson(url, undefined, 'getDeviceRunConsent');
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
      const payload = await apiFetchJson(`/api/devices/chat-run-consents/${encodeURIComponent(prompt.id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: this.chatId, decision }),
      }, 'postDeviceRunConsent');
      if (payload?.ok === false) this._error = true;
    } catch {
      this._error = true;
    }
    this._busyId = '';
    await this.refresh();
  }

  render() {
    return renderRunConsentView(this._prompts, t, this._busyId, this._error, (prompt, decision) => this._answer(prompt, decision));
  }
}

if (!customElements.get('cr-device-run-consent')) customElements.define('cr-device-run-consent', CrDeviceRunConsent);
export { CrDeviceRunConsent };
