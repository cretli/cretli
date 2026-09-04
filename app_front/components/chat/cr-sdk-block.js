import { LitElement, css, html } from 'lit';
import { writeTextToClipboard } from '../../lib/clipboard.js';
import { t } from '../../i18n/index.js';

/**
 * Collapsible SDK event block (assistant reply, thinking, tool_call, raw event).
 * One consistent look for every type. The content (Markdown/JSON) is passed in
 * through a slot (light DOM) so the global `.sdk-md`, `.sdk-rich-json` and hljs
 * styles keep working.
 */
class CrSdkBlock extends LitElement {
  static properties = {
    variant: { type: String },
    label: { type: String },
    name: { type: String },
    paths: { type: Array },
    open: { type: Boolean, reflect: true },
    copyText: { type: String, attribute: 'copy-text' },
    createdAt: { type: String, attribute: 'created-at' },
    copied: { type: Boolean, state: true },
    queued: { type: Boolean, reflect: true },
    running: { type: Boolean, reflect: true },
    speakable: { type: Boolean, reflect: true },
    speaking: { type: Boolean, state: true },
  };

  static styles = css`
    :host {
      display: block;
    }

    details {
      border-radius: var(--cr-radius-md, 6px);
      border: 1px solid var(--cr-border);
      background: var(--cr-code-bg);
    }

    summary {
      cursor: pointer;
      padding: 0.35rem 0.5rem;
      list-style: none;
      user-select: none;
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      gap: 0.35rem;
    }

    .summary-main {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      flex: 1;
      min-width: 0;
    }

    .copy-btn {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.45rem;
      height: 1.45rem;
      padding: 0;
      border: 1px solid var(--cr-border-strong);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-surface);
      color: var(--cr-text-muted);
      cursor: pointer;
    }

    .copy-btn:hover {
      background: var(--cr-hover);
      border-color: var(--cr-border-control);
      color: var(--cr-text);
    }

    .copy-btn:focus {
      outline: none;
      border-color: var(--cr-input-focus-border);
    }

    .copy-btn svg {
      display: block;
      width: 0.82rem;
      height: 0.82rem;
    }

    .copy-btn.is-copied {
      color: var(--cr-success);
      border-color: var(--cr-success-border);
    }

    .timestamp {
      flex-shrink: 0;
      margin-left: auto;
      color: var(--cr-text-muted);
      font-family: var(--terminal-font-family, var(--cr-font-mono, Consolas, Monaco, monospace));
      font-size: 0.68rem;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .action-btn {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.45rem;
      height: 1.45rem;
      padding: 0;
      border: 1px solid var(--cr-border-strong);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-surface);
      color: var(--cr-text-muted);
      cursor: pointer;
    }

    .action-btn:hover {
      background: var(--cr-hover);
      border-color: var(--cr-border-control);
      color: var(--cr-text);
    }

    .action-btn:focus {
      outline: none;
      border-color: var(--cr-input-focus-border);
    }

    .action-btn svg {
      display: block;
      width: 0.82rem;
      height: 0.82rem;
    }

    .action-btn--force:hover {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .action-btn--remove:hover {
      color: var(--cr-error);
      border-color: var(--cr-error-border);
    }

    .action-btn--speak.is-speaking {
      color: var(--cr-accent);
      border-color: var(--cr-accent);
    }

    summary::-webkit-details-marker {
      display: none;
    }

    .badge {
      display: inline-block;
      font-size: 0.72rem;
      padding: 0.12rem 0.38rem;
      border-radius: var(--cr-radius-sm, 4px);
      font-weight: 600;
    }

    .badge.ok {
      background: var(--cr-success-bg);
      color: var(--cr-success);
    }
    .badge.run {
      background: var(--cr-warn-bg);
      color: var(--cr-warn);
    }
    .badge.err {
      background: var(--cr-error-bg);
      color: var(--cr-error);
    }
    .badge.warn {
      background: var(--cr-warn-bg);
      color: var(--cr-warn);
    }
    .badge.thinking {
      background: var(--cr-success-bg);
      color: var(--cr-success);
    }
    .badge.status {
      background: var(--cr-status-bg);
      color: var(--cr-status);
    }
    .badge.assistant {
      background: var(--cr-info-bg);
      color: var(--cr-info);
    }
    .badge.plan {
      background: var(--cr-plan-bg);
      color: var(--cr-plan);
    }
    .badge.muted {
      background: var(--cr-neutral-bg);
      color: var(--cr-neutral);
    }
    .badge.user {
      background: var(--cr-info-bg);
      color: var(--cr-info);
    }

    .spinner {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 0.85rem;
      height: 0.85rem;
      color: var(--cr-success);
    }

    .spinner svg {
      width: 100%;
      height: 100%;
      animation: cr-sdk-spin 0.8s linear infinite;
    }

    @keyframes cr-sdk-spin {
      to {
        transform: rotate(360deg);
      }
    }

    .name {
      font-weight: 700;
      color: var(--cr-text);
      font-size: 0.82rem;
    }

    .paths {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 0.3rem;
    }

    .paths code {
      font-family: var(--terminal-font-family, var(--cr-font-mono, Consolas, Monaco, monospace));
      font-size: 0.72rem;
      color: var(--cr-code-string);
      background: var(--cr-bg);
      padding: 0.05rem 0.3rem;
      border-radius: 3px;
      word-break: break-all;
    }

    .body {
      padding: 0.45rem var(--cr-sdk-body-pad-x, 0.55rem) var(--cr-sdk-body-pad-x, 0.55rem);
      border-top: 1px solid var(--cr-border);
    }
  `;

