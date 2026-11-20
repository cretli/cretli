/**
 * One-time first-run dialog: chat backend + optional workspace folder.
 * Shown after login when chat has no key and/or no workspace yet.
 */
import { LitElement, html } from 'lit';
import * as api from '../../core/api/index.js';
import { t } from '../../i18n/index.js';
import { refreshHarnessSettingsPanel } from '../settings/models/harnessSettings.js';
import { getHarnessUiMeta, listFirstRunHarnessMeta, normalizeHarnessUiId } from '../../core/harness/harnessUiRegistry.js';
import '../../components/ui/index.js';
import { openFsPicker } from '../../components/ui/cr-fs-picker.js';
import './first-run-setup.scss';

/** @typedef {'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'mistral' | 'zai' | 'mimo' | 'codex' | 'qwen' | 'claude'} FirstRunHarness */

/**
 * @param {unknown} value
 * @returns {FirstRunHarness}
 */
function normalizeHarness(value) {
  return /** @type {FirstRunHarness} */ (normalizeHarnessUiId(value, 'openrouter'));
}

/**
 * @param {'always' | 'unlessFalse' | 'whenTrue'} rule
 * @param {{ available?: boolean } | undefined} backend
 * @returns {boolean}
 */
function isOfferedByStatus(rule, backend) {
  if (rule === 'always') return true;
  if (rule === 'unlessFalse') return backend?.available !== false;
  return backend?.available === true;
}

/**
 * @param {object|undefined} status
 * @returns {{ value: FirstRunHarness, label: string }[]}
 */
function listAvailableHarnesses(status) {
  return listFirstRunHarnessMeta()
    .filter((meta) => isOfferedByStatus(meta.firstRunAvailability, status?.[meta.id]))
    .map((meta) => ({ value: /** @type {FirstRunHarness} */ (meta.id), label: t(meta.settingsLabelKey) }));
}

class CrFirstRunSetup extends LitElement {
  static properties = {
    step: { state: true },
    harness: { state: true },
    keyValue: { state: true },
    workspacePath: { state: true },
    error: { state: true },
    submitting: { state: true },
    options: { state: true },
    needsWorkspace: { state: true },
    opencodeKeyKind: { state: true },
    codexAuthKind: { state: true },
  };

  constructor() {
    super();
    this.step = 'chat';
    this.harness = 'openrouter';
    this.keyValue = '';
    this.workspacePath = '~/projects';
    this.error = '';
    this.submitting = false;
    this.options = listAvailableHarnesses();
    this.needsWorkspace = false;
    this.opencodeKeyKind = 'zai-coding-plan';
    this.codexAuthKind = 'chatgpt';
    /** @type {(() => void)|null} */
    this.onConfigured = null;
    /** @type {(() => void)|null} */
    this.onWorkspaceAdded = null;
  }

  createRenderRoot() {
    return this;
  }

  /**
   * @param {object|undefined} status
   */
  applyStatus(status) {
    this.options = listAvailableHarnesses(status);
    const values = this.options.map((row) => row.value);
    if (!values.includes(this.harness)) {
      this.harness = values[0] || 'openrouter';
    }
  }

  _onHarnessChange(event) {
    this.harness = normalizeHarness(event.target?.value || event.detail?.value);
    this.error = '';
  }

  _onCodexAuthKindChange(event) {
    const raw = String(event.target?.value || event.detail?.value || '').trim();
    this.codexAuthKind = raw === 'api-key' ? 'api-key' : 'chatgpt';
    this.error = '';
  }

  _onOpenCodeKeyKindChange(event) {
    const raw = String(event.target?.value || event.detail?.value || '').trim();
    const keyKinds = getHarnessUiMeta(this.harness)?.firstRunKeyKinds;
    if (!keyKinds) return;
    const known = keyKinds.kinds.some((kind) => kind.value === raw);
    this.opencodeKeyKind = known ? raw : keyKinds.defaultKind;
  }

  _onKeyInput(event) {
    this.keyValue = event.target?.value || '';
  }

  _onWorkspaceInput(event) {
    this.workspacePath = event.target?.value || '';
  }

  async _openWorkspaceFolderPicker() {
    const picked = await openFsPicker({
      mode: 'folder',
      title: t('firstRun.workspaceHeading'),
      startPath: String(this.workspacePath || '').trim() || '~',
    });
    if (picked) this.workspacePath = picked;
  }

  _goToWorkspaceOrFinish() {
    if (this.needsWorkspace) {
      this.step = 'workspace';
      this.error = '';
      this.submitting = false;
      return;
    }
    this.onConfigured?.();
    this.remove();
  }

  async _dismissChat() {
    this.submitting = true;
    this.error = '';
    try {
      await api.patchSettings({ firstRunSetupDismissed: true });
    } catch {
      /* still continue */
    }
    this._goToWorkspaceOrFinish();
  }

