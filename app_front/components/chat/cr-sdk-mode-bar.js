import { LitElement, css, html } from 'lit';
import '../ui/cr-searchable-select.js';
import { t } from '../../i18n/index.js';

class CrSdkModeBar extends LitElement {
  static properties = {
    mode: { type: String },
    showBuild: { type: Boolean, attribute: 'show-build' },
    statusLabel: { type: String, attribute: 'status-label' },
    statusTone: { type: String, attribute: 'status-tone' },
    harness: { type: String },
    model: { type: String },
    models: { attribute: false },
    contextPercent: { type: Number, attribute: 'context-percent' },
    contextLevel: { type: String, attribute: 'context-level' },
    contextLabel: { type: String, attribute: 'context-label' },
    contextEstimated: { type: Boolean, attribute: 'context-estimated' },
    contextVisible: { type: Boolean, attribute: 'context-visible' },
    pickerStep: { type: String, attribute: false },
    pendingHarness: { type: String, attribute: false },
  };

  static styles = css`
    :host {
      display: block;
      margin: 0 0 0.35rem;
      font-family: inherit;
      --cr-mode-bar-control-height: var(--cr-toolbar-control-height, 1.75rem);
      --cr-mode-bar-font-size: 0.72rem;
    }

    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.45rem 0.65rem;
      width: 100%;
      box-sizing: border-box;
      padding: 0.35rem 0.55rem;
      border: 1px solid var(--cr-border-subtle);
      border-radius: var(--cr-radius-md, 6px);
      background: var(--cr-surface-translucent);
      position: relative;
    }

    .cluster {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      min-width: 0;
    }

    .cluster--start {
      flex-shrink: 0;
    }

    .cluster--end {
      flex: 1 1 12rem;
      min-width: 0;
      justify-content: flex-end;
    }

    .toggle {
      display: inline-flex;
      align-items: stretch;
      height: var(--cr-mode-bar-control-height);
      box-sizing: border-box;
      border: 1px solid var(--cr-border-subtle);
      border-radius: var(--cr-radius-sm, 4px);
      background: var(--cr-control-idle-bg);
      overflow: hidden;
    }

    .btn {
      border: 0;
      background: transparent;
      color: var(--cr-text-muted);
      font-size: var(--cr-mode-bar-font-size);
      font-weight: 600;
      height: 100%;
      padding: 0 0.65rem;
      cursor: pointer;
      box-sizing: border-box;
    }

    .btn + .btn {
      border-left: 1px solid var(--cr-border-subtle);
    }

    .btn.active {
      background: var(--cr-info-bg);
      color: var(--cr-info);
    }

    .build {
      border: 1px solid var(--cr-plan-border);
      background: var(--cr-plan-bg);
      color: var(--cr-plan);
      border-radius: var(--cr-radius-sm, 4px);
      font-size: var(--cr-mode-bar-font-size);
      font-weight: 600;
      height: var(--cr-mode-bar-control-height);
      padding: 0 0.55rem;
      cursor: pointer;
      box-sizing: border-box;
      flex-shrink: 0;
    }

    .combined-picker {
      --cr-searchable-select-height: var(--cr-mode-bar-control-height);
      --cr-searchable-select-padding-x: 0.5rem;
      --cr-searchable-select-font-size: 0.8rem;
      --cr-searchable-select-min-width: 8rem;
      flex: 1 1 auto;
      min-width: 0;
      max-width: 48ch;
      width: auto;
      display: block;
    }

    .combined-picker::part(control) {
      border-radius: var(--cr-radius-sm, 4px);
      border-color: var(--cr-border-subtle);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text);
      font-weight: inherit;
      height: var(--cr-mode-bar-control-height);
      min-height: var(--cr-mode-bar-control-height);
      max-width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .combined-picker::part(control):hover {
      border-color: var(--cr-border-strong);
    }

    .model {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      height: var(--cr-mode-bar-control-height);
      padding: 0 0.55rem;
      box-sizing: border-box;
      border-radius: var(--cr-radius-sm, 4px);
      border: 1px solid var(--cr-border-subtle);
      font-size: var(--cr-mode-bar-font-size);
      line-height: 1;
      font-weight: 600;
      background: var(--cr-control-idle-bg);
      color: var(--cr-text-muted);
      max-width: 22ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .model-picker {
      --cr-searchable-select-height: var(--cr-mode-bar-control-height);
      --cr-searchable-select-padding-x: 0.5rem;
      --cr-searchable-select-font-size: 0.8rem;
      --cr-searchable-select-min-width: 8rem;
      max-width: 28ch;
      width: auto;
      display: inline-block;
    }

    .model-picker::part(control) {
      border-radius: var(--cr-radius-sm, 4px);
      border-color: var(--cr-border-subtle);
      background: var(--cr-control-idle-bg);
      color: var(--cr-text);
      font-weight: inherit;
      height: var(--cr-mode-bar-control-height);
      min-height: var(--cr-mode-bar-control-height);
      max-width: 28ch;
      min-width: 0;
      box-sizing: border-box;
    }

    .model-picker::part(control):hover {
      border-color: var(--cr-border-strong);
    }

    .status {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      height: var(--cr-mode-bar-control-height);
      padding: 0 0.55rem;
      box-sizing: border-box;
      border-radius: var(--cr-radius-sm, 4px);
      border: 1px solid var(--cr-border-subtle);
      font-size: var(--cr-mode-bar-font-size);
      line-height: 1;
      font-weight: 600;
      background: var(--cr-control-idle-bg);
      color: var(--cr-neutral);
    }

    .context-ring {
      width: var(--cr-mode-bar-control-height);
      height: var(--cr-mode-bar-control-height);
      min-width: var(--cr-mode-bar-control-height);
      flex-shrink: 0;
      padding: 0;
      box-sizing: border-box;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--cr-text-muted);
      display: inline-grid;
      place-items: center;
      cursor: pointer;
      position: relative;
    }

    .context-ring:hover .context-ring-bg {
      stroke: var(--cr-border-strong);
    }

    .context-ring:focus-visible {
      outline: 2px solid var(--cr-focus-outline, var(--cr-accent));
      outline-offset: 1px;
    }

    .context-ring.is-dimmed {
      opacity: 0.72;
    }

    .context-ring svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .context-ring-bg {
      fill: none;
      stroke: var(--cr-border-subtle);
      stroke-width: 3;
    }

    .context-ring-value {
      fill: none;
      stroke-width: 3;
      stroke-linecap: round;
      transform: rotate(-90deg);
      transform-origin: 50% 50%;
      transition: stroke-dasharray 160ms ease;
      stroke: var(--cr-success);
    }

    .context-ring--warn .context-ring-value {
      stroke: var(--cr-warn);
    }

    .context-ring--danger .context-ring-value {
      stroke: var(--cr-error);
    }

    .context-ring-center {
      position: absolute;
      font-size: 0.62rem;
      line-height: 1;
      font-weight: 700;
      letter-spacing: 0.01em;
      pointer-events: none;
      color: var(--cr-text-muted);
    }

    .status--connecting {
      color: var(--cr-info);
      border-color: var(--cr-info-border);
    }

    .status--active {
      color: var(--cr-success);
      border-color: var(--cr-success-border);
    }

    .status--generating,
    .status--running,
    .status--grepping {
      color: var(--cr-success);
      border-color: var(--cr-success-border);
    }

    .status--reading {
      color: var(--cr-info);
      border-color: var(--cr-info-border);
    }

    .status--approval {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .status--thinking {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .status--editing {
      color: var(--cr-status);
      border-color: var(--cr-status-border);
    }

    .status--textarea {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .status--choice,
    .status--question,
    .status--awaiting {
      color: var(--cr-warn);
      border-color: var(--cr-warn-border);
    }

    .status--disconnected {
      color: var(--cr-neutral);
      border-color: var(--cr-neutral-border);
    }

    :host-context(.chat-fullscreen-bar) {
      margin: 0;
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
    }

    :host-context(.chat-fullscreen-bar) .bar {
      border: none;
      background: transparent;
      padding: 0;
      width: 100%;
      gap: var(--cr-toolbar-gap, 0.5rem);
    }

    :host-context(.chat-fullscreen-bar) .toggle {
      border-color: var(--cr-border-subtle);
    }
  `;