  constructor() {
    super();
    this.variant = 'muted';
    this.label = '';
    this.name = '';
    this.paths = [];
    this.open = false;
    this.copyText = '';
    this.createdAt = '';
    this.copied = false;
    this.queued = false;
    this.running = false;
    this.speakable = false;
    this.speaking = false;
    this._copyResetTimer = 0;
    this._speakToken = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this._onLangChanged = () => this.requestUpdate();
    window.addEventListener('cr-lang-changed', this._onLangChanged);
    this._onVoiceSpeaking = (event) => {
      const detail = event?.detail || {};
      if (!this._speakToken || detail.token !== this._speakToken) {
        if (detail.active === false) this.speaking = false;
        return;
      }
      this.speaking = detail.active === true;
    };
    window.addEventListener('cr-voice-speaking', this._onVoiceSpeaking);
  }

  disconnectedCallback() {
    window.removeEventListener('cr-lang-changed', this._onLangChanged);
    window.removeEventListener('cr-voice-speaking', this._onVoiceSpeaking);
    super.disconnectedCallback();
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  normalizeVariant(value) {
    const allowed = ['ok', 'run', 'err', 'warn', 'thinking', 'status', 'assistant', 'plan', 'muted', 'user'];
    const v = String(value || '').toLowerCase();
    return allowed.includes(v) ? v : 'muted';
  }

  handleToggle(event) {
    this.open = !!event.target.open;
  }

  /**
   * @param {MouseEvent} event
   */
  handleCopyClick(event) {
    event.preventDefault();
    event.stopPropagation();
    void this.copyBlockContent();
  }

  handleForceSendClick(event) {
    event.preventDefault();
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent('cr-sdk-block-force-send', { bubbles: true, composed: true }));
  }

