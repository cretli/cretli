import { LitElement, html, svg } from 'lit';
import '../components/ui/index.js';
import { initTheme } from '../theme.js';
import { t, getCurrentLang, initI18n, setLang, AVAILABLE_LANGS } from '../i18n/index.js';
import './login.scss';

// Inlined (Material Design Icons "shield-key") so the login page does not have
// to pull in the whole icon font — one glyph is not worth ~740 KB pre-auth.
const SHIELD_KEY_ICON = svg`<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor" aria-hidden="true"><path d="M12,8A1,1 0 0,1 13,9A1,1 0 0,1 12,10A1,1 0 0,1 11,9A1,1 0 0,1 12,8M21,11C21,16.55 17.16,21.74 12,23C6.84,21.74 3,16.55 3,11V5L12,1L21,5V11M12,6A3,3 0 0,0 9,9C9,10.31 9.83,11.42 11,11.83V18H13V16H15V14H13V11.83C14.17,11.42 15,10.31 15,9A3,3 0 0,0 12,6Z"/></svg>`;

/**
 * Login/setup page as a Lit component (light DOM).
 * Light DOM so the global .mdi (MDI) and --cr-* tokens from login.scss work.
 * Reuses cr-dialog + cr-bar-input + cr-bar-button (shared design system).
 * Flow: /api/auth-status -> setup or login -> redirect to the SPA.
 */
class CrLoginApp extends LitElement {
  static properties = {
    mode: { state: true },
    error: { state: true },
    info: { state: true },
    submitting: { state: true },
    _password: { state: true },
    _confirm: { state: true },
    _setupToken: { state: true },
    _setupTokenRequired: { state: true },
  };

  constructor() {
    super();
    this.mode = 'loading';
    this.error = '';
    this.info = '';
    this.submitting = false;
    this._password = '';
    this._confirm = '';
    this._setupToken = '';
    this._setupTokenRequired = false;
    this._next = this._resolveNext();
    this._focused = false;
  }

  _isWidgetAuth() {
    return Boolean(window.__crWidgetAuth) && this._next.includes('/widget-authorize/');
  }

  _parseWidgetAuthParams() {
    try {
      const url = new URL(this._next, window.location.origin);
      const match = url.pathname.match(/^\/widget-authorize\/([^/]+)$/);
      if (!match) return null;
      const pageSessionId = url.searchParams.get('pageSessionId')?.trim() || '';
      if (!pageSessionId) return null;
      return {
        installationId: decodeURIComponent(match[1]),
        origin: url.searchParams.get('origin')?.trim() || '',
        pageSessionId,
      };
    } catch {
      return null;
    }
  }

  _notifyWidgetAuthorized(payload, targetOrigin) {
    if (!payload || !window.parent || window.parent === window) return;
    window.parent.postMessage(payload, targetOrigin || '*');
  }