  async _saveChat() {
    const usesChatGpt = this.harness === 'codex' && this.codexAuthKind === 'chatgpt';
    const key = this.keyValue.trim();
    if (!usesChatGpt && !key) {
      this.error = t('firstRun.errorEmpty');
      return;
    }
    const harnessMeta = getHarnessUiMeta(this.harness);
    const keyKind = harnessMeta?.firstRunKeyKinds?.kinds.find((kind) => kind.value === this.opencodeKeyKind);
    const field = keyKind ? keyKind.keyField : harnessMeta?.firstRunKeyField;
    if (!usesChatGpt && !field) {
      this.error = t('firstRun.errorSave');
      return;
    }
    this.submitting = true;
    this.error = '';
    try {
      /** @type {Record<string, unknown>} */
      const payload = {
        defaultNewChatHarness: this.harness,
        firstRunSetupDismissed: true,
      };
      if (usesChatGpt) {
        payload.codexAuthMode = 'chatgpt';
      } else {
        payload[field] = key;
      }
      Object.assign(payload, harnessMeta?.firstRunPayload);
      if (this.harness === 'codex' && !usesChatGpt) {
        payload.codexAuthMode = 'api-key';
      }
      if (keyKind?.provider) payload[harnessMeta.firstRunKeyKinds.providerField] = keyKind.provider;
      const data = await api.patchSettings(payload);
      if (!data?.ok) {
        this.error = data?.error || t('firstRun.errorSave');
        this.submitting = false;
        return;
      }
      refreshHarnessSettingsPanel();
      this._goToWorkspaceOrFinish();
    } catch {
      this.error = t('firstRun.errorSave');
      this.submitting = false;
    }
  }

  _dismissWorkspace() {
    this.onConfigured?.();
    this.remove();
  }

  async _saveWorkspace() {
    const folder = this.workspacePath.trim();
    if (!folder) {
      this.error = t('firstRun.workspaceError');
      return;
    }
    this.submitting = true;
    this.error = '';
    try {
      const data = await api.patchSettings({
        workspaceAddPath: folder,
        workspaceAddAs: 'folder',
      });
      if (!data?.ok) {
        this.error = data?.error || t('firstRun.workspaceError');
        this.submitting = false;
        return;
      }
      this.onWorkspaceAdded?.();
      this.onConfigured?.();
      this.remove();
    } catch {
      this.error = t('firstRun.workspaceError');
      this.submitting = false;
    }
  }

  _renderChatStep() {
    const message = this.error
      ? html`<div class="message" data-tone="error">${this.error}</div>`
      : null;
    return html`
      <cr-dialog ?open=${true} ?persistent=${true} heading=${t('firstRun.heading')}>
        <span slot="icon" class="mdi mdi-key-variant" aria-hidden="true"></span>
        <p class="cr-hint" slot="subheading">${t('firstRun.subheading')}</p>
        ${message}
        <div class="cr-field">
          <label class="cr-field-label" for="cr-first-run-harness">${t('firstRun.harnessLabel')}</label>
          <cr-bar-select
            id="cr-first-run-harness"
            aria-label=${t('firstRun.harnessLabel')}
            .options=${this.options}
            .value=${this.harness}
            @cr-change=${this._onHarnessChange}
          ></cr-bar-select>
        </div>
        <p class="cr-hint">${t(getHarnessUiMeta(this.harness)?.firstRunHintKey || 'firstRun.hintOpenRouter')}</p>
        ${getHarnessUiMeta(this.harness)?.firstRunKeyKinds ? html`
          <div class="cr-field">
            <label class="cr-field-label" for="cr-first-run-opencode-kind">${t('firstRun.opencodeKeyKindLabel')}</label>
            <cr-bar-select
              id="cr-first-run-opencode-kind"
              aria-label=${t('firstRun.opencodeKeyKindLabel')}
              .options=${getHarnessUiMeta(this.harness).firstRunKeyKinds.kinds.map((kind) => ({
                value: kind.value,
                label: t(kind.labelKey),
              }))}
              .value=${this.opencodeKeyKind}
              @cr-change=${this._onOpenCodeKeyKindChange}
            ></cr-bar-select>
          </div>
        ` : null}
        ${this.harness === 'codex' ? html`
          <div class="cr-field">
            <label class="cr-field-label" for="cr-first-run-codex-kind">${t('firstRun.codexAuthKindLabel')}</label>
            <cr-bar-select
              id="cr-first-run-codex-kind"
              aria-label=${t('firstRun.codexAuthKindLabel')}
              .options=${[
                { value: 'chatgpt', label: t('firstRun.codexAuthKindChatGpt') },
                { value: 'api-key', label: t('firstRun.codexAuthKindApiKey') },
              ]}
              .value=${this.codexAuthKind}
              @cr-change=${this._onCodexAuthKindChange}
            ></cr-bar-select>
          </div>
        ` : null}
        ${this.harness === 'codex' && this.codexAuthKind === 'chatgpt' ? null : html`
        <div class="cr-field">
          <label class="cr-field-label" for="cr-first-run-key">${t('firstRun.keyLabel')}</label>
          <cr-bar-input
            id="cr-first-run-key"
            type="password"
            autocomplete="off"
            placeholder=${t('firstRun.keyPlaceholder')}
            aria-label=${t('firstRun.keyLabel')}
            .value=${this.keyValue}
            @input=${this._onKeyInput}
          ></cr-bar-input>
        </div>
        `}
        <div slot="actions">
          <cr-bar-button ?disabled=${this.submitting} @click=${this._dismissChat}>
            ${t('firstRun.skip')}
          </cr-bar-button>
          <cr-bar-button variant="primary" ?disabled=${this.submitting} @click=${this._saveChat}>
            ${this.submitting ? t('firstRun.saving') : t('firstRun.save')}
          </cr-bar-button>
        </div>
      </cr-dialog>
    `;
  }

