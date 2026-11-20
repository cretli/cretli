import { LitElement, css, html } from 'lit';
import { loadPermissionPanelState } from './permissionPanelState.js';
import '../../components/ui/index.js';
import { t } from '../../i18n/index.js';
import { normalizeHarnessPermissionControls, PERMISSION_CONTROL_CATEGORIES, PERMISSION_HARNESS_LABELS, GATED_PERMISSION_HARNESSES } from '../../../lib/approval/harness-permission-controls.ts';
import { getSettings, patchSettings, getPermissionGrants, revokePermissionGrants } from '../../core/api/index.js';

/** Settings list for human permission grants belonging to one harness. */
class CrPermissionGrants extends LitElement {
  static properties = {
    harness: { type: String },
    grants: { state: true },
    busy: { state: true },
    error: { state: true },
    controls: { state: true },
    saved: { state: true },
    controlsError: { state: true },
    grantsError: { state: true },
  };
  static styles = css`
    :host { display: block; color: var(--cr-text); font-family: var(--cr-font-ui); }
    .controls { display: grid; gap: var(--cr-space-2); margin-bottom: var(--cr-space-4); }
    h3 { font-size: 1rem; margin: 0 0 var(--cr-space-2); }
    p { font-size: 0.85rem; color: var(--cr-text-muted); }
    .actions, .row { display: flex; gap: var(--cr-space-2); align-items: center; flex-wrap: wrap; }
    .row { border: 1px solid var(--cr-border-strong); border-radius: var(--cr-radius-sm); padding: var(--cr-space-3); margin-top: var(--cr-space-2); }
    .details { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .meta { font-size: 0.8rem; color: var(--cr-text-muted); margin-top: var(--cr-space-1); }
    [data-tone="error"] { color: var(--cr-error); }
  `;
  constructor() {
    super();
    this.harness = '';
    this.grants = [];
    this.busy = false;
    this.error = false;
    this.controls = null;
    this.saved = false;
    this.controlsError = '';
    this.grantsError = '';
  }
  /** Reload on tab opening so grants created in other chats are visible. */
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    this.error = false;
    try {
      const state = await loadPermissionPanelState({ harness: this.harness, getSettings, getPermissionGrants });
      this.controls = state.controls;
      this.controlsError = state.controlsError;
      this.grants = state.grants;
      this.grantsError = state.grantsError;
      this.saved = false;
    } finally {
      this.busy = false;
    }
  }

  /** Revoke only the ids displayed when the user clicked the button. */
  async revoke(ids) {
    if (this.busy || !ids.length) return;
    this.busy = true;
    this.error = false;
    this.grantsError = '';
    try {
      const data = await revokePermissionGrants(ids);
      if (!data?.ok) throw new Error('Grant revocation failed');
      this.grants = this.grants.filter((grant) => !ids.includes(grant.id));
    } catch {
      this.error = true;
    } finally {
      this.busy = false;
    }
  }
  /** Save a single category without overwriting concurrent edits to other settings. */
  async saveControl(key, checked) {
    if (this.busy || !this.controls) return;
    this.busy = true;
    this.error = false;
    this.controlsError = '';
    this.saved = false;
    try {
      const data = await patchSettings({ harnessPermissionControls: { [this.harness || 'opencode']: { [key]: checked } } });
      if (!data?.ok || !data.harnessPermissionControls) throw new Error('Permission controls save failed');
      this.controls = normalizeHarnessPermissionControls(data.harnessPermissionControls)[this.harness || 'opencode'];
      this.saved = true;
    } catch {
      this.error = true;
      this.requestUpdate();
    } finally {
      this.busy = false;
    }
  }
  render() {
    const harnessLabel = PERMISSION_HARNESS_LABELS[this.harness || 'opencode'] || this.harness;
    if (!GATED_PERMISSION_HARNESSES.includes(this.harness || 'opencode')) {
      return html`<h3>${t('settings.permissionControlsTitle', { harness: harnessLabel })}</h3><p role="status">${t('settings.permissionControlsUnavailable')}</p>`;
    }
    return html`
      <h3>${t('settings.permissionControlsTitle', { harness: harnessLabel })}</h3>
      <p>${t('settings.permissionControlsHint')}</p>
      ${this.controlsError ? html`<p role="alert" data-tone="error">${t(`settings.permissionControlsError_${this.controlsError}`)}</p>` : ''}
      <div class="controls">
        ${['enabled', ...PERMISSION_CONTROL_CATEGORIES].map((key) => html`
          <cr-checkbox .checked=${this.controls?.[key] !== false}
            ?disabled=${this.busy || !this.controls || (key !== 'enabled' && !this.controls.enabled)}
            @change=${(event) => {
              const checked = event.target.checked;
              event.target.checked = this.controls?.[key] !== false;
              void this.saveControl(key, checked);
            }}>
            ${t(`settings.permissionControl_${key}`)}
          </cr-checkbox>
        `)}
      </div>
      <div role="status" aria-live="polite">${this.saved ? t('settings.permissionControlsSaved') : ''}</div>
      <h3>${t('settings.permissionGrantsTitle')}</h3>
      <p>${t('settings.permissionGrantsHint')}</p>
      <div class="actions">
        <cr-bar-button ?disabled=${this.busy} @click=${() => this.refresh()}>${t('settings.permissionGrantsRefresh')}</cr-bar-button>
        <cr-bar-button ?disabled=${this.busy || !this.grants.length} @click=${() => this.revoke(this.grants.map((grant) => grant.id))}>${t('settings.permissionGrantsRevokeAll')}</cr-bar-button>
      </div>
      <div role="status" aria-live="polite" aria-busy=${this.busy}>
        ${this.error ? html`<p data-tone="error">${t('settings.permissionGrantsError')}</p>` : ''}
        ${this.grantsError ? html`<p role="alert" data-tone="error">${t('settings.permissionGrantsLoadError')}</p>` : ''}
        ${!this.grants.length && !this.busy && !this.error && !this.grantsError ? html`<p>${t('settings.permissionGrantsEmpty')}</p>` : ''}
        ${this.grants.map((grant) => html`
          <div class="row">
            <div class="details">
              <strong>${PERMISSION_HARNESS_LABELS[grant.harness] || t('settings.permissionGrantsLegacy')}</strong>
              <div>${t(`settings.permissionGrantsScope_${grant.scope}`)}</div>
              ${grant.toolName ? html`<div class="meta">${grant.toolName}</div>` : ''}
              ${grant.workspace ? html`<div class="meta">${t('settings.permissionGrantsWorkspace')}: ${grant.workspace}</div>` : ''}
              <div class="meta">${grant.createdAt ? new Date(grant.createdAt).toLocaleString() : ''} · ${grant.id.slice(0, 12)}</div>
            </div>
            <cr-bar-button ?disabled=${this.busy} @click=${() => this.revoke([grant.id])}>${t('settings.permissionGrantsRevoke')}</cr-bar-button>
          </div>
        `)}
      </div>
    `;
  }
}
if (!customElements.get('cr-permission-grants')) customElements.define('cr-permission-grants', CrPermissionGrants);
export { CrPermissionGrants };