  handleRemoveClick(event) {
    event.preventDefault();
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent('cr-sdk-block-remove', { bubbles: true, composed: true }));
  }

  handleSpeakClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const text = this.getBlockCopyText();
    if (!text) return;
    if (!this._speakToken) this._speakToken = `sdk-block-${Math.random().toString(36).slice(2)}`;
    this.dispatchEvent(
      new CustomEvent('cr-sdk-block-speak', {
        bubbles: true,
        composed: true,
        detail: { text, token: this._speakToken },
      })
    );
  }

  /**
   * @returns {string}
   */
  getBlockCopyText() {
    const explicit = String(this.copyText || '').trim();
    if (explicit) return explicit;

    const md = this.querySelector('.sdk-md[data-raw-md]');
    if (md?.dataset?.rawMd) return md.dataset.rawMd;

    const thinking = this.querySelector('.sdk-rich-thinking-pre');
    if (thinking) return thinking.textContent || '';

    const userBody = this.querySelector('.sdk-rich-user-body');
    if (userBody) return userBody.innerText || '';

    const pres = this.querySelectorAll('pre.sdk-rich-json, pre.sdk-rich-todos');
    if (pres.length > 0) {
      return Array.from(pres)
        .map((node) => node.textContent || '')
        .filter(Boolean)
        .join('\n\n')
        .trimEnd();
    }

    return Array.from(this.children)
      .map((node) => node.innerText || '')
      .join('\n')
      .trimEnd();
  }

  async copyBlockContent() {
    const text = this.getBlockCopyText();
    if (!text) return false;

    const ok = await writeTextToClipboard(text);
    if (!ok) return false;

    this.copied = true;
    if (this._copyResetTimer) window.clearTimeout(this._copyResetTimer);
    this._copyResetTimer = window.setTimeout(() => {
      this.copied = false;
      this._copyResetTimer = 0;
    }, 1500);
    return true;
  }

  getTimestampMeta() {
    const raw = String(this.createdAt || '').trim();
    if (!raw) return null;
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return null;
    return {
      label: date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
      title: date.toISOString(),
    };
  }

  render() {
    const variant = this.normalizeVariant(this.variant);
    const paths = Array.isArray(this.paths) ? this.paths : [];
    const timestamp = this.getTimestampMeta();
    const copyLabel = this.copied ? t('sdkBlock.copied') : t('sdkBlock.copyContent');
    return html`
      <details ?open=${this.open} @toggle=${this.handleToggle}>
        <summary>
          <span class="summary-main">
            ${this.label ? html`<span class="badge ${variant}">${this.label}</span>` : null}
            ${this.running
              ? html`<span class="spinner" aria-hidden="true"
                  ><svg viewBox="0 0 24 24" aria-hidden="true"
                    ><path fill="currentColor" d="M12 4V2a10 10 0 0 1 0 20V20a8 8 0 0 0 0-16Z"
                  /></svg></span
                >`
              : null}
            ${this.name ? html`<span class="name">${this.name}</span>` : null}
            ${paths.length > 0
              ? html`<span class="paths">${paths.map((p) => html`<code>${p}</code>`)}</span>`
              : null}
          </span>
          ${timestamp
            ? html`<time class="timestamp" datetime=${timestamp.title} title=${timestamp.title}
                >${timestamp.label}</time
              >`
            : null}
          <button
            type="button"
            class="copy-btn ${this.copied ? 'is-copied' : ''}"
            title=${copyLabel}
            aria-label=${copyLabel}
            @click=${this.handleCopyClick}
            @mousedown=${(event) => event.stopPropagation()}
          >
            ${this.copied
              ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 7L9 19l-5.5-5.5 1.41-1.41L9 16.17 19.59 5.59 21 7z"/></svg>`
              : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 21H8V7H19M19 5H8A2 2 0 0 0 6 7V21A2 2 0 0 0 8 23H19A2 2 0 0 0 21 21V7A2 2 0 0 0 19 5M16 1H4A2 2 0 0 0 2 3V17H4V3H16V1Z"/></svg>`}
          </button>
          ${this.speakable
            ? html`
                <button
                  type="button"
                  class="action-btn action-btn--speak ${this.speaking ? 'is-speaking' : ''}"
                  title=${this.speaking ? t('sdkBlock.stopReading') : t('sdkBlock.readAloud')}
                  aria-label=${this.speaking ? t('sdkBlock.stopReading') : t('sdkBlock.readAloud')}
                  @click=${this.handleSpeakClick}
                  @mousedown=${(event) => event.stopPropagation()}
                >
                  ${this.speaking
                    ? html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 6h12v12H6z"/></svg>`
                    : html`<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4-.91 7-4.49 7-8.77s-3-7.86-7-8.77M16.5 12c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.74 2.5-2.25 2.5-4.02M3 9v6h4l5 5V4L7 9H3z"/></svg>`}
                </button>`
            : null}
          ${this.queued
            ? html`
                <button
                  type="button"
                  class="action-btn action-btn--force"
                  title=${t('sdkBlock.forceSendTitle')}
                  aria-label=${t('sdkBlock.forceSend')}
                  @click=${this.handleForceSendClick}
                  @mousedown=${(event) => event.stopPropagation()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>
                </button>
                <button
                  type="button"
                  class="action-btn action-btn--remove"
                  title=${t('sdkBlock.removeFromQueue')}
                  aria-label=${t('sdkBlock.removeFromQueue')}
                  @click=${this.handleRemoveClick}
                  @mousedown=${(event) => event.stopPropagation()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3v1H4v2h1v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5V3H9zm0 5h2v10H9V8zm4 0h2v10h-2V8z"/></svg>
                </button>`
            : null}
        </summary>
        <div class="body"><slot></slot></div>
      </details>
    `;
  }
}

if (!customElements.get('cr-sdk-block')) {
  customElements.define('cr-sdk-block', CrSdkBlock);
}