  _renderWorkspaceStep() {
    const message = this.error
      ? html`<div class="message" data-tone="error">${this.error}</div>`
      : null;
    return html`
      <cr-dialog ?open=${true} ?persistent=${true} heading=${t('firstRun.workspaceHeading')}>
        <span slot="icon" class="mdi mdi-folder-plus-outline" aria-hidden="true"></span>
        <p class="cr-hint" slot="subheading">${t('firstRun.workspaceSubheading')}</p>
        ${message}
        <div class="cr-field">
          <label class="cr-field-label" for="cr-first-run-folder">${t('firstRun.workspaceLabel')}</label>
          <div class="cr-row">
            <cr-bar-input
              id="cr-first-run-folder"
              type="text"
              autocomplete="off"
              placeholder=${t('firstRun.workspacePlaceholder')}
              aria-label=${t('firstRun.workspaceLabel')}
              .value=${this.workspacePath}
              @input=${this._onWorkspaceInput}
            ></cr-bar-input>
            <cr-icon-button
              class="settings-workspace-browse-btn"
              title=${t('settings.browseFolder')}
              aria-label=${t('settings.browseFolder')}
              @click=${this._openWorkspaceFolderPicker}
            >
              <span class="mdi mdi-folder-search-outline" aria-hidden="true"></span>
            </cr-icon-button>
          </div>
        </div>
        <p class="cr-hint">${t('firstRun.workspaceHint')}</p>
        <div slot="actions">
          <cr-bar-button ?disabled=${this.submitting} @click=${this._dismissWorkspace}>
            ${t('firstRun.workspaceSkip')}
          </cr-bar-button>
          <cr-bar-button variant="primary" ?disabled=${this.submitting} @click=${this._saveWorkspace}>
            ${this.submitting ? t('firstRun.saving') : t('firstRun.workspaceSave')}
          </cr-bar-button>
        </div>
      </cr-dialog>
    `;
  }

  render() {
    if (this.step === 'workspace') return this._renderWorkspaceStep();
    return this._renderChatStep();
  }
}

if (!customElements.get('cr-first-run-setup')) {
  customElements.define('cr-first-run-setup', CrFirstRunSetup);
}

/**
 * @param {object} data
 * @returns {boolean}
 */
function hasWorkspaceList(data) {
  return Array.isArray(data?.workspaces) && data.workspaces.length > 0;
}

/**
 * Shows the first-run configurator when chat has no backend and/or no workspace.
 *
 * @param {{ onConfigured?: () => void, onWorkspaceAdded?: () => void }} [options]
 * @returns {Promise<void>}
 */
export async function maybeShowFirstRunSetup(options = {}) {
  if (document.querySelector('cr-first-run-setup')) return;
  let data;
  try {
    data = await api.getSettings();
  } catch {
    return;
  }
  if (!data?.ok) return;
  const needsChat = !data.firstRunSetupDismissed && !data.harnessStatus?.anyConfigured;
  const needsWorkspace = !hasWorkspaceList(data);
  if (!needsChat && !needsWorkspace) return;
  const el = document.createElement('cr-first-run-setup');
  el.applyStatus(data.harnessStatus);
  el.needsWorkspace = needsWorkspace;
  el.step = needsChat ? 'chat' : 'workspace';
  el.onConfigured = typeof options.onConfigured === 'function' ? options.onConfigured : null;
  el.onWorkspaceAdded = typeof options.onWorkspaceAdded === 'function' ? options.onWorkspaceAdded : null;
  document.body.appendChild(el);
}