  async _completeWidgetAuth() {
    const params = this._parseWidgetAuthParams();
    if (!params) {
      this.error = t('login.loginFailed');
      return false;
    }
    const apiUrl = new URL(
      `/api/widget-authorize/${encodeURIComponent(params.installationId)}`,
      window.location.origin,
    );
    apiUrl.searchParams.set('origin', params.origin);
    apiUrl.searchParams.set('pageSessionId', params.pageSessionId);
    try {
      const r = await fetch(apiUrl.toString(), { credentials: 'include' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok || !data?.widgetAuth) {
        this.error = data?.error || t('login.loginFailed');
        return false;
      }
      this._notifyWidgetAuthorized(data.widgetAuth, params.origin);
      this.info = t('login.widgetAuthDone');
      this.submitting = false;
      return true;
    } catch {
      this.error = t('login.networkError');
      this.submitting = false;
      return false;
    }
  }

  /** Safe redirect target after login — same-origin path only, never /login. */
  _resolveNext() {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const next = (params.get('next') || '').trim();
      if (!next) return '/';
      const parsed = new URL(next, window.location.origin);
      if (parsed.origin !== window.location.origin) return '/';
      if (parsed.pathname === '/login' || parsed.pathname.startsWith('/login/')) return '/';
      return `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
    } catch {
      return '/';
    }
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void initI18n().then(() => this.requestUpdate());
    initTheme();
    this._onLangChanged = () => this.requestUpdate();
    window.addEventListener('cr-lang-changed', this._onLangChanged);
    this._checkStatus();
  }

  disconnectedCallback() {
    super.disconnectedCallback?.();
    if (this._onLangChanged) window.removeEventListener('cr-lang-changed', this._onLangChanged);
  }

  _onLangChange(e) {
    void setLang(e.target.value);
  }

  async _checkStatus() {
    try {
      const r = await fetch('/api/auth-status', { credentials: 'include' });
      const data = await r.json();
      if (!data || !data.ok) {
        this.mode = 'login';
        return;
      }
      if (!data.configured) {
        this._setupTokenRequired = data.setupTokenRequired === true;
        this.mode = 'setup';
        return;
      }
      if (data.authRequired === false) {
        if (this._isWidgetAuth()) {
          const ok = await this._completeWidgetAuth();
          if (!ok) this.mode = 'login';
          return;
        }
        window.location.replace(this._next);
        return;
      }
      this.mode = 'login';
    } catch {
      this.mode = 'login';
    }
  }

  _onPasswordInput(e) {
    this._password = e.target.value ?? '';
    this.error = '';
  }

  _onConfirmInput(e) {
    this._confirm = e.target.value ?? '';
    this.error = '';
  }

  _onSetupTokenInput(e) {
    this._setupToken = e.target.value ?? '';
    this.error = '';
  }

  /** Enter in the field = submit (better than waiting for a tap on mobile). */
  _onFieldKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this._submit();
    }
  }

  /** Autofocus the password field once the mode (login/setup) is set. */
  updated(changed) {
    super.updated?.(changed);
    if (this._focused) return;
    if (this.mode !== 'login' && this.mode !== 'setup') return;
    const el = this.querySelector('#cr-login-password');
    if (el && typeof el.focus === 'function') {
      this._focused = true;
      setTimeout(() => el.focus(), 0);
    }
  }

  _canSubmit() {
    if (this.submitting || this.mode === 'loading') return false;
    if (!this._password || this._password.length < 8) return false;
    if (this.mode === 'setup' && this._password !== this._confirm) return false;
    if (this.mode === 'setup' && this._setupTokenRequired && !this._setupToken) return false;
    return true;
  }

  async _submit() {
    if (!this._canSubmit()) return;
    this.submitting = true;
    this.error = '';
    this.info = '';
    const password = this._password;
    const endpoint = this.mode === 'setup' ? '/api/setup' : '/api/login';
    const widgetParams = this._isWidgetAuth() ? this._parseWidgetAuthParams() : null;
    const requestUrl = widgetParams ? `${endpoint}?widgetAuth=1` : endpoint;
    const requestBody = widgetParams
      ? {
          password,
          widgetAuth: true,
          installationId: widgetParams.installationId,
          origin: widgetParams.origin,
          pageSessionId: widgetParams.pageSessionId,
        }
      : { password };
    if (this.mode === 'setup' && this._setupToken) {
      requestBody.setupToken = this._setupToken;
    }
    try {
      const headers = { 'Content-Type': 'application/json', 'Accept-Language': getCurrentLang() };
      if (this.mode === 'setup' && this._setupToken) {
        headers['X-Setup-Token'] = this._setupToken;
      }
      const r = await fetch(requestUrl, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 200 && data && data.ok) {
        if (widgetParams && data.widgetAuth) {
          this._notifyWidgetAuthorized(data.widgetAuth, widgetParams.origin);
          this.info = t('login.widgetAuthDone');
          this.submitting = false;
          return;
        }
        if (this.mode === 'setup') {
          this.info = t('login.setupDone');
          setTimeout(() => window.location.replace(this._next), 350);
        } else {
          window.location.replace(this._next);
        }
        return;
      }
      this.error =
        (data && data.error) ||
        (this.mode === 'setup' ? t('login.setupFailed') : t('login.loginFailed'));
      this.submitting = false;
    } catch {
      this.error = t('login.networkError');
      this.submitting = false;
    }
  }

  _headingText() {
    return this.mode === 'setup' ? t('login.setupHeading') : t('login.loginHeading');
  }

  _subheading() {
    return this.mode === 'setup' ? t('login.setupSubheading') : t('login.loginSubheading');
  }

  _submitLabel() {
    return this.mode === 'setup' ? t('login.setupButton') : t('login.loginButton');
  }

  _passwordLabel() {
    return this.mode === 'setup' ? t('login.newPasswordLabel') : t('login.passwordLabel');
  }

  render() {
    const message =
      this.error
        ? html`<div class="message" data-tone="error">${this.error}</div>`
        : this.info
          ? html`<div class="message" data-tone="success">${this.info}</div>`
          : null;

    return html`
      <cr-dialog ?open=${true} ?persistent=${true} heading=${this._headingText()}>
        <span slot="icon" class="login-icon" aria-hidden="true">${SHIELD_KEY_ICON}</span>
        <p class="subheading" slot="subheading">${this._subheading()}</p>
        ${message}
        <div class="field">
          <label class="field-label" for="cr-login-password">${this._passwordLabel()}</label>
          <cr-bar-input
            id="cr-login-password"
            type="password"
            placeholder="••••••••"
            aria-label=${this._passwordLabel()}
            autocomplete=${this.mode === 'setup' ? 'new-password' : 'current-password'}
            .value=${this._password}
            @input=${this._onPasswordInput}
            @keydown=${this._onFieldKeyDown}
          ></cr-bar-input>
        </div>
        ${this.mode === 'setup'
          ? html`
              <div class="field">
                <label class="field-label" for="cr-login-confirm">${t('login.confirmLabel')}</label>
                <cr-bar-input
                  id="cr-login-confirm"
                  type="password"
                  placeholder="••••••••"
                  aria-label=${t('login.confirmAria')}
                  autocomplete="new-password"
                  .value=${this._confirm}
                  @input=${this._onConfirmInput}
                  @keydown=${this._onFieldKeyDown}
                ></cr-bar-input>
              </div>
              ${this._setupTokenRequired
                ? html`
                    <div class="field">
                      <label class="field-label" for="cr-login-setup-token">${t('login.setupTokenLabel')}</label>
                      <cr-bar-input
                        id="cr-login-setup-token"
                        type="password"
                        placeholder=${t('login.setupTokenPlaceholder')}
                        aria-label=${t('login.setupTokenLabel')}
                        autocomplete="off"
                        .value=${this._setupToken}
                        @input=${this._onSetupTokenInput}
                        @keydown=${this._onFieldKeyDown}
                      ></cr-bar-input>
                      <p class="hint">${t('login.setupTokenHint')}</p>
                    </div>
                  `
                : null}
            `
          : null}
        <div class="actions" slot="actions">
          <cr-bar-button
            variant="primary"
            ?disabled=${!this._canSubmit()}
            aria-label=${this._submitLabel()}
            @click=${this._submit}
          >
            ${this.submitting ? '…' : this._submitLabel()}
          </cr-bar-button>
        </div>
        ${this.mode === 'setup'
          ? html`<p class="hint">${t('login.setupHint')}</p>`
          : html`<p class="meta">${t('login.loginHint')}</p>`}
        <label class="lang-switch">
          <span class="lang-switch-label">${t('settings.language')}</span>
          <select class="lang-select" @change=${this._onLangChange} .value=${getCurrentLang()}>
            ${AVAILABLE_LANGS.map((l) => html`<option value=${l} ?selected=${getCurrentLang() === l}>${l === 'en' ? 'English' : 'Polski'}</option>`)}
          </select>
        </label>
      </cr-dialog>
    `;
  }
}

if (!customElements.get('cr-login-app')) {
  customElements.define('cr-login-app', CrLoginApp);
}

const root = document.getElementById('login-root');
if (root) {
  root.innerHTML = '';
  root.appendChild(document.createElement('cr-login-app'));
}