  constructor() {
    super();
    this.mode = 'agent';
    this.showBuild = false;
    this.harness = 'sdk';
    this.model = '';
    this.models = [];
    this.statusLabel = '';
    this.statusTone = 'connecting';
    this.contextPercent = null;
    this.contextLevel = 'none';
    this.contextLabel = '';
    this.contextEstimated = false;
    this.contextVisible = false;
    this.pickerStep = 'harness';
    this.pendingHarness = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this._onLangChanged = () => this.requestUpdate();
    window.addEventListener('cr-lang-changed', this._onLangChanged);
  }

  disconnectedCallback() {
    window.removeEventListener('cr-lang-changed', this._onLangChanged);
    super.disconnectedCallback();
  }

  normalizeBarHarness(value, fallback = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'openrouter' || raw === 'opencode' || raw === 'codebuddy' || raw === 'deepseek' || raw === 'codex' || raw === 'qwen') return raw;
    if (raw === 'sdk') return 'sdk';
    return fallback;
  }

  hasPendingHarnessSwitch() {
    const pending = this.normalizeBarHarness(this.pendingHarness, '');
    if (!pending) return false;
    const current = this.normalizeBarHarness(this.harness, 'sdk');
    return pending !== current;
  }

  _getNormalizedModels() {
    const rows = Array.isArray(this.models) ? this.models : [];
    const seen = new Set();
    const next = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const value = String(row.value || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const label = String(row.label || value).trim() || value;
      next.push({ value, label });
    }
    const currentValue = String(this.model || '').trim();
    if (currentValue && !seen.has(currentValue)) {
      next.push({ value: currentValue, label: currentValue });
    }
    return next;
  }

  handleModelSelect(nextModel) {
    const normalized = String(nextModel || '').trim() || 'auto';
    if (this.normalizePickerStep(this.pickerStep) === 'model') {
      this.dispatchEvent(
        new CustomEvent('cr-sdk-harness-commit', {
          detail: {
            harness: this.normalizeBarHarness(this.pendingHarness, ''),
            model: normalized,
          },
          bubbles: true,
          composed: true,
        })
      );
      return;
    }
    if (normalized === this.model) return;
    this.dispatchEvent(
      new CustomEvent('cr-sdk-model-change', {
        detail: { model: normalized },
        bubbles: true,
        composed: true,
      })
    );
  }

  handleModelChange(event) {
    const nextModel = event?.detail?.value;
    this.handleModelSelect(nextModel);
  }

  normalizePickerStep(step) {
    return step === 'model' ? 'model' : 'harness';
  }

  handleModeClick(nextMode) {
    const normalized = nextMode === 'plan' ? 'plan' : 'agent';
    if (this.mode !== normalized) {
      this.mode = normalized;
      this.showBuild = normalized === 'plan';
    }
    this.dispatchEvent(
      new CustomEvent('cr-sdk-mode-change', {
        detail: { mode: normalized },
        bubbles: true,
        composed: true,
      })
    );
  }

  handleHarnessChange(event) {
    const normalized = this.normalizeBarHarness(event?.detail?.value, 'sdk');
    const current = this.normalizeBarHarness(this.harness, 'sdk');
    if (normalized === current) {
      const hadPending = this.hasPendingHarnessSwitch();
      this.pendingHarness = '';
      if (!hadPending) return;
      this.dispatchEvent(
        new CustomEvent('cr-sdk-harness-cancel', {
          bubbles: true,
          composed: true,
        })
      );
      return;
    }
    this.pendingHarness = normalized;
    this.dispatchEvent(
      new CustomEvent('cr-sdk-harness-intent', {
        detail: { harness: normalized },
        bubbles: true,
        composed: true,
      })
    );
  }

  keepPickerOpenAfterStepChange(pickerEl) {
    const reopenPicker = () => {
      pickerEl?.refreshOptions?.();
      pickerEl?.openDropdown?.();
    };
    void this.updateComplete.then(() => {
      reopenPicker();
      window.requestAnimationFrame(reopenPicker);
    });
  }

  handleCombinedSelectionChange(event) {
    const nextValue = String(event?.detail?.value || '').trim();
    if (!nextValue) return;
    const pickerEl = event?.currentTarget;
    if (nextValue === 'step::harness') {
      event.preventDefault();
      const hadPending = this.hasPendingHarnessSwitch();
      this.pendingHarness = '';
      this.pickerStep = 'harness';
      if (hadPending) {
        this.dispatchEvent(
          new CustomEvent('cr-sdk-harness-cancel', {
            bubbles: true,
            composed: true,
          })
        );
      }
      this.keepPickerOpenAfterStepChange(pickerEl);
      return;
    }
    if (nextValue.startsWith('harness::')) {
      event.preventDefault();
      const nextHarness = nextValue.slice('harness::'.length);
      this.handleHarnessChange({ detail: { value: nextHarness } });
      this.pickerStep = 'model';
      this.keepPickerOpenAfterStepChange(pickerEl);
      return;
    }
    if (nextValue.startsWith('model::')) {
      const nextModel = nextValue.slice('model::'.length);
      this.handleModelSelect(nextModel);
      if (!this.hasPendingHarnessSwitch()) this.pickerStep = 'harness';
      pickerEl?.closeDropdown?.();
      return;
    }
  }

  handleBuildClick() {
    this.dispatchEvent(
      new CustomEvent('cr-sdk-build-plan', {
        bubbles: true,
        composed: true,
      })
    );
  }

  handleContextDetailsClick() {
    this.dispatchEvent(
      new CustomEvent('cr-context-details-open', {
        detail: {
          percent: this.contextPercent,
          level: this.contextLevel || 'none',
          estimated: this.contextEstimated === true,
          label: this.contextLabel || '',
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    const mode = this.mode === 'plan' ? 'plan' : 'agent';
    const tone = this.statusTone || 'connecting';
    const label = this.statusLabel || t('status.connecting');
    const harnessValue = this.normalizeBarHarness(this.harness, 'sdk');
    const pendingHarness = this.normalizeBarHarness(this.pendingHarness, '');
    const displayHarnessValue = pendingHarness || harnessValue;
    const harnessOptions = [
      { value: 'sdk', label: 'Cursor SDK' },
      { value: 'openrouter', label: 'OpenRouter' },
      { value: 'opencode', label: 'OpenCode' },
      { value: 'codebuddy', label: 'CodeBuddy' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'qwen', label: 'Qwen' },
      { value: 'codex', label: 'Codex' },
    ];
    const models = this._getNormalizedModels();
    const rawModelValue = String(this.model || '').trim();
    const modelValue = rawModelValue || 'auto';
    const selectedModel = models.find((item) => item.value === modelValue);
    const modelLabel = selectedModel?.label || modelValue;
    const selectedHarnessLabel = harnessOptions.find((entry) => entry.value === displayHarnessValue)?.label || 'Cursor SDK';
    const pickerStep = this.normalizePickerStep(this.pickerStep);
    const combinedOptions = pickerStep === 'harness'
      ? harnessOptions.map((entry) => ({
          value: `harness::${entry.value}`,
          label: entry.label,
        }))
      : [
          { value: 'step::harness', label: t('sdkBlock.pickerChangeHarness') },
          ...models.map((entry) => ({
            value: `model::${entry.value}`,
            label: entry.label,
          })),
        ];
    const combinedValue = pickerStep === 'harness'
      ? `harness::${harnessValue}`
      : (rawModelValue ? `model::${modelValue}` : '');
    const combinedPlaceholder = pickerStep === 'harness'
      ? t('sdkBlock.pickerHarnessStep', { harness: selectedHarnessLabel })
      : (rawModelValue
        ? t('sdkBlock.pickerModelStep', { model: modelLabel || modelValue })
        : t('sdkBlock.pickerModelStepEmpty', { harness: selectedHarnessLabel }));
    const combinedDisplayLabel = pickerStep === 'harness' && modelLabel
      ? t('sdkBlock.pickerClosedLabel', { harness: selectedHarnessLabel, model: modelLabel })
      : '';
    const contextPercent = Number(this.contextPercent);
    const hasContextPercent = Number.isFinite(contextPercent) && contextPercent >= 0;
    const normalizedContextPercent = hasContextPercent
      ? Math.max(0, Math.min(100, contextPercent))
      : 0;
    const ringRadius = 10;
    const ringCircumference = 2 * Math.PI * ringRadius;
    const ringDash = (normalizedContextPercent / 100) * ringCircumference;
    const ringTone =
      this.contextLevel === 'critical' || this.contextLevel === 'danger'
        ? 'danger'
        : this.contextLevel === 'warn'
          ? 'warn'
          : 'ok';
    const roundedContextPercent = hasContextPercent ? Math.round(contextPercent) : null;
    const ringCenterLabel = roundedContextPercent == null
      ? '—'
      : roundedContextPercent > 99
        ? '99+'
        : String(roundedContextPercent);
    const ringLabel = String(this.contextLabel || '').trim() || t('sdkBlock.contextDetails');
    return html`
      <div class="bar">
        <div class="cluster cluster--start">
          <div class="toggle" role="group" aria-label=${t('sdkBlock.modeGroupAria')}>
            <button
              type="button"
              class="btn ${mode === 'plan' ? 'active' : ''}"
              @click=${() => this.handleModeClick('plan')}
              aria-pressed=${mode === 'plan' ? 'true' : 'false'}
            >
              Plan
            </button>
            <button
              type="button"
              class="btn ${mode === 'agent' ? 'active' : ''}"
              @click=${() => this.handleModeClick('agent')}
              aria-pressed=${mode === 'agent' ? 'true' : 'false'}
            >
              Agent
            </button>
          </div>
          ${this.showBuild
            ? html`<button type="button" class="build" @click=${this.handleBuildClick}>
                ${t('sdkBlock.buildPlan')}
              </button>`
            : null}
        </div>
        <div class="cluster cluster--end">
          <cr-searchable-select
            class="combined-picker"
            size="sm"
            .value=${combinedValue}
            .options=${combinedOptions}
            .placeholder=${combinedPlaceholder}
            .displayLabel=${combinedDisplayLabel}
            search-threshold="8"
            search-placeholder=${pickerStep === 'harness' ? t('sdkBlock.searchHarness') : t('sdkBlock.searchModel')}
            empty-label=${t('sdkBlock.noMatchingOptions')}
            aria-label=${t('sdkBlock.harnessModelAria')}
            @cr-change=${this.handleCombinedSelectionChange}
          >
          </cr-searchable-select>
          <button
            type="button"
            class="context-ring context-ring--${ringTone} ${this.contextVisible ? '' : 'is-dimmed'}"
            title=${ringLabel}
            aria-label=${ringLabel}
            @click=${this.handleContextDetailsClick}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle class="context-ring-bg" cx="12" cy="12" r=${ringRadius}></circle>
              <circle
                class="context-ring-value"
                cx="12"
                cy="12"
                r=${ringRadius}
                stroke-dasharray="${ringDash} ${ringCircumference}"
              ></circle>
            </svg>
            <span class="context-ring-center">${ringCenterLabel}</span>
          </button>
          <span class="status status--${tone}" aria-live="polite">${label}</span>
        </div>
      </div>
    `;
  }
}

if (!customElements.get('cr-sdk-mode-bar')) {
  customElements.define('cr-sdk-mode-bar', CrSdkModeBar);
}
