import { LitElement, html, nothing } from 'lit';
import { t } from '../../i18n/index.js';
import { cretliApiFetch } from '../../lib/cretliApiRequest.js';
import '../../components/ui/index.js';
import './supervisor-settings.scss';

const STATES = {
  running: 'settings.supervisorRunning', backoff: 'settings.supervisorBackoff',
  crash_loop: 'settings.supervisorCrashLoop', starting: 'settings.supervisorStarting',
  stopping: 'settings.supervisorStopping', stopped: 'settings.supervisorStopped',
};

class CrSupervisorSettings extends LitElement {
  static properties = {
    data: { state: true }, logs: { state: true }, busy: { state: true },
    message: { state: true }, error: { state: true }, pending: { state: true },
  };

  constructor() {
    super();
    this.data = null; this.logs = null; this.busy = false;
    this.message = ''; this.error = false; this.pending = ''; this.logsOpen = false;
    this.refreshing = false;
    this.refreshError = false;
  }

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible' && this.getClientRects().length) void this.refresh();
    }, 5000);
  }

  disconnectedCallback() { clearInterval(this.timer); super.disconnectedCallback(); }

  async request(suffix = '', init) {
    const response = await cretliApiFetch(`/api/settings/supervisor${suffix}`, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.code || 'unavailable');
    return body;
  }

  async refresh() {
    if (this.refreshing || this.busy) return;
    this.refreshing = true;
    try {
      this.data = await this.request();
      if (this.refreshError) { this.message = ''; this.error = false; this.refreshError = false; }
      if (this.logsOpen) this.logs = await this.request('/logs');
    } catch { this.message = t('settings.supervisorError'); this.error = true; this.refreshError = true; }
    finally { this.refreshing = false; }
  }

  async apply() {
    if (this.busy || !this.pending) return;
    const action = this.pending;
    this.busy = true; this.error = false; this.refreshError = false;
    try {
      await this.request('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, confirm: true }) });
      this.pending = '';
      this.message = t(action === 'restart' ? 'settings.supervisorRestartAccepted' : 'settings.supervisorChangeAccepted');
    } catch (error) {
      this.error = true;
      this.message = t(error.message.startsWith('update.') || error.message === 'busy'
        ? 'settings.supervisorBusy' : 'settings.supervisorError');
    } finally { this.busy = false; if (!this.error) void this.refresh(); }
  }

  render() {
    const s = this.data?.supervisor;
    const controlled = s?.active && !s.stale && s.controlVersion === 1;
    const disabled = this.busy || this.data?.restarting;
    const date = (value) => value ? new Date(value).toLocaleString() : t('settings.autostartNoData');
    return html`<div class="cr-card supervisor-settings-card">
      <div class="supervisor-settings-heading">
        <h3 class="cr-section-title">${t('settings.supervisorTitle')}</h3>
        <cr-bar-button ?disabled=${this.busy} @click=${() => this.refresh()}>${t('settings.autostartRefresh')}</cr-bar-button>
      </div>
      ${s ? html`
        <p class="supervisor-settings-status" data-tone=${s.safeMode ? 'error' : s.enabled ? 'success' : 'muted'}>
          ${t(!s.active ? 'settings.autostartInactive' : !s.enabled ? 'settings.supervisorPaused' : STATES[s.state] || 'settings.autostartActive')}
        </p>
        <dl class="supervisor-settings-facts">
          <dt>${t('settings.supervisorPid')}</dt><dd>${s.pid ?? '—'}</dd>
          <dt>${t('settings.supervisorServerPid')}</dt><dd>${s.childPid ?? '—'}</dd>
          <dt>${t('settings.supervisorStarted')}</dt><dd>${date(s.startedAt)}</dd>
          <dt>${t('settings.autostartLastCrash')}</dt><dd>${date(s.lastCrash?.at)} ${s.lastCrash?.reason || ''}</dd>
          <dt>${t('settings.autostartLastLoop')}</dt><dd>${date(s.crashLoopAt)} ${s.crashLoopReason || ''}</dd>
        </dl>
        ${s.safeMode ? html`<p class="cr-hint">${t('settings.supervisorSafeMode')}</p>` : nothing}
        ${s.busy ? html`<p class="cr-hint">${t(s.busy === 'boot' ? 'settings.supervisorBootBusy' : 'settings.supervisorLoopBusy')}</p>` : nothing}
        ${s.active && !controlled ? html`<p class="cr-hint">${t('settings.supervisorLegacy')}</p>` : nothing}
        <div class="supervisor-settings-actions">
          <cr-bar-button ?disabled=${disabled || (s.active && (!controlled || s.enabled))}
            @click=${() => { this.pending = s.active ? 'enable' : 'restart'; }}>${t(s.active ? 'settings.supervisorEnable' : 'settings.supervisorStart')}</cr-bar-button>
          <cr-bar-button ?disabled=${disabled || !controlled || !s.enabled}
            @click=${() => { this.pending = 'disable'; }}>${t('settings.supervisorDisable')}</cr-bar-button>
          <cr-bar-button ?disabled=${disabled} @click=${() => { this.pending = 'restart'; }}>${t('settings.supervisorRestart')}</cr-bar-button>
        </div>
        <p class="cr-hint">${t('settings.supervisorDisableHint')}</p>
      ` : html`<p>${t('settings.loading')}</p>`}
      <p class="cr-status" role="status" data-tone=${this.error ? 'error' : 'success'}>${this.message}</p>
      <details @toggle=${(event) => { this.logsOpen = event.target.open; if (this.logsOpen) void this.refresh(); }}>
        <summary>${t('settings.supervisorLogs')}</summary>
        <p class="cr-hint">${t('settings.supervisorLogsHint')}</p>
        <h4>${t('settings.supervisorEvents')}</h4>
        <pre tabindex="0" aria-label=${t('settings.supervisorEvents')}>${this.logs?.events || t('settings.supervisorNoLogs')}</pre>
        <h4>${t('settings.supervisorServerLog')}</h4>
        <pre tabindex="0" aria-label=${t('settings.supervisorServerLog')}>${this.logs?.server || t('settings.supervisorNoLogs')}</pre>
      </details>
      <cr-dialog .open=${Boolean(this.pending)} .heading=${t('settings.supervisorTitle')}
        @cr-dialog-close=${() => { if (!this.busy) this.pending = ''; }}>
        <p>${t(this.pending === 'restart' ? 'settings.supervisorConfirmRestart' : this.pending === 'disable'
          ? 'settings.supervisorConfirmDisable' : 'settings.supervisorConfirmEnable')}</p>
        ${this.error ? html`<p class="cr-status" role="status" data-tone="error">${this.message}</p>` : nothing}
        <cr-bar-button slot="actions" ?disabled=${this.busy} @click=${() => { this.pending = ''; }}>${t('settings.autostartCancel')}</cr-bar-button>
        <cr-bar-button slot="actions" variant="primary" ?disabled=${this.busy} @click=${() => this.apply()}>${t('settings.autostartConfirm')}</cr-bar-button>
      </cr-dialog>
    </div>`;
  }
}

if (!customElements.get('cr-supervisor-settings')) customElements.define('cr-supervisor-settings', CrSupervisorSettings);
export function refreshSupervisorSettings() {
  document.querySelectorAll('cr-supervisor-settings').forEach((panel) => {
    if (panel instanceof CrSupervisorSettings) void panel.refresh();
  });
}
